# ADR-0002: Extract Ollama's native timing stats into structured fields, not just raw response text

- **Date:** 2026-07-30
- **Status:** Accepted

## Context

While investigating a live `ollama-chat` call's performance on 2026-07-30, it turned out
Ollama's own per-call timing stats — `prompt_eval_count`, `prompt_eval_duration`,
`eval_count`, `eval_duration`, `load_duration`, `total_duration` (nanoseconds), carried in the
final `"done": true` line of its NDJSON stream — were already reaching the gateway and being
written to `call_log.responseBody`. But only as raw, unparsed text, and only for responses
under the 64KB storage cap ([ADR-0001](./0001-mongodb-call-log.md)). There was no way to query
"which calls ran under 5 tok/s" without hand-splitting and parsing that blob per document, and
Prometheus had no visibility into per-model generation speed at all —
`gateway_ollama_model_requests_total` only counts calls, never how fast they ran.

## Decision

`server/index.js` now parses the last NDJSON line of Ollama's raw proxied response
(`parseOllamaStats`) *before* `call-log.js`'s 64KB storage cap is applied, so extraction
survives even when the raw body itself gets dropped for being too large. Two things happen
with the result:

1. `server/call-log.js` stores `promptEvalCount`, `promptEvalDurationMs`, `evalCount`,
   `evalDurationMs`, `loadDurationMs`, `totalDurationMs` as dedicated top-level fields on every
   `ollama`-backed `call_log` document, instead of leaving them buried in `responseBody` text.
2. Generation speed (`evalCount / evalDurationMs`) is observed into a new Prometheus
   histogram, `gateway_ollama_tokens_per_second{model}`, scraped the same way as the existing
   gateway metrics.

## Alternatives Considered

### Leave the stats as unparsed text inside `responseBody`

Rejected: only works for responses under the 64KB cap, and requires ad-hoc text parsing per
query with no aggregation and no Grafana visibility — exactly the gap this ADR closes.

### Compute tokens/sec only in Prometheus, skip the Mongo fields

Rejected: a Prometheus histogram is an aggregate by construction — the same limitation
ADR-0001 already rejected for the call log as a whole. Structured per-call fields in Mongo
(for ad hoc queries, e.g. "show me the 5 slowest `llava:7b` calls this week") and an aggregate
histogram in Prometheus (for trend visibility in Grafana) answer different questions; neither
substitutes for the other.

### Parse the stats downstream (e.g. in `ollama-chat`) instead of at the gateway

Rejected: the gateway is the one place that reliably sees every Ollama-routed call
(chat, vision, ad hoc scripts) before any single downstream consumer does. Parsing here fixes
it once for all current and future clients instead of duplicating the same parsing logic in
each one.

## Consequences

**Good:**
- Ad hoc queries like "calls under 5 tok/s" or "average `eval_count` by model" are now
  directly possible against `call_log` without parsing text.
- Per-model generation-speed trend is now visible in Grafana via
  `gateway_ollama_tokens_per_second`, closing a real observability gap noted in
  `gitops-homelab`'s `gpu-metrics-visibility` skill.
- Extraction happens before the 64KB `responseBody` cap, so a large generation that loses its
  full stored body still keeps its timing stats.

**Neutral:**
- Only applies to `backend === 'ollama'` requests — Whisper/Piper have no equivalent native
  stats format, so they're untouched.
- Non-streaming (`stream: false`) Ollama calls work identically, since the parser just treats
  a single JSON object as a one-line stream.

**Negative:**
- ⚠️ If a future Ollama version changes the NDJSON stats field names or switches units away
  from nanoseconds, `parseOllamaStats` silently returns `null` (no stats extracted) rather than
  erroring — worth re-checking after any Ollama upgrade that touches `/api/chat`/`/api/generate`
  response shape.
- ⚠️ Adds one more Prometheus series-cardinality dimension (`model` label on a 9-bucket
  histogram) — negligible at this cluster's scale today, worth watching if the model roster
  grows significantly.
