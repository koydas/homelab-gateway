// End-to-end suite: a real Express app (server/index.js), a real MongoDB
// (in-memory, via mongodb-memory-server) and three fake HTTP backends
// standing in for Ollama/Whisper/Piper. Every case here reproduces a
// scenario manually exercised against the live cluster on 2026-07-30,
// including the two bugs found and fixed that day (NDJSON responses never
// captured, locally-rejected requests invisible in the call log) -- these
// are regression guards for those, not just new-feature tests.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'

const DB_NAME = 'test_gateway'
const RETENTION_DAYS = 7

let mongod, mongoClient, collection
let app, server, baseUrl
let ollamaFake, whisperFake, piperFake
let callLog

function createFakeBackend() {
  let handler = (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{}')
  }
  const httpServer = http.createServer((req, res) => handler(req, res))
  return {
    setHandler: (fn) => {
      handler = fn
    },
    listen: () =>
      new Promise((resolve) => {
        httpServer.listen(0, '127.0.0.1', () => resolve(httpServer.address().port))
      }),
    close: () => new Promise((resolve) => httpServer.close(resolve)),
    raw: httpServer,
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

async function waitForDocs(query, count, timeoutMs = 3000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const docs = await collection.find(query).toArray()
    if (docs.length >= count) return docs
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`Timed out waiting for ${count} doc(s) matching ${JSON.stringify(query)}`)
}

async function latestDoc(query) {
  const [doc] = await waitForDocs(query, 1)
  return doc
}

before(async () => {
  mongod = await MongoMemoryServer.create()

  ollamaFake = createFakeBackend()
  whisperFake = createFakeBackend()
  piperFake = createFakeBackend()
  const ollamaPort = await ollamaFake.listen()
  const whisperPort = await whisperFake.listen()
  const piperPort = await piperFake.listen()

  process.env.MONGO_URL = mongod.getUri()
  process.env.MONGO_DB = DB_NAME
  process.env.LOG_RETENTION_DAYS = String(RETENTION_DAYS)
  process.env.OLLAMA_URL = `http://127.0.0.1:${ollamaPort}`
  process.env.WHISPER_URL = `http://127.0.0.1:${whisperPort}`
  process.env.PIPER_URL = `http://127.0.0.1:${piperPort}`

  // Import after env vars are set -- both modules read their config from
  // process.env at top-level, once, on first import.
  const [{ default: gatewayApp }, callLogModule] = await Promise.all([
    import('../server/index.js'),
    import('../server/call-log.js'),
  ])
  callLog = callLogModule
  await callLog.ready
  app = gatewayApp

  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`

  mongoClient = new MongoClient(mongod.getUri())
  await mongoClient.connect()
  collection = mongoClient.db(DB_NAME).collection('call_log')
})

after(async () => {
  // server.close() alone only stops accepting *new* connections -- it
  // waits indefinitely for any still-open (e.g. keep-alive) sockets, which
  // left the process hanging past the test run. closeAllConnections()
  // forces those shut so the process can actually exit.
  server.closeAllConnections()
  ollamaFake.raw.closeAllConnections()
  whisperFake.raw.closeAllConnections()

  await new Promise((resolve) => server.close(resolve))
  await Promise.all([ollamaFake.close(), whisperFake.close(), piperFake.close()])
  await callLog.close() // the gateway's own MongoClient -- same hang risk, see above
  await mongoClient.close()
  await mongod.stop()
})

test('basic Ollama call is proxied and logged with request + response bodies', async () => {
  ollamaFake.setHandler(async (req, res) => {
    await readBody(req)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ response: 'hello', done: true }))
  })

  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'smoke-test', prompt: 'hi' }),
  })
  assert.equal(res.status, 200)

  const doc = await latestDoc({ backend: 'ollama', model: 'smoke-test' })
  assert.equal(doc.statusCode, 200)
  assert.deepEqual(doc.requestBody, { model: 'smoke-test', prompt: 'hi' })
  assert.equal(JSON.parse(doc.responseBody).response, 'hello')
})

test('NDJSON streaming responses are captured (regression: were silently dropped)', async () => {
  ollamaFake.setHandler(async (req, res) => {
    await readBody(req)
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    res.write(JSON.stringify({ response: 'foo', done: false }) + '\n')
    res.end(JSON.stringify({ response: 'bar', done: true }) + '\n')
  })

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'ndjson-test', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(res.status, 200)

  const doc = await latestDoc({ backend: 'ollama', model: 'ndjson-test' })
  assert.equal(doc.responseContentType, 'application/x-ndjson')
  assert.ok(doc.responseBody.includes('"foo"') && doc.responseBody.includes('"bar"'))
  assert.equal(doc.responseBodyTruncated, false)
})

test('response bodies over 64KB are flagged truncated and not stored, size still accurate', async () => {
  const big = 'a'.repeat(70_000)
  ollamaFake.setHandler(async (req, res) => {
    await readBody(req)
    const payload = JSON.stringify({ response: big, done: true })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(payload)
  })

  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'truncation-test', prompt: 'hi' }),
  })
  assert.equal(res.status, 200)

  const doc = await latestDoc({ backend: 'ollama', model: 'truncation-test' })
  assert.equal(doc.responseBody, null)
  assert.equal(doc.responseBodyTruncated, true)
  assert.ok(doc.responseBodySize > 64 * 1024, `expected size > 64KB, got ${doc.responseBodySize}`)
})

test('binary responses (Piper audio) are never stored, only size + content-type', async () => {
  const audioBytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 1, 2, 3])
  piperFake.setHandler(async (req, res) => {
    await readBody(req)
    res.writeHead(200, { 'Content-Type': 'audio/wav' })
    res.end(audioBytes)
  })

  const res = await fetch(`${baseUrl}/api/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'bonjour' }),
  })
  assert.equal(res.status, 200)

  const doc = await latestDoc({ backend: 'piper' })
  assert.equal(doc.responseBody, null)
  assert.equal(doc.responseBodySize, audioBytes.length)
  assert.equal(doc.responseContentType, 'audio/wav')
  assert.deepEqual(doc.requestBody, { text: 'bonjour' })
})

