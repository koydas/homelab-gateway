# ADR-0001: Log every call to a bundled MongoDB, not just aggregate Prometheus counters

- **Date:** 2026-07-30
- **Status:** Accepted

## Context

`/metrics` (`gateway_http_requests_total`, `gateway_http_request_duration_seconds`,
`gateway_ollama_model_requests_total`) only ever exposed aggregate counters/histograms — there
was no way to answer "what did that specific request look like?" after the fact. The operator
asked for actual per-call history (what was sent, what came back, when), which an aggregate
counter can't provide no matter how many labels it carries.

## Decision

Every proxied request now gets one document written to a bundled, single-replica MongoDB
(`homelab-gateway-mongo`, `k8s/mongo.yaml`) via `server/call-log.js`, wired into the existing
`res.on('finish')` metrics hook in `server/index.js`.

- **Schema per doc:** timestamp, backend, method, path, status code, duration, Ollama model
  (if present), client IP, and request/response bodies. Extended in
  [ADR-0002](./0002-structured-ollama-stats.md) (2026-07-30) with structured Ollama timing-stat
  fields (`promptEvalCount`, `evalCount`, `evalDurationMs`, etc.) instead of leaving them
  buried in the raw response body text.
- **Body capture is capped and content-type-filtered:** only `application/json`/`text/*`
  bodies up to 64KB are stored; anything else (audio bytes, oversized payloads) is recorded as
  size + content-type only. Storing base64-encoded audio blobs or multi-megabyte streamed
  generations would bloat Mongo for data nobody would read back as a log entry.
- **Response bodies are captured by tee-ing `proxyRes` chunks** alongside the normal pipe to
  the client, capped at 512KB in memory (well above the 64KB log-truncation limit, so a large
  but loggable JSON response isn't cut short at the capture stage — only at the storage stage).
- **Fire-and-forget:** a slow or unreachable Mongo must never add latency to a proxied request
  or take the gateway down. `logCall()` never awaits its insert in the request path; connect
  and insert failures are only `console.error`'d.
- **TTL index** on `timestamp` (`LOG_RETENTION_DAYS`, default 30) auto-expires old entries so
  the collection doesn't grow unbounded on a single-node, resource-constrained cluster.
- Mongo runs with **no auth** — it's ClusterIP-only, unreachable outside the cluster network,
  and holds no secrets of its own (see README § Secrets).

## Alternatives Considered

### Redis Streams
Rejected: much lighter on RAM (~20-50Mi vs. ~200-400Mi), but a poor fit for "filter/query the
history later" — the operator's actual use case. Streams are better suited to a bounded recent
event window than ad-hoc querying by backend/model/status/date.

### CouchDB
Rejected: comparable memory footprint to MongoDB with no advantage for this use case (no
replication need on a single-node cluster); MongoDB's query/aggregation tooling is more
familiar and better documented for this kind of ad-hoc log inspection.

### Extending the existing Prometheus metrics instead
Rejected outright: histograms and counters are aggregates by construction — there's no way to
recover "what was request #47's actual prompt and response" from a bucketed duration
histogram, no matter how many labels are added. This is a different question than `/metrics`
was ever meant to answer.

### A capped collection instead of a TTL index
Considered, not used: a capped collection enforces a byte-size ceiling instead of a time
window, which is a worse fit here — the operator wants "the last N days," not "however many
docs fit in X MB before the oldest silently drops," and a TTL index is simpler to reason about
and to adjust (`LOG_RETENTION_DAYS`) without recreating the collection.

## Consequences

**Good:**
- Actual request/response history is now queryable directly (`mongosh` against
  `homelab-gateway-mongo`), not just aggregate rates/totals.
- Fire-and-forget design means this can't regress the gateway's core job (proxying) even if
  Mongo is unhealthy — the proxy behaves identically, just without the log entry.
- TTL index means this is zero-maintenance disk-growth-wise; no manual pruning task needed
  (contrast with the Ollama model PVC in `gitops-homelab`, which does need manual pruning).

**Neutral:**
- This is the first stateful workload this repo (and this cluster's git-source apps in
  general) has introduced — a `PersistentVolumeClaim` on `microk8s-hostpath`, single-node, no
  backup story beyond "it's a 30-day rolling audit log, not a system of record."

**Negative:**
- ⚠️ Body capture happens even for prompts/responses that may contain sensitive content —
  there's no redaction. Anyone with cluster access can read raw chat prompts/responses back
  out of Mongo for up to 30 days.
- ⚠️ Adds a second in-cluster dependency (beyond Ollama/Whisper/Piper) the gateway now talks
  to on every request, though failure is designed to be silent/non-blocking (see Decision).
- ⚠️ `homelab-gateway-mongo`'s PVC binds to whichever node it first schedules on
  (`WaitForFirstConsumer` on `microk8s-hostpath`) — fine on this single-node cluster, but
  would need revisiting before this pattern is reused on a multi-node one.
