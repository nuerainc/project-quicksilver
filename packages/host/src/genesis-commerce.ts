import { randomUUID } from 'node:crypto'

import type { GenesisRunConfig } from '@quicksilver/kernel/playbooks/genesis'

import type { GenesisStore } from './genesis-api.ts'
import { contentStatus } from './genesis-reviews.ts'
import { COMMERCE_PROPOSAL_ID, type CommerceProposal, type CommerceProposalInput, type CommerceProposalStore } from './genesis-store.ts'

/**
 * P-027 (commerce actions): ask Stripe to create a product, a price or a
 * payment link, only after a human approves.
 *
 * What this can do: those three create calls, nothing else. The client below
 * has no charge, refund, payout, transfer or customer call, and creating a
 * product, price or payment link moves no money. The money arrives later as a
 * payment, which the P-027 recording side (the signed webhook) puts in the
 * ledger.
 *
 * What stands in the way, in order:
 *   1. `commerceMode` in the run config is 'off' by default. Off means the
 *      routes refuse to propose or approve anything. The only other value is
 *      'test'; there is no live mode in v1.
 *   2. A proposal is a record, not an action. Anyone allowed to propose
 *      (including an agent) can add one; nothing is sent to Stripe.
 *   3. Approval is humans-only, the same boundary as the money routes.
 *   4. Customer-facing text (a product's name and description, a price's
 *      nickname, a payment link's offer text) needs a passing review of its
 *      exact text, under the run's WAES policy, at the moment of approval.
 *   5. The Stripe key is its own vault secret (`genesis-stripe-api`, never the
 *      webhook signing secret) and must be a test-mode key (sk_test_ or
 *      rk_test_). A live key is refused when the client is built.
 *
 * Each proposal carries one idempotency key, so a retry after a timeout
 * cannot create a second product, price or link.
 */

export const COMMERCE_KEY_VAULT_NAME = 'genesis-stripe-api'
const STRIPE_BASE = 'https://api.stripe.com/v1'
const STRIPE_TIMEOUT_MS = 15_000
const STALE_CLAIM_MS = 5 * 60_000
export const MIN_PRICE_CENTS = 50
export const MAX_PRICE_CENTS = 99_999_999
const PROPOSAL_REF = /^proposal:(cp-[0-9a-f-]{36})$/
const STRIPE_REF = { product: /^prod_[A-Za-z0-9]{1,60}$/, price: /^price_[A-Za-z0-9]{1,60}$/ } as const

// ── Stripe client ─────────────────────────────────────────────────────────

export interface StripeCommerceClient {
  readonly mode: 'test'
  createProduct(p: { name: string; description?: string; proposalId: string }, idempotencyKey: string): Promise<{ id: string; livemode: boolean }>
  createPrice(p: { product: string; unitAmountCents: number; nickname?: string; proposalId: string }, idempotencyKey: string): Promise<{ id: string; livemode: boolean }>
  createPaymentLink(p: { price: string; quantity: number; proposalId: string }, idempotencyKey: string): Promise<{ id: string; url: string; livemode: boolean }>
}

export class StripeApiError extends Error {
  readonly status: number
  readonly type?: string
  readonly code?: string
  constructor(status: number, message: string, type?: string, code?: string) {
    super(message)
    this.name = 'StripeApiError'
    this.status = status
    if (type !== undefined) this.type = type
    if (code !== undefined) this.code = code
  }
}

const TEST_KEY = /^(sk|rk)_test_[A-Za-z0-9]+$/

/** Form-encode flat and one-level-nested values the way Stripe expects (`a[b]=c`). */
function form(fields: Record<string, string | number | undefined>): string {
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) body.append(k, String(v))
  return body.toString()
}

export interface StripeRestOptions {
  apiKey: string
  mode: 'test'
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch
  baseUrl?: string
}

