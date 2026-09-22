/**
 * Process engine tests.
 *
 * The definitions under test are imported straight from the Sanity seed
 * (apps/studio/seed/workflows.ts), so these tests exercise exactly the
 * process definitions that get loaded into Content Lake.
 *
 * Run with:   npm run kernel:test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  authorize,
  authorizeTransition,
  describeNextSteps,
  evaluateGuard,
  historyEntry,
  nextAutomaticTransition,
  processFromSanity,
  processToSanityFields,
  validateProcessDefinition,
} from './index.ts'
import type { Facts, ProcessActor, ProcessDefinition } from './index.ts'
import type { CapabilityRef, EntityRef, EvidenceRef, PolicyRef, ProposedAction } from './types.ts'
import { decisionLifecycle, paramChange } from '../../../apps/studio/seed/workflows.ts'

function toDefinition(seed: typeof decisionLifecycle): ProcessDefinition {
  return {
    id: seed._id,
    name: seed.name,
    version: seed.version,
    initialState: seed.initialState,
    states: seed.states,
    transitions: seed.transitions,
  }
}

const lifecycle = toDefinition(decisionLifecycle)
const param = toDefinition(paramChange)

const kernelActor: ProcessActor = { id: 'quicksilver-kernel', entityType: 'system' }
const human: ProcessActor = { id: 'entity-diego-ruiz', entityType: 'human' }
const agent: ProcessActor = { id: 'entity-engineering-agent', entityType: 'agent' }

// ── Validation ───────────────────────────────────────────────────────────

test('Process: both seeded process definitions are valid', () => {
  for (const def of [lifecycle, param]) {
    const v = validateProcessDefinition(def)
    assert.deepEqual(v.errors, [], `${def.name}: ${v.errors.join(' | ')}`)
    assert.equal(v.valid, true)
  }
})

test('Process validator: catches unreachable states, dead ends, dangling refs, and bad guards', () => {
  const broken: ProcessDefinition = {
    id: 'broken',
    name: 'Broken',
    version: 1,
    initialState: 'a',
    states: [
      { id: 'a', label: 'A' },
      { id: 'trap', label: 'Trap' },
      { id: 'orphan', label: 'Orphan' },
      { id: 'done', label: 'Done', terminal: true },
    ],
    transitions: [
      { id: 'a-trap', from: 'a', to: 'trap' },
      { id: 'a-done', from: 'a', to: 'done', guard: { all: [{ fact: 'risk', op: 'lte', value: 'high' }] } },
    ],
  }
  const v = validateProcessDefinition(broken)
  assert.equal(v.valid, false)
  assert.ok(v.errors.some((e) => e.includes('needs a number value')), v.errors.join(' | '))

  // Fix the guard; the graph errors now surface.
  broken.transitions[1]!.guard = { all: [{ fact: 'kernel.riskLevel', op: 'lte', value: 2 }] }
  const v2 = validateProcessDefinition(broken)
  assert.ok(v2.errors.some((e) => e.includes('"orphan" is unreachable')), v2.errors.join(' | '))
  assert.ok(v2.errors.some((e) => e.includes('"trap" can never reach a terminal state')), v2.errors.join(' | '))

  const dangling: ProcessDefinition = { ...lifecycle, transitions: [...lifecycle.transitions, { id: 'x', from: 'approved', to: 'nowhere' }] }
  assert.ok(validateProcessDefinition(dangling).errors.some((e) => e.includes('undeclared state "nowhere"')))

  const leavesTerminal: ProcessDefinition = { ...lifecycle, transitions: [...lifecycle.transitions, { id: 'undo', from: 'rejected', to: 'approved' }] }
  assert.ok(validateProcessDefinition(leavesTerminal).errors.some((e) => e.includes('leaves terminal state')))
})

test('Process validator: an automatic transition cannot also require a human', () => {
  const def: ProcessDefinition = {
    ...lifecycle,
    transitions: lifecycle.transitions.map((t) => (t.id === 'approve' ? { ...t, automatic: true } : t)),
  }
  assert.ok(validateProcessDefinition(def).errors.some((e) => e.includes('both automatic and requires human approval')))
})

// ── Guards ───────────────────────────────────────────────────────────────

test('Guards: missing facts fail closed and every operator behaves', () => {
  assert.equal(evaluateGuard({ all: [{ fact: 'kernel.riskLevel', op: 'lte', value: 2 }] }, {}).passed, false)
  assert.equal(evaluateGuard({ all: [{ fact: 'kernel.riskLevel', op: 'neq', value: 3 }] }, {}).passed, false)
  assert.equal(evaluateGuard({ all: [{ fact: 'x', op: 'exists' }] }, {}).passed, false)
  assert.equal(evaluateGuard({ all: [{ fact: 'x', op: 'exists', value: false }] }, {}).passed, true)
  const f: Facts = { n: 3, s: 'emergency', b: true }
  assert.equal(evaluateGuard({ all: [{ fact: 'n', op: 'gt', value: 2 }, { fact: 'n', op: 'gte', value: 3 }, { fact: 'n', op: 'lt', value: 4 }] }, f).passed, true)
  assert.equal(evaluateGuard({ all: [{ fact: 's', op: 'in', value: ['emergency', 'critical'] }] }, f).passed, true)
  assert.equal(evaluateGuard({ all: [{ fact: 's', op: 'notIn', value: ['emergency'] }] }, f).passed, false)
  assert.equal(evaluateGuard({ all: [{ fact: 'b', op: 'eq', value: true }] }, f).passed, true)
  // A string "3" is not the number 3: no silent coercion.
  assert.equal(evaluateGuard({ all: [{ fact: 'n', op: 'eq', value: '3' }] }, f).passed, false)
  // any: at least one.
  assert.equal(evaluateGuard({ any: [{ fact: 'n', op: 'eq', value: 9 }, { fact: 'b', op: 'eq', value: true }] }, f).passed, true)
  // Failures are explained in plain words.
  const r = evaluateGuard({ all: [{ fact: 'n', op: 'lte', value: 2 }] }, f)
  assert.deepEqual(r.failures, ['n is 3, needs lte 2'])
})

// ── Decision lifecycle, driven by the real kernel ────────────────────────

const entities: EntityRef[] = [
  { id: 'entity-engineering-agent', name: 'Engineering Agent', entityType: 'agent', capabilityIds: ['cap-process-param'], reportsToId: null },
  { id: 'entity-tom-bradley', name: 'Tom Bradley', entityType: 'human', capabilityIds: ['cap-machine-diagnostics'], reportsToId: null },
]
const capabilities: CapabilityRef[] = [
  { id: 'cap-process-param', name: 'Process Parameter Modification', baseRiskLevel: 4, authorizedEntityIds: ['entity-engineering-agent'] },
  { id: 'cap-machine-diagnostics', name: 'Machine Diagnostics', baseRiskLevel: 1, authorizedEntityIds: ['entity-tom-bradley'] },
]
const policies: PolicyRef[] = [
  { id: 'policy-ops-17', name: 'Operations Policy 17', scope: 'production.parameter_changes', priority: 5, expirationDate: null, supersedesIds: [], approvalRequirementIds: [] },
  { id: 'policy-emergency-4', name: 'Emergency Policy 4', scope: 'production.parameter_changes', priority: 7, expirationDate: null, supersedesIds: [], approvalRequirementIds: [] },
]
const evidence: EvidenceRef[] = [{ id: 'ev-1', title: 'Downtime report', confidence: 0.9 }]

function kernelFacts(action: ProposedAction, actor: EntityRef): Facts {
  const k = authorize({ action, actor, capabilities, policies, evidence, thresholds: { autoMax: 2, review: 3 } })
  return {
    'kernel.recommendation': k.recommendation,
    'kernel.authorized': k.authorized,
    'kernel.riskLevel': k.riskLevel,
    'kernel.requiresApproval': k.requiresApproval,
  }
}

const paramAction: ProposedAction = {
  description: 'Change CNC controller parameter X',
  actorId: 'entity-engineering-agent',
  capabilityId: 'cap-process-param',
  applicablePolicyIds: ['policy-ops-17', 'policy-emergency-4'],
  evidenceIds: ['ev-1'],
  financialExposure: 0,
  reversible: false,
  operationalImpact: 0,
  uncertainty: 0,
}
const diagnosticsAction: ProposedAction = {
  description: 'Run diagnostics on Press 4',
  actorId: 'entity-tom-bradley',
  capabilityId: 'cap-machine-diagnostics',
  applicablePolicyIds: [],
  evidenceIds: ['ev-1'],
  financialExposure: 0,
  reversible: true,
  operationalImpact: 0,
  uncertainty: 0,
}

test('Lifecycle: kill-shot parameter change routes to a human (policy conflict, risk 5)', () => {
  const facts = kernelFacts(paramAction, entities[0]!)
  assert.equal(facts['kernel.recommendation'], 'request-approval')
  const step = nextAutomaticTransition(lifecycle, 'proposed', facts)
  assert.equal(step?.transition?.id, 'route-to-human')
  assert.equal(step?.to, 'awaiting-approval')
})

test('Lifecycle: low-risk diagnostics is auto-approved by the kernel, no human click', () => {
  const facts = kernelFacts(diagnosticsAction, entities[1]!)
  assert.equal(facts['kernel.recommendation'], 'execute-autonomously')
  const step = nextAutomaticTransition(lifecycle, 'proposed', facts)
  assert.equal(step?.transition?.id, 'auto-approve')
  assert.equal(step?.to, 'approved')
})

test('Lifecycle: the autonomy ceiling in content beats loosened env thresholds', () => {
  // Someone raises the kernel threshold so a risk-3 action is "autonomous"...
  const facts: Facts = { 'kernel.recommendation': 'execute-autonomously', 'kernel.authorized': true, 'kernel.riskLevel': 3 }
  // ...but the process definition still caps auto-approval at risk 2.
  const step = nextAutomaticTransition(lifecycle, 'proposed', facts)
  assert.equal(step?.transition?.id, 'route-to-human')

  // Raise the ceiling in the definition (what an edit in Studio does) and behavior follows.
  const raised: ProcessDefinition = {
    ...lifecycle,
    version: 2,
    transitions: lifecycle.transitions.map((t) =>
      t.id === 'auto-approve'
        ? { ...t, guard: { all: t.guard!.all!.map((c) => (c.fact === 'kernel.riskLevel' ? { ...c, value: 3 } : c)) } }
        : t,
    ),
  }
  // route-to-human still has "riskLevel gt 2" in its own guard, but auto-approve is declared first.
  assert.equal(nextAutomaticTransition(raised, 'proposed', facts)?.transition?.id, 'auto-approve')
})

test('Lifecycle: a kernel hard block always wins, even at high risk', () => {
  const facts: Facts = { 'kernel.recommendation': 'reject', 'kernel.authorized': false, 'kernel.riskLevel': 5 }
  assert.equal(nextAutomaticTransition(lifecycle, 'proposed', facts)?.transition?.id, 'kernel-reject')
})

test('Lifecycle: rollback decisions always route to a human, with no kernel facts at all', () => {
  const step = nextAutomaticTransition(lifecycle, 'proposed', { 'decision.kind': 'rollback' })
  assert.equal(step?.transition?.id, 'route-to-human')
})

test('Lifecycle: approving needs a human; an agent is refused with a reason', () => {
  const byAgent = authorizeTransition({ definition: lifecycle, currentState: 'awaiting-approval', transitionId: 'approve', facts: {}, actor: agent })
  assert.equal(byAgent.allowed, false)
  assert.match(byAgent.reasons.join(' '), /requires a human/)
  const byHuman = authorizeTransition({ definition: lifecycle, currentState: 'awaiting-approval', transitionId: 'approve', facts: {}, actor: human })
  assert.equal(byHuman.allowed, true)
  assert.equal(byHuman.to, 'approved')
})

test('Lifecycle: illegal jumps are refused (cannot approve a rejected or executed decision)', () => {
  for (const state of ['rejected', 'executed']) {
    const r = authorizeTransition({ definition: lifecycle, currentState: state, transitionId: 'approve', facts: {}, actor: human })
    assert.equal(r.allowed, false, state)
    assert.match(r.reasons[0]!, /has no transition "approve"/)
  }
  const exec = authorizeTransition({ definition: lifecycle, currentState: 'awaiting-approval', to: 'executed', facts: { 'execution.success': true }, actor: kernelActor })
  assert.equal(exec.allowed, false)
})

test('Lifecycle: execution outcome picks executed vs failed by guard', () => {
  const ok = authorizeTransition({ definition: lifecycle, currentState: 'approved', to: 'executed', facts: { 'execution.success': true }, actor: kernelActor })
  assert.equal(ok.allowed, true)
  const wrong = authorizeTransition({ definition: lifecycle, currentState: 'approved', to: 'executed', facts: { 'execution.success': false }, actor: kernelActor })
  assert.equal(wrong.allowed, false)
  assert.match(wrong.reasons[0]!, /execution\.success is false, needs eq true/)
  const failed = authorizeTransition({ definition: lifecycle, currentState: 'approved', to: 'failed', facts: { 'execution.success': false }, actor: kernelActor })
  assert.equal(failed.allowed, true)
})

test('Lifecycle: rollback needs an observed deviation (after success) or a failure', () => {
  const noDeviation = authorizeTransition({ definition: lifecycle, currentState: 'executed', to: 'rollback-proposed', facts: { 'observation.deviationDetected': false }, actor: human })
  assert.equal(noDeviation.allowed, false)
  const deviation = authorizeTransition({ definition: lifecycle, currentState: 'executed', to: 'rollback-proposed', facts: { 'observation.deviationDetected': true }, actor: human })
  assert.equal(deviation.allowed, true)
  assert.equal(deviation.transition?.id, 'propose-rollback')
  const afterFailure = authorizeTransition({ definition: lifecycle, currentState: 'failed', to: 'rollback-proposed', facts: {}, actor: human })
  assert.equal(afterFailure.transition?.id, 'propose-rollback-after-failure')
  const done = authorizeTransition({ definition: lifecycle, currentState: 'rollback-proposed', to: 'rolled-back', facts: { 'rollback.executed': true }, actor: kernelActor })
  assert.equal(done.allowed, true)
})

test('Lifecycle: an invalid definition authorizes nothing (a broken playbook stops the line)', () => {
  const broken: ProcessDefinition = { ...lifecycle, initialState: 'nope' }
  const r = authorizeTransition({ definition: broken, currentState: 'awaiting-approval', transitionId: 'approve', facts: {}, actor: human })
  assert.equal(r.allowed, false)
  assert.match(r.reasons[0]!, /is invalid/)
  assert.equal(nextAutomaticTransition(broken, 'proposed', { 'kernel.recommendation': 'reject' }), null)
})

test('Lifecycle: history entries carry the definition version and revision', () => {
  const def: ProcessDefinition = { ...lifecycle, revision: 'rev-abc' }
  const d = authorizeTransition({ definition: def, currentState: 'awaiting-approval', transitionId: 'approve', facts: {}, actor: human })
  const h = historyEntry(def, d, human, '2026-09-22T00:00:00.000Z')
  assert.deepEqual(h, {
    transitionId: 'approve',
    from: 'awaiting-approval',
    to: 'approved',
    actorId: 'entity-diego-ruiz',
    actorType: 'human',
    at: '2026-09-22T00:00:00.000Z',
    processVersion: 1,
    processRevision: 'rev-abc',
  })
  const refused = authorizeTransition({ definition: def, currentState: 'awaiting-approval', transitionId: 'approve', facts: {}, actor: agent })
  assert.throws(() => historyEntry(def, refused, agent, 'now'))
})

test('Lifecycle: describeNextSteps shows the next gate for the UI', () => {
  const s = describeNextSteps(lifecycle, 'awaiting-approval', {})
  assert.equal(s.stateLabel, 'Awaiting human approval')
  assert.deepEqual(s.next.map((n) => n.id), ['approve', 'reject', 'request-evidence'])
  assert.ok(s.next.every((n) => n.requiresHuman))
})

// ── Parameter change process (declared, validated) ───────────────────────

test('Param change: without an emergency, deployment needs a human even if kernel says no approval', () => {
  const facts: Facts = { 'kernel.requiresApproval': false, 'incident.classification': 'routine' }
  assert.equal(nextAutomaticTransition(param, 'approval', facts), null)
  const human2 = authorizeTransition({ definition: param, currentState: 'approval', transitionId: 'deploy-approved', facts, actor: human })
  assert.equal(human2.allowed, true)
  const emergency = nextAutomaticTransition(param, 'approval', { ...facts, 'incident.classification': 'emergency' })
  assert.equal(emergency?.transition?.id, 'deploy-autonomously')
})

// ── Sanity round-trip ────────────────────────────────────────────────────

test('Sanity mapping: definitions round-trip exactly through the document shape', () => {
  for (const def of [lifecycle, param]) {
    const doc = { _id: def.id, _rev: 'r1', ...processToSanityFields(def) }
    const back = processFromSanity(doc)
    const normalize = (d: ProcessDefinition) => ({
      ...d,
      revision: undefined,
      states: d.states.map((s) => ({ ...s, terminal: s.terminal ?? false })),
      transitions: d.transitions.map((t) => ({
        ...t,
        label: t.label ?? t.id,
        automatic: t.automatic ?? false,
        requiresHumanApproval: t.requiresHumanApproval ?? false,
      })),
    })
    assert.deepEqual(normalize(back), normalize(def))
    assert.equal(back.revision, 'r1')
    assert.equal(validateProcessDefinition(back).valid, true)
  }
})

test('Sanity mapping: a half-filled document is rejected by validation, not patched up', () => {
  const back = processFromSanity({ _id: 'x', name: 'Draft', states: [{ id: 'a', label: 'A' }] })
  const v = validateProcessDefinition(back)
  assert.equal(v.valid, false)
  assert.ok(v.errors.some((e) => e.includes('Version')))
  assert.ok(v.errors.some((e) => e.includes('Initial state')))
})
