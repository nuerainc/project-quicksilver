import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import { signWebhook } from '@quicksilver/kernel/triggers'

import { sha256, type ToolDefinition } from './tool-executor.ts'

/**
 * Real adapters for approved actions (P-095): an email to an allowed recipient, and a signed
 * POST to an allowed host. They run only after a different human approved the exact call and the
 * kernel-signed grant was checked (see actions.ts); everything here is a second wall, not the first.
 *
 *   notification.send  -> Resend. The recipient must be on the owner's list, so this is an operational
 *                         notice to your own people. It cannot reach a customer, which would need a WAES review.
 *   webhook.dispatch   -> HTTPS POST to a host on the owner's list, signed with the kernel webhook scheme.
 *
 * Both: https only, fixed provider or allow-listed host, no redirects, a timeout, a size cap, the
 * proposal's idempotency key sent along, and the secret never in a result or an error.
 * There is deliberately no real `sanity.mutate`: a generic "apply this mutation" tool is too broad to
 * approve safely. Department changes already have their own narrow executor.
 */

export type HttpFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: 'error' }) => Promise<{ status: number; text(): Promise<string> }>

const TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 64 * 1024
const CONTROL = /[\u0000-\u001f\u007f]/

const objectOf = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})

async function send(fetcher: HttpFetch, label: string, url: string, headers: Record<string, string>, body: string): Promise<{ status: number; text: string }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetcher(url, { method: 'POST', headers, body, signal: controller.signal, redirect: 'error' })
    const text = (await res.text()).slice(0, MAX_RESPONSE_BYTES)
    return { status: res.status, text }
  } catch {
    throw new Error(`${label}: the request ${controller.signal.aborted ? 'timed out' : 'failed'}. It may or may not have been delivered.`)
  } finally { clearTimeout(timer) }
}

// ── Email (Resend) ─────────────────────────────────────────────────────────

export interface EmailAdapterOptions {
  apiKey: string
  from: string
  /** Exact addresses ("ops@example.com") or whole domains ("@example.com"). */
  recipients: readonly string[]
  fetcher?: HttpFetch
  apiUrl?: string
}

const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/

export function emailRecipientAllowed(to: string, allowed: readonly string[]): boolean {
  const address = to.trim().toLowerCase()
  if (!ADDRESS.test(address)) return false
  return allowed.some((entry) => {
    const e = entry.trim().toLowerCase()
    return e.startsWith('@') ? address.endsWith(e) && address.split('@').length === 2 : address === e
  })
}

function emailProblem(input: unknown, recipients: readonly string[]): string | undefined {
  const { to, subject, text } = objectOf(input)
  if (typeof to !== 'string' || !emailRecipientAllowed(to, recipients)) return 'to must be one address on the allowed recipients list.'
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 200 || CONTROL.test(subject)) return 'subject must be 1 to 200 characters on one line.'
  if (typeof text !== 'string' || !text.trim() || text.length > 5000) return 'text must be 1 to 5000 characters.'
  return undefined
}

export function resendNotificationTool(options: EmailAdapterOptions): ToolDefinition {
  if (!options.apiKey || !ADDRESS.test(options.from)) throw new Error('The email adapter needs an API key and a valid from address.')
  if (!options.recipients.length) throw new Error('The email adapter needs at least one allowed recipient.')
  const url = options.apiUrl ?? 'https://api.resend.com/emails'
  if (new URL(url).protocol !== 'https:') throw new Error('The email API url must be https.')
  const fetcher = options.fetcher ?? (globalThis.fetch as unknown as HttpFetch)
  return {
    manifest: { id: 'notification.send', contractVersion: 1, provider: 'resend', access: 'side-effect', requiresApproval: true, description: 'Email an operational notice to an allowed internal recipient.' },
    live: true,
    configDigest: sha256({ from: options.from, recipients: [...options.recipients].map((r) => r.toLowerCase()).sort(), url }),
    validate: (input) => emailProblem(input, options.recipients),
    run: async (call) => {
      const problem = emailProblem(call.input, options.recipients)
      if (problem) throw new Error(problem)
      const { to, subject, text } = call.input as { to: string; subject: string; text: string }
      const body = JSON.stringify({ from: options.from, to: [to.trim().toLowerCase()], subject: subject.trim(), text })
      const res = await send(fetcher, 'Resend', url, { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json', 'idempotency-key': call.idempotencyKey }, body)
      if (res.status < 200 || res.status >= 300) throw new Error(`Resend answered HTTP ${res.status}; the email was not sent.`)
      let id: string | undefined
      try { const parsed = JSON.parse(res.text) as { id?: unknown }; if (typeof parsed.id === 'string') id = parsed.id.slice(0, 100) } catch { /* the id is nice to have */ }
      return { executed: true, dryRun: false, provider: 'resend', to: to.trim().toLowerCase(), ...(id ? { messageId: id } : {}), inputDigest: sha256(call.input), idempotencyKey: call.idempotencyKey }
    },
  }
}

// ── Signed webhook ─────────────────────────────────────────────────────────

export type HostResolver = (hostname: string) => Promise<string[]>

export interface WebhookAdapterOptions {
  /** Exact hostnames. No wildcards, no IP addresses. */
  allowedHosts: readonly string[]
  /** At least 32 characters; the receiver verifies with the same secret. */
  signingSecret: string
  fetcher?: HttpFetch
  resolver?: HostResolver
  now?: () => number
}

const defaultResolver: HostResolver = async (hostname) => (await lookup(hostname, { all: true })).map((a) => a.address)

/** True for loopback, private, link-local, unique-local, unspecified and multicast addresses (IPv4 and IPv6). */
export function isPrivateAddress(address: string): boolean {
  const a = address.toLowerCase()
  if (isIP(a) === 4) {
    const [p, q] = a.split('.').map(Number) as [number, number]
    return p === 0 || p === 10 || p === 127 || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 100 && q >= 64 && q <= 127) || p >= 224
  }
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a)
  if (mapped) return isPrivateAddress(mapped[1]!)
  return a === '::' || a === '::1' || a.startsWith('fe80:') || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('ff')
}

