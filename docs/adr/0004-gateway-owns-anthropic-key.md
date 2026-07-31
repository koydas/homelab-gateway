# ADR-0004: This gateway owns the Anthropic API key, not `ollama-chat`

- **Date:** 2026-07-31
- **Status:** Accepted

## Context

ADR-0003 deliberately kept no credential here, reasoning that `ollama-chat` already owned the
key and this proxy just needed to relay it unchanged. In practice that broke the exact thing
routing through the gateway was supposed to buy: `ollama-chat`'s pod went
`CreateContainerConfigError` and failed to deploy at all the moment its own
`ANTHROPIC_API_KEY` Secret didn't exist yet, on a change that should have been additive (new
mode in a dropdown) rather than deployment-blocking. `ollama-chat` should always talk to this
gateway for Claude calls, never straight to `api.anthropic.com` — so the credential belongs
wherever that's true, which is here, not in the app that's supposed to never need it directly.

## Decision

`ANTHROPIC_API_KEY` moves to this repo:

- `server/index.js`: `claudeProxy`'s `proxyReq` now unconditionally sets `x-api-key` to this
  gateway's own `ANTHROPIC_API_KEY`, overwriting whatever the client sent — same pattern as
  `ollamaProxy` overwriting `Origin`. The routing rule checks `ANTHROPIC_API_KEY` is configured
  *before* ever handing a request to `claudeProxy`, returning `500` immediately (backend
  `'claude'`, so it's still call-logged) if it isn't — the same "fail clearly, don't call out
  with a bad credential" behavior `ollama-chat` used to implement itself.
- `k8s/deployment.yaml`: `ANTHROPIC_API_KEY` from a new Secret, `homelab-gateway-anthropic`,
  created once out-of-band (never in Git) — same posture as every other credential in this
  cluster, see `docs/deployment.md`.
- `ollama-chat` (that repo's ADR-0019) no longer holds this credential at all, and its
  `CLAUDE_URL` no longer has a direct-to-Anthropic fallback — see below.

## Alternatives Considered

- **Keep the credential in `ollama-chat`, just fix the Kubernetes-level coupling** (e.g. make
  the Secret optional so the pod starts without it and only Claude mode 500s) — rejected: this
  still leaves two Secrets to create for one feature (`ollama-chat`'s own key plus, if this
  gateway ever needs one for anything else, a second), and doesn't answer the actual ask —
  `ollama-chat` is meant to always go through this gateway for Claude, so the gateway is where
  the credential naturally belongs, the same as this repo already being the thing that knows
  how to reach Ollama/Whisper/Piper without each caller configuring that itself.
- **`ollama-chat` sends no `x-api-key` at all, gateway adds one from scratch** — rejected in
  favor of *overwriting*: `@anthropic-ai/sdk` (used client-side in `ollama-chat`) requires a
  non-empty `apiKey` to construct at all; sending a placeholder and having this gateway replace
  it is less code than teaching `ollama-chat` to build a raw HTTP request instead of using the
  SDK, and behaves identically from `ollama-chat`'s point of view — see that repo's ADR-0019
  for why the SDK was worth keeping.

## Consequences

**Good:**
- `ollama-chat` deploys cleanly with zero Claude-specific configuration; the only new secret
  anyone has to create lives in the one place that's actually load-bearing for it.
- Matches how every other backend already works here: `ollama-chat` doesn't hold an Ollama
  token or a Whisper/Piper credential either — it just knows to talk to this gateway.

**Neutral:**
- This repo now holds a real external-service secret for the first time (`MONGO_URL` isn't
  one — the bundled Mongo has no auth). `docs/deployment.md` gets a bootstrapping section
  matching `ollama-chat`'s own TLS-Secret one in shape.

**Negative:**
- ⚠️ A leaked `ollama-chat` pod environment no longer exposes the Anthropic key (good), but a
  compromised gateway pod now can reach Anthropic on this cluster's behalf regardless of which
  caller asked — this proxy was already a single point of failure for Ollama/Whisper/Piper
  traffic; it's now also the single point of trust for the one backend with a real external
  cost attached. Worth keeping in mind if a second client of this gateway is ever added.
