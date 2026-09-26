/** Genesis run on the host (M5). Run with `npm run host:test`. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MemoryIntentGraphStore, MemoryLedgerStore } from '@quicksilver/aura'
import { generateToken, type TokenPrincipalConfig } from '@quicksilver/kernel/identity/tokens'
import type { ExperimentDefinition } from '@quicksilver/kernel/playbooks/economics'
import type { GenesisRunConfig } from '@quicksilver/kernel/playbooks/genesis'

import { parseHostConfig } from './config.ts'
import { FileGenesisStore, MemoryGenesisStore, type GenesisStore } from './genesis-api.ts'
import { QuicksilverHost } from './host.ts'
import { Logger } from './log.ts'

const TENANT = 'nuera'
function who(id: string, kind: 'human' | 'agent', roles: string[]): { config: TokenPrincipalConfig; token: string } {
  const { token, tokenDigest } = generateToken()
  return { token, config: { id, kind, tenantId: TENANT, roles, tokenDigest } }
}

const runConfig = (over: Partial<GenesisRunConfig['prerequisites']> = {}): GenesisRunConfig => ({
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
  prerequisites: { entityApproved: true, paymentAccounts: ['genesis-card'], ...over },
  owner: 'entity-founder',
})

const definition = (id = 'exp-landing', over: Partial<ExperimentDefinition> = {}) => ({
  id,
  hypothesis: 'If we publish a landing page, return on capital reaches 1.0 within 14 days.',
  playbookId: 'genesis',
  metric: { id: 'roc', label: 'Return on capital', direction: 'higher-is-better', kill: 0.1, hold: 0.5, scale: 1 },
  budgetUsd: 100,
  durationDays: 14,
  customerFacing: false,
  ...over,
})

async function start(options: { config?: GenesisRunConfig; vault?: string[]; store?: GenesisStore; genesis?: boolean } = {}) {
  const founder = who('entity-founder', 'human', ['intent-provider'])
  const agent = who('agent-genesis', 'agent', ['agent-worker'])
  const viewer = who('entity-viewer', 'human', ['viewer'])
  const graphs = new MemoryIntentGraphStore()
  const store = options.store ?? new MemoryGenesisStore()
  const host = new QuicksilverHost(parseHostConfig({ tenantId: TENANT, http: { host: '127.0.0.1', port: 0 }, workflows: {} }), {
    principals: [founder.config, agent.config, viewer.config],
    logger: new Logger({ level: 'error', sink: { write: () => {} } }),
    intent: { graphs, ledger: new MemoryLedgerStore() },
    ...(options.genesis === false ? {} : { genesis: { config: options.config ?? runConfig(), store, vaultNames: async () => options.vault ?? ['genesis-card'] } }),
  })
  const { port } = await host.start()
  const call = (path: string, token: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() as any }))
  return { host, call, store, port, tokens: { founder: founder.token, agent: agent.token, viewer: viewer.token } }
}

const E = '/api/genesis/experiments'

test('permissions: read needs decision:read; drafting takes a provider or an agent; starting and money need a human provider', async () => {
  const { host, call, port, tokens } = await start()
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/genesis`)).status, 401)
    const read = await call('/api/genesis', tokens.viewer)
    assert.equal(read.status, 200)
    assert.equal(read.body.executes, false)
    assert.deepEqual(read.body.blockers, [])
    assert.equal(read.body.totals.remainingUsd, 500)

    assert.equal((await call(E, tokens.viewer, { definition: definition() })).status, 403)
    const drafted = await call(E, tokens.agent, { definition: definition() })
    assert.equal(drafted.status, 201)
    assert.equal(drafted.body.experiment.status, 'draft')
    assert.equal(drafted.body.experiment.definition.proposedBy, 'agent-genesis', 'proposedBy is the caller, never the body')
    assert.equal((await call(E, tokens.founder, { definition: definition() })).status, 409, 'a changed experiment needs a new id')

    assert.equal((await call(`${E}/exp-landing/start`, tokens.agent, {})).status, 403)
    assert.equal((await call(`${E}/exp-landing/start`, tokens.viewer, {})).status, 403)
    assert.equal((await call('/api/genesis/money', tokens.agent, { kind: 'revenue', amountUsd: 5, description: 'x', source: { type: 'bank', ref: 'b1' } })).status, 403)
    assert.equal((await call(`${E}/exp-landing/decide`, tokens.agent, {})).status, 403)
    assert.equal((await call(`${E}/exp-landing/evaluate`, tokens.viewer, {})).status, 409, 'anyone who can read may ask for an evaluation (a draft has nothing to evaluate)')
  } finally { await host.stop() }

  const off = await start({ genesis: false })
  try { assert.equal((await off.call('/api/genesis', off.tokens.viewer)).status, 404) } finally { await off.host.stop() }
})

test('blockers are listed and refuse a start', async () => {
  const { host, call, tokens } = await start({ config: runConfig({ entityApproved: false }), vault: [] })
  try {
    const read = await call('/api/genesis', tokens.viewer)
    assert.equal(read.body.blockers.length, 2)
    assert.match(read.body.blockers.join(' '), /legal entity/)
    assert.match(read.body.blockers.join(' '), /"genesis-card" is not in the vault/)
    await call(E, tokens.founder, { definition: definition() })
    const s = await call(`${E}/exp-landing/start`, tokens.founder, {})
    assert.equal(s.status, 409)
    assert.equal(s.body.blockers.length, 2)
    assert.equal((await call('/api/genesis', tokens.viewer)).body.experiments[0].status, 'draft')
    assert.equal((await call('/api/genesis', tokens.viewer)).body.run.startedAt, null)
  } finally { await host.stop() }
})

test('kill applies automatically, as the kernel', async () => {
  const { host, call, tokens } = await start()
  try {
    await call(E, tokens.founder, { definition: definition() })
    const started = await call(`${E}/exp-landing/start`, tokens.founder, {})
    assert.equal(started.status, 200)
    assert.equal(started.body.experiment.status, 'running')
    assert.ok((await call('/api/genesis', tokens.viewer)).body.run.startedAt)

    assert.equal((await call(`${E}/exp-landing/evaluate`, tokens.viewer, {})).body.evaluation.verdict, 'no-data')
    assert.equal((await call(`${E}/exp-landing/measurements`, tokens.agent, { value: 0.05, source: 'ledger totals, day 3' })).status, 201)
    const ev = await call(`${E}/exp-landing/evaluate`, tokens.viewer, {})
    assert.equal(ev.status, 200)
    assert.equal(ev.body.evaluation.verdict, 'kill')
    assert.equal(ev.body.applied, 'killed')
    assert.equal(ev.body.appliedBy, 'kernel')
    assert.equal(ev.body.experiment.decisions[0].by, 'kernel')
    assert.match(ev.body.experiment.decisions[0].note, /entity-viewer/)
    assert.equal((await call(`${E}/exp-landing/measurements`, tokens.founder, { value: 2, source: 'late' })).status, 409)
    assert.equal((await call(`${E}/exp-landing/evaluate`, tokens.viewer, {})).status, 409)
  } finally { await host.stop() }
})

test('scale waits for a human decision', async () => {
  const { host, call, tokens } = await start()
  try {
    await call(E, tokens.founder, { definition: definition() })
    await call(`${E}/exp-landing/start`, tokens.founder, {})
    await call(`${E}/exp-landing/measurements`, tokens.founder, { value: 1.4, source: 'stripe payouts' })
    const ev = await call(`${E}/exp-landing/evaluate`, tokens.agent, {})
    assert.equal(ev.body.evaluation.verdict, 'scale')
    assert.equal(ev.body.applied, null)
    assert.equal(ev.body.awaitingDecision, true)
    const read = await call('/api/genesis', tokens.viewer)
    assert.equal(read.body.experiments[0].status, 'running')
    assert.equal(read.body.experiments[0].awaitingDecision, true)

    assert.equal((await call(`${E}/exp-landing/decide`, tokens.agent, {})).status, 403)
    assert.equal((await call(`${E}/exp-landing/decide`, tokens.founder, { note: 7 })).status, 422)
    const d = await call(`${E}/exp-landing/decide`, tokens.founder, { note: 'Double the ad budget.' })
    assert.equal(d.status, 200)
    assert.equal(d.body.applied, 'scaled')
    assert.equal(d.body.experiment.decisions[0].by, 'entity-founder')
    assert.equal(d.body.experiment.decisions[0].note, 'Double the ad budget.')
  } finally { await host.stop() }
})

test('money: rejected spends 422, founder decisions 409 until confirmed, and nothing is executed', async () => {
  const { host, call, tokens } = await start()
  try {
    await call(E, tokens.founder, { definition: definition() })
    await call(`${E}/exp-landing/start`, tokens.founder, {})
    const money = (body: Record<string, unknown>) => call('/api/genesis/money', tokens.founder, { kind: 'spend', amountUsd: 5, category: 'advertising', description: 'Ad test', source: { type: 'receipt', ref: 'r-1' }, experimentId: 'exp-landing', ...body })

    const rejected = await money({ category: 'inventory' })
    assert.equal(rejected.status, 422)
    assert.match(rejected.body.reasons.join(' '), /never allowed/)
    assert.equal(rejected.body.executed, false)

    const needs = await money({ experimentId: undefined, amountUsd: 20 })
    assert.equal(needs.status, 409)
    assert.match(needs.body.reasons.join(' '), /outside an experiment/)
    assert.match(needs.body.reasons.join(' '), /\$10 limit/)

    const confirmed = await money({ experimentId: undefined, amountUsd: 20, confirm: true })
    assert.equal(confirmed.status, 201)
    assert.equal(confirmed.body.executed, false)
    assert.equal(confirmed.body.approvedBy, 'entity-founder')
    assert.match(confirmed.body.note, /already moved/)

    const auto = await money({})
    assert.equal(auto.status, 201)
    assert.equal(auto.body.decision.recommendation, 'execute-autonomously')
    assert.equal((await call('/api/genesis/money', tokens.founder, { kind: 'compute', amountUsd: 2, description: 'Model usage', source: { type: 'provider-usage', ref: 'u-1' } })).status, 409, 'compute is capital, under the same rules')
    assert.equal((await call('/api/genesis/money', tokens.founder, { kind: 'revenue', amountUsd: 40, description: 'First sale', source: { type: 'payment-processor', ref: 'p-1' }, experimentId: 'exp-landing' })).status, 201)
    assert.equal((await money({ experimentId: 'no-such' })).status, 404)

    const read = await call('/api/genesis', tokens.viewer)
    assert.equal(read.body.totals.capitalUsedUsd, 25)
    assert.equal(read.body.totals.revenueUsd, 40)
    assert.equal(read.body.totals.remainingUsd, 475)
    assert.equal(read.body.ledger.entries, 3)
    assert.equal(read.body.ledger.verified.valid, true)
    assert.equal(read.body.experiments[0].spentUsd, 5)
    assert.equal(read.body.ledger.recent[0].seq, 3)
  } finally { await host.stop() }
})

test('the ledger is verified on read, and a broken chain stops further recording', async () => {
  const store = new MemoryGenesisStore()
  const { host, call, tokens } = await start({ store })
  try {
    const rev = (ref: string) => call('/api/genesis/money', tokens.founder, { kind: 'revenue', amountUsd: 10, description: 'Sale', source: { type: 'bank', ref } })
    const results = await Promise.all(['a', 'b', 'c', 'd'].map(rev))
    assert.deepEqual(results.map((r) => r.status), [201, 201, 201, 201])
    const ok = await call('/api/genesis', tokens.viewer)
    assert.equal(ok.body.ledger.entries, 4, 'concurrent writes do not lose each other')
    assert.equal(ok.body.ledger.verified.valid, true)

    const s = await store.load(runConfig())
    s.ledger.entries[1]!.amountUsd = 1_000
    await store.saveLedger('genesis-test', s.ledger)
    const bad = await call('/api/genesis', tokens.viewer)
    assert.equal(bad.body.ledger.verified.valid, false)
    assert.match(bad.body.ledger.verified.errors.join(' '), /altered/)
    assert.equal((await rev('e')).status, 409)
  } finally { await host.stop() }
})

test('input validation', async () => {
  const { host, call, port, tokens } = await start()
  try {
    const bad = async (path: string, body: unknown) => (await call(path, tokens.founder, body)).status
    assert.equal(await bad(E, {}), 422)
    assert.equal(await bad(E, { definition: definition('bad id!') }), 422)
    assert.equal(await bad(E, { definition: { ...definition(), hypothesis: 42 } }), 422)
    assert.equal(await bad(E, { definition: definition('x', { playbookId: 'other' }) }), 422)
    assert.equal(await bad(E, { definition: definition('x', { durationDays: 0 }) }), 422)
    assert.equal(await bad(E, { definition: { ...definition('x'), metric: { ...definition().metric, kill: 2 } } }), 422, 'thresholds out of order')
    assert.equal(await bad(E, { definition: { ...definition('x'), metric: { ...definition().metric, direction: 'up' } } }), 422)

    await call(E, tokens.founder, { definition: definition() })
    await call(`${E}/exp-landing/start`, tokens.founder, {})
    assert.equal(await bad(`${E}/exp-landing/measurements`, { value: 'high', source: 's' }), 422)
    assert.equal(await bad(`${E}/exp-landing/measurements`, { value: 1 }), 422)
    assert.equal(await bad(`${E}/exp-landing/measurements`, { value: 1, source: '   ' }), 422)
    assert.equal(await bad(`${E}/no-such/measurements`, { value: 1, source: 's' }), 404)
    assert.equal(await bad(`${E}/bad%20id/evaluate`, {}), 422)
    assert.equal(await bad(`${E}/exp-landing/explode`, {}), 404)

    const money = { kind: 'spend', amountUsd: 5, category: 'advertising', description: 'Ad', source: { type: 'receipt', ref: 'r' }, experimentId: 'exp-landing' }
    assert.equal(await bad('/api/genesis/money', { ...money, kind: 'transfer' }), 422)
    assert.equal(await bad('/api/genesis/money', { ...money, amountUsd: -5 }), 422)
    assert.equal(await bad('/api/genesis/money', { ...money, amountUsd: '5' }), 422)
    assert.equal(await bad('/api/genesis/money', { ...money, category: 'Ads!' }), 422)
    assert.equal(await bad('/api/genesis/money', { ...money, description: '' }), 422)
    assert.equal(await bad('/api/genesis/money', { ...money, source: { type: 'cash', ref: 'r' } }), 422)
    assert.equal(await bad('/api/genesis/money', { ...money, source: 'receipt:r' }), 422)
    assert.equal(await bad('/api/genesis/money', { ...money, confirm: 'yes' }), 422)

    const raw = await fetch(`http://127.0.0.1:${port}/api/genesis/money`, { method: 'POST', headers: { authorization: `Bearer ${tokens.founder}`, 'content-type': 'text/plain' }, body: 'spend 5' })
    assert.equal(raw.status, 415)
    assert.equal((await call('/api/genesis', tokens.viewer)).body.ledger.entries, 0, 'nothing invalid was recorded')
  } finally { await host.stop() }
})

test('the file store uses the CLI layout: <dir>/<runId>/{experiments,ledger,run}.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'genesis-api-'))
  try {
    const { host, call, tokens } = await start({ store: new FileGenesisStore(dir) })
    try {
      await call(E, tokens.founder, { definition: definition() })
      await call(`${E}/exp-landing/start`, tokens.founder, {})
      await call('/api/genesis/money', tokens.founder, { kind: 'spend', amountUsd: 5, category: 'advertising', description: 'Ad', source: { type: 'receipt', ref: 'r' }, experimentId: 'exp-landing' })
    } finally { await host.stop() }
    const read = async (f: string) => JSON.parse(await readFile(join(dir, 'genesis-test', f), 'utf8'))
    assert.equal((await read('experiments.json'))[0].status, 'running')
    assert.equal((await read('ledger.json')).entries.length, 1)
    assert.equal((await read('ledger.json')).budgetUsd, 500)
    assert.ok((await read('run.json')).startedAt)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

const R = '/api/genesis/reviews'
const offer = 'Get a margin report for your feed store in 48 hours.'

test('reviews: only a human provider records a manual founder review, with the caller as reviewer; GET lists them apart from WAES', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'genesis-reviews-'))
  try {
    const { host, call, tokens } = await start({ config: { ...runConfig(), waesManualReviewAllowed: true }, store: new FileGenesisStore(dir) })
    try {
      assert.equal((await call(R, tokens.agent, { text: offer, channel: 'landing-page', verdict: 'pass' })).status, 403, 'an agent cannot approve text')
      assert.equal((await call(R, tokens.viewer, { text: offer, channel: 'landing-page', verdict: 'pass' })).status, 403)

      const made = await call(R, tokens.founder, { text: offer, channel: 'landing-page', verdict: 'pass', note: 'Plain claim.', reviewer: 'someone-else', kind: 'waes', components: ['SENTINEL'] })
      assert.equal(made.status, 201)
      const r = made.body.review
      assert.equal(r.kind, 'manual', 'the body cannot make it a WAES review')
      assert.deepEqual(r.components, ['MANUAL-FOUNDER-REVIEW'])
      assert.equal(r.reviewer, 'entity-founder', 'the reviewer is always the caller')
      assert.equal(r.reviewerKind, 'human')
      assert.equal(r.text, offer)
      assert.equal(r.note, 'Plain claim.')
      assert.equal(made.body.executed, false)
      assert.match(made.body.label, /not a WAES evaluation/)

      // A later decision on changed text is a new record; nothing is rewritten.
      assert.equal((await call(R, tokens.founder, { text: `${offer} Now 50% off!`, channel: 'landing-page', verdict: 'revise' })).status, 201)

      const g = await call('/api/genesis', tokens.viewer)
      assert.equal(g.body.config.waesManualReviewAllowed, true)
      assert.equal(g.body.config.waesRequired, true)
      assert.equal(g.body.reviews.length, 2)
      assert.equal(g.body.reviews[0].verdict, 'revise', 'newest first')
      assert.deepEqual(g.body.reviewSummary.manual, { total: 2, pass: 1, revise: 1, block: 0 })
      assert.deepEqual(g.body.reviewSummary.waes, { total: 0, pass: 0, revise: 0, block: 0 })
    } finally { await host.stop() }
    const stored = JSON.parse(await readFile(join(dir, 'genesis-test', 'reviews.json'), 'utf8'))
    assert.equal(stored.length, 2)
    assert.equal(stored[0].contentDigest, (await import('@quicksilver/kernel/waes')).waesContentDigest(offer))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('reviews: input validation, unknown experiments, and the policy note when manual reviews are not accepted', async () => {
  const { host, call, tokens } = await start()
  try {
    const bad = async (body: unknown) => (await call(R, tokens.founder, body)).status
    assert.equal(await bad({ channel: 'email', verdict: 'pass' }), 422)
    assert.equal(await bad({ text: '   ', channel: 'email', verdict: 'pass' }), 422)
    assert.equal(await bad({ text: 'x'.repeat(20_001), channel: 'email', verdict: 'pass' }), 422)
    assert.equal(await bad({ text: offer, channel: 'Email!', verdict: 'pass' }), 422)
    assert.equal(await bad({ text: offer, channel: 'email', verdict: 'approve' }), 422)
    assert.equal(await bad({ text: offer, channel: 'email', verdict: 'pass', note: 'n'.repeat(501) }), 422)
    assert.equal(await bad({ text: offer, channel: 'email', verdict: 'pass', experimentId: 'no-such' }), 404)
    await call(E, tokens.founder, { definition: definition() })
    const ok = await call(R, tokens.founder, { text: offer, channel: 'email', verdict: 'block', experimentId: 'exp-landing' })
    assert.equal(ok.status, 201)
    assert.equal(ok.body.review.experimentId, 'exp-landing')
    assert.match(ok.body.counts, /does not accept manual founder reviews/, 'runConfig() leaves waesManualReviewAllowed unset (off)')
    assert.equal((await call('/api/genesis', tokens.viewer)).body.config.waesManualReviewAllowed, false)
  } finally { await host.stop() }
})
