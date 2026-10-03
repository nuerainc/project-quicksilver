/**
 * P-027 (commerce actions): proposals a human approves into Stripe product, price and
 * payment-link creation. Run with `npm run host:test`.
 *
 * Nothing here talks to Stripe. The host tests inject a fake client; the REST client is
 * driven with a fake `fetch` that records requests. A test-format key is never given to a
 * host without an injected client, so no test can reach the network.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateToken, type TokenPrincipalConfig } from '@quicksilver/kernel/identity/tokens'
import { validateGenesisConfig, type GenesisRunConfig } from '@quicksilver/kernel/playbooks/genesis'

import { parseHostConfig } from './config.ts'
import { MemoryGenesisStore } from './genesis-api.ts'
import { createStripeCommerceClient, parseCommerceProposal, StripeApiError, type StripeCommerceClient } from './genesis-commerce.ts'
import { FileCommerceProposalStore, MemoryCommerceProposalStore, type CommerceProposal } from './genesis-store.ts'
import { QuicksilverHost } from './host.ts'
import { Logger } from './log.ts'

const TENANT = 'nuera'
const T0 = Date.parse('2026-10-03T12:00:00Z')

const runConfig = (over: Partial<GenesisRunConfig> = {}): GenesisRunConfig => ({
  schemaVersion: 1,
  runId: 'genesis-test',
  playbookId: 'genesis',
  budgetUsd: 500,
  durationDays: 30,
  digitalOnly: true,
  allowedCategories: ['compute', 'hosting', 'advertising'],
  prohibitedCategories: ['inventory'],
  spend: { autoMaxUsd: 10, autoMaxRisk: 2, dailyCapUsd: 50 },
  waesRequired: true,
  waesManualReviewAllowed: true,
  commerceMode: 'test',
  prerequisites: { entityApproved: true, paymentAccounts: ['genesis-card'] },
  owner: 'entity-founder',
  ...over,
})

// ── Input ─────────────────────────────────────────────────────────────────

test('parseCommerceProposal: the three actions, their limits, and the exact customer-facing text', () => {
  const product = parseCommerceProposal({ action: 'create_product', name: '  Margin report ', description: ' In 48 hours. ' })
  assert.ok(product.ok)
  assert.deepEqual(product.input, { action: 'create_product', name: 'Margin report', description: 'In 48 hours.' })
  assert.equal(product.text, 'Margin report\nIn 48 hours.')
  const bare = parseCommerceProposal({ action: 'create_product', name: 'Margin report' })
  assert.ok(bare.ok && bare.text === 'Margin report')

  const price = parseCommerceProposal({ action: 'create_price', product: 'prod_ABC123', unitAmountCents: 4900 })
  assert.ok(price.ok && price.text === undefined, 'a price with no nickname shows customers no text')
  const nick = parseCommerceProposal({ action: 'create_price', product: 'proposal:cp-12345678-1234-1234-1234-123456789abc', unitAmountCents: 4900, nickname: 'Launch price' })
  assert.ok(nick.ok && nick.text === 'Launch price')

  const link = parseCommerceProposal({ action: 'create_payment_link', price: 'price_XYZ789', offerText: 'Buy the margin report for $49.' })
  assert.ok(link.ok)
  assert.deepEqual(link.input, { action: 'create_payment_link', price: 'price_XYZ789', quantity: 1, offerText: 'Buy the margin report for $49.' })
  assert.equal(link.text, 'Buy the margin report for $49.')

  const bad = (v: unknown) => { const r = parseCommerceProposal(v); assert.ok(!r.ok, JSON.stringify(v)); return r.ok ? '' : r.error }
  bad(null)
  bad({ action: 'refund_payment' })
  bad({ action: 'create_product', name: '' })
  bad({ action: 'create_product', name: 'x'.repeat(251) })
  bad({ action: 'create_product', name: 'ok', description: '' })
  bad({ action: 'create_price', product: 'cus_123', unitAmountCents: 4900 })
  bad({ action: 'create_price', product: 'prod_ABC', unitAmountCents: 49 })
  bad({ action: 'create_price', product: 'prod_ABC', unitAmountCents: 100_000_000 })
  bad({ action: 'create_price', product: 'prod_ABC', unitAmountCents: 49.5 })
  bad({ action: 'create_payment_link', price: 'prod_ABC', offerText: 'x' })
  bad({ action: 'create_payment_link', price: 'price_ABC' })
  bad({ action: 'create_payment_link', price: 'price_ABC', offerText: 'x', quantity: 0 })
  bad({ action: 'create_payment_link', price: 'price_ABC', offerText: 'x', quantity: 100 })
})

test('run config: commerceMode is off by default and only "off" or "test" validate (there is no live mode)', () => {
  assert.deepEqual(validateGenesisConfig(runConfig()), [])
  assert.deepEqual(validateGenesisConfig(runConfig({ commerceMode: 'off' })), [])
  const { commerceMode: _drop, ...none } = runConfig()
  assert.deepEqual(validateGenesisConfig(none as GenesisRunConfig), [])
  assert.ok(validateGenesisConfig(runConfig({ commerceMode: 'live' as never })).some((e) => e.includes('commerceMode')))
  assert.ok(validateGenesisConfig(runConfig({ commerceMode: true as never })).some((e) => e.includes('commerceMode')))
})

// ── The Stripe REST client ────────────────────────────────────────────────

interface Call { url: string; init: RequestInit; form: URLSearchParams }

function fakeFetch(respond: (call: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = []
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = { url: String(url), init: init ?? {}, form: new URLSearchParams(String(init?.body ?? '')) }
    calls.push(call)
    const r = respond(call)
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { impl, calls }
}

/** Fake keys are assembled at runtime so no Stripe-key-shaped literal sits in the source (push protection, and honesty: none is real). */
const fakeKey = (prefix: 'sk' | 'rk' | 'pk', mode: 'test' | 'live', tail = '0123456789abcdefABCDEF') => [prefix, mode, tail].join('_')
const TEST_KEY = fakeKey('sk', 'test')

