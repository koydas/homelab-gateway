# Routing and request flow

## Routing: picking a backend by content, not by path

There's no `/ollama/*`, `/whisper/*`, `/piper/*`, `/claude/*` URL scheme — every request
arrives at whatever path the client used (`/api/chat`, `/v1/messages`, ...) and the gateway
decides where it goes purely from `Content-Type` and the JSON body shape:

```mermaid
flowchart TD
    A[Incoming request] --> B{Content-Type is<br/>audio/* or multipart/form-data?}
    B -- yes --> W["Whisper<br/>POST /asr (streamed, unparsed)"]
    B -- no --> C[express.json parses body]
    C --> D{JSON body has a<br/>'text' field, no 'model'?}
    D -- yes --> P["Piper<br/>POST /tts"]
    D -- no --> G{"'model' starts with<br/>'claude-'?"}
    G -- yes --> CL["Claude (Anthropic API)<br/>original path preserved (/v1/messages)"]
    G -- no --> E{JSON body has<br/>a 'model' field?}
    E -- yes --> O["Ollama<br/>original path preserved"]
    E -- no --> F{"Body is empty<br/>(GET, /api/tags, ...)?"}
    F -- yes --> O
    F -- no --> R["400: can't determine backend"]
```

This is a deliberate trade-off: it means one entry point works for chat, STT, and TTS with
zero path convention for clients to remember, but a bodiless request has nothing to sniff, so
rule 4's "default to Ollama" is a real design choice, not a fallback-of-convenience — see the
README's Routing rules section for the exact precedence, and `server/index.js` for the
implementation (order of `app.use()` calls *is* the precedence).

## Request flow: a proxied call

```mermaid
sequenceDiagram
    participant C as Client<br/>(ollama-chat, curl, ...)
    participant G as homelab-gateway
    participant B as Backend<br/>(Ollama/Whisper/Piper)
    participant M as homelab-gateway-mongo

    C->>G: POST /api/chat { model, messages }
    G->>G: content-sniff → backend = ollama
    G->>B: proxied, Origin rewritten to OLLAMA_URL<br/>(DNS-rebinding allowlist, see below)
    B-->>G: response (streamed NDJSON or buffered JSON)
    G-->>C: response, byte-for-byte
    G->>G: res 'finish' fires
    par fire-and-forget, never blocks the response above
        G->>M: insertOne({ backend, method, path,<br/>statusCode, duration, bodies, ... })
    end
```

Two details worth calling out:

- **Origin rewrite (Ollama only)** — Ollama enforces an Origin allowlist (DNS-rebinding
  protection) and rejects anything that isn't same-origin with itself.
  `changeOrigin: true` (from `http-proxy-middleware`) only rewrites the `Host` header, not
  `Origin`, so without an explicit `proxyReq.setHeader('origin', OLLAMA_URL)` the client's own
  Origin would pass through untouched and get a 403 — this exact bug was hit and fixed while
  wiring `ollama-chat` through this gateway (see that repo's ADR-0014). Whisper/Piper don't
  need this; only Ollama checks Origin.
- **Logging never blocks the response** — the Mongo insert in the diagram above happens
  *after* the response has already been sent to the client, off the `res.on('finish')` event.
  A slow or unreachable Mongo adds zero latency to a proxied call and can never turn a working
  backend into a failing request — see [ADR-0001](./adr/0001-mongodb-call-log.md) for the full
  reasoning (also covers what gets captured vs. dropped: size limits, content-type filtering,
  binary bodies).
