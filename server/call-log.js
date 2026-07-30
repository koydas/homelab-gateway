import { MongoClient } from 'mongodb'

// Logs every proxied call (metadata + request/response body) to MongoDB for
// history/audit purposes, separate from the aggregate Prometheus counters in
// index.js. Fire-and-forget by design: a slow or unreachable Mongo must never
// add latency to a proxied request or take the gateway down.

const MONGO_URL = process.env.MONGO_URL || 'mongodb://homelab-gateway-mongo.homelab-gateway.svc.cluster.local:27017'
const DB_NAME = process.env.MONGO_DB || 'homelab_gateway'
const COLLECTION = 'call_log'
const RETENTION_DAYS = Number(process.env.LOG_RETENTION_DAYS || 30)

// Binary/streamed payloads (audio in/out) aren't useful to read back as
// logged bytes, so only body up to this size and of a body-loggable
// content-type gets stored; anything else is recorded as size + content-type.
const MAX_BODY_BYTES = 64 * 1024

let mongoClient = null
let collection = null
const connecting = MongoClient.connect(MONGO_URL, { serverSelectionTimeoutMS: 5000 })
  .then(async (client) => {
    mongoClient = client
    const col = client.db(DB_NAME).collection(COLLECTION)
    await col.createIndex({ timestamp: 1 }, { expireAfterSeconds: RETENTION_DAYS * 86400 })
    collection = col
    console.log(`call-log: connected to ${MONGO_URL}, retention ${RETENTION_DAYS}d`)
  })
  .catch((err) => {
    console.error(`call-log: could not connect to MongoDB, call logging disabled: ${err.message}`)
  })

// Covers application/json, text/*, and JSON-lines variants like Ollama's
// streaming application/x-ndjson — anything with "json" in the type, plus
// any text/* type.
const isLoggableContentType = (contentType) => {
  const type = contentType || ''
  return type.includes('json') || type.startsWith('text/')
}

// Bodies are captured as raw values by the caller (already-parsed JSON for
// requests, raw Buffer for proxied responses) and normalized here.
const summarizeBody = (body, contentType, isBuffer) => {
  if (body == null) return { body: null, bodySize: 0, bodyTruncated: false }

  const raw = isBuffer ? body : Buffer.from(JSON.stringify(body))
  const bodySize = raw.length

  if (!isLoggableContentType(contentType) || bodySize > MAX_BODY_BYTES) {
    return { body: null, bodySize, bodyTruncated: bodySize > MAX_BODY_BYTES }
  }

  return { body: isBuffer ? raw.toString('utf8') : body, bodySize, bodyTruncated: false }
}

// entry: { backend, method, path, statusCode, durationMs, model, clientIp,
//          requestBody, requestContentType, responseBody, responseContentType, error }
export function logCall(entry) {
  if (!collection) return // Mongo unavailable or still connecting — drop silently, see console.error above

  const req = summarizeBody(entry.requestBody, entry.requestContentType, false)
  const res = summarizeBody(entry.responseBody, entry.responseContentType, true)

  collection
    .insertOne({
      timestamp: new Date(),
      backend: entry.backend,
      method: entry.method,
      path: entry.path,
      statusCode: entry.statusCode,
      durationMs: entry.durationMs,
      model: entry.model,
      clientIp: entry.clientIp,
      requestBody: req.body,
      requestBodySize: req.bodySize,
      requestBodyTruncated: req.bodyTruncated,
      requestContentType: entry.requestContentType || null,
      responseBody: res.body,
      responseBodySize: res.bodySize,
      responseBodyTruncated: res.bodyTruncated,
      responseContentType: entry.responseContentType || null,
      error: entry.error || null,
    })
    .catch((err) => console.error(`call-log: insert failed: ${err.message}`))
}

export const ready = connecting

// Not used by the running server (which lives for the pod's lifetime), only
// by tests that need the process to exit cleanly after a run instead of
// hanging on an open MongoClient connection.
export async function close() {
  if (mongoClient) await mongoClient.close()
}