test('Stripe client: refuses a live key, a malformed key and any mode but test, before any request', () => {
  const { impl, calls } = fakeFetch(() => ({ body: {} }))
  assert.throws(() => createStripeCommerceClient({ apiKey: fakeKey('sk', 'live'), mode: 'test', fetch: impl }), /Live keys are refused/)
  assert.throws(() => createStripeCommerceClient({ apiKey: fakeKey('rk', 'live'), mode: 'test', fetch: impl }), /Live keys are refused/)
  assert.throws(() => createStripeCommerceClient({ apiKey: fakeKey('pk', 'test'), mode: 'test', fetch: impl }), /not a test-mode/)
  assert.throws(() => createStripeCommerceClient({ apiKey: '', mode: 'test', fetch: impl }), /not a test-mode/)
  assert.throws(() => createStripeCommerceClient({ apiKey: TEST_KEY, mode: 'live' as never, fetch: impl }), /Only Stripe test mode/)
  assert.ok(createStripeCommerceClient({ apiKey: fakeKey('rk', 'test'), mode: 'test', fetch: impl }))
  assert.equal(calls.length, 0)
})

test('Stripe client: three create calls, form-encoded, with the idempotency key and the proposal id in metadata', async () => {
  const { impl, calls } = fakeFetch((c) => {
    if (c.url.endsWith('/products')) return { body: { id: 'prod_TEST1', livemode: false } }
    if (c.url.endsWith('/prices')) return { body: { id: 'price_TEST1', livemode: false } }
    return { body: { id: 'plink_TEST1', url: 'https://buy.stripe.com/test_abc', livemode: false } }
  })
  const client = createStripeCommerceClient({ apiKey: TEST_KEY, mode: 'test', fetch: impl })
  assert.deepEqual(await client.createProduct({ name: 'Margin report', description: 'In 48 hours.', proposalId: 'cp-1' }, 'qs-cp-1'), { id: 'prod_TEST1', livemode: false })
  assert.deepEqual(await client.createPrice({ product: 'prod_TEST1', unitAmountCents: 4900, nickname: 'Launch', proposalId: 'cp-2' }, 'qs-cp-2'), { id: 'price_TEST1', livemode: false })
  assert.deepEqual(await client.createPaymentLink({ price: 'price_TEST1', quantity: 2, proposalId: 'cp-3' }, 'qs-cp-3'), { id: 'plink_TEST1', url: 'https://buy.stripe.com/test_abc', livemode: false })

  assert.deepEqual(calls.map((c) => c.url), ['https://api.stripe.com/v1/products', 'https://api.stripe.com/v1/prices', 'https://api.stripe.com/v1/payment_links'])
  for (const [i, key] of ['qs-cp-1', 'qs-cp-2', 'qs-cp-3'].entries()) {
    const headers = calls[i]!.init.headers as Record<string, string>
    assert.equal(calls[i]!.init.method, 'POST')
    assert.equal(headers['idempotency-key'], key)
    assert.equal(headers.authorization, `Bearer ${TEST_KEY}`)
    assert.equal(headers['content-type'], 'application/x-www-form-urlencoded')
  }
  assert.equal(calls[0]!.form.get('name'), 'Margin report')
  assert.equal(calls[0]!.form.get('description'), 'In 48 hours.')
  assert.equal(calls[0]!.form.get('metadata[quicksilver_proposal]'), 'cp-1')
  assert.equal(calls[1]!.form.get('currency'), 'usd')
  assert.equal(calls[1]!.form.get('unit_amount'), '4900')
  assert.equal(calls[1]!.form.get('product'), 'prod_TEST1')
  assert.equal(calls[1]!.form.get('nickname'), 'Launch')
  assert.equal(calls[2]!.form.get('line_items[0][price]'), 'price_TEST1')
  assert.equal(calls[2]!.form.get('line_items[0][quantity]'), '2')
  assert.equal(calls[2]!.form.get('payment_intent_data[metadata][quicksilver_proposal]'), 'cp-3', 'a payment through the link is traceable to its proposal')
  // No other endpoint is ever used: nothing here can charge, refund, pay out or transfer.
  assert.ok(calls.every((c) => /\/(products|prices|payment_links)$/.test(c.url)))
})

