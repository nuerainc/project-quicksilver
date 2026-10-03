/**
 * P-027 (recording side): Stripe webhook → Genesis money ledger. Run with `npm run host:test`.
 *
 * Nothing here talks to Stripe. Deliveries are signed locally with the same
 * construction Stripe uses (`Stripe-Signature: t=<ts>,v1=<hmac>`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateToken, type TokenPrincipalConfig } from '@quicksilver/kernel/identity/tokens'
import { verifyMoneyLedger } from '@quicksilver/kernel/playbooks/economics'
import type { GenesisRunConfig } from '@quicksilver/kernel/playbooks/genesis'
import { signStripeWebhook, type VerifiedWebhookDelivery } from '@quicksilver/kernel/triggers'

import { ConfigError, parseHostConfig } from './config.ts'
import { MemoryGenesisStore } from './genesis-api.ts'
import { genesisPaymentWebhookSink, mapStripeEvent, STRIPE_WEBHOOK_ACTOR } from './genesis-payment-webhook.ts'
import { FilePendingPaymentStore, MemoryPendingPaymentStore, PendingPaymentError, type PendingPaymentEntry } from './genesis-store.ts'
import { QuicksilverHost } from './host.ts'
import { Logger } from './log.ts'

const TENANT = 'nuera'
const SECRET = 'whsec_local_test_signing_secret_0123456789abcdef'
const T0 = Date.parse('2026-10-02T18:00:00Z')

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
  prerequisites: { entityApproved: true, paymentAccounts: ['genesis-card'] },
  owner: 'entity-founder',
  ...over,
})

const paymentIntentEvent = (over: { id?: string; pi?: string; cents?: number; currency?: string; livemode?: boolean } = {}) => ({
  id: over.id ?? 'evt_pi_1',
  object: 'event',
  type: 'payment_intent.succeeded',
  livemode: over.livemode ?? true,
  created: Math.floor(T0 / 1000) - 60,
  data: { object: { id: over.pi ?? 'pi_100', object: 'payment_intent', amount: over.cents ?? 4900, amount_received: over.cents ?? 4900, currency: over.currency ?? 'usd', status: 'succeeded' } },
})

const checkoutEvent = (over: { id?: string; pi?: string | null | { id: string }; cents?: number; paid?: boolean } = {}) => ({
  id: over.id ?? 'evt_cs_1',
  object: 'event',
  type: 'checkout.session.completed',
  livemode: true,
  created: Math.floor(T0 / 1000) - 30,
  data: { object: { id: 'cs_live_1', object: 'checkout.session', amount_total: over.cents ?? 4900, currency: 'usd', payment_status: over.paid === false ? 'unpaid' : 'paid', payment_intent: over.pi === undefined ? 'pi_100' : over.pi } },
})

const refundEvent = () => ({ id: 'evt_rf_1', type: 'charge.refunded', livemode: true, data: { object: { id: 'ch_1', amount_refunded: 4900, currency: 'usd', payment_intent: 'pi_100' } } })

const delivery = (payload: unknown): VerifiedWebhookDelivery => ({ endpointId: 'stripe', tenantId: TENANT, payload, deliveryId: 'sig:x', idempotencyKey: 'webhook:stripe:sig:x' })

// ── mapStripeEvent ────────────────────────────────────────────────────────

test('mapStripeEvent: payment_intent.succeeded and a paid checkout.session.completed map to revenue keyed by the PaymentIntent', () => {
  const pi = mapStripeEvent(paymentIntentEvent())
  assert.equal(pi.kind, 'record')
  if (pi.kind !== 'record') return
  assert.equal(pi.paymentRef, 'pi_100')
  assert.deepEqual(pi.input, {
    kind: 'revenue', amountUsd: 49, category: 'sales',
    description: 'Stripe payment pi_100 (payment_intent.succeeded, event evt_pi_1)',
    source: { type: 'payment-processor', ref: 'pi_100' },
    occurredAt: new Date(T0 - 60_000).toISOString(),
  })
  for (const event of [checkoutEvent(), checkoutEvent({ pi: { id: 'pi_100' } })]) {
    const cs = mapStripeEvent(event)
    assert.equal(cs.kind, 'record')
    if (cs.kind === 'record') {
      assert.equal(cs.paymentRef, 'pi_100', 'same payment, same key: the two events never double-count')
      assert.equal(cs.input.amountUsd, 49)
      assert.equal(cs.input.source.ref, 'pi_100')
    }
  }
  const upper = mapStripeEvent(paymentIntentEvent({ currency: 'USD', cents: 1 }))
  assert.equal(upper.kind === 'record' && upper.input.amountUsd, 0.01)
})

test('mapStripeEvent: refunds, test mode, unpaid or PaymentIntent-less sessions, and other types are ignored', () => {
  const cases: Array<[unknown, RegExp]> = [
    [refundEvent(), /no kind for money returned to a customer/],
    [paymentIntentEvent({ livemode: false }), /Test-mode/],
    [checkoutEvent({ paid: false }), /not paid yet/],
    [checkoutEvent({ pi: null }), /no PaymentIntent/],
    [{ id: 'evt_x', type: 'customer.created', livemode: true, data: { object: { id: 'cus_1' } } }, /not a payment this ledger records/],
    [{ id: 'evt_y', type: 'payment_intent.payment_failed', livemode: true, data: { object: { id: 'pi_9' } } }, /not a payment/],
  ]
  for (const [event, reason] of cases) {
    const r = mapStripeEvent(event)
    assert.equal(r.kind, 'ignored', JSON.stringify(event))
    if (r.kind === 'ignored') assert.match(r.reason, reason)
  }
})

test('mapStripeEvent: malformed events, non-USD currency and zero, negative or fractional amounts are invalid', () => {
  const base = paymentIntentEvent()
  const cases: unknown[] = [
    null, [], 'evt', {},
    { ...base, id: undefined },
    { ...base, id: '../evil' },
    { ...base, type: undefined },
    { ...base, data: undefined },
    { ...base, data: { object: null } },
    { ...base, livemode: undefined },
    paymentIntentEvent({ currency: 'eur' }),
    paymentIntentEvent({ cents: 0 }),
    paymentIntentEvent({ cents: -500 }),
    paymentIntentEvent({ cents: 10.5 }),
    paymentIntentEvent({ cents: 100_000_001 }),
    paymentIntentEvent({ pi: '' }),
    { ...base, data: { object: { ...base.data.object, amount: undefined, amount_received: undefined } } },
  ]
  for (const event of cases) assert.equal(mapStripeEvent(event).kind, 'invalid', JSON.stringify(event))
})

// ── genesisPaymentWebhookSink ─────────────────────────────────────────────

function sink(over: Partial<GenesisRunConfig> = {}) {
  const config = runConfig(over)
  const store = new MemoryGenesisStore()
  const pending = new MemoryPendingPaymentStore()
  return { config, store, pending, deliver: genesisPaymentWebhookSink({ config, store, pending, now: () => T0 }) }
}

test('sink (default, human confirms): a payment waits as one pending row and never touches the ledger', async () => {
  const { config, store, pending, deliver } = sink()
  const first = await deliver(delivery(paymentIntentEvent()))
  assert.equal(first.status, 202)
  assert.equal(first.body.pending, true)
  assert.equal(first.body.executed, false)
  // Stripe retry, and the Checkout event for the same payment: still one row.
  const retry = await deliver(delivery(paymentIntentEvent()))
  const sibling = await deliver(delivery(checkoutEvent()))
  for (const r of [retry, sibling]) { assert.equal(r.status, 200); assert.equal(r.body.deduplicated, true) }
  const rows = await pending.list(config.runId)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.id, 'pi_100')
  assert.equal(rows[0]!.eventId, 'evt_pi_1', 'the first event that reported it is kept')
  assert.equal(rows[0]!.status, 'pending')
  assert.equal((await store.load(config)).ledger.entries.length, 0)
})

test('sink (autoRecordPaymentWebhooks: true): records revenue once as the webhook service, deduplicated on the PaymentIntent', async () => {
  const { config, store, pending, deliver } = sink({ autoRecordPaymentWebhooks: true })
  const first = await deliver(delivery(checkoutEvent()))
  assert.equal(first.status, 201)
  assert.equal(first.body.recorded, true)
  assert.equal(first.body.seq, 1)
  assert.equal(first.body.executed, false)
  const again = [await deliver(delivery(checkoutEvent())), await deliver(delivery(paymentIntentEvent()))]
  for (const r of again) { assert.equal(r.status, 200); assert.equal(r.body.deduplicated, true); assert.equal(r.body.seq, 1) }
  const { ledger } = await store.load(config)
  assert.equal(ledger.entries.length, 1)
  assert.equal(ledger.entries[0]!.recordedBy, STRIPE_WEBHOOK_ACTOR.id)
  assert.equal(ledger.entries[0]!.kind, 'revenue')
  assert.equal(ledger.entries[0]!.amountUsd, 49)
  assert.ok(verifyMoneyLedger(ledger).valid)
  assert.equal((await pending.list(config.runId)).length, 0, 'auto mode never queues')
  // A second, different payment is a second entry.
  assert.equal((await deliver(delivery(paymentIntentEvent({ id: 'evt_pi_2', pi: 'pi_200', cents: 1500 })))).status, 201)
  assert.equal((await store.load(config)).ledger.entries.length, 2)
})

test('sink: concurrent deliveries of the same payment still record it once', async () => {
  const { config, store, deliver } = sink({ autoRecordPaymentWebhooks: true })
  const results = await Promise.all([deliver(delivery(paymentIntentEvent())), deliver(delivery(checkoutEvent())), deliver(delivery(paymentIntentEvent()))])
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 201])
  assert.equal((await store.load(config)).ledger.entries.length, 1)
})

test('sink: ignored events answer 200 so Stripe stops retrying; invalid ones 422; an invalid run config or broken ledger 503', async () => {
  const { config, store, pending, deliver } = sink({ autoRecordPaymentWebhooks: true })
  const ignored = await deliver(delivery(refundEvent()))
  assert.equal(ignored.status, 200)
  assert.equal(ignored.body.recorded, false)
  assert.equal(ignored.body.ignored, true)
  assert.equal((await deliver(delivery(paymentIntentEvent({ currency: 'gbp' })))).status, 422)
  assert.equal((await store.load(config)).ledger.entries.length, 0)
  assert.equal((await pending.list(config.runId)).length, 0)

  const bad = sink({ budgetUsd: -1 })
  assert.equal((await bad.deliver(delivery(paymentIntentEvent()))).status, 503)

  await deliver(delivery(paymentIntentEvent()))
  const s = await store.load(config)
  await store.saveLedger(config.runId, { ...s.ledger, entries: s.ledger.entries.map((e) => ({ ...e, amountUsd: 4_900 })) })
  const broken = await deliver(delivery(paymentIntentEvent({ id: 'evt_pi_3', pi: 'pi_300' })))
  assert.equal(broken.status, 503)
  assert.match(String(broken.body.error), /does not verify/)
})

// ── Pending stores ────────────────────────────────────────────────────────

const row = (id: string): PendingPaymentEntry => ({
  id, status: 'pending', provider: 'stripe', eventId: `evt_${id}`, eventType: 'payment_intent.succeeded', livemode: true, receivedAt: new Date(T0).toISOString(),
  input: { kind: 'revenue', amountUsd: 10, category: 'sales', description: 'x', source: { type: 'payment-processor', ref: id } },
})

test('pending stores (file and memory): idempotent put, decide once, tenant partitioned, file layout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-pending-'))
  try {
    for (const [a, b] of [[new FilePendingPaymentStore(dir, 'nuera'), new FilePendingPaymentStore(dir, 'other')], [new MemoryPendingPaymentStore('nuera'), new MemoryPendingPaymentStore('other')]] as const) {
      assert.equal((await a.putPending('run-1', row('pi_1'))).created, true)
      assert.equal((await a.putPending('run-1', { ...row('pi_1'), eventId: 'evt_other' })).created, false)
      assert.equal((await a.get('run-1', 'pi_1'))!.eventId, 'evt_pi_1')
      assert.equal((await b.list('run-1')).length, 0, 'another tenant sees nothing')
      const decided = await a.decide('run-1', 'pi_1', { status: 'confirmed', by: 'entity-founder', at: new Date(T0).toISOString(), ledgerSeq: 1 })
      assert.equal(decided.status, 'confirmed')
      assert.equal(decided.ledgerSeq, 1)
      await assert.rejects(a.decide('run-1', 'pi_1', { status: 'rejected', by: 'x', at: new Date(T0).toISOString() }), (e: unknown) => e instanceof PendingPaymentError && e.code === 'already-decided')
      await assert.rejects(a.decide('run-1', 'pi_404', { status: 'rejected', by: 'x', at: new Date(T0).toISOString() }), (e: unknown) => e instanceof PendingPaymentError && e.code === 'not-found')
      await assert.rejects(a.putPending('run-1', { ...row('pi_2'), status: 'confirmed' }))
      await assert.rejects(a.list('../escape'))
    }
    const onDisk = JSON.parse(await readFile(join(dir, 'nuera', 'run-1', 'pending-payments.json'), 'utf8'))
    assert.equal(onDisk.length, 1)
    assert.equal(onDisk[0].status, 'confirmed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── Host config ───────────────────────────────────────────────────────────

function problems(input: unknown): string[] {
  try { parseHostConfig(input); return [] } catch (error) { if (error instanceof ConfigError) return error.problems; throw error }
}

test('host config: a genesisPayment webhook needs scheme "stripe" and names no task or workflow; schemes are checked', () => {
  const base = { tenantId: TENANT, workflows: { brief: { schemaVersion: 1, id: 'brief', version: 1, entryNodeId: 's', nodes: [{ id: 's', kind: 'trigger', label: 'S' }, { id: 'o', kind: 'output', label: 'O' }], edges: [{ id: 'e', from: 's', to: 'o' }] } }, services: [{ id: 'svc:stripe', roles: ['trigger'] }] }
  const hook = { id: 'stripe-payments', secret: 'env:STRIPE_WEBHOOK_SECRET', principal: 'svc:stripe' }
  assert.deepEqual(problems({ ...base, webhooks: [{ ...hook, genesisPayment: true, scheme: 'stripe' }] }), [])
  assert.ok(problems({ ...base, webhooks: [{ ...hook, genesisPayment: true }] }).some((p) => p.includes('needs scheme "stripe"')))
  assert.ok(problems({ ...base, webhooks: [{ ...hook, genesisPayment: true, scheme: 'stripe', workflow: 'brief' }] }).some((p) => p.includes('names no task or workflow')))
  assert.ok(problems({ ...base, webhooks: [{ ...hook, genesisPayment: true, scheme: 'stripe', task: {} }] }).some((p) => p.includes('names no task or workflow')))
  assert.ok(problems({ ...base, webhooks: [{ ...hook, genesisPayment: 'yes', scheme: 'stripe' }] }).some((p) => p.includes('genesisPayment must be true')))
  assert.ok(problems({ ...base, webhooks: [{ ...hook, workflow: 'brief', scheme: 'paypal' }] }).some((p) => p.includes('scheme must be')))
  assert.deepEqual(problems({ ...base, webhooks: [{ ...hook, workflow: 'brief', scheme: 'stripe' }] }), [], 'a stripe-signed workflow webhook is allowed too')
})

// ── HTTP: routes and the full chain ───────────────────────────────────────

function who(id: string, kind: 'human' | 'agent', roles: string[]): { config: TokenPrincipalConfig; token: string } {
  const { token, tokenDigest } = generateToken()
  return { token, config: { id, kind, tenantId: TENANT, roles, tokenDigest } }
}

async function startHost(options: { config?: GenesisRunConfig; pending?: boolean; webhook?: boolean } = {}) {
  const founder = who('entity-founder', 'human', ['intent-provider'])
  const agent = who('agent-genesis', 'agent', ['agent-worker'])
  const viewer = who('entity-viewer', 'human', ['viewer'])
  const config = options.config ?? runConfig()
  const store = new MemoryGenesisStore(TENANT)
  const pending = new MemoryPendingPaymentStore(TENANT)
  const auditDir = await mkdtemp(join(tmpdir(), 'qs-payments-audit-'))
  const now = { t: T0 }
  const host = new QuicksilverHost(parseHostConfig({
    tenantId: TENANT,
    http: { host: '127.0.0.1', port: 0 },
    workflows: {},
    services: [{ id: 'svc:stripe', roles: ['trigger'] }],
    webhooks: options.webhook === false ? [] : [{ id: 'stripe-payments', genesisPayment: true, scheme: 'stripe', secret: 'env:STRIPE_WEBHOOK_SECRET', principal: 'svc:stripe' }],
  }), {
    principals: [founder.config, agent.config, viewer.config],
    env: { QUICKSILVER_AUTHORIZATION_AUDIT_PATH: join(auditDir, 'authorization.jsonl'), STRIPE_WEBHOOK_SECRET: SECRET },
    logger: new Logger({ level: 'error', sink: { write: () => {} } }),
    now: () => now.t,
    genesis: { config, store, vaultNames: async () => ['genesis-card'], ...(options.pending === false ? {} : { pending }) },
  })
  const { port } = await host.start()
  const base = `http://127.0.0.1:${port}`
  const call = (path: string, token: string, body?: unknown) => fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() as any }))
  /** POST a delivery exactly as Stripe would: raw JSON body, `Stripe-Signature` header, no bearer token. */
  const stripe = async (event: unknown, secret = SECRET) => {
    const raw = JSON.stringify(event)
    const ts = Math.floor(now.t / 1000)
    const r = await fetch(`${base}/webhooks/stripe-payments`, { method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8', 'stripe-signature': signStripeWebhook(secret, ts, raw) }, body: raw })
    now.t += 1_000 // each Stripe attempt is signed at a new time
    return { status: r.status, body: await r.json() as any }
  }
  const stop = async () => { await host.stop(); await rm(auditDir, { recursive: true, force: true }) }
  return { host, call, stripe, stop, store, pending, config, tokens: { founder: founder.token, agent: agent.token, viewer: viewer.token } }
}

const P = '/api/genesis/pending-payments'

test('end to end (default): a Stripe-signed delivery through the running host lands in pending; a human confirms it into the ledger', async () => {
  const { call, stripe, stop, store, config, tokens } = await startHost()
  try {
    const forged = await stripe(paymentIntentEvent(), 'whsec_forged_secret_forged_secret_forged_1234')
    assert.equal(forged.status, 401)

    const first = await stripe(paymentIntentEvent())
    assert.equal(first.status, 202)
    assert.equal(first.body.pending, true)
    assert.equal(first.body.executed, false)
    assert.equal((await stripe(checkoutEvent())).body.deduplicated, true)
    assert.equal((await stripe(refundEvent())).body.ignored, true)

    const list = await call(P, tokens.viewer)
    assert.equal(list.status, 200)
    assert.equal(list.body.autoRecord, false)
    assert.deepEqual(list.body.pending.map((r: PendingPaymentEntry) => [r.id, r.input.amountUsd]), [['pi_100', 49]])
    assert.equal((await store.load(config)).ledger.entries.length, 0, 'nothing reaches the ledger without a human')

    const confirmed = await call(`${P}/pi_100/confirm`, tokens.founder, { note: 'Matches the Stripe dashboard.' })
    assert.equal(confirmed.status, 201)
    assert.equal(confirmed.body.executed, false)
    assert.equal(confirmed.body.entry.recordedBy, 'entity-founder')
    assert.equal(confirmed.body.entry.source.ref, 'pi_100')
    assert.equal(confirmed.body.payment.status, 'confirmed')
    assert.equal(confirmed.body.payment.ledgerSeq, 1)
    assert.equal(confirmed.body.totals.revenueUsd, 49)

    assert.equal((await call(`${P}/pi_100/confirm`, tokens.founder, {})).status, 409, 'decided once')
    assert.equal((await call(`${P}/pi_100/reject`, tokens.founder, {})).status, 409)
    // A late Stripe retry after confirmation is a no-op: the payment is in the ledger.
    const late = await stripe(paymentIntentEvent())
    assert.equal(late.status, 200)
    assert.equal(late.body.deduplicated, true)
    assert.equal(late.body.seq, 1)
    const { ledger } = await store.load(config)
    assert.equal(ledger.entries.length, 1)
    assert.ok(verifyMoneyLedger(ledger).valid)
    const after = await call(P, tokens.viewer)
    assert.equal(after.body.pending.length, 0)
    assert.equal(after.body.decided[0].id, 'pi_100')
  } finally {
    await stop()
  }
})

test('end to end (autoRecordPaymentWebhooks: true): the delivery is recorded straight into the ledger, once', async () => {
  const { call, stripe, stop, store, config, tokens } = await startHost({ config: runConfig({ autoRecordPaymentWebhooks: true }) })
  try {
    const first = await stripe(checkoutEvent())
    assert.equal(first.status, 201)
    assert.equal(first.body.recorded, true)
    assert.equal((await stripe(paymentIntentEvent())).body.deduplicated, true)
    const { ledger } = await store.load(config)
    assert.equal(ledger.entries.length, 1)
    assert.equal(ledger.entries[0]!.recordedBy, STRIPE_WEBHOOK_ACTOR.id)
    assert.equal((await call(P, tokens.viewer)).body.pending.length, 0)
    const g = await call('/api/genesis', tokens.viewer)
    assert.equal(g.body.totals.revenueUsd, 49)
  } finally {
    await stop()
  }
})

test('pending-payment routes: list needs decision:read; confirm and reject need a human provider; 404 unknown; reject records nothing', async () => {
  const { call, stop, store, pending, config, tokens } = await startHost({ webhook: false })
  try {
    await pending.putPending(config.runId, row('pi_1'))
    await pending.putPending(config.runId, row('pi_2'))
    assert.equal((await call(P, tokens.viewer)).status, 200)
    assert.equal((await call(P, tokens.agent)).status, 200)
    assert.equal((await call(`${P}/pi_1/confirm`, tokens.viewer, {})).status, 403, 'a viewer cannot confirm')
    assert.equal((await call(`${P}/pi_1/confirm`, tokens.agent, {})).status, 403, 'an agent cannot confirm')
    assert.equal((await call(`${P}/pi_1/reject`, tokens.agent, {})).status, 403, 'an agent cannot reject')
    assert.equal((await call(`${P}/pi_404/confirm`, tokens.founder, {})).status, 404)
    assert.equal((await call(`${P}/pi_404/reject`, tokens.founder, {})).status, 404)
    assert.equal((await call(`${P}/pi_1/confirm`, tokens.founder, { note: '' })).status, 422)

    const rejected = await call(`${P}/pi_2/reject`, tokens.founder, { note: 'Duplicate of a manual entry.' })
    assert.equal(rejected.status, 200)
    assert.equal(rejected.body.payment.status, 'rejected')
    assert.equal(rejected.body.payment.decidedBy, 'entity-founder')
    assert.equal((await call(`${P}/pi_2/confirm`, tokens.founder, {})).status, 409)
    assert.equal((await store.load(config)).ledger.entries.length, 0)

    // A payment someone already recorded by hand through /money is not recorded twice.
    const manual = await call('/api/genesis/money', tokens.founder, { kind: 'revenue', amountUsd: 10, description: 'Recorded by hand', source: { type: 'payment-processor', ref: 'pi_1' } })
    assert.equal(manual.status, 201)
    const dup = await call(`${P}/pi_1/confirm`, tokens.founder, {})
    assert.equal(dup.status, 409)
    assert.match(dup.body.error, /already in the ledger/)
    assert.equal((await store.load(config)).ledger.entries.length, 1)
  } finally {
    await stop()
  }
})

test('host: a genesisPayment webhook without a pending store refuses to start; without one the routes answer 404', async () => {
  await assert.rejects(startHost({ pending: false }), /pending-payment store/)
  const { call, stop, tokens } = await startHost({ pending: false, webhook: false })
  try {
    assert.equal((await call(P, tokens.viewer)).status, 404)
  } finally {
    await stop()
  }
})