function webhookProblem(input: unknown, allowedHosts: readonly string[]): string | undefined {
  const { url, payload, eventType } = objectOf(input)
  if (typeof url !== 'string') return 'url is required.'
  let parsed: URL
  try { parsed = new URL(url) } catch { return 'url is not a valid URL.' }
  if (parsed.protocol !== 'https:') return 'url must be https.'
  if (parsed.username || parsed.password) return 'url must not carry credentials.'
  if (parsed.port && parsed.port !== '443') return 'url must use the default https port.'
  if (isIP(parsed.hostname.replace(/^\[|\]$/g, '')) !== 0) return 'url must name a host, not an IP address.'
  if (!allowedHosts.includes(parsed.hostname.toLowerCase())) return 'url host is not on the allowed hosts list.'
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'payload must be an object.'
  if (Buffer.byteLength(JSON.stringify(payload)) > 16 * 1024) return 'payload is larger than 16384 bytes.'
  if (eventType !== undefined && (typeof eventType !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(eventType))) return 'eventType must be a short identifier.'
  return undefined
}

export function signedWebhookTool(options: WebhookAdapterOptions): ToolDefinition {
  if (options.signingSecret.length < 32) throw new Error('The webhook signing secret must be at least 32 characters.')
  const hosts = options.allowedHosts.map((h) => h.trim().toLowerCase())
  if (!hosts.length || hosts.some((h) => !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h) || h.includes('*') || isIP(h) !== 0)) throw new Error('allowedHosts must be exact hostnames.')
  const fetcher = options.fetcher ?? (globalThis.fetch as unknown as HttpFetch)
  const resolve = options.resolver ?? defaultResolver
  const now = options.now ?? Date.now
  return {
    manifest: { id: 'webhook.dispatch', contractVersion: 1, provider: 'http', access: 'side-effect', requiresApproval: true, description: 'Send a signed event payload to an allowed host.' },
    live: true,
    configDigest: sha256({ hosts: [...hosts].sort(), secret: createHash('sha256').update(options.signingSecret).digest('hex').slice(0, 12) }),
    validate: (input) => webhookProblem(input, hosts),
    run: async (call) => {
      const problem = webhookProblem(call.input, hosts)
      if (problem) throw new Error(problem)
      const { url, payload, eventType } = call.input as { url: string; payload: unknown; eventType?: string }
      const target = new URL(url)
      // The host is on the owner's list; still refuse it if it resolves somewhere private.
      let addresses: string[]
      try { addresses = await resolve(target.hostname) } catch { throw new Error('The host could not be resolved; nothing was sent.') }
      if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error('The host resolves to a private or reserved address; nothing was sent.')
      const body = JSON.stringify({ eventType: eventType ?? 'quicksilver.action', actionId: call.runId, payload })
      const timestamp = Math.floor(now() / 1000)
      const res = await send(fetcher, 'Webhook', target.href, {
        'content-type': 'application/json',
        'x-quicksilver-timestamp': String(timestamp),
        'x-quicksilver-signature': signWebhook(options.signingSecret, timestamp, body),
        'idempotency-key': call.idempotencyKey,
      }, body)
      if (res.status < 200 || res.status >= 300) throw new Error(`The receiver answered HTTP ${res.status}.`)
      return { executed: true, dryRun: false, provider: 'http', targetHost: target.hostname, status: res.status, payloadDigest: sha256(payload), idempotencyKey: call.idempotencyKey }
    },
  }
}