test('Stripe client: API errors keep status, code and message but never the key; a live object or a malformed answer is refused', async () => {
  const err = fakeFetch(() => ({ status: 402, body: { error: { type: 'invalid_request_error', code: 'amount_too_small', message: 'Amount must be at least 50 cents.' } } }))
  const client = createStripeCommerceClient({ apiKey: TEST_KEY, mode: 'test', fetch: err.impl })
  await assert.rejects(client.createPrice({ product: 'prod_1', unitAmountCents: 50, proposalId: 'cp-1' }, 'k'), (e: unknown) => {
    assert.ok(e instanceof StripeApiError)
    assert.equal(e.status, 402)
    assert.equal(e.code, 'amount_too_small')
    assert.ok(!e.message.includes(TEST_KEY))
    return true
  })
  const live = createStripeCommerceClient({ apiKey: TEST_KEY, mode: 'test', fetch: fakeFetch(() => ({ body: { id: 'prod_L', livemode: true } })).impl })
  await assert.rejects(live.createProduct({ name: 'x', proposalId: 'cp-1' }, 'k'), /livemode is true, not false/)
  const noId = createStripeCommerceClient({ apiKey: TEST_KEY, mode: 'test', fetch: fakeFetch(() => ({ body: { livemode: false } })).impl })
  await assert.rejects(noId.createProduct({ name: 'x', proposalId: 'cp-1' }, 'k'), /without an id/)
  const noUrl = createStripeCommerceClient({ apiKey: TEST_KEY, mode: 'test', fetch: fakeFetch(() => ({ body: { id: 'plink_1', livemode: false } })).impl })
  await assert.rejects(noUrl.createPaymentLink({ price: 'price_1', quantity: 1, proposalId: 'cp-1' }, 'k'), /without a payment link URL/)
})

