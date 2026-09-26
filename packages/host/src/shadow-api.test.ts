/** Shadow mode on the host (M4). Run with `npm run host:test`. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MemoryIntentGraphStore, MemoryLedgerStore } from '@quicksilver/aura'
import { generateToken, type TokenPrincipalConfig } from '@quicksilver/kernel/identity/tokens'

import { parseHostConfig } from './config.ts'
import { QuicksilverHost } from './host.ts'
import { Logger } from './log.ts'
import { kernelVerdict, MemoryShadowStore, type ShadowGenerator, type ShadowProposal } from './shadow-api.ts'

const TENANT = 'nuera'
function who(id: string, kind: 'human' | 'agent', roles: string[]): { config: TokenPrincipalConfig; token: string } {
  const { token, tokenDigest } = generateToken()
  return { token, config: { id, kind, tenantId: TENANT, roles, tokenDigest } }
}

const proposal = (over: Partial<ShadowProposal> = {}): ShadowProposal => ({
  department: 'finance',
  description: 'Send the three overdue invoices a reminder.',
  reversible: true,
  operationalImpact: 1,
  uncertainty: 1,
  evidence: [{ id: 'ledger:overdue', title: 'Three invoices over 30 days', confidence: 0.9 }],
  ...over,
})

async function start(generator?: ShadowGenerator) {
  const founder = who('entity-founder', 'human', ['intent-provider', 'viewer'])
  const agent = who('agent-shadow', 'agent', ['agent-worker'])
  const viewer = who('entity-viewer', 'human', ['viewer'])
  const graphs = new MemoryIntentGraphStore()
  const host = new QuicksilverHost(parseHostConfig({ tenantId: TENANT, http: { host: '127.0.0.1', port: 0 }, workflows: {} }), {
    principals: [founder.config, agent.config, viewer.config],
    logger: new Logger({ level: 'error', sink: { write: () => {} } }),
    intent: { graphs, ledger: new MemoryLedgerStore() },
    shadow: { graphs, store: new MemoryShadowStore(), ...(generator ? { generator } : {}) },
  })
  const { port } = await host.start()
  const call = (path: string, token: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() as any }))
  const created = await call('/api/intents', founder.token, { objective: 'We run a feed store. Help us understand our margins.' })
  return { host, call, intentId: created.body.intent.id as string, tokens: { founder: founder.token, agent: agent.token, viewer: viewer.token } }
}

test('the kernel verdict: low-risk reversible work would run; no evidence is refused; big exposure goes to a human', () => {
  assert.equal(kernelVerdict(proposal(), {}).recommendation, 'execute-autonomously')
  assert.equal(kernelVerdict(proposal({ evidence: [] }), {}).recommendation, 'reject')
  assert.equal(kernelVerdict(proposal({ reversible: false, operationalImpact: 4, uncertainty: 3, financialExposure: 20_000 }), {}).recommendation, 'request-approval')
})

test('recommendations are recorded with the kernel verdict and a prediction, and never executed', async () => {
  const { host, call, intentId, tokens } = await start()
  try {
    const r = await call(`/api/shadow/${intentId}/recommendations`, tokens.agent, { proposal: proposal() })
    assert.equal(r.status, 201)
    const rec = r.body.recommendations[0]
    assert.equal(rec.executed, false)
    assert.equal(rec.source, 'agent')
    assert.equal(rec.kernel.recommendation, 'execute-autonomously')
    assert.equal(rec.prediction.observations, 0)
    assert.equal(rec.prediction.accept > 0 && rec.prediction.accept < 1, true)

    assert.equal((await call(`/api/shadow/${intentId}/recommendations`, tokens.viewer, { proposal: proposal() })).status, 403)
    assert.equal((await call(`/api/shadow/${intentId}/recommendations`, tokens.agent, { proposal: { ...proposal(), department: 'Finance!' } })).status, 422)
    assert.equal((await call(`/api/shadow/no-such-intent`, tokens.viewer)).status, 404)
  } finally { await host.stop() }
})

test('only a human judges; verdicts train Aura and predictions are scored before each verdict', async () => {
  const { host, call, intentId, tokens } = await start()
  try {
    for (let i = 0; i < 6; i++) await call(`/api/shadow/${intentId}/recommendations`, tokens.agent, { proposal: proposal({ description: `Reminder batch ${i}` }) })
    assert.equal((await call(`/api/shadow/${intentId}/recommendations/rec-1/verdict`, tokens.agent, { value: 'accepted' })).status, 403, 'agents lack intent:provide')

    for (let i = 1; i <= 3; i++) assert.equal((await call(`/api/shadow/${intentId}/recommendations/rec-${i}/verdict`, tokens.founder, { value: 'rejected', note: 'Not yet' })).status, 200)
    assert.equal((await call(`/api/shadow/${intentId}/recommendations/rec-1/verdict`, tokens.founder, { value: 'accepted' })).status, 422, 'verdicts are not rewritten')

    // Recommendations recorded earlier kept the prediction made at the time; a new one reflects the learning.
    const later = await call(`/api/shadow/${intentId}/recommendations`, tokens.agent, { proposal: proposal({ description: 'Another reminder batch' }) })
    const first = (await call(`/api/shadow/${intentId}`, tokens.viewer)).body
    assert.ok(later.body.recommendations[0].prediction.accept < first.recommendations[0].prediction.accept, 'rejections lower the predicted acceptance')
    assert.equal(first.aura.learner.observations, 3)
    assert.equal(first.aura.learner.provenance, 'AGENT_INFERRED')
    assert.equal(first.aura.predictions.scored, 3)
    assert.equal(first.departments[0].rejected, 3)

    assert.equal((await call(`/api/shadow/${intentId}/recommendations/rec-4/outcome`, tokens.founder, { value: 'good' })).status, 422, 'judge before outcome')
    await call(`/api/shadow/${intentId}/recommendations/rec-4/verdict`, tokens.founder, { value: 'accepted' })
    assert.equal((await call(`/api/shadow/${intentId}/recommendations/rec-4/outcome`, tokens.founder, { value: 'good' })).status, 200)
  } finally { await host.stop() }
})

test('the shadow-stage agent proposes; departments it was not asked about are refused', async () => {
  const generator: ShadowGenerator = async ({ departments }) => [proposal({ department: departments[0]! }), proposal({ department: 'marketing' })]
  const { host, call, intentId, tokens } = await start(generator)
  try {
    const r = await call(`/api/shadow/${intentId}/generate`, tokens.founder, { departments: ['finance'] })
    assert.equal(r.status, 201)
    assert.deepEqual(r.body.added, ['rec-1'])
    assert.equal(r.body.refused.length, 1)
    assert.equal(r.body.executed, false)
  } finally { await host.stop() }
  const none = await start()
  try {
    assert.equal((await none.call(`/api/shadow/${none.intentId}/generate`, none.tokens.founder, {})).status, 501)
  } finally { await none.host.stop() }
})
