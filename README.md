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
only configuration is the three backend URLs (`OLLAMA_URL`, `WHISPER_URL`,
`PIPER_URL`), set as plain env vars in `k8s/deployment.yaml` and defaulting
to the in-cluster service DNS names if unset — see `server/index.js`. There
is no `Secret` resource in `k8s/`. If a backend ever needs an API key, add it
via a `Secret` referenced through `envFrom`/`secretKeyRef` rather than a
plain env var, and document it here.