// ── Stores ────────────────────────────────────────────────────────────────

const proposal = (n: number, over: Partial<CommerceProposal> = {}): CommerceProposal => ({
  id: `cp-00000000-0000-0000-0000-${String(n).padStart(12, '0')}`,
  status: 'pending',
  input: { action: 'create_product', name: 'Report' },
  text: 'Report',
  proposedBy: 'agent-genesis',
  proposedByKind: 'agent',
  proposedAt: new Date(T0).toISOString(),
  mode: 'test',
  attempts: 0,
  ...over,
})

test('proposal stores (file and memory): upsert by id, tenant partitioned, valid ids only, file layout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-commerce-'))
  try {
    for (const make of [() => new FileCommerceProposalStore(dir, 'nuera'), () => new MemoryCommerceProposalStore('nuera')]) {
      const s = make()
      assert.deepEqual(await s.list('run-1'), [])
      await s.put('run-1', proposal(1))
      await s.put('run-1', proposal(2))
      await s.put('run-1', proposal(1, { status: 'executed', result: { stripeId: 'prod_1', livemode: false, executedAt: new Date(T0).toISOString() } }))
      const all = await s.list('run-1')
      assert.deepEqual(all.map((p) => [p.id.slice(-1), p.status]), [['1', 'executed'], ['2', 'pending']], 'put replaces in place and keeps order')
      assert.equal((await s.get('run-1', proposal(2).id))?.status, 'pending')
      assert.equal(await s.get('run-1', proposal(9).id), undefined)
      await assert.rejects(s.put('run-1', { ...proposal(3), id: 'not-a-proposal-id' }), /valid id/)
      await assert.rejects(s.list('../escape'), /Invalid run id/)
    }
    const other = new FileCommerceProposalStore(dir, 'other-tenant')
    assert.deepEqual(await other.list('run-1'), [], 'another tenant never sees these rows')
    const mem = new MemoryCommerceProposalStore('a')
    await mem.put('run-1', proposal(1))
    assert.deepEqual(await new MemoryCommerceProposalStore('b').list('run-1'), [])
    const file = join(dir, 'nuera', 'run-1', 'commerce-proposals.json')
    assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(file, 'utf8')).length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── HTTP: the full chain ──────────────────────────────────────────────────

function who(id: string, kind: 'human' | 'agent', roles: string[]): { config: TokenPrincipalConfig; token: string } {
  const { token, tokenDigest } = generateToken()
  return { token, config: { id, kind, tenantId: TENANT, roles, tokenDigest } }
}

interface FakeCall { method: 'createProduct' | 'createPrice' | 'createPaymentLink'; args: Record<string, unknown>; key: string }

function fakeClient(script: { failFirst?: number; delayMs?: number } = {}) {
  const calls: FakeCall[] = []
  let failures = script.failFirst ?? 0
  let n = 0
  const run = async <T>(method: FakeCall['method'], args: Record<string, unknown>, key: string, make: () => T): Promise<T> => {
    calls.push({ method, args, key })
    if (script.delayMs) await new Promise((r) => setTimeout(r, script.delayMs))
    if (failures > 0) { failures--; throw new StripeApiError(429, 'Rate limited, try again.', 'rate_limit_error', 'rate_limit') }
    n++
    return make()
  }
  const client: StripeCommerceClient = {
    mode: 'test',
    createProduct: (p, key) => run('createProduct', p, key, () => ({ id: `prod_FAKE${n}`, livemode: false })),
    createPrice: (p, key) => run('createPrice', p, key, () => ({ id: `price_FAKE${n}`, livemode: false })),
    createPaymentLink: (p, key) => run('createPaymentLink', p, key, () => ({ id: `plink_FAKE${n}`, url: `https://buy.stripe.com/test_fake${n}`, livemode: false })),
  }
  return { client, calls }
}

