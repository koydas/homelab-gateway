import express from 'express'
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware'
import client from 'prom-client'

// In-cluster services (see gitops-homelab). Overridable for local dev
// against the LAN IPs instead of cluster-internal DNS.
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://ollama.ollama.svc.cluster.local:11434'
const WHISPER_URL = process.env.WHISPER_URL || 'http://whisper.whisper.svc.cluster.local:9000'
const PIPER_URL = process.env.PIPER_URL || 'http://piper.piper.svc.cluster.local:8000'

const register = new client.Registry()
client.collectDefaultMetrics({ register })

const requestsTotal = new client.Counter({
  name: 'gateway_http_requests_total',
  help: 'Total requests proxied by homelab-gateway, by backend',
  labelNames: ['backend', 'method', 'status_code'],
  registers: [register],
})

const requestDuration = new client.Histogram({
  name: 'gateway_http_request_duration_seconds',
  help: 'Duration of requests proxied by homelab-gateway, by backend',
  labelNames: ['backend'],
  registers: [register],
})

const ollamaModelRequests = new client.Counter({
  name: 'gateway_ollama_model_requests_total',
  help: 'Requests routed to Ollama, by model',
  labelNames: ['model'],
  registers: [register],
})

const app = express()

// Records metrics for every request that got routed somewhere.
// req.gatewayBackend is set by the routing middleware below before handing
// off to a proxy; requests that never reach a backend (/healthz, /metrics,
// a rejected 400) leave it unset and are skipped here.
app.use((req, res, next) => {
  const start = process.hrtime.bigint()
  res.on('finish', () => {
    const backend = req.gatewayBackend
    if (!backend) return
    const seconds = Number(process.hrtime.bigint() - start) / 1e9
    requestDuration.observe({ backend }, seconds)
    requestsTotal.inc({ backend, method: req.method, status_code: res.statusCode })
  })
  next()
})

app.get('/healthz', (req, res) => res.json({ status: 'ok' }))

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType)
  res.end(await register.metrics())
})

// Rewrites only the path portion, keeping any query string intact (e.g.
// whisper's ?task=transcribe&language=fr).
const rewriteTo = (targetPath) => (path) => targetPath + (path.includes('?') ? path.slice(path.indexOf('?')) : '')

const onProxyError = (backend) => (err, req, res) => {
  res.writeHead(502, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Backend unreachable', backend, detail: err.message }))
}

const whisperProxy = createProxyMiddleware({
  target: WHISPER_URL,
  changeOrigin: true,
  pathRewrite: rewriteTo('/asr'),
  on: { error: onProxyError('whisper') },
})

const piperProxy = createProxyMiddleware({
  target: PIPER_URL,
  changeOrigin: true,
  pathRewrite: rewriteTo('/tts'),
  on: { proxyReq: fixRequestBody, error: onProxyError('piper') },
})

const ollamaProxy = createProxyMiddleware({
  target: OLLAMA_URL,
  changeOrigin: true,
  on: {
    // Ollama enforces an Origin allowlist (DNS-rebinding protection) and
    // rejects anything that isn't same-origin with itself. changeOrigin
    // only rewrites the Host header, so the Origin of whatever client sent
    // this request (e.g. ollama-chat, or this gateway's own address) would
    // otherwise pass through untouched and get a 403 — same fix ollama-chat
    // applies for its own direct-to-Ollama proxy.
    proxyReq: (proxyReq, req) => {
      proxyReq.setHeader('origin', OLLAMA_URL)
      fixRequestBody(proxyReq, req)
    },
    error: onProxyError('ollama'),
  },
})

// Rule 1: audio/* or multipart -> whisper, streamed through unparsed so a
// large audio upload is never buffered in memory just to inspect it.
app.use((req, res, next) => {
  const contentType = req.headers['content-type'] || ''
  if (!contentType.startsWith('audio/') && !contentType.startsWith('multipart/form-data')) return next()
  req.gatewayBackend = 'whisper'
  whisperProxy(req, res, next)
})

app.use(express.json({ limit: '25mb' }))

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' })
  }
  next(err)
})

// Rules 2-5: JSON-body content sniffing. A bodiless request (GET, or a POST
// with no distinguishing field) falls back to Ollama by default -- this is
// an inherent limit of routing by content instead of by path, since there's
// nothing to sniff. See the plan / README for the full rule set.
app.use((req, res, next) => {
  const body = req.body && Object.keys(req.body).length > 0 ? req.body : null

  if (body && typeof body.text === 'string' && body.model === undefined) {
    req.gatewayBackend = 'piper'
    return piperProxy(req, res, next)
  }

  if (body && body.model !== undefined) {
    req.gatewayBackend = 'ollama'
    ollamaModelRequests.inc({ model: String(body.model) })
    return ollamaProxy(req, res, next)
  }

  if (!body) {
    req.gatewayBackend = 'ollama'
    return ollamaProxy(req, res, next)
  }

  res.status(400).json({
    error: 'Unable to determine target service from request body. Expected a "text" field (Piper) or a "model" field (Ollama).',
  })
})

const PORT = process.env.PORT || 8080
app.listen(PORT, () => console.log(`homelab-gateway ready, listening on :${PORT}`))