test('Whisper: multipart request body is not captured, JSON/text response is', async () => {
  whisperFake.setHandler(async (req, res) => {
    await readBody(req)
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('bonjour le monde')
  })

  const res = await fetch(`${baseUrl}/api/stt`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: Buffer.from([1, 2, 3, 4]),
  })
  assert.equal(res.status, 200)

  const doc = await latestDoc({ backend: 'whisper' })
  // Documents current, deliberate behavior: whisper's body bypasses
  // express.json() entirely (see index.js rule 1), so there's nothing for
  // the call log to capture on the request side -- only metadata.
  assert.equal(doc.requestBody, null)
  assert.equal(doc.responseBody, 'bonjour le monde')
  assert.equal(doc.responseContentType, 'text/plain')
})

test('concurrent requests are never cross-attributed to each other', async () => {
  ollamaFake.setHandler(async (req, res) => {
    const body = JSON.parse(await readBody(req))
    await new Promise((r) => setTimeout(r, 10 + Math.random() * 40))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ id: body.id }))
  })

  const N = 8
  await Promise.all(
    Array.from({ length: N }, (_, id) =>
      fetch(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'concurrent-test', id }),
      }).then((r) => assert.equal(r.status, 200)),
    ),
  )

  const docs = await waitForDocs({ backend: 'ollama', model: 'concurrent-test' }, N)
  assert.equal(docs.length, N)
  for (const doc of docs) {
    assert.equal(JSON.parse(doc.responseBody).id, doc.requestBody.id, 'response echoed a different request\'s id')
  }
})

test('real backend errors are proxied through and logged with the actual error body', async () => {
  ollamaFake.setHandler(async (req, res) => {
    await readBody(req)
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: "model 'nope' not found" }))
  })

  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'error-test', prompt: 'hi' }),
  })
  assert.equal(res.status, 404)

  const doc = await latestDoc({ backend: 'ollama', model: 'error-test' })
  assert.equal(doc.statusCode, 404)
  assert.match(doc.responseBody, /not found/)
})

test('Ollama native timing stats (NDJSON final line) are extracted to top-level fields', async () => {
  ollamaFake.setHandler(async (req, res) => {
    await readBody(req)
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    res.write(JSON.stringify({ message: { content: 'foo' }, done: false }) + '\n')
    res.end(
      JSON.stringify({
        message: { content: '' },
        done: true,
        total_duration: 20383548099,
        load_duration: 4148919317,
        prompt_eval_count: 2218,
        prompt_eval_duration: 8321447000,
        eval_count: 71,
        eval_duration: 7730835000,
      }) + '\n',
    )
  })

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'stats-test', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(res.status, 200)

  const doc = await latestDoc({ backend: 'ollama', model: 'stats-test' })
  assert.equal(doc.promptEvalCount, 2218)
  assert.equal(doc.promptEvalDurationMs, 8321)
  assert.equal(doc.evalCount, 71)
  assert.equal(doc.evalDurationMs, 7731)
  assert.equal(doc.loadDurationMs, 4149)
  assert.equal(doc.totalDurationMs, 20384)
})

