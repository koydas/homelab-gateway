---
name: inspect-call-perf
description: Find and interpret performance data (tokens/sec, durations) for a specific call that went through homelab-gateway. Covers the three separate stores (ephemeral pod logs, Prometheus, Mongo call_log) and where Ollama's structured per-call timing stats live since ADR-0002. Use when asked to check metrics/performance for a recent chat or vision call, or to improve what's captured.
---

# Inspecting per-call performance through homelab-gateway

## When to Apply

Someone asks "how did that call perform?", "what are the metrics on this?", or wants to
improve what's captured, for traffic that went through `homelab-gateway` (chat/vision calls to
Ollama, TTS to Piper, STT to Whisper).

## The three stores, and what each actually has

**1. Ollama pod stdout (`kubectl logs`) — richest detail, but ephemeral.**
```bash
sudo microk8s kubectl logs -n ollama <pod> --since=15m | grep -v 'GET      "/"'
```
Has `llama-server`'s verbose per-request breakdown: prompt eval tok/s, eval tok/s, model load
time, GPU layers offloaded (`offloaded N/M layers`). Nothing persists this — no Loki/log
aggregator in this cluster (deliberately not built, see `gitops-homelab`'s
`gpu-metrics-visibility` skill). Gone on pod restart/rotation, not queryable. This is the only
place GPU-layer-offload detail exists at all.

**2. Prometheus (`ServiceMonitor` in `k8s/servicemonitor.yaml`, scraped every 30s).**
- `gateway_http_requests_total{backend,method,status_code}`
- `gateway_http_request_duration_seconds{backend}` (histogram, bucketed)
- `gateway_ollama_model_requests_total{model}` — counts calls per model
- `gateway_ollama_tokens_per_second{model}` — generation-speed histogram, fed by the same
  native Ollama stats as point 3 below ([ADR-0002](../../docs/adr/0002-structured-ollama-stats.md))
- Node.js default process metrics (`collectDefaultMetrics`)

Use this for trend/drift questions ("has `llava:7b` gotten slower over the last week?"), not
for one specific call — a histogram can't tell you what call #47 did, only the distribution.

Ollama itself still exposes no `/metrics` endpoint (confirmed 404 on `:11434`) — everything
above comes from the gateway's own instrumentation of the calls it proxies, not from Ollama
natively.

**3. MongoDB `call_log` (`server/call-log.js`, 30-day TTL) — per-call, structured.**
```bash
sudo microk8s kubectl exec -n homelab-gateway deploy/homelab-gateway-mongo -- mongosh --quiet homelab_gateway --eval '
db.call_log.find({model:"llava:7b"}).sort({timestamp:-1}).limit(1).forEach(d => print(JSON.stringify(d, null, 2)))'
```
Has `timestamp`, `backend`, `method`, `path`, `statusCode`, `durationMs` (total HTTP time,
measured by the gateway), `model`, `clientIp`, `requestBody`/`responseBody` (+ size/truncated/
content-type), and — since [ADR-0002](../../docs/adr/0002-structured-ollama-stats.md),
2026-07-30 — dedicated top-level fields for `ollama`-backed calls:
`promptEvalCount`, `promptEvalDurationMs`, `evalCount`, `evalDurationMs`, `loadDurationMs`,
`totalDurationMs`. These are extracted server-side from Ollama's NDJSON final line
(`server/index.js`'s `parseOllamaStats`) — no more manual text-splitting needed. Query directly:
```bash
sudo microk8s kubectl exec -n homelab-gateway deploy/homelab-gateway-mongo -- mongosh --quiet homelab_gateway --eval '
db.call_log.find({model:"llava:7b", evalDurationMs:{$lt:8000}}).sort({timestamp:-1}).limit(5).forEach(d =>
  print(d.timestamp, d.model, "eval:", d.evalCount, "tok in", d.evalDurationMs, "ms ->",
        (d.evalCount / (d.evalDurationMs/1000)).toFixed(1), "tok/s"))'
```

## Constraints — when the structured stats are NOT there

- `promptEvalCount`/`evalCount`/etc. are only populated for `backend === 'ollama'` calls whose
  final NDJSON line actually has `done: true` and a numeric `eval_count` — a proxy error (502),
  a non-Ollama backend, or an Ollama response shape change would leave these fields absent.
- They're extracted from the raw buffer *before* `call-log.js`'s 64KB `responseBody`
  storage cap, so they still show up even when `responseBody` itself is `null`/truncated for
  being too large — don't assume no stats just because `responseBodyTruncated: true`.
- Capture itself still caps at 512KB (`MAX_CAPTURE_BYTES` in `index.js`) — a response larger
  than that never has its final line available at all, so extraction fails silently past this
  point (see ADR-0002's negative consequences).

## References

- `docs/adr/0001-mongodb-call-log.md` — why Mongo over Prometheus-only, body capture rules
- `docs/adr/0002-structured-ollama-stats.md` — why/how the stats above were extracted
- `server/call-log.js`, `server/index.js` — implementation of both metric paths
- `gitops-homelab`'s `gpu-metrics-visibility` skill — the GPU/DCGM side of this same gap