async function startHost(options: { config?: GenesisRunConfig; client?: StripeCommerceClient; commerce?: boolean; env?: Record<string, string> } = {}) {
  const founder = who('entity-founder', 'human', ['intent-provider'])
  const agent = who('agent-genesis', 'agent', ['agent-worker'])
  const viewer = who('entity-viewer', 'human', ['viewer'])
  const config = options.config ?? runConfig()
  const store = new MemoryGenesisStore(TENANT)
  const proposals = new MemoryCommerceProposalStore(TENANT)
  const auditDir = await mkdtemp(join(tmpdir(), 'qs-commerce-audit-'))
  const host = new QuicksilverHost(parseHostConfig({ tenantId: TENANT, http: { host: '127.0.0.1', port: 0 }, workflows: {}, services: [], webhooks: [] }), {
    principals: [founder.config, agent.config, viewer.config],
    env: { QUICKSILVER_AUTHORIZATION_AUDIT_PATH: join(auditDir, 'authorization.jsonl'), ...(options.env ?? {}) },
    logger: new Logger({ level: 'error', sink: { write: () => {} } }),
    now: () => T0,
    genesis: { config, store, vaultNames: async () => ['genesis-card'], ...(options.commerce === false ? {} : { commerce: { store: proposals, ...(options.client ? { client: async () => options.client! } : {}) } }) },
  })
  const { port } = await host.start()
  const base = `http://127.0.0.1:${port}`
  const call = (path: string, token: string, body?: unknown) => fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() as any }))
  const stop = async () => { await host.stop(); await rm(auditDir, { recursive: true, force: true }) }
  return { call, stop, proposals, config, tokens: { founder: founder.token, agent: agent.token, viewer: viewer.token } }
}

const C = '/api/genesis/commerce'
const PRODUCT = { action: 'create_product', name: 'Margin report', description: 'A feed-store margin report in 48 hours.' }
const PRODUCT_TEXT = 'Margin report\nA feed-store margin report in 48 hours.'

type Harness = Awaited<ReturnType<typeof startHost>>
/** The founder (a human, not the proposer) records a manual pass of the exact text. */
const review = (h: Harness, text: string) => h.call('/api/genesis/reviews', h.tokens.founder, { text, channel: 'offer-page', verdict: 'pass', note: 'Reads fine.' })
const propose = (h: Harness, body: unknown, token = h.tokens.agent) => h.call(`${C}/proposals`, token, body)
const approve = (h: Harness, id: string, token = h.tokens.founder) => h.call(`${C}/proposals/${id}/approve`, token, {})

test('commerce is off by default: nothing can be proposed or approved, and the client is never built', async () => {
  const { client, calls } = fakeClient()
  const { commerceMode: _drop, ...rest } = runConfig()
  const h = await startHost({ config: rest as GenesisRunConfig, client })
  try {
    const list = await h.call(C, h.tokens.viewer)
    assert.equal(list.status, 200)
    assert.equal(list.body.mode, 'off')
    assert.equal(list.body.enabled, false)
    const r = await propose(h, PRODUCT)
    assert.equal(r.status, 409)
    assert.match(r.body.error, /off/)
    assert.equal(r.body.executed, false)
    assert.deepEqual(await h.proposals.list(h.config.runId), [])
    assert.equal(calls.length, 0)
  } finally { await h.stop() }
})

