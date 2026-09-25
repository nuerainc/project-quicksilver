import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import type { WorkflowGraph } from '../workflows/graph.ts'
import type { Principal } from '../identity/rbac.ts'
import type { WorkflowRunQueue } from '../runtime/queue.ts'

/**
 * Signed webhook trigger (server-only).
 *
 * A sender signs `${timestamp}.${rawBody}` with HMAC-SHA256 using the
 * endpoint's shared secret and sends:
 *
 *   X-Quicksilver-Timestamp: <unix seconds>
 *   X-Quicksilver-Signature: v1=<hex>[,v1=<hex>]   (several during secret rotation)
 *   X-Quicksilver-Delivery:  <sender's unique delivery id>   (optional, recommended)
 *
 * The handler verifies the signature in constant time, rejects stale or
 * future timestamps, rejects replays, and enqueues exactly one run per
 * delivery (the delivery id, or the signature, is the idempotency key).
 * Runs are enqueued as the endpoint's service principal, which should hold
 * only the `trigger` role.
 */

export interface WebhookEndpoint {
  /** Public, unguessable-not-required id used in the URL path. */
  id: string
  tenantId: string
  graph: WorkflowGraph
  /** Current secret plus any secrets still valid during rotation. Each ≥ 32 characters. */
  secrets: readonly string[]
  principal?: Principal
  priority?: number
  enabled?: boolean
  /** Maximum raw body size in bytes (default 256 KiB). */
  maxBodyBytes?: number
}

export interface ReplayCache {
  /** Returns true if the key was newly recorded, false if it was already seen. */
  remember(key: string, expiresAt: number): boolean | Promise<boolean>
}

/** Bounded in-memory replay cache. Use a shared store (e.g. Postgres/Redis) across replicas. */
export class InMemoryReplayCache implements ReplayCache {
  private readonly seen = new Map<string, number>()
  private readonly maxEntries: number
  private readonly now: () => number

  constructor(options: { maxEntries?: number; now?: () => number } = {}) {
    this.maxEntries = options.maxEntries ?? 100_000
    this.now = options.now ?? Date.now
  }

  remember(key: string, expiresAt: number): boolean {
    const now = this.now()
    const existing = this.seen.get(key)
    if (existing !== undefined && existing > now) return false
    if (this.seen.size >= this.maxEntries) {
      for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k)
      while (this.seen.size >= this.maxEntries) this.seen.delete(this.seen.keys().next().value!)
    }
    this.seen.set(key, expiresAt)
    return true
  }
}

export interface WebhookTriggerOptions {
  queue: WorkflowRunQueue
  endpoints: readonly WebhookEndpoint[]
  replayCache?: ReplayCache
  /** Accepted clock skew in seconds (default 300). */
  toleranceSeconds?: number
  now?: () => number
}

export type WebhookOutcome =
  | { status: 202; body: { accepted: true; runId: string; deduplicated: false } }
  | { status: 200; body: { accepted: true; runId: string; deduplicated: true } }
  | { status: 400 | 401 | 403 | 404 | 405 | 409 | 413 | 415 | 422 | 429 | 503; body: { accepted: false; error: string } }

