/** Aura intent entry point and ledger routes on the host. Run with `npm run host:test`. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MemoryIntentGraphStore, MemoryLedgerStore } from '@quicksilver/aura'
import { generateToken, type TokenPrincipalConfig } from '@quicksilver/kernel/identity/tokens'

import { parseHostConfig } from './config.ts'
import { QuicksilverHost } from './host.ts'
import { Logger } from './log.ts'

const TENANT = 'nuera'
function person(id: string, roles: string[]): { config: TokenPrincipalConfig; token: string } {
  const { token, tokenDigest } = generateToken()
  return { token, config: { id, kind: 'human', tenantId: TENANT, roles, tokenDigest } }
}

async function start() {
  const founder = person('entity-founder', ['intent-provider', 'viewer'])
  const ops = person('entity-ops', ['intent-admin', 'viewer'])
  const viewer = person('entity-viewer', ['viewer'])
  const host = new QuicksilverHost(parseHostConfig({ tenantId: TENANT, http: { host: '127.0.0.1', port: 0 }, workflows: {} }), {
    principals: [founder.config, ops.config, viewer.config],
    logger: new Logger({ level: 'error', sink: { write: () => {} } }),
    intent: { graphs: new MemoryIntentGraphStore(), ledger: new MemoryLedgerStore() },
  })
  const { port } = await host.start()
  const call = (path: string, token: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() as any }))
  return { host, call, tokens: { founder: founder.token, ops: ops.token, viewer: viewer.token } }
}

test('an objective becomes an intent with questions; answers are recorded as the provider\'s own', async () => {
  const { host, call, tokens } = await start()
  try {
    const created = await call('/api/intents', tokens.founder, { objective: 'We run a feed store. Help us understand our margins.' })
    assert.equal(created.status, 201)
    const intent = created.body.intent
    assert.equal(intent.mode, 'onboard')
    assert.ok(intent.questions.length > 0)
    assert.ok(!intent.questions.some((q: any) => q.variableId === 'business_type'), 'implied values are not asked')
    assert.deepEqual(intent.issues, [])

    const q = intent.questions[0]
    const answered = await call(`/api/intents/${intent.id}/answers`, tokens.founder, { variableId: q.variableId, answer: 'Books and the point-of-sale system' })
    assert.equal(answered.status, 200)
    assert.ok(!answered.body.intent.questions.some((x: any) => x.variableId === q.variableId), 'an answered question is not asked again')
    const full = await call(`/api/intents/${intent.id}`, tokens.viewer)
    const v = full.body.graph.variables.find((x: any) => x.id === q.variableId)
    assert.equal(v.provenance, 'HUMAN_SPECIFIED')
    assert.equal(v.sources[0].ref, 'entity-founder')

    assert.equal((await call('/api/intents', tokens.viewer)).body.intents.length, 1)
    assert.equal((await call('/api/intents', tokens.viewer, { objective: 'x' })).status, 403, 'viewers cannot state intent')
    assert.equal((await call('/api/intents', tokens.founder, { objective: '' })).status, 422)
  } finally {
    await host.stop({ abort: true })
  }
})

test('the intent ledger over HTTP: providers shape intent, admins set rules only, every entry verifies', async () => {
  const { host, call, tokens } = await start()
  try {
    const create = await call('/api/intent-ledger/nuera-feed', tokens.founder, { change: { type: 'company.create', companyId: 'nuera-feed', tenantId: TENANT, admins: ['entity-ops'], providers: [{ id: 'entity-founder', kind: 'person', name: 'Founder', authority: 1 }] } })
    assert.equal(create.status, 201)
    assert.equal((await call('/api/intent-ledger/nuera-feed', tokens.founder, { change: { type: 'goal.set', goal: { id: 'trust', label: 'Most trusted feed store', horizon: 'enduring', serves: [] } } })).status, 201)
    assert.equal((await call('/api/intent-ledger/nuera-feed', tokens.founder, { change: { type: 'weight.set', goalId: 'trust', weight: 0.8 }, reason: 'From the intent profile' })).status, 201)

    const adminIntent = await call('/api/intent-ledger/nuera-feed', tokens.ops, { change: { type: 'weight.set', goalId: 'trust', weight: 0.1 } })
    assert.equal(adminIntent.status, 403)
    assert.equal((await call('/api/intent-ledger/nuera-feed', tokens.ops, { change: { type: 'rule.set', rule: { kind: 'majority' } } })).status, 201)
    assert.equal((await call('/api/intent-ledger/nuera-feed', tokens.viewer, { change: { type: 'rule.set', rule: null } })).status, 403)

    const read = await call('/api/intent-ledger/nuera-feed', tokens.viewer)
    assert.equal(read.status, 200)
    assert.equal(read.body.verified.valid, true)
    assert.equal(read.body.entries.length, 4)
    assert.equal(read.body.state.weights['entity-founder'].trust, 0.8)
    assert.equal(read.body.entries[2].reason, 'From the intent profile')
    assert.equal((await call('/api/intent-ledger/no-such-co', tokens.viewer)).status, 404)
    assert.equal((await call('/api/intent-ledger/bad%20id', tokens.viewer)).status, 422)
  } finally {
    await host.stop({ abort: true })
  }
})

test('question quality: answering and dismissing Aura\'s questions are recorded with their rank', async () => {
  const { host, call, tokens } = await start()
  try {
    const created = await call('/api/intents', tokens.founder, { objective: 'Start a side business sharpening knives and garden tools; I keep my day job.' })
    const id = created.body.intent.id
    const [first, second] = created.body.intent.questions
    const dismissed = await call(`/api/intents/${id}/dismiss`, tokens.founder, { variableId: first.variableId })
    assert.equal(dismissed.status, 200)
    assert.equal(dismissed.body.feedback.rank, 1)
    assert.ok(!dismissed.body.intent.questions.some((q: any) => q.variableId === first.variableId), 'a dismissed question is not asked again')
    assert.equal((await call(`/api/intents/${id}/dismiss`, tokens.founder, { variableId: first.variableId })).status, 422)
    assert.equal((await call(`/api/intents/${id}/dismiss`, tokens.viewer, { variableId: second.variableId })).status, 403)
    const answered = await call(`/api/intents/${id}/answers`, tokens.founder, { variableId: second.variableId, answer: 'About 6 hours a week' })
    assert.equal(answered.status, 200)
    const list = await call('/api/intents', tokens.viewer)
    assert.deepEqual({ scored: list.body.questionQuality.scored, answered: list.body.questionQuality.answered }, { scored: 2, answered: 1 })
  } finally { await host.stop() }
})