test('routes: 404 when the host has no commerce store; list needs decision:read; propose needs a provider or proposer; approve and reject are humans only', async () => {
  const none = await startHost({ commerce: false })
  try { assert.equal((await none.call(C, none.tokens.viewer)).status, 404) } finally { await none.stop() }

  const { client, calls } = fakeClient()
  const h = await startHost({ client })
  try {
    assert.equal((await h.call(C, h.tokens.viewer)).status, 200)
    assert.equal((await h.call(C, h.tokens.agent)).status, 200)
    assert.equal((await propose(h, PRODUCT, h.tokens.viewer)).status, 403, 'a viewer cannot propose')
    const made = await propose(h, PRODUCT)
    assert.equal(made.status, 201, 'an agent can propose')
    const id = made.body.proposal.id as string
    assert.equal((await approve(h, id, h.tokens.agent)).status, 403, 'an agent cannot approve')
    assert.equal((await approve(h, id, h.tokens.viewer)).status, 403, 'a viewer cannot approve')
    assert.equal((await h.call(`${C}/proposals/${id}/reject`, h.tokens.agent, {})).status, 403, 'an agent cannot reject')
    assert.equal((await approve(h, 'cp-nope')).status, 404)
    assert.equal((await approve(h, 'cp-00000000-0000-0000-0000-000000000000')).status, 404)
    assert.equal((await h.call(`${C}/proposals/${id}/approve`, h.tokens.founder, { note: '' })).status, 422)
    assert.equal(calls.length, 0, 'nothing reached Stripe')
  } finally { await h.stop() }
})

test('propose: validates the body, stores a pending record, and reports whether the text would pass review', async () => {
  const { client, calls } = fakeClient()
  const h = await startHost({ client })
  try {
    assert.equal((await propose(h, { action: 'create_product' })).status, 422)
    assert.equal((await propose(h, { action: 'refund_payment', payment: 'pi_1' })).status, 422, 'there is no refund action')
    const made = await propose(h, PRODUCT)
    assert.equal(made.status, 201)
    assert.equal(made.body.executed, false)
    assert.equal(made.body.proposal.status, 'pending')
    assert.equal(made.body.proposal.proposedBy, 'agent-genesis')
    assert.equal(made.body.proposal.mode, 'test')
    assert.equal(made.body.proposal.text, PRODUCT_TEXT)
    assert.equal(made.body.review.passes, false)
    assert.ok(made.body.review.reason)
    const listed = await h.call(C, h.tokens.viewer)
    assert.equal(listed.body.open.length, 1)
    assert.equal(calls.length, 0)
    await review(h, PRODUCT_TEXT)
    const second = await propose(h, PRODUCT)
    assert.equal(second.body.review.passes, true, 'a later proposal of reviewed text shows it passes')
  } finally { await h.stop() }
})

test('approve: customer-facing text needs a passing review of its exact text; the Stripe call then happens once, with one idempotency key', async () => {
  const { client, calls } = fakeClient()
  const h = await startHost({ client })
  try {
    const id = (await propose(h, PRODUCT)).body.proposal.id as string
    const blocked = await approve(h, id)
    assert.equal(blocked.status, 409)
    assert.match(blocked.body.error, /no passing review/)
    assert.equal(blocked.body.executed, false)
    assert.equal(calls.length, 0, 'an unreviewed text never reaches Stripe')

    // A review of different text does not unlock it.
    await review(h, PRODUCT_TEXT + ' Now 50% off!')
    assert.equal((await approve(h, id)).status, 409)

    assert.equal((await review(h, PRODUCT_TEXT)).status, 201)
    const done = await approve(h, id)
    assert.equal(done.status, 200)
    assert.equal(done.body.executed, true)
    assert.equal(done.body.proposal.status, 'executed')
    assert.equal(done.body.proposal.decidedBy, 'entity-founder')
    assert.equal(done.body.proposal.result.stripeId, 'prod_FAKE1')
    assert.equal(done.body.proposal.result.livemode, false)
    assert.deepEqual(calls.map((c) => [c.method, c.key]), [['createProduct', `qs-${id}`]])
    assert.deepEqual(calls[0]!.args, { name: 'Margin report', description: 'A feed-store margin report in 48 hours.', proposalId: id })

    const again = await approve(h, id)
    assert.equal(again.status, 409, 'an executed proposal is not run twice')
    assert.equal(calls.length, 1)
    assert.equal((await h.call(`${C}/proposals/${id}/reject`, h.tokens.founder, {})).status, 409)
  } finally { await h.stop() }
})

