import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { BUSINESS_AGENT_IDS, BUILT_IN_AGENT_MANIFESTS } from '@quicksilver/kernel'
import { BUSINESS_AGENT_DEFINITIONS, BusinessAgentOutputSchema, businessAgents, runBusinessAgent } from './business-agents.ts'
import { assertAgentDispatch } from './governance.ts'
import { executeGovernedAgent } from './contracts.ts'

test('the seven business specialists have executable Nuera identities and bounded NQC manifests', () => {
  const keys = ['research', 'offer', 'content', 'outreach', 'sales', 'fulfillment', 'finance'] as const
  const builtIns = new Map(BUILT_IN_AGENT_MANIFESTS.map((manifest) => [manifest.id, manifest]))
  assert.deepEqual(keys.map((key) => BUSINESS_AGENT_DEFINITIONS[key].id), BUSINESS_AGENT_IDS)
  for (const key of keys) {
    const definition = BUSINESS_AGENT_DEFINITIONS[key]
    const agent = businessAgents[key]
    const manifest = builtIns.get(definition.id)
    assert.ok(manifest, `${key} is registered in the NQC Kernel`)
    assert.equal(agent.id, definition.id)
    assert.deepEqual(agent.tasks, [definition.task])
    assert.equal(manifest.authority, 'propose')
    assert.equal(manifest.maximumImpact, 'moderate')
    assert.equal(manifest.requiresEvaluation, true)
    assert.doesNotThrow(() => assertAgentDispatch(agent.id, definition.task, 'moderate'))
    assert.throws(() => assertAgentDispatch(agent.id, definition.task, 'high'), /exceeds agent/)
  }
  assert.equal(new Set(keys.map((key) => BUSINESS_AGENT_DEFINITIONS[key].specialty)).size, keys.length)
})

test('business agent result schema requires grounded, bounded proposal output', () => {
  const valid = {
    summary: 'A short evidence-based summary.',
    recommendations: [{ proposal: 'Review the current supplier terms.', evidenceIds: ['evidence-1'], confidence: 0.8, impact: 'moderate' }],
    unknowns: ['Renewal date'],
    questions: ['When is the renewal?'],
    externalEffects: ['A human would need to contact the supplier.'],
  }
  assert.deepEqual(BusinessAgentOutputSchema.parse(valid), valid)
  assert.throws(() => BusinessAgentOutputSchema.parse({ ...valid, recommendations: [{ ...valid.recommendations[0], confidence: 1.1 }] }))
  assert.throws(() => BusinessAgentOutputSchema.parse({ ...valid, extra: 'unreviewed side effect' }))
})

test('business worker input is bounded before model or context-client work starts', async () => {
  await assert.rejects(runBusinessAgent('research', { objective: 'x' }), /3 to 2,000 characters/)
  await assert.rejects(runBusinessAgent('research', { objective: 'Research this market', context: Array.from({ length: 21 }, () => 'context') }), /at most 20 strings/)
  await assert.rejects(runBusinessAgent('research', { objective: 'Research this market', context: ['x'.repeat(4_001)] }), /4,000 characters each/)
})

test('a business specialist result passes through the standard Quicksilver Engine contract', async () => {
  const worker = {
    ...businessAgents.research,
    async execute() {
      return {
        output: BusinessAgentOutputSchema.parse({ summary: 'Grounded result.', recommendations: [], unknowns: [], questions: [], externalEffects: [] }),
        modelId: 'test-model',
        evaluationContext: ['tool:company-records'],
      }
    },
  }
  const result = await executeGovernedAgent(worker, {
    agentId: worker.id,
    taskType: 'reasoning',
    input: { objective: 'Research supplier performance.' },
    impactLevel: 'moderate',
  })
  assert.equal(result.agentId, 'nuera-quicksilver:research')
  assert.equal(result.modelId, 'test-model')
  assert.ok(['ALLOW', 'BLOCK', 'ESCALATE'].includes(result.evaluation.safetyDecision))
  assert.equal(result.mayContinueAutomatically, result.evaluation.safetyDecision === 'ALLOW')
})

test('business workers use read-only company tools and explicitly prohibit side effects', () => {
  const source = readFileSync(new URL('./business-agents.ts', import.meta.url), 'utf8')
  assert.match(source, /mergeClientTools\(clients, toolCalls\)/)
  assert.match(source, /Never approve, execute, send, purchase, publish, change records/)
  assert.match(source, /NueraQuicksilverAgent/)
})
