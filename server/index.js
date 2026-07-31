import express from 'express'
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware'
import client from 'prom-client'
import zlib from 'node:zlib'
import { logCall } from './call-log.js'

// In-cluster services (see gitops-homelab). Overridable for local dev
// against the LAN IPs instead of cluster-internal DNS.
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://ollama.ollama.svc.cluster.local:11434'
const WHISPER_URL = process.env.WHISPER_URL || 'http://whisper.whisper.svc.cluster.local:9000'
const PIPER_URL = process.env.PIPER_URL || 'http://piper.piper.svc.cluster.local:8000'
// Unlike the other three, this is a real external service, not an
// in-cluster one -- and unlike them, this proxy also owns the credential
// for it (ANTHROPIC_API_KEY below), so ollama-chat can depend on this
// gateway alone rather than needing its own copy of the key. See ADR-0004
// (supersedes ADR-0003's original "no credential here" call).
const ANTHROPIC_URL = process.env.ANTHROPIC_URL || 'https://api.anthropic.com'
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

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

const claudeModelRequests = new client.Counter({
  name: 'gateway_claude_model_requests_total',
  help: 'Requests routed to Claude, by model',
  labelNames: ['model'],
  registers: [register],
})

// Counts requests per model but says nothing about how fast they were --
// this histogram fills that gap using Ollama's own generation-speed stats
// (see parseOllamaStats below), so per-model performance drift is visible
// in Grafana instead of only reachable by hand-parsing a Mongo blob.
// See ADR-0002 (docs/adr/0002-structured-ollama-stats.md).
const ollamaTokensPerSecond = new client.Histogram({
  name: 'gateway_ollama_tokens_per_second',
  help: 'Ollama generation speed (eval tokens per second), by model, from native Ollama timing stats',
  labelNames: ['model'],
  buckets: [1, 2, 5, 10, 15, 20, 30, 50, 100],
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
// Ollama streams NDJSON (one JSON object per line); the final line
// (`done: true`) carries Ollama's own native timing stats in nanoseconds.
// Non-streaming responses are just that one object on its own, so the same
// "parse the last line" logic covers both. Runs against the raw captured
// buffer -- *before* call-log.js's 64KB body-storage cap -- so a large
// generation that loses its stored responseBody doesn't also lose these.
// See ADR-0002 (docs/adr/0002-structured-ollama-stats.md).
const parseOllamaStats = (buffer) => {
  if (!buffer || buffer.length === 0) return null
  const lines = buffer.toString('utf8').split('\n').filter((line) => line.trim().length > 0)
  if (lines.length === 0) return null

  let last
  try {
    last = JSON.parse(lines[lines.length - 1])
  } catch {
    return null
  }
  if (!last || last.done !== true || typeof last.eval_count !== 'number') return null

  const nsToMs = (ns) => (typeof ns === 'number' ? Math.round(ns / 1e6) : undefined)
  return {
    promptEvalCount: last.prompt_eval_count,
    promptEvalDurationMs: nsToMs(last.prompt_eval_duration),
    evalCount: last.eval_count,
    evalDurationMs: nsToMs(last.eval_duration),
    loadDurationMs: nsToMs(last.load_duration),
    totalDurationMs: nsToMs(last.total_duration),
  }
}

app.use((req, res, next) => {
  const start = process.hrtime.bigint()
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress
  res.on('finish', () => {
    const backend = req.gatewayBackend
    if (!backend) return
    const seconds = Number(process.hrtime.bigint() - start) / 1e9
    requestDuration.observe({ backend }, seconds)
    requestsTotal.inc({ backend, method: req.method, status_code: res.statusCode })

    const model = req.body && req.body.model !== undefined ? String(req.body.model) : undefined
    const ollamaStats = backend === 'ollama' ? parseOllamaStats(req.gatewayResponseBody) : null
    if (ollamaStats && ollamaStats.evalCount > 0 && ollamaStats.evalDurationMs > 0) {
      ollamaTokensPerSecond.observe({ model: model || 'unknown' }, ollamaStats.evalCount / (ollamaStats.evalDurationMs / 1000))
    }

    logCall({
      backend,
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: Math.round(seconds * 1000),
      model,
      clientIp,
      requestBody: req.body ?? null,
      requestContentType: req.headers['content-type'],
      responseBody: req.gatewayResponseBody ?? null,
      responseContentType: req.gatewayResponseContentType,
      error: req.gatewayProxyError,
      ollamaStats,
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

// Anthropic (and potentially other backends) compress responses --
// http-proxy-middleware pipes those bytes to the client untouched (correct;
// the client negotiated that encoding), but this tee captures the same raw
// compressed bytes for logging, which is unreadable in call_log without
// this. Decompress the *captured copy only* -- res.write, .responseBody
// on the wire, and everything the real client sees is untouched by this.
const DECOMPRESSORS = { gzip: zlib.gunzipSync, br: zlib.brotliDecompressSync, deflate: zlib.inflateSync }
const captureProxyResponse = (proxyRes, req) => {
  const chunks = []
  let size = 0
  let truncated = false
  proxyRes.on('data', (chunk) => {
    if (size >= MAX_CAPTURE_BYTES) {
      truncated = true
      return
    }
    chunks.push(chunk)
    size += chunk.length
  })
  proxyRes.on('end', () => {
    const raw = Buffer.concat(chunks)
    const decompress = DECOMPRESSORS[proxyRes.headers['content-encoding']]
    // A capture cut short by the cap above is an incomplete compressed
    // stream and can't be decompressed -- store it raw rather than
    // throwing (call-log.js's own size cap already excludes bodies this
    // large from being read back as text either way).
    req.gatewayResponseBody = decompress && !truncated ? tryDecompress(decompress, raw) : raw
    req.gatewayResponseContentType = proxyRes.headers['content-type']
  })
}

function tryDecompress(decompress, raw) {
  try {
    return decompress(raw)
  } catch {
    return raw
  }
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

// Anthropic has no Origin allowlist to work around (unlike Ollama), but
// this gateway does own the credential for this backend: it overwrites
// whatever x-api-key the client sent (ollama-chat sends a placeholder --
// see that repo's server/index.js) with the real key, the same way
// ollamaProxy overwrites Origin. The routing rule below only ever hands a
// request to this proxy once ANTHROPIC_API_KEY has been confirmed set.
// See ADR-0004.
const claudeProxy = createProxyMiddleware({
  target: ANTHROPIC_URL,
  changeOrigin: true,
  on: {
    proxyReq: (proxyReq, req) => {
      proxyReq.setHeader('x-api-key', ANTHROPIC_API_KEY)
      fixRequestBody(proxyReq, req)
    },
    proxyRes: captureProxyResponse,
    error: onProxyError('claude'),
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

  if (body && typeof body.model === 'string' && body.model.startsWith('claude-')) {
    req.gatewayBackend = 'claude'
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the gateway' })
    }
    claudeModelRequests.inc({ model: body.model })
    return claudeProxy(req, res, next)
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

// Guarded so importing this module from tests doesn't also bind :8080 --
// only bind when run directly, the way the Docker CMD and `npm start` do.
if (import.meta.url === `file://${process.argv[1]}`) {
  const PORT = process.env.PORT || 8080
  app.listen(PORT, () => console.log(`homelab-gateway ready, listening on :${PORT}`))
}

export default app
