# homelab-gateway

Single LAN entry point in front of `whisper`, `piper`, and `ollama`. Routes
each request to the right backend by inspecting its content — no `/whisper`,
`/piper`, `/ollama` prefix required — and exposes Prometheus metrics for
request counts, latency, and Ollama model usage.

## Routing rules

Applied in order, based on `Content-Type` and the JSON body shape:

1. `Content-Type: audio/*` or `multipart/form-data` → **whisper**, `POST /asr`
   (streamed through unparsed, not buffered).
2. JSON body with a `text` field and no `model` field → **piper**, `POST /tts`.
3. JSON body with a `model` field → **ollama**, original path preserved
   (e.g. `/api/generate`, `/api/chat`).
4. No body (GET, health checks, `/api/tags`, ...) → falls back to **ollama**
   by default. Content-based routing has nothing to sniff on a bodiless
   request, so this is a deliberate default rather than a coincidence.
5. Anything else (JSON with neither `text` nor `model`) → `400`.

## Endpoints on the gateway itself

- `GET /healthz` — liveness check.
- `GET /metrics` — Prometheus exposition format:
  - `gateway_http_requests_total{backend,method,status_code}`
  - `gateway_http_request_duration_seconds{backend}`
  - `gateway_ollama_model_requests_total{model}`

CPU/RAM per backend pod isn't duplicated here — it's already collected by
the cluster's existing cAdvisor/kube-prometheus metrics, filterable by
namespace (`whisper`, `piper`, `ollama`, `homelab-gateway`).

## Local dev

```bash
npm install
OLLAMA_URL=http://192.168.1.241:11434 \
WHISPER_URL=http://192.168.1.245:9000 \
PIPER_URL=http://192.168.1.246:8000 \
npm run dev
```

## Deployment

Deployed via ArgoCD from `k8s/` — see `gitops-homelab/apps/homelab-gateway`.
Reached at `http://gateway.home/` through the shared ingress-nginx entry
point (`192.168.1.243`, see gitops-homelab docs/adr/0014); needs a local
`/etc/hosts` entry, same as `ollama-chat.home`.
