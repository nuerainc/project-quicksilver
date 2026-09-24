/**
 * Regression suite for the Quicksilver Engine, NQC Kernel contract, routing,
 * memory governance, and the tool/agent registries. Run with:
 *   node --experimental-strip-types --no-warnings --test packages/kernel/src/nqc/nqc.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AgentRegistry,
  BUILT_IN_AGENT_MANIFESTS,
  ToolRegistry,
  createBuiltInAgentRegistry,
  evaluateAgentOutput,
  evaluateNqcRequest,
  generateReasoningStressChallenge,
  governMemoryWrite,
  runReasoningStressSuite,
  scoreReasoningStressAnswer,
  selectRoute,
  updateModelPerformance,
  validateToolRequest,
  writeGovernedMemory,
  type GovernedMemoryEntry,
  type ModelPerformanceProfile,
} from '../index.ts'

// ── Quicksilver Engine ────────────────────────────────────────────────────

const grounded = {
  agentOutput: 'Line 3 pressure is within tolerance per SOP-12.',
  context: ['SOP-12: tolerance 40–60 psi', 'Sensor: 52 psi'],
  citedReferences: ['SOP-12'],
  availableReferences: ['SOP-12'],
}

test('Engine: a grounded answer with no defects scores 100 and low risk', () => {
  const r = evaluateAgentOutput(grounded)
  assert.equal(r.reasoningScore, 100)
  assert.equal(r.hallucinationRisk, 'low')
  assert.equal(r.brittleness, 'low')
  assert.deepEqual(r.failureExemplars, [])
  assert.equal(r.taskType, 'other')
  assert.equal(r.modelId, null)
})

test('Engine: empty output and unresolved citations are high hallucination risk', () => {
  assert.equal(evaluateAgentOutput({ ...grounded, agentOutput: '   ' }).hallucinationRisk, 'high')
  const r = evaluateAgentOutput({ ...grounded, citedReferences: ['SOP-12', 'SOP-99'] })
  assert.equal(r.hallucinationRisk, 'high')
  assert.ok(r.failureExemplars.some((e) => e.includes('SOP-99')))
  assert.ok(r.reasoningScore <= 75)
})

test('Engine: ungrounded answers, failed tools, and uncertainty are medium risk', () => {
  assert.equal(evaluateAgentOutput({ agentOutput: 'yes' }).hallucinationRisk, 'med')
  const tools = evaluateAgentOutput({ ...grounded, toolCalls: [{ name: 'q', succeeded: false, error: 'timeout' }] })
  assert.equal(tools.hallucinationRisk, 'med')
  assert.equal(tools.failedToolCount, 1)
  assert.ok(tools.failureExemplars.includes('Tool q failed: timeout'))
  assert.equal(evaluateAgentOutput({ ...grounded, uncertainty: 4 }).brittleness, 'med')
})

test('Engine: long plans and repeated tool failures raise brittleness', () => {
  assert.equal(evaluateAgentOutput({ ...grounded, stepCount: 5 }).brittleness, 'med')
  assert.equal(evaluateAgentOutput({ ...grounded, stepCount: 8 }).brittleness, 'high')
  const fails = [{ name: 'a', succeeded: false }, { name: 'b', succeeded: false }]
  assert.equal(evaluateAgentOutput({ ...grounded, toolCalls: fails }).brittleness, 'high')
})

test('Engine: score is clamped to 0..100 even when every penalty applies', () => {
  const r = evaluateAgentOutput({
    agentOutput: '', citedReferences: ['a', 'b', 'c', 'd', 'e'], availableReferences: [], impactLevel: 'critical', uncertainty: 5, stepCount: 10,
    toolCalls: [{ name: 'x', succeeded: false }, { name: 'y', succeeded: false }, { name: 'z', succeeded: false }, { name: 'w', succeeded: false }],
  })
  assert.equal(r.reasoningScore, 0)
  assert.equal(r.brittleness, 'high')
})

test('Engine: critical work without grounding is penalised further', () => {
  const normal = evaluateAgentOutput({ agentOutput: 'ok' }).reasoningScore
  const critical = evaluateAgentOutput({ agentOutput: 'ok', impactLevel: 'critical' }).reasoningScore
  assert.equal(normal - critical, 15)
})

// ── tool validation ───────────────────────────────────────────────────────

test('Tool validation: unknown tools, sequence mismatches, and missing args fail closed', () => {
  const r = validateToolRequest({ name: 'ghost', arguments: undefined, sequence: 2 }, [], 1)
  assert.equal(r.allowed, false)
  assert.equal(r.reasons.length, 3)
})

test('Tool validation: JSON-schema subset is enforced', () => {
  const tool = {
    name: 'search',
    parameters: {
      type: 'object', required: ['q'], additionalProperties: false,
      properties: {
        q: { type: 'string', minLength: 2, maxLength: 5 },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
        mode: { type: 'string', enum: ['fast', 'deep'] },
        tags: { type: 'array', items: { type: 'string' } },
        flag: { type: 'boolean' },
      },
    },
  }
  assert.equal(validateToolRequest({ name: 'search', arguments: { q: 'abc', limit: 3, mode: 'fast', tags: ['a'], flag: true } }, [tool]).allowed, true)
  const bad = validateToolRequest({ name: 'search', arguments: { q: 'a', limit: 11.5, mode: 'slow', tags: [1], flag: 'y', extra: 1 } }, [tool])
  for (const fragment of ['shorter', 'integer', 'above the maximum', 'allowed value', '$.tags[0] must be a string', 'boolean', 'not an allowed parameter']) {
    assert.ok(bad.reasons.some((reason) => reason.includes(fragment)), `missing "${fragment}" in ${bad.reasons.join(' | ')}`)
  }
  assert.ok(validateToolRequest({ name: 'search', arguments: {} }, [tool]).reasons.includes('$.q is required.'))
  assert.ok(validateToolRequest({ name: 'search', arguments: [] }, [tool]).reasons.includes('$ must be an object.'))
})

test('Tool validation: approval must be verified and dependencies completed', () => {
  const tool = { name: 'deploy', requiresApproval: true, dependsOn: ['build'] }
  const r = validateToolRequest({ name: 'deploy', arguments: {}, approvalId: 'apr-1' }, [tool], undefined, [])
  assert.ok(r.reasons.some((x) => x.includes('supervisor approval')), 'no verifier means no approval')
  assert.ok(r.reasons.some((x) => x.includes('"build"')))
  const ok = validateToolRequest({ name: 'deploy', arguments: {}, approvalId: 'apr-1' }, [tool], undefined, ['build'], (id) => id === 'apr-1')
  assert.equal(ok.allowed, true)
  assert.equal(ok.requiresApproval, true)
})

// ── registries ────────────────────────────────────────────────────────────

test('ToolRegistry: invalid, duplicate, and unsafe manifests are refused', () => {
  const registry = new ToolRegistry()
  registry.register({ id: 'sanity.query', contractVersion: 1, provider: 'sanity', access: 'read-only', requiresApproval: false })
  assert.throws(() => registry.register({ id: 'sanity.query', contractVersion: 1, provider: 'sanity', access: 'read-only', requiresApproval: false }), /already registered/)
  assert.throws(() => registry.register({ id: 'x.write', contractVersion: 1, provider: 'x', access: 'side-effect', requiresApproval: false }), /side-effect tools must require approval/)
  assert.throws(() => registry.register({ id: 'loop', contractVersion: 1, provider: 'x', access: 'read-only', requiresApproval: false, dependsOn: ['loop'] }), /depend on itself/)
  assert.throws(() => registry.register({ id: 'bad id', contractVersion: 2 as 1, provider: '', access: 'read-only', requiresApproval: false }), /Invalid tool manifest/)
  assert.deepEqual(registry.list().map((t) => t.manifest.id), ['sanity.query'])
})

test('ToolRegistry: manifests are frozen and schemas cannot be mutated after registration', () => {
  const schema = { type: 'object', properties: { q: { type: 'string' } } }
  const registry = new ToolRegistry()
  const tool = registry.register({ id: 's', contractVersion: 1, provider: 'p', access: 'read-only', requiresApproval: false, inputSchema: schema })
  schema.properties.q.type = 'number'
  assert.equal((tool.manifest.inputSchema as typeof schema).properties.q.type, 'string')
  assert.ok(Object.isFrozen(tool.manifest))
  assert.throws(() => { (tool.manifest.inputSchema as typeof schema).properties.q.type = 'x' })
})

test('ToolRegistry: approval ids are ignored for tools that do not need them and verified for those that do', () => {
  const registry = new ToolRegistry()
  registry.register({ id: 'write', contractVersion: 1, provider: 'p', access: 'side-effect', requiresApproval: true })
  assert.equal(registry.validate({ name: 'write', arguments: {}, approvalId: 'forged' }).allowed, false)
  assert.equal(registry.validate({ name: 'write', arguments: {}, approvalId: 'real' }, undefined, [], (id) => id === 'real').allowed, true)
  assert.equal(registry.validate({ name: 'nope', arguments: {} }).allowed, false)
})

test('AgentRegistry: built-ins register and dispatch is limited by task and impact', () => {
  const registry = createBuiltInAgentRegistry()
  assert.equal(registry.list().length, BUILT_IN_AGENT_MANIFESTS.length)
  assert.equal(registry.authorizeDispatch('nuera-quicksilver:query', 'reasoning', 'moderate').allowed, true)
  const tooHigh = registry.authorizeDispatch('nuera-quicksilver:query', 'reasoning', 'high')
  assert.equal(tooHigh.allowed, false)
  assert.ok(tooHigh.reasons.some((r) => r.includes('exceeds')))
  assert.equal(registry.authorizeDispatch('nuera-quicksilver:query', 'code').allowed, false)
  assert.equal(registry.authorizeDispatch('nuera-quicksilver:ghost', 'reasoning').allowed, false)
})

test('AgentRegistry: agents can never hold approval authority', () => {
  const registry = new AgentRegistry()
  assert.throws(() => registry.register({ id: 'nuera-quicksilver:boss', version: 1, authority: 'approve' as 'review', tasks: ['planning'], maximumImpact: 'low', requiresEvaluation: true }), /cannot authorize/)
  assert.throws(() => registry.register({ id: 'other:agent', version: 1, authority: 'propose', tasks: ['planning'], maximumImpact: 'low', requiresEvaluation: true }), /namespaced/)
  assert.throws(() => registry.register({ id: 'nuera-quicksilver:dup', version: 1, authority: 'propose', tasks: ['planning', 'planning'], maximumImpact: 'low', requiresEvaluation: true }), /duplicates/)
})

// ── NQC contract ──────────────────────────────────────────────────────────

test('NQC: clean moderate-impact work is allowed with no memory proposals', () => {
  const r = evaluateNqcRequest({ ...grounded, agentId: 'nuera-quicksilver:query', impactLevel: 'moderate' })
  assert.equal(r.safetyDecision, 'ALLOW')
  assert.deepEqual(r.memoryUpdates, [])
  assert.equal(r.routingUpdate, null)
})

test('NQC: high impact, high risk, tool failure, or low score escalate', () => {
  const base = { ...grounded, agentId: 'nuera-quicksilver:query' }
  assert.equal(evaluateNqcRequest({ ...base, impactLevel: 'high' }).safetyDecision, 'ESCALATE')
  assert.equal(evaluateNqcRequest({ ...base, citedReferences: ['ghost'] }).safetyDecision, 'ESCALATE')
  assert.equal(evaluateNqcRequest({ ...base, toolCalls: [{ name: 't', succeeded: false }] }).safetyDecision, 'ESCALATE')
  assert.equal(evaluateNqcRequest({ ...base, stepCount: 9 }).safetyDecision, 'ESCALATE')
})

test('NQC: failure exemplars become governed memory proposals, never direct writes', () => {
  const r = evaluateNqcRequest({ agentId: 'nuera-quicksilver:query', agentOutput: '', modelId: 'm1', taskType: 'reasoning' })
  assert.ok(r.memoryUpdates.length > 0)
  for (const update of r.memoryUpdates) {
    assert.equal(update.status, 'ready-for-review')
    assert.equal(update.governance.safeEntry?.kind, 'failure-exemplar')
    assert.equal(update.governance.safeEntry?.source, 'quicksilver-engine/m1')
  }
})

test('NQC: a credential inside a failure exemplar is blocked from memory', () => {
  const r = evaluateNqcRequest({
    agentId: 'nuera-quicksilver:query', agentOutput: 'ok', context: ['c'],
    toolCalls: [{ name: 'fetch', succeeded: false, error: 'api_key=sk-abcdefghijklmnopqrstuv rejected' }],
  })
  assert.ok(r.memoryUpdates.some((u) => u.status === 'blocked'))
})

// ── memory governance ─────────────────────────────────────────────────────

const memory: GovernedMemoryEntry = { id: 'm-1', kind: 'failure-exemplar', domain: 'reasoning', content: 'Empty output.', source: 'engine', confidence: 0.8, retentionDays: 30 }

test('Memory: valid failure exemplars are allowed and approvalId is stripped from the safe entry', () => {
  const d = governMemoryWrite({ ...memory, approvalId: 'x' })
  assert.equal(d.allowed, true)
  assert.equal(d.requiresApproval, false)
  assert.equal('approvalId' in (d.safeEntry ?? {}), false)
})

test('Memory: secrets, SSNs, and card numbers are refused', () => {
  for (const content of ['token AKIAABCDEFGHIJKLMNOP', '-----BEGIN PRIVATE KEY-----', 'password: hunter2', 'ssn 123-45-6789', 'card 4111 1111 1111 1111']) {
    assert.equal(governMemoryWrite({ ...memory, content }).allowed, false, content)
  }
})

test('Memory: bounds on confidence, retention, and size are enforced', () => {
  assert.equal(governMemoryWrite({ ...memory, confidence: 1.1 }).allowed, false)
  assert.equal(governMemoryWrite({ ...memory, retentionDays: 0 }).allowed, false)
  assert.equal(governMemoryWrite({ ...memory, retentionDays: 3651 }).allowed, false)
  assert.equal(governMemoryWrite({ ...memory, content: 'x'.repeat(10_001) }).allowed, false)
  assert.equal(governMemoryWrite({ ...memory, domain: ' ' }).allowed, false)
})

test('Memory: policy-bearing kinds need a verified supervisor approval', () => {
  const rule = { ...memory, kind: 'routing-rule' as const, approvalId: 'apr-9' }
  assert.equal(governMemoryWrite(rule).allowed, false)
  assert.equal(governMemoryWrite(rule, () => false).allowed, false)
  const ok = governMemoryWrite(rule, (id) => id === 'apr-9')
  assert.equal(ok.allowed, true)
  assert.equal(ok.requiresApproval, true)
})

test('Memory: the persistence callback runs only for governed writes', async () => {
  let writes = 0
  const persist = async () => { writes += 1; return 'stored' }
  assert.equal((await writeGovernedMemory({ ...memory, content: 'password=x' }, persist)).result, undefined)
  assert.equal(writes, 0)
  assert.equal((await writeGovernedMemory(memory, persist)).result, 'stored')
  assert.equal(writes, 1)
})

// ── routing ───────────────────────────────────────────────────────────────

const profile = (id: string, extra: Partial<ModelPerformanceProfile> = {}): ModelPerformanceProfile => ({
  modelId: id, supportedTasks: ['reasoning', 'code'], taskAccuracy: { reasoning: 0.8, code: 0.7 },
  successRate: 0.95, averageCostPer1kTokens: 0.01, p95LatencyMs: 2000, available: true, ...extra,
})

test('Routing: the best measured model wins and others become ordered fallbacks', () => {
  const r = selectRoute({
    taskType: 'reasoning', estimatedTokens: 1000,
    candidates: [profile('cheap', { taskAccuracy: { reasoning: 0.7 } }), profile('best', { taskAccuracy: { reasoning: 0.95 } }), profile('mid')],
  })
  assert.equal(r.selectedModelId, 'best')
  assert.deepEqual(r.fallbackModelIds, ['mid', 'cheap'])
})

test('Routing: policy constraints reject unavailable, unmeasured, slow, costly, and recently failed models', () => {
  const r = selectRoute({
    taskType: 'reasoning', estimatedTokens: 1000, budget: 0.02, maxLatencyMs: 3000, maximumRateLimitRate: 0.1, recentFailureModelIds: ['flaky'],
    candidates: [
      profile('down', { available: false }),
      profile('unmeasured', { taskAccuracy: {} }),
      profile('slow', { p95LatencyMs: 5000 }),
      profile('pricey', { averageCostPer1kTokens: 0.05 }),
      profile('limited', { rateLimitRate: 0.5 }),
      profile('flaky'),
      profile('weak', { taskAccuracy: { reasoning: 0.5 } }),
      profile('ok'),
    ],
  })
  assert.equal(r.selectedModelId, 'ok')
  assert.deepEqual(r.rejected.map((x) => x.modelId), ['down', 'unmeasured', 'slow', 'pricey', 'limited', 'flaky', 'weak'])
})

test('Routing: domain accuracy overrides task accuracy when present', () => {
  const r = selectRoute({
    taskType: 'reasoning', domain: 'hydraulic', estimatedTokens: 100,
    candidates: [profile('generalist', { taskAccuracy: { reasoning: 0.95 }, domainAccuracy: { hydraulic: 0.6 } }), profile('specialist', { domainAccuracy: { hydraulic: 0.9 } })],
  })
  assert.equal(r.selectedModelId, 'specialist')
})

test('Routing: no eligible candidate yields a null selection with a reason', () => {
  const r = selectRoute({ taskType: 'bulk', estimatedTokens: 10, candidates: [profile('a')] })
  assert.equal(r.selectedModelId, null)
  assert.match(r.reason, /No candidate/)
})

test('Routing: performance updates are bounded moving averages and ignore other models', () => {
  const p = profile('m')
  assert.equal(updateModelPerformance(p, { modelId: 'other', taskType: 'reasoning', success: false, latencyMs: 1 }), p)
  const u = updateModelPerformance(p, { modelId: 'm', taskType: 'reasoning', success: false, measuredAccuracy: 0.4, latencyMs: 4000, rateLimited: true, domain: 'repo' }, 0.5)
  assert.equal(u.successRate, 0.475)
  assert.ok(Math.abs(u.taskAccuracy.reasoning! - 0.6) < 1e-9)
  assert.equal(u.p95LatencyMs, 3000)
  assert.equal(u.rateLimitRate, 0.5)
  assert.equal(u.domainAccuracy?.repo, 0.4)
  const clamped = updateModelPerformance(p, { modelId: 'm', taskType: 'reasoning', success: true, latencyMs: -5 }, 7)
  assert.equal(clamped.successRate, 1)
  assert.equal(clamped.p95LatencyMs, 0)
})

// ── reasoning stress ──────────────────────────────────────────────────────

test('Stress: challenges are deterministic and cycle through all four categories', () => {
  assert.deepEqual(generateReasoningStressChallenge(42), generateReasoningStressChallenge(42))
  const categories = new Set([0, 1, 2, 3].map((s) => generateReasoningStressChallenge(s).category))
  assert.equal(categories.size, 4)
  assert.throws(() => generateReasoningStressChallenge(-1))
  assert.throws(() => scoreReasoningStressAnswer('other-1', 'x'), /Unknown/)
})

test('Stress: rubrics accept correct final answers and reject traps', () => {
  const arithmetic = generateReasoningStressChallenge(4)
  const [groups, perGroup, removed] = arithmetic.prompt.match(/\d+/g)!.map(Number)
  assert.equal(scoreReasoningStressAnswer(arithmetic.id, String(groups! * perGroup! - removed!)).passed, true)
  assert.equal(scoreReasoningStressAnswer(arithmetic.id, String(groups! * perGroup!)).passed, removed === 0)
  assert.equal(scoreReasoningStressAnswer('qs-reasoning-v1-1', 'No — affirming the consequent.').passed, true)
  assert.equal(scoreReasoningStressAnswer('qs-reasoning-v1-1', 'Yes.').passed, false)
  assert.equal(scoreReasoningStressAnswer('qs-reasoning-v1-2', 'It cannot be determined.').passed, true)
  assert.equal(scoreReasoningStressAnswer('qs-reasoning-v1-2', '42 liters').passed, false)
  assert.equal(scoreReasoningStressAnswer('qs-reasoning-v1-3', 'Impossible, it is cyclic.').passed, true)
})

test('Stress: suite scores provider answers, counts provider failures, and honours cancellation', async () => {
  const report = await runReasoningStressSuite(async (c) => {
    if (c.category === 'invalid-inference') throw new Error('provider down')
    return c.category === 'insufficient-information' ? 'cannot be determined' : c.category === 'constraint-conflict' ? 'no' : 'wrong'
  }, { seed: 0, count: 4 })
  assert.equal(report.completedCount, 4)
  assert.equal(report.failedCount >= 2, true)
  assert.ok(report.cases.some((c) => c.diagnostic.includes('provider failed')))
  const controller = new AbortController()
  controller.abort()
  const cancelled = await runReasoningStressSuite(async () => 'x', { seed: 0, count: 5, signal: controller.signal })
  assert.equal(cancelled.completedCount, 0)
  await assert.rejects(runReasoningStressSuite(async () => 'x', { seed: 0, count: 51 }))
})
