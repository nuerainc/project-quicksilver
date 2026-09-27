/** M7 part 2: capability graph (inheritance, dependencies, conflicts, risk multipliers). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyRiskMultiplier,
  authorize,
  buildCapabilityGraph,
  checkCapability,
  MIN_SOLE_OPERATOR_JUSTIFICATION,
  validateCapabilityGraph,
} from './index.ts'
import type { CapabilityRef, EntityRef, EvidenceRef, PolicyRef, ProposedAction } from './index.ts'

const C = (c: Partial<CapabilityRef> & { id: string }): CapabilityRef => ({ name: c.id, baseRiskLevel: 0, authorizedEntityIds: ['ana'], ...c })
const ana = (caps: string[]): EntityRef => ({ id: 'ana', name: 'Ana', entityType: 'human', capabilityIds: caps })
const ev: EvidenceRef[] = [{ id: 'ev', title: 'E', confidence: 0.9 }]
const act = (capabilityId: string, extra: Partial<ProposedAction> = {}): ProposedAction => ({
  description: 'Refund a customer', actorId: 'ana', capabilityId, applicablePolicyIds: [], evidenceIds: ['ev'],
  reversible: true, operationalImpact: 0, uncertainty: 0, ...extra,
})
const run = (capabilityId: string, capabilities: CapabilityRef[], holds: string[], extra: Partial<Parameters<typeof authorize>[0]> = {}) =>
  authorize({ action: act(capabilityId), actor: ana(holds), capabilities, policies: [], evidence: ev, thresholds: { autoMax: 2, review: 3 }, ...extra })

const refunds: CapabilityRef[] = [
  C({ id: 'payments.refund', baseRiskLevel: 2, policyScopes: ['finance.payments'], riskMultiplier: 1 }),
  C({ id: 'payments.refund-large', baseRiskLevel: 1, inherits: ['payments.refund'], policyScopes: ['finance.large'] }),
]

test('Graph: without graph fields a capability resolves to itself and authorize() is unchanged', () => {
  const caps = [C({ id: 'plain', baseRiskLevel: 1, policyScopes: ['ops'] })]
  const g = buildCapabilityGraph(caps)
  const r = g.capabilities.get('plain')!
  assert.deepEqual(
    { scopes: r.effectiveScopes, base: r.effectiveBaseRiskLevel, m: r.riskMultiplier, req: r.transitiveRequires, conf: r.conflictsWith, anc: r.ancestors },
    { scopes: ['ops'], base: 1, m: 1, req: [], conf: [], anc: [] },
  )
  assert.deepEqual(g.problems, [])
  const d = run('plain', caps, ['plain'])
  assert.equal(d.riskLevel, 1)
  assert.equal(d.recommendation, 'execute-autonomously')
  assert.equal(d.capabilityGraph!.riskMultiplier, 1)
  assert.deepEqual(d.capabilityGraph!.effectiveScopes, ['ops'])
})

test('Inheritance: a child inherits its parents\' scopes (union) and base-risk floor', () => {
  const r = buildCapabilityGraph(refunds).capabilities.get('payments.refund-large')!
  assert.deepEqual(r.effectiveScopes, ['finance.large', 'finance.payments'])
  assert.equal(r.ownBaseRiskLevel, 1)
  assert.equal(r.effectiveBaseRiskLevel, 2)
  assert.deepEqual(r.ancestors, ['payments.refund'])
})

test('Inheritance: a policy on the parent\'s scope governs the child', () => {
  const deny: PolicyRef = { id: 'no-refunds', name: 'No refunds', scope: 'finance.payments', priority: 5, effectiveDate: '2020-01-01', expirationDate: null, supersedesIds: [], approvalRequirementIds: [], effect: 'deny' }
  const d = run('payments.refund-large', refunds, ['payments.refund-large'], { policies: [deny] })
  assert.equal(d.recommendation, 'reject')
  assert.deepEqual(d.uncitedPolicyIds, ['no-refunds'])
})

test('Inheritance never grants: holding the parent does not allow the child, nor the child the parent', () => {
  const child = run('payments.refund-large', refunds, ['payments.refund'])
  assert.equal(child.recommendation, 'reject')
  assert.match(child.blockingReasons[0]!, /does not have capability "payments.refund-large"/)
  const parent = run('payments.refund', refunds, ['payments.refund-large'])
  assert.equal(parent.recommendation, 'reject')
})

test('Inheritance: diamond ancestors count once for the multiplier; chains multiply', () => {
  const caps = [
    C({ id: 'root', riskMultiplier: 2 }),
    C({ id: 'left', inherits: ['root'] }),
    C({ id: 'right', inherits: ['root'], riskMultiplier: 1.5 }),
    C({ id: 'leaf', inherits: ['left', 'right'] }),
  ]
  const g = buildCapabilityGraph(caps)
  assert.equal(g.capabilities.get('leaf')!.riskMultiplier, 3)
  assert.deepEqual(g.capabilities.get('leaf')!.ancestors, ['left', 'right', 'root'])
})

test('Requires: the actor must hold every required capability, transitively', () => {
  const caps = [C({ id: 'x', requires: ['y'] }), C({ id: 'y', requires: ['z'] }), C({ id: 'z' })]
  assert.deepEqual(buildCapabilityGraph(caps).capabilities.get('x')!.transitiveRequires, ['y', 'z'])
  const missing = run('x', caps, ['x', 'y'])
  assert.equal(missing.recommendation, 'reject')
  assert.match(missing.blockingReasons.join(' '), /requires "z", which Ana does not hold/)
  assert.deepEqual(missing.capabilityGraph!.missingRequires, ['z'])
  const ok = run('x', caps, ['x', 'y', 'z'])
  assert.equal(ok.recommendation, 'execute-autonomously')
  assert.deepEqual(ok.capabilityGraph!.requires, ['y', 'z'])
})

test('Requires: holding means in the profile AND granted', () => {
  const caps = [C({ id: 'x', requires: ['y'] }), C({ id: 'y', authorizedEntityIds: [] })]
  assert.equal(run('x', caps, ['x', 'y']).recommendation, 'reject')
})

test('Requires: a child inherits its parent\'s dependencies', () => {
  const caps = [C({ id: 'parent', requires: ['training'] }), C({ id: 'child', inherits: ['parent'] }), C({ id: 'training' })]
  const d = run('child', caps, ['child'])
  assert.equal(d.recommendation, 'reject')
  assert.deepEqual(d.capabilityGraph!.missingRequires, ['training'])
})

test('Conflicts: an actor holding both is refused for either; other capabilities are unaffected', () => {
  const caps = [C({ id: 'pay.create' }), C({ id: 'pay.approve', conflictsWith: ['pay.create'] }), C({ id: 'reports' })]
  for (const use of ['pay.create', 'pay.approve']) {
    const d = run(use, caps, ['pay.create', 'pay.approve', 'reports'])
    assert.equal(d.recommendation, 'reject', use)
    assert.match(d.blockingReasons.join(' '), /conflicting .*Separation of duties/)
    assert.equal(d.capabilityGraph!.conflictsHeld.length, 1)
  }
  assert.equal(run('reports', caps, ['pay.create', 'pay.approve', 'reports']).recommendation, 'execute-autonomously')
})

test('Conflicts: a grant alone (not in the profile) still counts as holding for conflicts', () => {
  const caps = [C({ id: 'pay.create' }), C({ id: 'pay.approve', conflictsWith: ['pay.create'] })]
  assert.equal(run('pay.approve', caps, ['pay.approve']).recommendation, 'reject')
})

test('Conflicts: a conflict with a parent is a conflict with its children', () => {
  const caps = [C({ id: 'audit', conflictsWith: ['pay'] }), C({ id: 'pay' }), C({ id: 'pay.large', inherits: ['pay'], authorizedEntityIds: ['ana'] })]
  const caps2 = caps.map((c) => (c.id === 'pay' ? { ...c, authorizedEntityIds: [] } : c))
  const d = run('audit', caps2, ['audit', 'pay.large'])
  assert.equal(d.recommendation, 'reject')
  assert.deepEqual(d.capabilityGraph!.conflictsHeld, ['pay.large'])
})

test('Conflicts: the sole-operator override from separation of duties applies, and still goes to a human', () => {
  const caps = [C({ id: 'pay.create' }), C({ id: 'pay.approve', conflictsWith: ['pay.create'] })]
  const holds = ['pay.create', 'pay.approve']
  const justification = 'Single-founder lab; no second person exists to split these duties.'
  assert.ok(justification.length >= MIN_SOLE_OPERATOR_JUSTIFICATION)
  const ok = run('pay.approve', caps, holds, { separation: { soleOperatorId: 'ana', justification } })
  assert.equal(ok.authorized, true)
  assert.equal(ok.recommendation, 'request-approval')
  assert.equal(ok.capabilityGraph!.soleOperatorOverride, true)
  assert.ok(ok.concerns.some((c) => /waived by the sole operator/.test(c)))
  const short = run('pay.approve', caps, holds, { separation: { soleOperatorId: 'ana', justification: 'ok' } })
  assert.equal(short.recommendation, 'reject')
  assert.match(short.blockingReasons.join(' '), /justification/)
  const someoneElse = run('pay.approve', caps, holds, { separation: { soleOperatorId: 'founder', justification } })
  assert.equal(someoneElse.recommendation, 'reject')
})

test('Model check: entities holding conflicting capabilities are reported', () => {
  const caps = [C({ id: 'a', conflictsWith: ['b'] }), C({ id: 'b', authorizedEntityIds: [] })]
  const problems = validateCapabilityGraph(caps, [ana(['a', 'b']), { id: 'bo', name: 'Bo', entityType: 'human', capabilityIds: ['b'] }])
  assert.deepEqual(problems.map((p) => [p.code, p.entityId, p.capabilityIds]), [['conflicting-holdings', 'ana', ['a', 'b']]])
})

test('Risk multiplier: rounds up, clamps to 5, and ignores values at or below 1', () => {
  assert.equal(applyRiskMultiplier(2, 1.5), 3)
  assert.equal(applyRiskMultiplier(2, 1.1), 3)
  assert.equal(applyRiskMultiplier(2, 1.5 * 2), 5)
  assert.equal(applyRiskMultiplier(1, 1.5 * 2), 3)
  assert.equal(applyRiskMultiplier(0, 4), 0)
  assert.equal(applyRiskMultiplier(4, 1), 4)
  assert.equal(applyRiskMultiplier(3, 0.1 * 3 + 0.7), 3, 'float noise around 1 does not round up')
})

test('Risk multiplier: applied before policies see the risk, and shown in the decision record', () => {
  const caps = [C({ id: 'send', baseRiskLevel: 2, riskMultiplier: 1.5, policyScopes: ['ops'] })]
  const allowUpTo2: PolicyRef = { id: 'ok', name: 'OK up to 2', scope: 'ops', priority: 5, effectiveDate: '2020-01-01', expirationDate: null, supersedesIds: [], approvalRequirementIds: [], effect: 'allow', maxRiskLevel: 2 }
  const d = run('send', caps, ['send'], { policies: [allowUpTo2] })
  assert.equal(d.riskLevel, 3)
  assert.equal(d.capabilityGraph!.riskBeforeMultiplier, 2)
  assert.equal(d.capabilityGraph!.riskAfterMultiplier, 3)
  assert.equal(d.capabilityGraph!.riskMultiplier, 1.5)
  assert.match(d.policyChecks[0]!.reason, /effect require-approval/)
  assert.equal(d.recommendation, 'request-approval')
})

test('Validation: cycles, unknown ids, requires-and-conflicts, bad multipliers, duplicates, self-conflict', () => {
  const codes = (caps: CapabilityRef[]) => validateCapabilityGraph(caps).map((p) => p.code).sort()
  assert.deepEqual(codes([C({ id: 'a', inherits: ['b'] }), C({ id: 'b', inherits: ['c'] }), C({ id: 'c', inherits: ['a'] })]), ['inheritance-cycle'])
  assert.deepEqual(codes([C({ id: 'a', requires: ['b'] }), C({ id: 'b', requires: ['a'] })]), ['requires-cycle'])
  assert.deepEqual(codes([C({ id: 'a', inherits: ['ghost'], requires: ['nope'], conflictsWith: ['none'] })]), ['unknown-reference', 'unknown-reference', 'unknown-reference'])
  assert.deepEqual(codes([C({ id: 'a', requires: ['b'], conflictsWith: ['b'] }), C({ id: 'b' })]), ['requires-and-conflicts'])
  assert.deepEqual(codes([C({ id: 'a', requires: ['b'] }), C({ id: 'b', requires: ['c'] }), C({ id: 'c', conflictsWith: ['a'] })]).filter((c) => c === 'requires-and-conflicts'), ['requires-and-conflicts'])
  for (const m of [0.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.deepEqual(codes([C({ id: 'a', riskMultiplier: m })]), ['invalid-multiplier'], String(m))
  assert.deepEqual(codes([C({ id: 'a' }), C({ id: 'a' })]), ['duplicate-id'])
  assert.deepEqual(codes([C({ id: 'a', conflictsWith: ['a'] })]), ['conflicts-with-self'])
  const cycle = validateCapabilityGraph([C({ id: 'a', inherits: ['b'] }), C({ id: 'b', inherits: ['a'] })])[0]!
  assert.match(cycle.message, /a → b → a/)
})

test('Fail closed: authorize() refuses a capability whose graph is invalid, but not an unrelated one', () => {
  const caps = [
    C({ id: 'a', inherits: ['b'] }), C({ id: 'b', inherits: ['a'] }),
    C({ id: 'uses-a', requires: ['a'] }),
    C({ id: 'bad', riskMultiplier: 0.5 }),
    C({ id: 'fine' }),
  ]
  const holdsAll = ['a', 'b', 'uses-a', 'bad', 'fine']
  for (const id of ['a', 'uses-a', 'bad']) {
    const d = run(id, caps, holdsAll)
    assert.equal(d.recommendation, 'reject', id)
    assert.match(d.blockingReasons.join(' '), /capability graph is invalid/, id)
  }
  assert.equal(run('fine', caps, holdsAll).recommendation, 'execute-autonomously')
  assert.equal(checkCapability(ana(holdsAll), act('bad'), caps).allowed, false)
})