test('approve: the proposer cannot be the reviewer of their own text (a human proposer is held to the same rule)', async () => {
  const { client, calls } = fakeClient()
  const h = await startHost({ client })
  try {
    const id = (await propose(h, PRODUCT, h.tokens.founder)).body.proposal.id as string
    await review(h, PRODUCT_TEXT) // the founder reviews their own proposal
    const r = await approve(h, id)
    assert.equal(r.status, 409)
    assert.equal(calls.length, 0)
  } finally { await h.stop() }
})

test('chain: a price and a payment link can name earlier proposals, and only once those have executed', async () => {
  const { client, calls } = fakeClient()
  const h = await startHost({ client })
  try {
    await review(h, PRODUCT_TEXT)
    const productId = (await propose(h, PRODUCT)).body.proposal.id as string
    const priceId = (await propose(h, { action: 'create_price', product: `proposal:${productId}`, unitAmountCents: 4900 })).body.proposal.id as string
    const offer = 'Buy the margin report for $49.'
    const linkId = (await propose(h, { action: 'create_payment_link', price: `proposal:${priceId}`, quantity: 1, offerText: offer })).body.proposal.id as string
    await review(h, offer)

    const early = await approve(h, priceId)
    assert.equal(early.status, 409, 'the product has not been created yet')
    assert.match(early.body.error, /executed create_product proposal first/)
    assert.equal(calls.length, 0)

    assert.equal((await approve(h, productId)).status, 200)
    const price = await approve(h, priceId)
    assert.equal(price.status, 200)
    assert.equal(price.body.proposal.result.stripeId, 'price_FAKE2')
    assert.equal(calls[1]!.args.product, 'prod_FAKE1', 'the proposal reference was resolved to the real Stripe id')
    assert.equal(calls[1]!.args.unitAmountCents, 4900)

    const link = await approve(h, linkId)
    assert.equal(link.status, 200)
    assert.equal(link.body.proposal.result.url, 'https://buy.stripe.com/test_fake3')
    assert.equal(calls[2]!.args.price, 'price_FAKE2')
    assert.deepEqual(calls.map((c) => c.method), ['createProduct', 'createPrice', 'createPaymentLink'])

    // A wrong kind of reference is refused too.
    const wrong = (await propose(h, { action: 'create_payment_link', price: `proposal:${productId}`, quantity: 1, offerText: offer })).body.proposal.id as string
    assert.equal((await approve(h, wrong)).status, 409)
    assert.equal(calls.length, 3)

    // A price on an existing Stripe product needs no review when it shows customers no text.
    const direct = (await propose(h, { action: 'create_price', product: 'prod_EXISTING1', unitAmountCents: 1500 })).body.proposal.id as string
    assert.equal((await approve(h, direct)).status, 200)
    assert.equal(calls[3]!.args.product, 'prod_EXISTING1')
  } finally { await h.stop() }
})