/** The only code in this repository that sends a write to Stripe. Three create calls, nothing else. */
export function createStripeCommerceClient(opts: StripeRestOptions): StripeCommerceClient {
  if (opts.mode !== 'test') throw new Error('Only Stripe test mode is supported.')
  if (!TEST_KEY.test(opts.apiKey)) throw new Error('The Stripe API key is not a test-mode secret or restricted key (expected sk_test_ or rk_test_). Live keys are refused.')
  const doFetch = opts.fetch ?? fetch
  const base = opts.baseUrl ?? STRIPE_BASE

  async function post(path: string, fields: Record<string, string | number | undefined>, idempotencyKey: string): Promise<Record<string, unknown>> {
    const res = await doFetch(`${base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': idempotencyKey },
      body: form(fields),
      signal: AbortSignal.timeout(STRIPE_TIMEOUT_MS),
    })
    let json: unknown
    try { json = await res.json() } catch { json = undefined }
    const obj = json && typeof json === 'object' ? (json as Record<string, unknown>) : {}
    if (!res.ok) {
      const e = obj.error && typeof obj.error === 'object' ? (obj.error as Record<string, unknown>) : {}
      throw new StripeApiError(res.status, typeof e.message === 'string' ? e.message.slice(0, 300) : `Stripe answered ${res.status}.`, typeof e.type === 'string' ? e.type : undefined, typeof e.code === 'string' ? e.code : undefined)
    }
    if (typeof obj.id !== 'string') throw new StripeApiError(res.status, 'Stripe answered without an id.')
    // A test key must create test objects; anything else is refused loudly.
    if (obj.livemode !== false) throw new StripeApiError(res.status, `Stripe created an object whose livemode is ${String(obj.livemode)}, not false.`)
    return obj
  }

  return {
    mode: opts.mode,
    async createProduct(p, key) {
      const o = await post('/products', { name: p.name, description: p.description, 'metadata[quicksilver_proposal]': p.proposalId }, key)
      return { id: o.id as string, livemode: o.livemode as boolean }
    },
    async createPrice(p, key) {
      const o = await post('/prices', { currency: 'usd', unit_amount: p.unitAmountCents, product: p.product, nickname: p.nickname, 'metadata[quicksilver_proposal]': p.proposalId }, key)
      return { id: o.id as string, livemode: o.livemode as boolean }
    },
    async createPaymentLink(p, key) {
      const o = await post('/payment_links', {
        'line_items[0][price]': p.price,
        'line_items[0][quantity]': p.quantity,
        'metadata[quicksilver_proposal]': p.proposalId,
        'payment_intent_data[metadata][quicksilver_proposal]': p.proposalId,
      }, key)
      if (typeof o.url !== 'string') throw new StripeApiError(200, 'Stripe answered without a payment link URL.')
      return { id: o.id as string, url: o.url, livemode: o.livemode as boolean }
    },
  }
}

// ── Input ─────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max

export function parseCommerceProposal(value: unknown): { ok: true; input: CommerceProposalInput; text?: string } | { ok: false; error: string } {
  if (!isObj(value)) return { ok: false, error: 'The body must be a JSON object.' }
  const b = value
  const ref = (v: unknown, kind: 'product' | 'price'): string | undefined =>
    typeof v === 'string' && (STRIPE_REF[kind].test(v) || PROPOSAL_REF.test(v)) ? v : undefined
  if (b.action === 'create_product') {
    if (!str(b.name, 250)) return { ok: false, error: 'name must be 1 to 250 characters.' }
    if (b.description !== undefined && !str(b.description, 1_000)) return { ok: false, error: 'description must be 1 to 1,000 characters.' }
    const name = b.name.trim()
    const description = typeof b.description === 'string' ? b.description.trim() : undefined
    return { ok: true, input: { action: 'create_product', name, ...(description ? { description } : {}) }, text: description ? `${name}\n${description}` : name }
  }
  if (b.action === 'create_price') {
    const product = ref(b.product, 'product')
    if (!product) return { ok: false, error: 'product must be a Stripe product id (prod_...) or "proposal:<id>".' }
    if (typeof b.unitAmountCents !== 'number' || !Number.isInteger(b.unitAmountCents) || b.unitAmountCents < MIN_PRICE_CENTS || b.unitAmountCents > MAX_PRICE_CENTS) return { ok: false, error: `unitAmountCents must be a whole number of cents from ${MIN_PRICE_CENTS} to ${MAX_PRICE_CENTS}. Prices are in USD.` }
    if (b.nickname !== undefined && !str(b.nickname, 250)) return { ok: false, error: 'nickname must be 1 to 250 characters.' }
    const nickname = typeof b.nickname === 'string' ? b.nickname.trim() : undefined
    return { ok: true, input: { action: 'create_price', product, unitAmountCents: b.unitAmountCents, ...(nickname ? { nickname } : {}) }, ...(nickname ? { text: nickname } : {}) }
  }
  if (b.action === 'create_payment_link') {
    const price = ref(b.price, 'price')
    if (!price) return { ok: false, error: 'price must be a Stripe price id (price_...) or "proposal:<id>".' }
    const quantity = b.quantity === undefined ? 1 : b.quantity
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) return { ok: false, error: 'quantity must be a whole number from 1 to 99.' }
    if (!str(b.offerText, 2_000)) return { ok: false, error: 'offerText must be 1 to 2,000 characters: the exact text a customer will see with this link.' }
    const offerText = b.offerText.trim()
    return { ok: true, input: { action: 'create_payment_link', price, quantity, offerText }, text: offerText }
  }
  return { ok: false, error: 'action must be "create_product", "create_price" or "create_payment_link".' }
}

// ── Routes ────────────────────────────────────────────────────────────────

type Response = { status: number; body: unknown }

export interface CommerceDeps {
  store: CommerceProposalStore
  /** Builds the Stripe client when an approval needs it (the host reads the vault key then). Absent means no key is configured. */
  client?: () => Promise<StripeCommerceClient>
}

export interface CommerceRouteContext {
  method: string
  parts: string[]
  principal: { id: string; kind: string }
  config: GenesisRunConfig
  store: GenesisStore
  commerce: CommerceDeps
  needRead(): Response | undefined
  needPropose(): Response | undefined
  humanOnly(what: string): Response | undefined
  bodyOf(): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; res: Response }>
  now(): Date
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>
}

const OFF = 'Commerce actions are off for this run (commerceMode is not "test"). Nothing was sent to Stripe.'
const NOTHING_MOVES = 'Creates a product, price or payment link only. No charge, refund or transfer exists in this path.'

function claimIsStale(p: CommerceProposal, now: Date): boolean {
  return p.status === 'executing' && p.claimedAt !== undefined && now.getTime() - Date.parse(p.claimedAt) > STALE_CLAIM_MS
}

export async function handleCommerceRoute(ctx: CommerceRouteContext): Promise<Response | undefined> {
  const { method, parts, config, commerce, principal } = ctx
  if (parts[2] !== 'commerce') return undefined
  const mode: 'off' | 'test' = config.commerceMode === 'test' ? 'test' : 'off'
  const runId = config.runId

  // GET /api/genesis/commerce
  if (parts.length === 3 && method === 'GET') {
    const denied = ctx.needRead()
    if (denied) return denied
    const rows = await commerce.store.list(runId)
    const open = (r: CommerceProposal) => r.status === 'pending' || r.status === 'executing' || r.status === 'failed'
    return { status: 200, body: { mode, enabled: mode !== 'off', open: rows.filter(open), decided: rows.filter((r) => !open(r)).slice(-50).reverse(), note: NOTHING_MOVES } }
  }

  // POST /api/genesis/commerce/proposals
  if (parts.length === 4 && parts[3] === 'proposals' && method === 'POST') {
    const denied = ctx.needPropose()
    if (denied) return denied
    if (mode === 'off') return { status: 409, body: { error: OFF, executed: false } }
    const body = await ctx.bodyOf()
    if (!body.ok) return body.res
    const parsed = parseCommerceProposal(body.value)
    if (!parsed.ok) return { status: 422, body: { error: parsed.error, executed: false } }
    const at = ctx.now()
    const proposal: CommerceProposal = {
      id: `cp-${randomUUID()}`,
      status: 'pending',
      input: parsed.input,
      ...(parsed.text !== undefined ? { text: parsed.text } : {}),
      proposedBy: principal.id,
      proposedByKind: principal.kind,
      proposedAt: at.toISOString(),
      mode,
      attempts: 0,
    }
    const reviews = parsed.text !== undefined ? await ctx.store.loadReviews(runId) : []
    const gate = parsed.text !== undefined ? contentStatus(config, reviews, parsed.text, principal.id) : undefined
    if (gate) proposal.contentDigest = gate.contentDigest
    await ctx.withLock(runId, () => commerce.store.put(runId, proposal))
    return {
      status: 201,
      body: {
        proposal,
        ...(gate ? { review: { passes: gate.passes, ...(gate.reason ? { reason: gate.reason } : {}), contentDigest: gate.contentDigest } } : {}),
        executed: false,
        note: 'A proposal only. Nothing was sent to Stripe; a human approves it, and customer-facing text needs a passing review first.',
      },
    }
  }

  // POST /api/genesis/commerce/proposals/:id/(approve|reject)
  if (parts.length === 6 && parts[3] === 'proposals' && (parts[5] === 'approve' || parts[5] === 'reject') && method === 'POST') {
    const approving = parts[5] === 'approve'
    const denied = ctx.humanOnly(approving ? 'approves a commerce action' : 'rejects a commerce proposal')
    if (denied) return denied
    const id = parts[4]!
    if (!COMMERCE_PROPOSAL_ID.test(id)) return { status: 404, body: { error: 'Unknown commerce proposal.' } }
    const body = await ctx.bodyOf()
    if (!body.ok) return body.res
    const note = body.value.note
    if (note !== undefined && !str(note, 500)) return { status: 422, body: { error: 'note must be 1 to 500 characters.' } }
    const noteField = typeof note === 'string' ? { note: note.trim() } : {}

    if (!approving) {
      return ctx.withLock(runId, async () => {
        const p = await commerce.store.get(runId, id)
        if (!p) return { status: 404, body: { error: `No commerce proposal "${id}".` } }
        if (p.status !== 'pending' && p.status !== 'failed') return { status: 409, body: { error: `Proposal "${id}" is ${p.status} and cannot be rejected.`, proposal: p, executed: false } }
        const rejected: CommerceProposal = { ...p, status: 'rejected', decidedBy: principal.id, decidedAt: ctx.now().toISOString(), ...noteField }
        await commerce.store.put(runId, rejected)
        return { status: 200, body: { proposal: rejected, executed: false } }
      })
    }

    // Phase 1, under the lock: every check, then claim the proposal so a second approval cannot run it too.
    const claimed = await ctx.withLock(runId, async (): Promise<Response | { proposal: CommerceProposal; client: StripeCommerceClient; product?: string; price?: string }> => {
      const p = await commerce.store.get(runId, id)
      if (!p) return { status: 404, body: { error: `No commerce proposal "${id}".` } }
      const at = ctx.now()
      if (p.status !== 'pending' && p.status !== 'failed' && !claimIsStale(p, at)) return { status: 409, body: { error: `Proposal "${id}" is ${p.status}.`, proposal: p, executed: false } }
      if (mode === 'off') return { status: 409, body: { error: OFF, executed: false } }
      if (p.text !== undefined) {
        const gate = contentStatus(config, await ctx.store.loadReviews(runId), p.text, p.proposedBy)
        if (!gate.passes) return { status: 409, body: { error: `The customer-facing text has no passing review: ${gate.reason ?? 'review it first.'}`, review: { passes: false, contentDigest: gate.contentDigest }, executed: false } }
      }
      const resolved: { product?: string; price?: string } = {}
      const input = p.input
      const wanted = input.action === 'create_price' ? ['product', input.product] as const : input.action === 'create_payment_link' ? ['price', input.price] as const : undefined
      if (wanted) {
        const m = PROPOSAL_REF.exec(wanted[1])
        if (m) {
          const dep = await commerce.store.get(runId, m[1]!)
          const needs = wanted[0] === 'product' ? 'create_product' : 'create_price'
          if (!dep || dep.input.action !== needs || dep.status !== 'executed' || !dep.result) return { status: 409, body: { error: `${wanted[1]} must be an executed ${needs} proposal first.`, executed: false } }
          resolved[wanted[0]] = dep.result.stripeId
        } else resolved[wanted[0]] = wanted[1]
      }
      if (!commerce.client) return { status: 503, body: { error: `No Stripe API key is configured (vault secret "${COMMERCE_KEY_VAULT_NAME}"). Nothing was sent to Stripe.`, executed: false } }
      let client: StripeCommerceClient
      try { client = await commerce.client() } catch (error) {
        return { status: 503, body: { error: `The Stripe client could not be built: ${(error as Error).message}`, executed: false } }
      }
      const next: CommerceProposal = { ...p, status: 'executing', claimedAt: at.toISOString(), decidedBy: principal.id, decidedAt: at.toISOString(), attempts: p.attempts + 1, ...noteField }
      delete (next as { error?: string }).error
      await commerce.store.put(runId, next)
      return { proposal: next, client, ...resolved }
    })
    if ('status' in claimed && 'body' in claimed) return claimed

    // Phase 2, outside the lock: the one Stripe call. The idempotency key makes a retry safe.
    const { proposal, client } = claimed as { proposal: CommerceProposal; client: StripeCommerceClient; product?: string; price?: string }
    const key = `qs-${proposal.id}`
    const resolved = claimed as { product?: string; price?: string }
    let outcome: { stripeId: string; url?: string; livemode: boolean } | { error: string }
    try {
      const input = proposal.input
      if (input.action === 'create_product') {
        const r = await client.createProduct({ name: input.name, ...(input.description ? { description: input.description } : {}), proposalId: proposal.id }, key)
        outcome = { stripeId: r.id, livemode: r.livemode }
      } else if (input.action === 'create_price') {
        const r = await client.createPrice({ product: resolved.product!, unitAmountCents: input.unitAmountCents, ...(input.nickname ? { nickname: input.nickname } : {}), proposalId: proposal.id }, key)
        outcome = { stripeId: r.id, livemode: r.livemode }
      } else {
        const r = await client.createPaymentLink({ price: resolved.price!, quantity: input.quantity, proposalId: proposal.id }, key)
        outcome = { stripeId: r.id, url: r.url, livemode: r.livemode }
      }
    } catch (error) {
      outcome = { error: error instanceof StripeApiError ? `Stripe refused it (${error.status}${error.code ? ` ${error.code}` : ''}): ${error.message}` : `The Stripe call failed: ${(error as Error).name}.` }
    }

    return ctx.withLock(runId, async () => {
      const at = ctx.now().toISOString()
      if ('error' in outcome) {
        const failed: CommerceProposal = { ...proposal, status: 'failed', error: outcome.error }
        await commerce.store.put(runId, failed)
        return { status: 502, body: { proposal: failed, executed: false, error: outcome.error, note: 'Approve it again to retry; the same idempotency key is reused, so it cannot create a duplicate.' } }
      }
      const done: CommerceProposal = { ...proposal, status: 'executed', result: { ...outcome, executedAt: at } }
      await commerce.store.put(runId, done)
      return { status: 200, body: { proposal: done, executed: true, note: NOTHING_MOVES } }
    })
  }

  return undefined
}
