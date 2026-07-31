# ADR-0003: Front Claude (Anthropic API) calls the same way as Ollama/Whisper/Piper

- **Date:** 2026-07-31
- **Status:** Accepted

> **Note:** the credential-ownership call below ("no credential lives here") was reversed the
> same day, once it became clear it made `ollama-chat` un-deployable without a secret that
> gateway routing was supposed to make optional. See [ADR-0004](./0004-gateway-owns-anthropic-key.md).
> Routing/pass-through decisions in this ADR are otherwise unchanged.

## Context

`ollama-chat` is adding a "Claude" chat mode alongside its existing Ollama-backed "Chat" and
"Vocal" modes (that repo's ADR-0023). Its own Express server already does the actual
Ollama-shape ↔ Anthropic-shape translation and SSE→NDJSON re-emission for this — the open
question was only where the outbound Anthropic API call itself should land: straight from
`ollama-chat` to `api.anthropic.com`, or through this gateway like every other backend call.

## Decision

Route it through the gateway, consistent with `ollama-chat` ADR-0014 (all of its production
traffic already goes through here) and this repo's whole reason to exist: one place to see
request volume/latency/model usage across every backend `ollama-chat` talks to, not three
places plus a silent fourth.

- `server/index.js` gets a fourth proxy target, `ANTHROPIC_URL` (default
  `https://api.anthropic.com`), and a **pure pass-through** `claudeProxy` — unlike `ollamaProxy`,
  it does no header rewriting. Anthropic has no Origin allowlist to work around, and
  `ollama-chat`'s own request already carries a real `x-api-key` header (its own secret) that
  this gateway never inspects or replaces.
- **Routing stays content-based, no new path convention:** a JSON body whose `model` field
  starts with `claude-` routes here, checked *before* the existing "any `model` field →
  Ollama" rule. Anthropic's own model-ID convention (`claude-opus-5`, never colon-tagged like
  Ollama's `llama3.1:8b-instruct-q4_0`) makes this an unambiguous, zero-cost signal — no need
  to special-case `/v1/messages` by path and break the "no `/whisper`, `/piper`, `/ollama`
  prefix" design this gateway already commits to.
- No credential lives here: this gateway holds no Anthropic API key of its own, unlike
  `MONGO_URL` or (implicitly) nothing-for-Ollama today. `ollama-chat` keeps owning that secret
  and sending it on every request; this proxy relays it unchanged, the same way it already
  relays whatever `Content-Type`/body a client sends.
- `gateway_claude_model_requests_total{model}` mirrors `gateway_ollama_model_requests_total`
  for per-model visibility. No Claude equivalent of `gateway_ollama_tokens_per_second`
  (ADR-0002) yet — Anthropic's response shape carries no comparable native timing stats in the
  request/response bodies this gateway sees; revisit if that turns out to matter.

## Alternatives Considered

- **`ollama-chat` calls `api.anthropic.com` directly, gateway untouched** — rejected: the
  explicit ask driving this change was unified visibility; a fourth backend invisible to
  `/metrics` and the call log defeats that, and it's the one case here that touches real
  external API cost, arguably the most worth tracking of the four.
- **Path-based routing for Claude only (`/api/claude-chat` or similar)** — rejected: this
  gateway's one deliberate design commitment (see `docs/routing.md`) is "no per-backend URL
  scheme, decide from content alone." The `model` prefix already gives an unambiguous signal
  without carving out an exception.
- **Move the Anthropic-shape translation into the gateway itself** (so `ollama-chat` sends a
  plain Ollama-shaped body and the gateway does the Messages-API conversion + SSE→NDJSON
  re-emission) — rejected for now: every other proxy in this gateway is a genuinely dumb
  byte-for-byte pass-through with at most a header fixup; taking on full request/response
  reshaping for one backend is a different kind of component than what this repo is today.
  `ollama-chat` already had this translation built (it needs the app's own message/image shape
  either way), so pass-through was strictly less new code on both sides.
- **Gateway holds the Anthropic API key, injects `x-api-key` itself** (matching "the gateway is
  the trusted layer holding credentials" pattern) — rejected: no other backend here needed a
  credential of the gateway's own (Ollama/Whisper/Piper are unauthenticated in-cluster
  services), so this would be a new credential-custody responsibility for a repo that
  currently holds none beyond its own Mongo connection string. Keeping the key in
  `ollama-chat` (the thing the user actually interacts with and where the mode toggle lives)
  keeps credential ownership matching feature ownership.

## Consequences

**Good:**
- `ollama-chat`'s Claude traffic gets the same request volume/latency/error visibility as
  Ollama/Whisper/Piper, in the same place, for free.
- Zero new failure surface: `claudeProxy` is exactly as dumb as `piperProxy`, just pointed at a
  different (external, not in-cluster) target — the existing `onProxyError`/`captureProxyResponse`
  machinery applies unchanged.

**Neutral:**
- This is the first backend target that's an external internet service rather than an
  in-cluster one — `docs/architecture.md`'s topology diagram gets a fourth box outside the
  cluster boundary.

**Negative:**
- ⚠️ No streaming-aware stats extraction for Claude the way ADR-0002 added for Ollama — a
  large streamed reply still gets its response body captured/truncated by the generic 64KB cap
  (ADR-0001), but nothing pulls Anthropic's own token-usage numbers out of it into structured
  `call_log` fields yet. Worth a follow-up ADR if per-call cost tracking becomes a real need.