export const MIN_WEBHOOK_SECRET_LENGTH = 32

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`
}

/** Compute the signature header value a sender should attach. */
export function signWebhook(secret: string, timestamp: number, rawBody: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${rawBody}`, 'utf8').digest('hex')}`
}

export class WebhookTrigger {
  private readonly queue: WorkflowRunQueue
  private readonly endpoints = new Map<string, WebhookEndpoint>()
  private readonly replayCache: ReplayCache
  private readonly toleranceSeconds: number
  private readonly now: () => number

  constructor(options: WebhookTriggerOptions) {
    this.queue = options.queue
    this.now = options.now ?? Date.now
    this.replayCache = options.replayCache ?? new InMemoryReplayCache({ now: this.now })
    this.toleranceSeconds = options.toleranceSeconds ?? 300
    if (!Number.isInteger(this.toleranceSeconds) || this.toleranceSeconds < 1 || this.toleranceSeconds > 3_600) throw new Error('toleranceSeconds must be 1–3600.')
    for (const endpoint of options.endpoints) this.addEndpoint(endpoint)
  }

  addEndpoint(endpoint: WebhookEndpoint): void {
    if (!endpoint || typeof endpoint.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(endpoint.id)) throw new Error('Webhook endpoint id is invalid.')
    if (this.endpoints.has(endpoint.id)) throw new Error(`Webhook endpoint "${endpoint.id}" already exists.`)
    if (!Array.isArray(endpoint.secrets) || endpoint.secrets.length === 0 || endpoint.secrets.some((s) => typeof s !== 'string' || s.length < MIN_WEBHOOK_SECRET_LENGTH)) {
      throw new Error(`Webhook endpoint "${endpoint.id}" needs at least one secret of ${MIN_WEBHOOK_SECRET_LENGTH}+ characters.`)
    }
    this.endpoints.set(endpoint.id, { ...endpoint, secrets: [...endpoint.secrets] })
  }

  /**
   * Replace an endpoint's secrets (rotation). Pass the new secret plus any
   * earlier ones that senders may still use. Same length rules as `addEndpoint`.
   */
  setSecrets(endpointId: string, secrets: readonly string[]): void {
    const endpoint = this.endpoints.get(endpointId)
    if (!endpoint) throw new Error(`Webhook endpoint "${endpointId}" does not exist.`)
    if (!Array.isArray(secrets) || secrets.length === 0 || secrets.some((s) => typeof s !== 'string' || s.length < MIN_WEBHOOK_SECRET_LENGTH)) {
      throw new Error(`Webhook endpoint "${endpointId}" needs at least one secret of ${MIN_WEBHOOK_SECRET_LENGTH}+ characters.`)
    }
    this.endpoints.set(endpointId, { ...endpoint, secrets: [...secrets] })
  }

  /** Endpoint metadata without secrets. */
  list(): Array<{ id: string; tenantId: string; workflowId: string; enabled: boolean; secretCount: number }> {
    return [...this.endpoints.values()].map((e) => ({ id: e.id, tenantId: e.tenantId, workflowId: e.graph.id, enabled: e.enabled !== false, secretCount: e.secrets.length }))
  }

  /** Framework-neutral core: verify and enqueue one delivery. */
  async receive(endpointId: string, headers: { get(name: string): string | null }, rawBody: string): Promise<WebhookOutcome> {
    const endpoint = this.endpoints.get(endpointId)
    // Unknown and disabled endpoints look the same to callers.
    if (!endpoint || endpoint.enabled === false) return fail(404, 'Unknown webhook endpoint.')
    const maxBytes = endpoint.maxBodyBytes ?? 262_144
    if (Buffer.byteLength(rawBody, 'utf8') > maxBytes) return fail(413, `Body exceeds ${maxBytes} bytes.`)
    const contentType = headers.get('content-type') ?? ''
    if (!/^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType)) return fail(415, 'Content-Type must be application/json.')

    const timestampText = headers.get('x-quicksilver-timestamp') ?? ''
    const signatureHeader = headers.get('x-quicksilver-signature') ?? ''
    if (!/^\d{9,11}$/.test(timestampText)) return fail(401, 'Missing or invalid signature.')
    const timestamp = Number(timestampText)
    if (Math.abs(this.now() / 1000 - timestamp) > this.toleranceSeconds) return fail(401, 'Missing or invalid signature.')
    const supplied = signatureHeader.split(',').map((part) => part.trim()).filter((part) => /^v1=[0-9a-f]{64}$/.test(part)).map((part) => Buffer.from(part.slice(3), 'hex'))
    if (supplied.length === 0 || supplied.length > 5) return fail(401, 'Missing or invalid signature.')
    let verified = false
    for (const secret of endpoint.secrets) {
      const expected = Buffer.from(signWebhook(secret, timestamp, rawBody).slice(3), 'hex')
      for (const candidate of supplied) if (timingSafeEqual(expected, candidate)) verified = true
    }
    if (!verified) return fail(401, 'Missing or invalid signature.')

    let payload: unknown
    try {
      payload = JSON.parse(rawBody)
    } catch {
      return fail(400, 'Body must be valid JSON.')
    }

    const deliveryHeader = headers.get('x-quicksilver-delivery')
    if (deliveryHeader !== null && !/^[\x21-\x7e]{1,128}$/.test(deliveryHeader)) return fail(400, 'X-Quicksilver-Delivery must be 1–128 printable characters.')
    const signatureHex = supplied[0]!.toString('hex')
    const deliveryId = deliveryHeader ?? `sig:${signatureHex.slice(0, 32)}`
    const idempotencyKey = `webhook:${endpoint.id}:${deliveryId}`

    // Replay protection: a (signature) may be used once within the tolerance window.
    // Same delivery id with a *new* signature (a legitimate retry) falls through to idempotent enqueue.
    const fresh = await this.replayCache.remember(`${endpoint.id}:${signatureHex}`, this.now() + this.toleranceSeconds * 2_000)
    if (!fresh) {
      if (deliveryHeader === null) return fail(409, 'Replayed delivery.')
      // With an explicit delivery id, a replay resolves to the existing run below.
    }

    let result
    try {
      result = await this.queue.enqueue({
        graph: endpoint.graph,
        // Deterministic input so a retried delivery deduplicates to the same run.
        input: { event: payload, deliveryId },
        tenantId: endpoint.tenantId,
        trigger: { kind: 'webhook', source: endpoint.id },
        idempotencyKey,
        ...(endpoint.priority !== undefined ? { priority: endpoint.priority } : {}),
        ...(endpoint.principal ? { principal: endpoint.principal } : {}),
      })
    } catch {
      return fail(503, 'Could not record the delivery; retry later.')
    }
    if (result.accepted) {
      return result.deduplicated
        ? { status: 200, body: { accepted: true, runId: result.run.runId, deduplicated: true } }
        : { status: 202, body: { accepted: true, runId: result.run.runId, deduplicated: false } }
    }
    if (result.code === 'backpressure') return fail(429, 'Queue is busy; retry later.')
    if (result.code === 'forbidden') return fail(403, 'This endpoint is not permitted to start runs.')
    if (result.code === 'invalid-graph') return fail(422, 'The endpoint workflow is invalid.')
    // Idempotency conflict: same delivery id, different payload.
    if (!fresh) return fail(409, 'Replayed delivery.')
    return fail(409, result.reasons[0] ?? 'Delivery conflicts with an earlier delivery.')
  }

  /**
   * Fetch-standard handler for Next.js route handlers, Deno, Bun, or any
   * `Request`/`Response` runtime. The endpoint id is the last path segment
   * unless `endpointId` is passed.
   */
  async handle(request: Request, endpointId?: string): Promise<Response> {
    if (request.method !== 'POST') return json(fail(405, 'Use POST.'))
    const id = endpointId ?? new URL(request.url).pathname.split('/').filter(Boolean).at(-1) ?? ''
    const endpoint = this.endpoints.get(id)
    const limit = endpoint?.maxBodyBytes ?? 262_144
    const declared = Number(request.headers.get('content-length') ?? 0)
    if (declared > limit) return json(fail(413, `Body exceeds ${limit} bytes.`))
    const rawBody = await request.text()
    return json(await this.receive(id, request.headers, rawBody))
  }
}

function fail(status: Exclude<WebhookOutcome['status'], 200 | 202>, error: string): WebhookOutcome {
  return { status, body: { accepted: false, error } }
}

function json(outcome: WebhookOutcome): Response {
  return new Response(JSON.stringify(outcome.body), { status: outcome.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}
