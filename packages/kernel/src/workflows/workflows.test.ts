/**
 * Regression suite for the workflow graph validator, condition language, and
 * in-process runtime. Run with:
 *   node --experimental-strip-types --no-warnings --test packages/kernel/src/workflows/workflows.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  executeWorkflowGraph,
  validateWorkflowGraph,
  evaluateWorkflowConditionExpression,
  validateWorkflowConditionExpression,
  workflowConditionNodeReference,
  type WorkflowGraph,
  type WorkflowNode,
  type WorkflowRuntimeHandlers,
} from '../index.ts'

// ── fixtures ──────────────────────────────────────────────────────────────

function linear(extra: Partial<WorkflowNode['config']> = {}): WorkflowGraph {
  return {
    schemaVersion: 1,
    id: 'wf-linear',
    version: 1,
    entryNodeId: 'start',
    nodes: [
      { id: 'start', kind: 'trigger', label: 'Start' },
      { id: 'agent-1', kind: 'agent', label: 'Agent', config: { agentId: 'nuera-quicksilver:query', evaluationRequired: true, ...extra } },
      { id: 'done', kind: 'output', label: 'Done' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'agent-1' },
      { id: 'e2', from: 'agent-1', to: 'done' },
    ],
  }
}

function branching(expression = '$input == "go"'): WorkflowGraph {
  return {
    schemaVersion: 1,
    id: 'wf-branch',
    version: 1,
    entryNodeId: 'start',
    nodes: [
      { id: 'start', kind: 'trigger', label: 'Start' },
      { id: 'gate', kind: 'condition', label: 'Gate', config: { conditionExpression: expression } },
      { id: 'yes', kind: 'agent', label: 'Yes path', config: { agentId: 'a', evaluationRequired: true } },
      { id: 'no', kind: 'agent', label: 'No path', config: { agentId: 'b', evaluationRequired: true } },
      { id: 'done', kind: 'output', label: 'Done' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'gate' },
      { id: 'e2', from: 'gate', to: 'yes', branch: 'true' },
      { id: 'e3', from: 'gate', to: 'no', branch: 'false' },
      { id: 'e4', from: 'yes', to: 'done' },
      { id: 'e5', from: 'no', to: 'done' },
    ],
  }
}

function fanOut(count: number): WorkflowGraph {
  const agents = Array.from({ length: count }, (_, i) => ({
    id: `agent-${i}`, kind: 'agent' as const, label: `Agent ${i}`,
    config: { agentId: 'nuera-quicksilver:query', evaluationRequired: true },
  }))
  return {
    schemaVersion: 1,
    id: 'wf-fan',
    version: 1,
    entryNodeId: 'start',
    nodes: [{ id: 'start', kind: 'trigger', label: 'Start' }, ...agents, { id: 'done', kind: 'output', label: 'Done' }],
    edges: [
      ...agents.map((a, i) => ({ id: `in-${i}`, from: 'start', to: a.id })),
      ...agents.map((a, i) => ({ id: `out-${i}`, from: a.id, to: 'done' })),
    ],
  }
}

function toolGraph(config: WorkflowNode['config']): WorkflowGraph {
  return {
    schemaVersion: 1,
    id: 'wf-tool',
    version: 1,
    entryNodeId: 'start',
    nodes: [
      { id: 'start', kind: 'trigger', label: 'Start' },
      { id: 'tool-1', kind: 'tool', label: 'Tool', config: { toolId: 'sanity.query', ...config } },
      { id: 'done', kind: 'output', label: 'Done' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'tool-1' },
      { id: 'e2', from: 'tool-1', to: 'done' },
    ],
  }
}

function handlers(overrides: Partial<WorkflowRuntimeHandlers> = {}): WorkflowRuntimeHandlers & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async runAgent(node) { calls.push(`agent:${node.id}`); return { value: node.id } },
    async runTool(node) { calls.push(`tool:${node.id}`); return { tool: node.id } },
    async evaluate(node, _c, _ctx, phase) { calls.push(`eval:${node.id}:${phase}`); return { safetyDecision: 'ALLOW', reasoningScore: 90 } },
    async validateTool(node) { calls.push(`validate:${node.id}`); return { allowed: true, reasons: [] } },
    async approve(node) { calls.push(`approve:${node.id}`); return { approved: true } },
    ...overrides,
  }
}

// ── graph validation ──────────────────────────────────────────────────────

test('Graph: well-formed linear and branching graphs validate with a stable topological order', () => {
  const a = validateWorkflowGraph(linear())
  assert.equal(a.valid, true, a.errors.join(' '))
  assert.deepEqual(a.topologicalOrder, ['start', 'agent-1', 'done'])
  const b = validateWorkflowGraph(branching())
  assert.equal(b.valid, true, b.errors.join(' '))
  assert.equal(b.topologicalOrder[0], 'start')
  assert.equal(b.topologicalOrder.at(-1), 'done')
})

test('Graph: non-object, wrong schema, bad id/version, and empty node lists are rejected', () => {
  assert.equal(validateWorkflowGraph(null as unknown as WorkflowGraph).valid, false)
  const bad = validateWorkflowGraph({ ...linear(), schemaVersion: 2 as 1, id: ' bad id', version: 0 })
  assert.ok(bad.errors.includes('schemaVersion must be 1.'))
  assert.ok(bad.errors.includes('Workflow id is invalid.'))
  assert.ok(bad.errors.includes('Workflow version must be a positive integer.'))
  assert.ok(validateWorkflowGraph({ ...linear(), nodes: [] }).errors.includes('Workflow must include at least one node.'))
})

test('Graph: size limits are enforced (500 nodes, 1,000 edges)', () => {
  const nodes = Array.from({ length: 501 }, (_, i) => ({ id: `n${i}`, kind: 'output' as const, label: 'x' }))
  assert.ok(validateWorkflowGraph({ ...linear(), nodes }).errors.some((e) => e.includes('500-node')))
  const edges = Array.from({ length: 1001 }, (_, i) => ({ id: `e${i}`, from: 'start', to: 'done' }))
  assert.ok(validateWorkflowGraph({ ...linear(), edges }).errors.some((e) => e.includes('1,000-edge')))
})

test('Graph: duplicate ids, dangling edges, and duplicate connections are rejected', () => {
  const g = linear()
  g.nodes.push({ id: 'done', kind: 'output', label: 'Dup' })
  g.edges.push({ id: 'e1', from: 'start', to: 'agent-1' })
  g.edges.push({ id: 'e9', from: 'start', to: 'ghost' })
  const v = validateWorkflowGraph(g)
  assert.ok(v.errors.includes('Duplicate workflow node id "done".'))
  assert.ok(v.errors.includes('Duplicate workflow edge id "e1".'))
  assert.ok(v.errors.includes('Duplicate connection from "start" to "agent-1".'))
  assert.ok(v.errors.includes('Edge "e9" references a missing node.'))
})

test('Graph: exactly one trigger, it must be the entry, and it cannot have inputs', () => {
  const g = linear()
  g.nodes.push({ id: 'start-2', kind: 'trigger', label: 'Second' })
  g.edges.push({ id: 'e3', from: 'start-2', to: 'agent-1' })
  assert.ok(validateWorkflowGraph(g).errors.includes('A workflow must have exactly one trigger node.'))
  assert.ok(validateWorkflowGraph({ ...linear(), entryNodeId: 'agent-1' }).errors.includes('entryNodeId must identify a trigger node.'))
})

test('Graph: cycles are rejected until a bounded-loop node exists', () => {
  const g = linear()
  g.nodes.splice(2, 0, { id: 'agent-2', kind: 'agent', label: 'Loop', config: { agentId: 'x', evaluationRequired: true } })
  g.edges = [
    { id: 'e1', from: 'start', to: 'agent-1' },
    { id: 'e2', from: 'agent-1', to: 'agent-2' },
    { id: 'e3', from: 'agent-2', to: 'agent-1' },
    { id: 'e4', from: 'agent-2', to: 'done' },
  ]
  assert.ok(validateWorkflowGraph(g).errors.some((e) => e.includes('contains a cycle')))
})

test('Graph: dead ends, outputs with exits, and unreachable nodes are rejected', () => {
  const g = linear()
  g.nodes.push({ id: 'orphan', kind: 'output', label: 'Orphan' })
  g.edges.push({ id: 'e3', from: 'done', to: 'orphan' })
  const v = validateWorkflowGraph(g)
  assert.ok(v.errors.includes('Output node "done" cannot have outgoing edges.'))

  const h = linear()
  h.nodes.push({ id: 'island', kind: 'output', label: 'Island' })
  assert.ok(validateWorkflowGraph(h).errors.includes('Every workflow node must be reachable from the trigger.'))

  const d = linear()
  d.edges = d.edges.filter((edge) => edge.id !== 'e2')
  assert.ok(validateWorkflowGraph(d).errors.includes('Non-output node "agent-1" must connect to a next step.'))
})

test('Graph: condition nodes need exactly one true and one false branch; others cannot label branches', () => {
  const g = branching()
  g.edges = g.edges.map((edge) => edge.id === 'e3' ? { ...edge, branch: 'true' } : edge)
  assert.ok(validateWorkflowGraph(g).errors.some((e) => e.includes('one true and one false branch')))
  const h = linear()
  h.edges[0] = { ...h.edges[0]!, branch: 'true' }
  assert.ok(validateWorkflowGraph(h).errors.some((e) => e.includes('Only condition nodes may label')))
})

test('Graph: condition references must point to an earlier, connected step; $nqc must reference an agent', () => {
  const later = branching('$steps.done.value exists')
  assert.ok(validateWorkflowGraph(later).errors.some((e) => e.includes('may only reference an earlier step')))
  const missing = branching('$steps.ghost.value exists')
  assert.ok(validateWorkflowGraph(missing).errors.some((e) => e.includes('references missing node "ghost"')))
  const nqcOnTrigger = branching('$nqc.start.reasoningScore >= 70')
  assert.ok(validateWorkflowGraph(nqcOnTrigger).errors.some((e) => e.includes('does not reference an agent node')))
  const invalid = branching('process.exit(1)')
  assert.ok(validateWorkflowGraph(invalid).errors.some((e) => e.includes('invalid expression')))
})

test('Graph: governance config — agents need evaluation + id, side-effect tools need evaluation + approval', () => {
  const noEval = validateWorkflowGraph(linear({ evaluationRequired: false }))
  assert.ok(noEval.errors.includes('Agent node "agent-1" must require Quicksilver Engine evaluation.'))
  const sideEffect = validateWorkflowGraph(toolGraph({ sideEffect: true }))
  assert.ok(sideEffect.errors.includes('Side-effect tool node "tool-1" must require supervisor approval.'))
  assert.ok(sideEffect.errors.includes('Side-effect tool node "tool-1" must require evaluation.'))
  const high = validateWorkflowGraph(linear({ impact: 'high' }))
  assert.ok(high.errors.includes('High-impact node "agent-1" must require supervisor approval.'))
})

test('Graph: retry and timeout settings are bounded; tools can never be retried', () => {
  assert.ok(validateWorkflowGraph(linear({ maxAttempts: 11 })).errors.some((e) => e.includes('1 to 10')))
  assert.ok(validateWorkflowGraph(linear({ maxAttempts: 1.5 })).errors.some((e) => e.includes('1 to 10')))
  assert.ok(validateWorkflowGraph(linear({ timeoutMs: 0 })).errors.some((e) => e.includes('timeoutMs')))
  assert.ok(validateWorkflowGraph(linear({ timeoutMs: 300_001 })).errors.some((e) => e.includes('timeoutMs')))
  assert.ok(validateWorkflowGraph(toolGraph({ maxAttempts: 2 })).errors.some((e) => e.includes('tools are never retried')))
  assert.equal(validateWorkflowGraph(linear({ maxAttempts: 10, timeoutMs: 300_000 })).valid, true)
})

// ── condition language ────────────────────────────────────────────────────

test('Condition: every operator evaluates data only', () => {
  const ctx = {
    input: 'approved',
    outputs: { a: { count: 5, tags: ['x', 'y'], name: 'quicksilver', list: [{ v: 1 }] } },
    evaluations: { a: { reasoningScore: 82, safetyDecision: 'ALLOW' } },
  }
  assert.equal(evaluateWorkflowConditionExpression('$input == "approved"', ctx), true)
  assert.equal(evaluateWorkflowConditionExpression('$input != "approved"', ctx), false)
  assert.equal(evaluateWorkflowConditionExpression('$steps.a.count > 4', ctx), true)
  assert.equal(evaluateWorkflowConditionExpression('$steps.a.count >= 5', ctx), true)
  assert.equal(evaluateWorkflowConditionExpression('$steps.a.count < 5', ctx), false)
  assert.equal(evaluateWorkflowConditionExpression('$steps.a.count <= 5', ctx), true)
  assert.equal(evaluateWorkflowConditionExpression('$steps.a.tags contains "y"', ctx), true)
  assert.equal(evaluateWorkflowConditionExpression('$steps.a.name contains "silver"', ctx), true)
  assert.equal(evaluateWorkflowConditionExpression('$steps.a.list.0.v == 1', ctx), true)
  assert.equal(evaluateWorkflowConditionExpression('$steps.a.missing exists', ctx), false)
  assert.equal(evaluateWorkflowConditionExpression('$nqc.a.reasoningScore >= 70', ctx), true)
  assert.equal(evaluateWorkflowConditionExpression('$nqc.a.safetyDecision == "ALLOW"', ctx), true)
})

test('Condition: numeric operators on non-numbers throw instead of coercing', () => {
  assert.throws(() => evaluateWorkflowConditionExpression('$input > 3', { input: '10', outputs: {} }), /numeric value/)
  assert.throws(() => evaluateWorkflowConditionExpression('$input contains "a"', { input: 5, outputs: {} }), /contains operator/)
})

test('Condition: validator rejects code, unsupported paths, and malformed values', () => {
  for (const bad of ['', 'true', '$input === 1', '$env.SECRET == 1', '$input == undefined', '$input > "5"', '$input exists 1', '$nqc.a.secret == 1', '$steps.a.__proto__.x exists extra']) {
    assert.notEqual(validateWorkflowConditionExpression(bad), null, `expected "${bad}" to be rejected`)
  }
  assert.equal(validateWorkflowConditionExpression('$steps.agent-1.value exists'), null)
})

test('Condition: prototype properties are never resolved from step outputs', () => {
  assert.equal(evaluateWorkflowConditionExpression('$steps.a.constructor exists', { input: null, outputs: { a: {} } }), false)
})

test('Condition: node references are extracted for graph checks', () => {
  assert.deepEqual(workflowConditionNodeReference('$steps.agent-1.value exists'), { source: 'steps', nodeId: 'agent-1' })
  assert.deepEqual(workflowConditionNodeReference('$nqc.agent-1.brittleness == "low"'), { source: 'nqc', nodeId: 'agent-1' })
  assert.equal(workflowConditionNodeReference('$input exists'), null)
  assert.equal(workflowConditionNodeReference('nonsense'), null)
})

// ── runtime ───────────────────────────────────────────────────────────────

test('Runtime: an invalid graph is blocked before any handler runs', async () => {
  const h = handlers()
  const result = await executeWorkflowGraph({ ...linear(), entryNodeId: 'nope' }, 'x', h)
  assert.equal(result.status, 'blocked')
  assert.match(result.error ?? '', /invalid/)
  assert.deepEqual(h.calls, [])
})

test('Runtime: linear run executes the agent, evaluates the result, and passes output through', async () => {
  const h = handlers()
  const result = await executeWorkflowGraph(linear(), { q: 1 }, h)
  assert.equal(result.status, 'completed')
  assert.deepEqual(h.calls, ['agent:agent-1', 'eval:agent-1:result'])
  assert.deepEqual(result.outputs.start, { q: 1 })
  assert.deepEqual(result.outputs.done, { value: 'agent-1' })
  assert.deepEqual(result.steps.map((s) => [s.nodeId, s.status]), [['start', 'completed'], ['agent-1', 'completed'], ['done', 'completed']])
  assert.equal(result.steps[1]!.safetyDecision, 'ALLOW')
})

test('Runtime: condition selects exactly one branch and the other is recorded as skipped', async () => {
  for (const [input, taken, skipped] of [['go', 'yes', 'no'], ['stop', 'no', 'yes']] as const) {
    const h = handlers()
    const result = await executeWorkflowGraph(branching(), input, h)
    assert.equal(result.status, 'completed')
    assert.ok(h.calls.includes(`agent:${taken}`))
    assert.ok(!h.calls.includes(`agent:${skipped}`))
    assert.equal(result.steps.find((s) => s.nodeId === skipped)?.status, 'skipped')
    assert.deepEqual(result.outputs.done, { value: taken })
  }
})

test('Runtime: an inactive branch is never executed, even when concurrency is enabled', async () => {
  const h = handlers()
  const result = await executeWorkflowGraph(branching(), 'go', h, { maxConcurrentAgents: 4 })
  assert.equal(result.status, 'completed')
  assert.ok(h.calls.includes('agent:yes'))
  assert.ok(!h.calls.includes('agent:no'), 'false-branch agent must not run')
  assert.equal(result.steps.find((s) => s.nodeId === 'no')?.status, 'skipped')
  assert.deepEqual(result.outputs.done, { value: 'yes' })
})

test('Runtime: a failing condition expression fails the run', async () => {
  const result = await executeWorkflowGraph(branching('$input > 3'), 'text', handlers())
  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /numeric/)
})

test('Runtime: a custom condition handler must return a boolean', async () => {
  const result = await executeWorkflowGraph(branching(), 'go', handlers({ evaluateCondition: async () => 'yes' as unknown as boolean }))
  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /true or false/)
})

test('Runtime: evaluator BLOCK stops the run; ESCALATE requires approval', async () => {
  const blocked = await executeWorkflowGraph(linear(), 'x', handlers({ evaluate: async () => ({ safetyDecision: 'BLOCK', issues: ['ungrounded'] }) }))
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.error, 'ungrounded')
  assert.equal(blocked.steps.at(-1)?.safetyDecision, 'BLOCK')

  const h = handlers({ evaluate: async () => ({ safetyDecision: 'ESCALATE' }), approve: async () => ({ approved: false, reason: 'denied' }) })
  const escalated = await executeWorkflowGraph(linear(), 'x', h)
  assert.equal(escalated.status, 'blocked')
  assert.equal(escalated.error, 'denied')

  const approved = await executeWorkflowGraph(linear(), 'x', handlers({ evaluate: async () => ({ safetyDecision: 'ESCALATE' }) }))
  assert.equal(approved.status, 'completed')
})

test('Runtime: missing or malformed evaluator output fails closed', async () => {
  const noEvaluator = handlers()
  delete (noEvaluator as Partial<WorkflowRuntimeHandlers>).evaluate
  assert.equal((await executeWorkflowGraph(linear(), 'x', noEvaluator)).status, 'blocked')
  const garbage = await executeWorkflowGraph(linear(), 'x', handlers({ evaluate: async () => ({ safetyDecision: 'MAYBE' as 'ALLOW' }) }))
  assert.equal(garbage.status, 'blocked')
  const unsimulatedSkip = await executeWorkflowGraph(linear(), 'x', handlers({ evaluate: async () => ({ safetyDecision: 'SKIPPED' }) }))
  assert.equal(unsimulatedSkip.status, 'blocked')
})

test('Runtime: a simulated evaluation is shown as SKIPPED but cannot authorize high-impact work', async () => {
  const sim = handlers({ evaluate: async () => ({ safetyDecision: 'SKIPPED', simulated: true }) })
  const low = await executeWorkflowGraph(linear(), 'x', sim)
  assert.equal(low.status, 'completed')
  assert.equal(low.steps[1]!.safetyDecision, 'SKIPPED')
  const high = await executeWorkflowGraph(linear({ impact: 'high', supervisorApprovalRequired: true }), 'x', sim)
  assert.equal(high.status, 'blocked')
  assert.match(high.error ?? '', /simulated evaluator/)
})

test('Runtime: tools require NQC validation before dispatch', async () => {
  const h = handlers()
  delete (h as Partial<WorkflowRuntimeHandlers>).validateTool
  const result = await executeWorkflowGraph(toolGraph({}), 'x', h)
  assert.equal(result.status, 'blocked')
  assert.ok(!h.calls.includes('tool:tool-1'))

  const denied = handlers({ validateTool: async () => ({ allowed: false, reasons: ['schema mismatch'] }) })
  const r2 = await executeWorkflowGraph(toolGraph({}), 'x', denied)
  assert.equal(r2.error, 'schema mismatch')
  assert.ok(!denied.calls.includes('tool:tool-1'))
})

test('Runtime: side-effect tools are evaluated and approved before execution, in that order', async () => {
  const h = handlers()
  const result = await executeWorkflowGraph(toolGraph({ sideEffect: true, evaluationRequired: true, supervisorApprovalRequired: true }), 'x', h)
  assert.equal(result.status, 'completed')
  assert.deepEqual(h.calls, ['validate:tool-1', 'eval:tool-1:before-execution', 'approve:tool-1', 'tool:tool-1'])
})

test('Runtime: a denied or missing approval means the side-effect tool never runs', async () => {
  const cfg = { sideEffect: true, evaluationRequired: true, supervisorApprovalRequired: true }
  const denied = handlers({ approve: async () => ({ approved: false }) })
  assert.equal((await executeWorkflowGraph(toolGraph(cfg), 'x', denied)).status, 'blocked')
  assert.ok(!denied.calls.includes('tool:tool-1'))
  const none = handlers()
  delete (none as Partial<WorkflowRuntimeHandlers>).approve
  assert.equal((await executeWorkflowGraph(toolGraph(cfg), 'x', none)).status, 'blocked')
  assert.ok(!none.calls.includes('tool:tool-1'))
  const sim = handlers({ evaluate: async () => ({ safetyDecision: 'SKIPPED', simulated: true }) })
  assert.equal((await executeWorkflowGraph(toolGraph(cfg), 'x', sim)).status, 'blocked')
  assert.ok(!sim.calls.includes('tool:tool-1'))
})

test('Runtime: agent retries honour maxAttempts; tools are called once', async () => {
  let attempts = 0
  const flaky = handlers({ async runAgent() { attempts += 1; if (attempts < 3) throw new Error('transient'); return 'ok' } })
  const ok = await executeWorkflowGraph(linear({ maxAttempts: 3 }), 'x', flaky)
  assert.equal(ok.status, 'completed')
  assert.equal(attempts, 3)

  attempts = 0
  const alwaysFails = handlers({ async runAgent() { attempts += 1; throw new Error('down') } })
  const failed = await executeWorkflowGraph(linear({ maxAttempts: 2 }), 'x', alwaysFails)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.error, 'down')
  assert.equal(attempts, 2)

  let toolCalls = 0
  const toolFail = handlers({ async runTool() { toolCalls += 1; throw new Error('tool down') } })
  const t = await executeWorkflowGraph(toolGraph({}), 'x', toolFail)
  assert.equal(t.status, 'failed')
  assert.equal(toolCalls, 1)
})

test('Runtime: handler timeouts fail the step and abort the signal passed to the handler', async () => {
  let aborted = false
  const slow = handlers({
    runAgent: (_node, ctx) => new Promise((resolve) => {
      ctx.signal?.addEventListener('abort', () => { aborted = true })
      setTimeout(() => resolve('late'), 500)
    }),
  })
  const result = await executeWorkflowGraph(linear({ timeoutMs: 20 }), 'x', slow)
  assert.equal(result.status, 'failed')
  assert.match(result.error ?? '', /20 ms timeout/)
  assert.equal(aborted, true)
})

test('Runtime: maxConcurrentAgents is validated', async () => {
  for (const bad of [0, 17, 1.5]) {
    const result = await executeWorkflowGraph(linear(), 'x', handlers(), { maxConcurrentAgents: bad })
    assert.equal(result.status, 'blocked')
  }
})

test('Runtime: independent agents run concurrently up to the limit and all results reach the output', async () => {
  let active = 0
  let peak = 0
  const h = handlers({
    async runAgent(node) {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 15))
      active -= 1
      return node.id
    },
  })
  const result = await executeWorkflowGraph(fanOut(5), 'x', h, { maxConcurrentAgents: 3 })
  assert.equal(result.status, 'completed')
  assert.equal(peak, 3)
  assert.deepEqual([...(result.outputs.done as string[])].sort(), ['agent-0', 'agent-1', 'agent-2', 'agent-3', 'agent-4'])

  peak = 0
  await executeWorkflowGraph(fanOut(4), 'x', h)
  assert.equal(peak, 1, 'default is sequential')
})

test('Runtime: high-impact agents are never batched concurrently', async () => {
  const g = fanOut(3)
  for (const node of g.nodes) if (node.kind === 'agent') node.config = { ...node.config, impact: 'high', supervisorApprovalRequired: true }
  let active = 0
  let peak = 0
  const h = handlers({
    async runAgent() { active += 1; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active -= 1; return 1 },
  })
  const result = await executeWorkflowGraph(g, 'x', h, { maxConcurrentAgents: 8 })
  assert.equal(result.status, 'completed')
  assert.equal(peak, 1)
})

test('Runtime: one failure in a concurrent batch fails the run but records every sibling step', async () => {
  const h = handlers({ async runAgent(node) { if (node.id === 'agent-1') throw new Error('boom'); return node.id } })
  const result = await executeWorkflowGraph(fanOut(3), 'x', h, { maxConcurrentAgents: 3 })
  assert.equal(result.status, 'failed')
  assert.equal(result.error, 'boom')
  assert.equal(result.steps.filter((s) => s.nodeId.startsWith('agent-')).length, 3)
})

test('Runtime: the runner never mutates the caller-supplied graph', async () => {
  const g = branching()
  const snapshot = JSON.stringify(g)
  await executeWorkflowGraph(g, 'go', handlers(), { maxConcurrentAgents: 2 })
  assert.equal(JSON.stringify(g), snapshot)
})

test('Runtime: a run-level signal cancels at the next step boundary and aborts the in-flight handler', async () => {
  const controller = new AbortController()
  let handlerAborted = false
  const h = handlers({
    runAgent: (_node, ctx) => new Promise((resolve) => {
      ctx.signal?.addEventListener('abort', () => { handlerAborted = true })
      setTimeout(() => resolve('late'), 300)
    }),
  })
  setTimeout(() => controller.abort(new Error('operator stop')), 15)
  const result = await executeWorkflowGraph(linear({ maxAttempts: 3 }), 'x', h, { signal: controller.signal })
  assert.equal(result.status, 'cancelled')
  assert.equal(result.error, 'operator stop')
  assert.equal(handlerAborted, true)
  assert.equal(result.steps.at(-1)?.status, 'cancelled')
  assert.equal(h.calls.filter((c) => c.startsWith('agent:')).length, 0, 'a cancelled attempt is not retried')

  const pre = new AbortController()
  pre.abort()
  const before = handlers()
  const early = await executeWorkflowGraph(linear(), 'x', before, { signal: pre.signal })
  assert.equal(early.status, 'cancelled')
  assert.deepEqual(before.calls, [])
})

test('Runtime: a provider retry hint on a thrown error is surfaced on the failed step', async () => {
  const h = handlers({ async runAgent() { throw Object.assign(new Error('429 Too Many Requests'), { retryAfterMs: 12_000 }) } })
  const result = await executeWorkflowGraph(linear(), 'x', h)
  assert.equal(result.status, 'failed')
  assert.equal(result.steps.at(-1)?.retryAfterMs, 12_000)
})
