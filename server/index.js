import express from 'express'
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware'
import client from 'prom-client'
import { logCall } from './call-log.js'

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

// Records metrics and the call-log entry for every request that got routed
// somewhere, or that the gateway itself rejected. req.gatewayBackend is set
// either by the routing middleware below before handing off to a proxy
// (backend name), or by the gateway's own rejection paths (malformed JSON,
// unroutable body — backend 'gateway', see below). /healthz and /metrics
// leave it unset and are the only requests skipped here — they're scraper/
// liveness noise, not application traffic. Response body/content-type, when
// captured, are attached to req by the proxyRes hooks below (see
// captureProxyResponse).
app.use((req, res, next) => {
  const start = process.hrtime.bigint()
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  res.on('finish', () => {
    const backend = req.gatewayBackend
    if (!backend) return
    const seconds = Number(process.hrtime.bigint() - start) / 1e9
    requestDuration.observe({ backend }, seconds)
    requestsTotal.inc({ backend, method: req.method, status_code: res.statusCode })

    logCall({
      backend,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Math.round(seconds * 1000),
      model: req.body && req.body.model !== undefined ? String(req.body.model) : undefined,
      clientIp,
      requestBody: req.body ?? null,
      requestContentType: req.headers['content-type'],
      responseBody: req.gatewayResponseBody ?? null,
      responseContentType: req.gatewayResponseContentType,
      error: req.gatewayProxyError,
    })
  })
  next()
})

// Response bodies are captured by tee-ing proxyRes chunks alongside the
// normal pipe to the client (http-proxy-middleware pipes proxyRes -> res
// after emitting this event; adding our own 'data' listener here doesn't
// interfere with that). Capped well above the call-log truncation limit so
// a large-but-loggable JSON response isn't cut short here, while a huge
// streamed generation or audio body still can't balloon gateway memory.
const MAX_CAPTURE_BYTES = 512 * 1024
const captureProxyResponse = (proxyRes, req) => {
  const chunks = []
  let size = 0
  proxyRes.on('data', (chunk) => {
    if (size >= MAX_CAPTURE_BYTES) return
    chunks.push(chunk)
    size += chunk.length
  })
  proxyRes.on('end', () => {
    req.gatewayResponseBody = Buffer.concat(chunks)
    req.gatewayResponseContentType = proxyRes.headers['content-type']
  })
}

app.get('/healthz', (req, res) => res.json({ status: 'ok' }))

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType)
  res.end(await register.metrics())
})

// Rewrites only the path portion, keeping any query string intact (e.g.
// whisper's ?task=transcribe&language=fr).
const rewriteTo = (targetPath) => (path) => targetPath + (path.includes('?') ? path.slice(path.indexOf('?')) : '')

const onProxyError = (backend) => (err, req, res) => {
  req.gatewayProxyError = err.message
  res.writeHead(502, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'Backend unreachable', backend, detail: err.message }))
}

const whisperProxy = createProxyMiddleware({
  target: WHISPER_URL,
  changeOrigin: true,
  pathRewrite: rewriteTo('/asr'),
  on: { proxyRes: captureProxyResponse, error: onProxyError('whisper') },
})

const piperProxy = createProxyMiddleware({
  target: PIPER_URL,
  changeOrigin: true,
  pathRewrite: rewriteTo('/tts'),
  on: { proxyReq: fixRequestBody, proxyRes: captureProxyResponse, error: onProxyError('piper') },
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
    proxyRes: captureProxyResponse,
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
    req.gatewayBackend = 'gateway'
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

  req.gatewayBackend = 'gateway'
  res.status(400).json({
    error: 'Unable to determine target service from request body. Expected a "text" field (Piper) or a "model" field (Ollama).',
  })
})

const PORT = process.env.PORT || 8080
app.listen(PORT, () => console.log(`homelab-gateway ready, listening on :${PORT}`))