test('Ollama stats survive even when the response is too large to store (regression: 64KB cap)', async () => {
  const big = 'a'.repeat(70_000)
  ollamaFake.setHandler(async (req, res) => {
    await readBody(req)
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    res.write(JSON.stringify({ message: { content: big }, done: false }) + '\n')
    res.end(JSON.stringify({ message: { content: '' }, done: true, eval_count: 42, eval_duration: 2_000_000_000 }) + '\n')
  })

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'big-stats-test', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(res.status, 200)

  const doc = await latestDoc({ backend: 'ollama', model: 'big-stats-test' })
  assert.equal(doc.responseBody, null, 'responseBody itself should still be dropped past the 64KB cap')
  assert.equal(doc.responseBodyTruncated, true)
  assert.equal(doc.evalCount, 42, 'stats should be extracted from the raw buffer regardless of the storage cap')
  assert.equal(doc.evalDurationMs, 2000)
})

test('gateway_ollama_tokens_per_second is exposed on /metrics after an Ollama call with stats', async () => {
  ollamaFake.setHandler(async (req, res) => {
    await readBody(req)
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' })
    res.end(JSON.stringify({ message: { content: '' }, done: true, eval_count: 100, eval_duration: 10_000_000_000 }) + '\n')
  })

  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'metrics-test', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(res.status, 200)
  await latestDoc({ backend: 'ollama', model: 'metrics-test' })

  const metrics = await (await fetch(`${baseUrl}/metrics`)).text()
  assert.match(metrics, /gateway_ollama_tokens_per_second_bucket\{.*model="metrics-test".*\}/)
})

test('locally-rejected requests are logged with backend "gateway" (regression: were invisible)', async () => {
  const before1 = await collection.countDocuments({ backend: 'gateway' })

  const malformed = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"model": not-valid-json}',
  })
  assert.equal(malformed.status, 400)

  const ambiguous = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ neither: 'text-nor-model' }),
  })
  assert.equal(ambiguous.status, 400)

  const docs = await waitForDocs({ backend: 'gateway' }, before1 + 2)
  const statuses = docs.map((d) => d.statusCode).filter((s) => s === 400)
  assert.ok(statuses.length >= 2, 'expected both rejection paths to produce a 400 call-log entry')
})

test('/healthz and /metrics are deliberately not written to the call log', async () => {
  const beforeCount = await collection.countDocuments({})
  await fetch(`${baseUrl}/healthz`)
  await fetch(`${baseUrl}/metrics`)
  await new Promise((r) => setTimeout(r, 100))
  const afterCount = await collection.countDocuments({})
  assert.equal(afterCount, beforeCount)
})

test('call_log has a TTL index matching LOG_RETENTION_DAYS', async () => {
  const indexes = await collection.indexes()
  const ttlIndex = indexes.find((i) => i.key && i.key.timestamp === 1)
  assert.ok(ttlIndex, 'expected an index on { timestamp: 1 }')
  assert.equal(ttlIndex.expireAfterSeconds, RETENTION_DAYS * 86400)
})

test('an unreachable backend produces a 502 with the error captured', async () => {
  // Last test: permanently closes the Piper fake so this reflects a real
  // connection failure, not a stub response. The low-level error string
  // depends on OS/socket state at the moment of failure -- a port nobody
  // ever listened on gives ECONNREFUSED (confirmed against the live
  // cluster), but this fake had prior successful traffic in an earlier
  // test, so a pooled connection tearing down mid-close can instead
  // surface as ECONNRESET/"socket hang up". Both are the same real
  // failure mode from the gateway's point of view (onProxyError catches
  // any proxy-side error uniformly) -- what matters is the 502 and that
  // *an* error got captured, not which exact libuv code fired.
  await piperFake.close()

  const res = await fetch(`${baseUrl}/api/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: 'bonjour' }),
  })
  assert.equal(res.status, 502)

  const doc = await latestDoc({ backend: 'piper', statusCode: 502 })
  assert.match(doc.error, /ECONNREFUSED|ECONNRESET|socket hang up/)
})