test('failures: a Stripe error leaves a failed record, a retry reuses the same idempotency key, and reject closes it', async () => {
  const { client, calls } = fakeClient({ failFirst: 1 })
  const h = await startHost({ client })
  try {
    await review(h, PRODUCT_TEXT)
    const id = (await propose(h, PRODUCT)).body.proposal.id as string
    const failed = await approve(h, id)
    assert.equal(failed.status, 502)
    assert.equal(failed.body.executed, false)
    assert.equal(failed.body.proposal.status, 'failed')
    assert.match(failed.body.proposal.error, /Stripe refused it \(429 rate_limit\)/)
    assert.equal(failed.body.proposal.attempts, 1)

    const retried = await approve(h, id)
    assert.equal(retried.status, 200)
    assert.equal(retried.body.proposal.status, 'executed')
    assert.equal(retried.body.proposal.attempts, 2)
    assert.equal(retried.body.proposal.error, undefined, 'a stale failure is cleared on success')
    assert.deepEqual(calls.map((c) => c.key), [`qs-${id}`, `qs-${id}`], 'the retry cannot create a duplicate: same idempotency key')

    const other = (await propose(h, { action: 'create_product', name: 'Other' })).body.proposal.id as string
    const rejected = await h.call(`${C}/proposals/${other}/reject`, h.tokens.founder, { note: 'Not now.' })
    assert.equal(rejected.status, 200)
    assert.equal(rejected.body.proposal.status, 'rejected')
    assert.equal(rejected.body.proposal.note, 'Not now.')
    assert.equal((await approve(h, other)).status, 409)
    assert.equal(calls.length, 2, 'rejecting sent nothing')
  } finally { await h.stop() }
})

test('concurrency: two simultaneous approvals call Stripe once', async () => {
  const { client, calls } = fakeClient({ delayMs: 50 })
  const h = await startHost({ client })
  try {
    await review(h, PRODUCT_TEXT)
    const id = (await propose(h, PRODUCT)).body.proposal.id as string
    const [a, b] = await Promise.all([approve(h, id), approve(h, id)])
    assert.deepEqual([a.status, b.status].sort(), [200, 409])
    assert.equal(calls.length, 1)
  } finally { await h.stop() }
})

test('client resolution: no key, or a live-format key, refuses with 503 and sends nothing; the key never appears in a response', async () => {
  const LIVE = fakeKey('sk', 'live', '0123456789abcdefSECRETVALUE')
  for (const env of [{}, { QUICKSILVER_GENESIS_STRIPE_API_KEY: LIVE }] as Record<string, string>[]) {
    const h = await startHost({ env }) // no injected client: the host resolves the key itself
    try {
      await review(h, PRODUCT_TEXT)
      const id = (await propose(h, PRODUCT)).body.proposal.id as string
      const r = await approve(h, id)
      assert.equal(r.status, 503)
      assert.equal(r.body.executed, false)
      assert.ok(!JSON.stringify(r.body).includes('SECRETVALUE'), 'the key is never echoed')
      assert.equal((await h.proposals.get(h.config.runId, id))?.status, 'pending', 'the proposal stays approvable once a valid test key is configured')
    } finally { await h.stop() }
  }
  const noKey = await startHost({ commerce: true })
  try {
    await review(noKey, PRODUCT_TEXT)
    const id = (await propose(noKey, PRODUCT)).body.proposal.id as string
    assert.match((await approve(noKey, id)).body.error, /could not be built/)
  } finally { await noKey.stop() }
})

test('run config turned off after a proposal was made: approval is refused', async () => {
  const { client, calls } = fakeClient()
  const on = await startHost({ client })
  try {
    await review(on, PRODUCT_TEXT)
    const id = (await propose(on, PRODUCT)).body.proposal.id as string
    const stored = (await on.proposals.get(on.config.runId, id))!
    const { commerceMode: _drop, ...rest } = runConfig()
    const off = await startHost({ config: rest as GenesisRunConfig, client })
    try {
      await off.proposals.put(off.config.runId, stored)
      await review(off, PRODUCT_TEXT)
      const r = await approve(off, id)
      assert.equal(r.status, 409)
      assert.match(r.body.error, /off/)
      assert.equal(calls.length, 0)
    } finally { await off.stop() }
  } finally { await on.stop() }
})
