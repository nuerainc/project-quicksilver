/** Aura decision journal on the host. Run with `npm run host:test`. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MemoryDecisionStore, MemoryIntentGraphStore, MemoryLedgerStore } from '@quicksilver/aura'
import { generateToken, type TokenPrincipalConfig } from '@quicksilver/kernel/identity/tokens'

import { parseHostConfig } from './config.ts'
import { QuicksilverHost } from './host.ts'
import { Logger } from './log.ts'
import { MemoryShadowStore } from './shadow-api.ts'

const TENANT = 'nuera'
function who(id: string, kind: 'human' | 'agent', roles: string[]): { config: TokenPrincipalConfig; token: string } {
  const { token, tokenDigest } = generateToken()
  return { token, config: { id, kind, tenantId: TENANT, roles, tokenDigest } }
}

async function start() {
  const founder = who('entity-founder', 'human', ['intent-provider', 'viewer'])
  const agent = who('agent-shadow', 'agent', ['agent-worker', 'intent-provider'])
  const viewer = who('entity-viewer', 'human', ['viewer'])
  const graphs = new MemoryIntentGraphStore()
  const shadowStore = new MemoryShadowStore()
  let clock = Date.parse('2026-09-26T12:00:00Z')
  const host = new QuicksilverHost(parseHostConfig({ tenantId: TENANT, http: { host: '127.0.0.1', port: 0 }, workflows: {} }), {
    principals: [founder.config, agent.config, viewer.config],
    logger: new Logger({ level: 'error', sink: { write: () => {} } }),
    now: () => (clock += 60_000),
    intent: { graphs, ledger: new MemoryLedgerStore() },
    shadow: { graphs, store: shadowStore },
    decisions: { store: new MemoryDecisionStore(), shadow: { graphs, store: shadowStore } },
  })
  const { port } = await host.start()
  const call = (path: string, token: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() as any }))
  return { host, call, tokens: { founder: founder.token, agent: agent.token, viewer: viewer.token } }
}

const entry = { situation: 'A regular asked for 30-day terms on a large order.', options: ['Say yes', 'Decline and keep cash on delivery', 'Offer 15-day terms instead'], chosen: 3, note: 'Good customer, but cash is tight.', category: 'sales' }

test('a provider logs decisions; they are listed newest first with a labeled baseline', async () => {
  const { host, call, tokens } = await start()
  try {
    const a = await call('/api/decisions', tokens.founder, entry)
    assert.equal(a.status, 201)
    assert.equal(a.body.decision.chosen, 'c')
    assert.equal(a.body.decision.by, 'entity-founder')
    assert.equal(a.body.decision.source, 'journal')
    const b = await call('/api/decisions', tokens.founder, { situation: 'Upgrade the POS system now?', options: [{ id: 'now', text: 'Buy it now' }, { id: 'later', text: 'Wait until spring' }], chosen: 'later' })
    assert.equal(b.status, 201)

    const list = await call('/api/decisions', tokens.viewer)
    assert.equal(list.status, 200)
    assert.deepEqual(list.body.decisions.map((d: any) => d.id), [b.body.decision.id, a.body.decision.id])
    assert.deepEqual(list.body.counts, { journal: 2, shadow: 0, scenario: 0 })
    assert.equal(list.body.baseline.decisions, 2)
    assert.match(list.body.baseline.label, /^Baseline only/)
  } finally { await host.stop() }
})

test('permissions: only humans with intent:provide log; decision:read lists; bad input is refused', async () => {
  const { host, call, tokens } = await start()
  try {
    assert.equal((await call('/api/decisions', tokens.viewer, entry)).status, 403, 'viewers lack intent:provide')
    assert.equal((await call('/api/decisions', tokens.agent, entry)).status, 403, 'agents never log decisions, even with the role')
    assert.equal((await call('/api/decisions', tokens.founder, { ...entry, options: ['only one'] })).status, 422)
    assert.equal((await call('/api/decisions', tokens.founder, { ...entry, chosen: 9 })).status, 422)
    assert.equal((await call('/api/decisions', tokens.founder, { ...entry, situation: 'x'.repeat(1001) })).status, 422)
    assert.equal((await call('/api/decisions', tokens.founder, { ...entry, source: 'shadow' })).body.decision.source, 'journal', 'the API logs journal entries only')
    assert.equal((await call('/api/decisions', 'not-a-token')).status, 401)
    assert.equal((await call('/api/decisions/x', tokens.viewer)).status, 404)
  } finally { await host.stop() }
})

test('judged shadow recommendations are listed and scored as decisions', async () => {
  const { host, call, tokens } = await start()
  try {
    const intent = await call('/api/intents', tokens.founder, { objective: 'We run a feed store. Help us understand our margins.' })
    const id = intent.body.intent.id
    const proposal = { department: 'finance', description: 'Send overdue reminders.', reversible: true, operationalImpact: 1, uncertainty: 1, evidence: [{ id: 'e', title: 'Overdue', confidence: 0.9 }] }
    await call(`/api/shadow/${id}/recommendations`, tokens.founder, { proposal })
    await call(`/api/shadow/${id}/recommendations`, tokens.founder, { proposal: { ...proposal, description: 'Pending one.' } })
    assert.equal((await call(`/api/shadow/${id}/recommendations/rec-1/verdict`, tokens.founder, { value: 'rejected', note: 'Not this week.' })).status, 200)
    await call('/api/decisions', tokens.founder, entry)

    const list = await call('/api/decisions', tokens.viewer)
    assert.deepEqual(list.body.counts, { journal: 1, shadow: 1, scenario: 0 })
    const shadow = list.body.decisions.find((d: any) => d.source === 'shadow')
    assert.equal(shadow.id, `shadow:${id}:rec-1`)
    assert.equal(shadow.chosen, 'reject')
    assert.equal(shadow.note, 'Not this week.')
    assert.equal(list.body.baseline.decisions, 2)
    assert.deepEqual(Object.keys(list.body.baseline.bySource).sort(), ['journal', 'shadow'])
  } finally { await host.stop() }
})
