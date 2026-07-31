# homelab-gateway

[![e2e](https://github.com/koydas/homelab-gateway/actions/workflows/e2e.yml/badge.svg)](https://github.com/koydas/homelab-gateway/actions/workflows/e2e.yml)
[![build/deploy](https://github.com/koydas/homelab-gateway/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/koydas/homelab-gateway/actions/workflows/docker-publish.yml)

Single LAN entry point in front of `whisper`, `piper`, `ollama`, and the
Anthropic API (Claude). Routes each request to the right backend by
inspecting its content — no `/whisper`, `/piper`, `/ollama`, `/claude`
prefix required — and exposes Prometheus metrics for request counts,
latency, and per-model usage.

See [`docs/architecture.md`](./docs/architecture.md) for diagrams of how this
fits together, and [`docs/adr/README.md`](./docs/adr/README.md) for the
design decisions behind non-obvious parts of this repo.

## Routing rules

Applied in order, based on `Content-Type` and the JSON body shape:

1. `Content-Type: audio/*` or `multipart/form-data` → **whisper**, `POST /asr`
   (streamed through unparsed, not buffered).
2. JSON body with a `text` field and no `model` field → **piper**, `POST /tts`.
3. JSON body with a `model` field starting with `claude-` → **claude**,
   original path preserved (`/v1/messages`) — see [ADR-0003](./docs/adr/0003-front-claude-calls.md).
4. JSON body with any other `model` field → **ollama**, original path
   preserved (e.g. `/api/generate`, `/api/chat`).
5. No body (GET, health checks, `/api/tags`, ...) → falls back to **ollama**
   by default. Content-based routing has nothing to sniff on a bodiless
   request, so this is a deliberate default rather than a coincidence.
6. Anything else (JSON with neither `text` nor `model`) → `400`.

## Endpoints on the gateway itself

- `GET /healthz` — liveness check.
- `GET /metrics` — Prometheus exposition format:
  - `gateway_http_requests_total{backend,method,status_code}`
  - `gateway_http_request_duration_seconds{backend}`
  - `gateway_ollama_model_requests_total{model}`
  - `gateway_claude_model_requests_total{model}`
  - `gateway_ollama_tokens_per_second{model}` — generation speed histogram, from Ollama's own
    native timing stats (see below and [ADR-0002](./docs/adr/0002-structured-ollama-stats.md))

CPU/RAM per backend pod isn't duplicated here — it's already collected by
the cluster's existing cAdvisor/kube-prometheus metrics, filterable by
namespace (`whisper`, `piper`, `ollama`, `homelab-gateway`).

## Call log (MongoDB)

Every proxied request is also written as one document per call to a
`homelab-gateway-mongo` MongoDB instance (`k8s/mongo.yaml`), separate from
the aggregate `/metrics` counters above — this is per-call history, not just
totals. See `server/call-log.js` and [ADR-0001](./docs/adr/0001-mongodb-call-log.md)
for why.

- Each document: timestamp, backend, method, path, status code, duration,
  Ollama model (if any), client IP, and request/response bodies.
- Bodies are only stored for JSON/text content-types up to 64KB; anything
  else (audio, oversized bodies) is recorded as size + content-type only,
  to avoid dumping binary blobs into Mongo for no benefit.
- For `ollama`-backed calls, Ollama's own native timing stats
  (`promptEvalCount`, `promptEvalDurationMs`, `evalCount`, `evalDurationMs`,
  `loadDurationMs`, `totalDurationMs`) are stored as dedicated top-level
  fields — extracted from the raw NDJSON response *before* the 64KB cap
  above applies, so they survive even when the full response body is too
  large to store. See [ADR-0002](./docs/adr/0002-structured-ollama-stats.md).
- Logging is fire-and-forget: a slow or unreachable Mongo never adds
  latency to a proxied request, and never takes the gateway down — insert
  failures are only `console.error`'d.
- A TTL index (`LOG_RETENTION_DAYS`, default 30) auto-expires old entries so
  this doesn't grow unbounded on a single-node cluster.
- Config: `MONGO_URL` (default: in-cluster `homelab-gateway-mongo` Service),
  `MONGO_DB` (default `homelab_gateway`), `LOG_RETENTION_DAYS`.
- Mongo runs as a single replica (Deployment + hostpath PVC, no HA) — it's
  a homelab audit log, not a system of record. See the comment in
  `k8s/mongo.yaml` for why this is a Deployment and not a StatefulSet.

## Local dev

```bash
npm install
OLLAMA_URL=http://192.168.1.241:11434 \
WHISPER_URL=http://192.168.1.245:9000 \
PIPER_URL=http://192.168.1.246:8000 \
npm run dev
```

## Tests

```bash
npm test
```

`test/gateway.e2e.test.js` runs the real Express app (`server/index.js`) against
an in-memory MongoDB ([`mongodb-memory-server`](https://github.com/typegoose/mongodb-memory-server))
and three fake HTTP backends standing in for Ollama/Whisper/Piper — no external
services or Docker needed. Covers routing, the call-log capture rules
(truncation, content-type filtering including NDJSON, binary bodies never
stored), concurrent-request isolation, real backend errors, an unreachable
backend, and locally-rejected requests (malformed JSON, unroutable body) —
several of these are regression guards for bugs found by exercising the live
cluster on 2026-07-30 (see [ADR-0001](./docs/adr/0001-mongodb-call-log.md)).
Gated in CI (`.github/workflows/docker-publish.yml`'s `test` job) before any
image is built or deployed.

## Deployment

Deployed via ArgoCD from `k8s/` — see `gitops-homelab/apps/homelab-gateway`.
There's no separate bootstrap step for this repo: pushing to `main` a change
that touches code (i.e. anything outside `**.md`, `docs/**`, and `k8s/**` —
see the `paths-ignore` on `.github/workflows/docker-publish.yml`) builds and
pushes the image to GHCR, rewrites the tag in `k8s/deployment.yaml`, and
commits that change back to the branch — ArgoCD picks up the new manifest
from there. A docs- or manifest-only push (like this one) is intentionally
skipped and does not trigger a build. `k8s/` is the full set of manifests
(Deployment, Service, Ingress, ServiceMonitor); nothing else needs to be
applied by hand.

Reached at `http://gateway.home/` through the shared ingress-nginx entry
point (`192.168.1.243`, see gitops-homelab docs/adr/0014).

### Client DNS setup (manual, per machine)

There is no DNS server in this homelab, so `gateway.home` only resolves on
machines where it's added by hand. On every new client that needs to reach
the gateway, add an `/etc/hosts` entry (or equivalent local DNS override)
pointing at the shared ingress-nginx IP:

```
192.168.1.243  gateway.home
```

`/etc/hosts` resolves one hostname per line, so this entry only covers
`gateway.home` — it does not also resolve `ollama-chat.home` or any other
`*.home` service, even though they share the same ingress IP. Each hostname
needs its own line, added on each client individually, e.g.:

```
192.168.1.243  gateway.home
192.168.1.243  ollama-chat.home
```

### Transport: HTTP, not TLS

The gateway is plain HTTP end-to-end, and that's the deliberate current
state, not an oversight:

- `k8s/ingress.yaml` has no `tls:` block, so ingress-nginx terminates
  nothing and serves `gateway.home` over HTTP only.
- `k8s/service.yaml` is `ClusterIP` on port 80 → container port 8080, both
  plain HTTP.
- `server/index.js` calls `app.listen()` with no TLS options, and proxies
  to `OLLAMA_URL` / `WHISPER_URL` / `PIPER_URL`, which are themselves
  `http://` in-cluster addresses.

Everything stays inside the LAN and cluster-internal network, so there's no
TLS anywhere in the path today. Revisit this if the gateway is ever exposed
outside the trusted LAN.

### Secrets

No API keys, tokens, or credentials are required to start the gateway. The
only configuration is the backend URLs (`OLLAMA_URL`, `WHISPER_URL`,
`PIPER_URL`, `MONGO_URL`), set as plain env vars in `k8s/deployment.yaml` and
defaulting to the in-cluster service DNS names if unset — see
`server/index.js`. There is no `Secret` resource in `k8s/`, and the bundled
`homelab-gateway-mongo` has no auth enabled — it's ClusterIP-only, unreachable
outside the cluster network. If a backend ever needs an API key, add it
via a `Secret` referenced through `envFrom`/`secretKeyRef` rather than a
plain env var, and document it here.
