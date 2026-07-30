---
name: inspect-call-perf
description: Find and interpret performance data (tokens/sec, durations, GPU layers) for a specific call that went through homelab-gateway. Covers the three separate stores (ephemeral pod logs, Prometheus, Mongo call_log) and where Ollama's real per-call timing stats actually live. Use when asked to check metrics/performance for a recent chat or vision call, or to improve what's captured.
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
aggregator in this cluster. Gone on pod restart/rotation, not queryable.

**2. Prometheus (`ServiceMonitor` in `k8s/servicemonitor.yaml`, scraped every 30s) —
aggregates only.**
- `gateway_http_requests_total{backend,method,status_code}`
- `gateway_http_request_duration_seconds{backend}` (histogram, bucketed)
- `gateway_ollama_model_requests_total{model}` — counts calls per model, not their performance
- Node.js default process metrics (`collectDefaultMetrics`)

Ollama itself exposes no `/metrics` endpoint (confirmed 404 on `:11434`) — none of its native
timing stats reach Prometheus from any source today.

**3. MongoDB `call_log` (`server/call-log.js`, 30-day TTL) — per-call, but stats are buried.**
```bash
sudo microk8s kubectl exec -n homelab-gateway deploy/homelab-gateway-mongo -- mongosh --quiet homelab_gateway --eval '
db.call_log.find({model:"llava:7b"}).sort({timestamp:-1}).limit(1).forEach(d => print(JSON.stringify(d, null, 2)))'
```
Has `timestamp`, `backend`, `method`, `path`, `statusCode`, `durationMs` (total HTTP time,
measured by the gateway), `model`, `clientIp`, `requestBody`/`responseBody` (+ size/truncated/
content-type).

**Key discovery (2026-07-30):** Ollama's streaming chat/generate response is NDJSON — one
JSON object per line — and the *last* line (`"done": true`) carries Ollama's own native timing
stats: `total_duration`, `load_duration`, `prompt_eval_count`, `prompt_eval_duration`,
`eval_count`, `eval_duration` (all nanoseconds). These land in `responseBody` as raw text
verbatim, unextracted:
```bash
sudo microk8s kubectl exec -n homelab-gateway deploy/homelab-gateway-mongo -- mongosh --quiet homelab_gateway --eval '
db.call_log.find({model:"llava:7b"}).sort({timestamp:-1}).limit(1).forEach(d => {
  let lines = d.responseBody.split("\n").filter(l => l.trim().length>0)
  printjson(JSON.parse(lines[lines.length-1]))
})'
```
Compute tok/s from that: `eval_count / (eval_duration / 1e9)` for generation speed,
`prompt_eval_count / (prompt_eval_duration / 1e9)` for prompt processing speed.

## Constraints on that discovery — when the stats are NOT there

- `summarizeBody()` in `call-log.js` stores `responseBody: null` entirely if the body exceeds
  `MAX_BODY_BYTES` (64KB) — a long generation blows past this and the stats line is lost with
  the rest of the body, not just truncated.
- Capture itself caps at 512KB (`MAX_CAPTURE_BYTES` in `index.js`) — an even larger streamed
  response never reaches the point of having its final line available to store, regardless of
  the 64KB check.
- Non-JSON/text content types (audio to/from Whisper/Piper) are never body-captured at all —
  only size + content-type, by design (see ADR-0001).

So this technique works for typical chat/vision calls but silently stops working past ~64KB of
streamed response — worth checking `responseBodyTruncated`/`responseBody: null` before
assuming the stats line is there.

## Known gap / improvement backlog

Nobody currently surfaces Ollama's native timing stats as structured, queryable data — they
only exist as raw text inside a Mongo blob (and only under the 64KB cap above). If asked to
improve this:

1. **Extract at write time.** In `call-log.js` (or before calling `logCall()` in `index.js`),
   when `backend === 'ollama'` and the response is NDJSON, parse the last line and pass through
   dedicated fields (`promptEvalCount`, `promptEvalDurationMs`, `evalCount`, `evalDurationMs`,
   `loadDurationMs`, `totalDurationMs`) instead of relying on the raw blob. Do this regardless
   of the 64KB body-storage cap so large generations don't lose their stats.
2. **Expose it in Prometheus too.** Add a histogram (e.g. `gateway_ollama_tokens_per_second{model}`)
   fed by the same extraction, so performance drift per model is visible in Grafana over time —
   `gateway_ollama_model_requests_total` today only counts calls, it says nothing about how fast
   they were.

If this gets implemented, record it as an ADR (see `new-adr` skill) — it's a real
schema/instrumentation decision, not routine housekeeping.

## References

- `docs/adr/0001-mongodb-call-log.md` — why Mongo over Prometheus-only, body capture rules
- `server/call-log.js`, `server/index.js` — implementation of both metric paths
- `gitops-homelab`'s `gpu-metrics-visibility` skill — the GPU/DCGM side of this same gap
