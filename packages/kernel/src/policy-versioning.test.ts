/** M7 part 1: policy versioning, supersession and scope nesting. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authorize, checkAuthority, scopeIncludes, validatePolicySet } from './index.ts'
import type { CapabilityRef, EntityRef, EvidenceRef, PolicyRef, ProposedAction } from './index.ts'

const NOW = new Date('2026-10-01T00:00:00Z')
const base = { scope: 'finance.payments', effectiveDate: '2026-01-01', expirationDate: null, supersedesIds: [], approvalRequirementIds: [] }
const P = (p: Partial<PolicyRef> & { id: string }): PolicyRef => ({ name: p.id, priority: 5, ...base, ...p }) as PolicyRef
const act = (ids: string[], extra: Partial<ProposedAction> = {}): ProposedAction => ({
  description: 'Pay a vendor', actorId: 'agent', capabilityId: 'cap', applicablePolicyIds: ids,
  evidenceIds: ['ev'], reversible: true, operationalImpact: 0, uncertainty: 0, ...extra,
})
const row = (r: { checks: { policyId: string }[] }, id: string) => r.checks.find((c) => c.policyId === id) as NonNullable<ReturnType<typeof checkAuthority>['checks'][number]>

const actor: EntityRef = { id: 'agent', name: 'Agent', entityType: 'agent', capabilityIds: ['cap'] }
const ev: EvidenceRef[] = [{ id: 'ev', title: 'E', confidence: 0.9 }]
const cap = (scopes: string[]): CapabilityRef[] => [{ id: 'cap', name: 'Cap', baseRiskLevel: 0, authorizedEntityIds: ['agent'], policyScopes: scopes }]

// ── Versions ────────────────────────────────────────────────────────────────

test('Versions: only the highest live version in a lineage applies', () => {
  const r = checkAuthority(act(['v1', 'v2', 'v3']), [
    P({ id: 'v1', lineageId: 'pay', version: 1, effect: 'deny' }),
    P({ id: 'v2', lineageId: 'pay', version: 2, effect: 'deny' }),
    P({ id: 'v3', lineageId: 'pay', version: 3, effect: 'require-approval' }),
  ], { now: NOW })
  assert.deepEqual(r.applicablePolicyIds, ['v3'])
  for (const id of ['v1', 'v2']) {
    assert.equal(row(r, id).result, 'superseded')
    assert.equal(row(r, id).reasonCode, 'superseded-by-version')
    assert.equal(row(r, id).supersededById, 'v3')
    assert.match(row(r, id).reason, /newer version 3 of lineage "pay"/)
  }
  assert.deepEqual(r.blockingReasons, [])
  assert.deepEqual(r.conflicts, [])
})

test('Versions: a newer version that is not yet effective does not supersede yet', () => {
  const r = checkAuthority(act(['v1', 'v2']), [
    P({ id: 'v1', lineageId: 'pay', version: 1, effect: 'deny' }),
    P({ id: 'v2', lineageId: 'pay', version: 2, effect: 'allow', effectiveDate: '2027-01-01' }),
  ], { now: NOW, riskLevel: 0 })
  assert.equal(row(r, 'v1').result, 'applies')
  assert.equal(row(r, 'v2').reasonCode, 'not-yet-effective')
  assert.equal(r.blockingReasons.length, 1)
})

test('Versions: an expired newest version hands back to the highest live one', () => {
  const r = checkAuthority(act(['v1', 'v2', 'v3']), [
    P({ id: 'v1', lineageId: 'pay', version: 1 }),
    P({ id: 'v2', lineageId: 'pay', version: 2, effect: 'require-approval' }),
    P({ id: 'v3', lineageId: 'pay', version: 3, expirationDate: '2026-06-01' }),
  ], { now: NOW })
  assert.equal(row(r, 'v3').reasonCode, 'expired')
  assert.equal(row(r, 'v2').result, 'applies')
  assert.equal(row(r, 'v1').supersededById, 'v2')
})

test('Versions: a newer version outside this action\'s scope still supersedes, is recorded out-of-scope, and a human confirms', () => {
  const r = checkAuthority(act([]), [
    P({ id: 'v1', lineageId: 'pay', version: 1, effect: 'deny' }),
    P({ id: 'v2', lineageId: 'pay', version: 2, effect: 'deny', scope: 'finance.payroll' }),
  ], { now: NOW, governingScopes: ['finance.payments'] })
  assert.equal(row(r, 'v1').reasonCode, 'superseded-by-version')
  assert.match(row(r, 'v1').reason, /does not govern this action/)
  assert.equal(row(r, 'v2').result, 'inapplicable')
  assert.equal(row(r, 'v2').reasonCode, 'out-of-scope')
  assert.deepEqual(r.blockingReasons, [])
  assert.equal(r.approvalReasons.length, 1)
  assert.match(r.approvalReasons[0]!, /newer version v2 \(version 2\) does not/)
})

test('Versions: two live policies at the top version are not silently picked', () => {
  const r = checkAuthority(act(['a', 'b', 'old']), [
    P({ id: 'old', lineageId: 'pay', version: 1 }),
    P({ id: 'a', lineageId: 'pay', version: 2, effect: 'allow', priority: 9 }),
    P({ id: 'b', lineageId: 'pay', version: 2, effect: 'deny', priority: 1 }),
  ], { now: NOW, riskLevel: 0 })
  assert.equal(row(r, 'old').reasonCode, 'superseded-by-version')
  assert.equal(row(r, 'a').result, 'applies')
  assert.equal(row(r, 'b').result, 'applies')
  assert.ok(r.conflicts.some((c) => /2 live policies at version 2/.test(c)))
})

test('Versions: a live lineage member without a version leaves the lineage unresolved (all apply, human review)', () => {
  const r = checkAuthority(act(['a', 'b']), [
    P({ id: 'a', lineageId: 'pay', version: 1, effect: 'require-approval' }),
    P({ id: 'b', lineageId: 'pay', effect: 'require-approval' }),
  ], { now: NOW })
  assert.deepEqual(r.applicablePolicyIds, ['a', 'b'])
  assert.ok(r.conflicts.some((c) => /without a valid version/.test(c)))
})

// ── Supersession and cycles ─────────────────────────────────────────────────

test('Supersession: rows carry reason codes (superseded-by-id, expired, not-yet-effective, conditions-not-met, applies)', () => {
  const r = checkAuthority(act(['old', 'new', 'gone', 'later', 'cond']), [
    P({ id: 'old' }),
    P({ id: 'new', supersedesIds: ['old'], scope: 's1' }),
    P({ id: 'gone', expirationDate: '2026-02-01', scope: 's2' }),
    P({ id: 'later', effectiveDate: '2027-01-01', scope: 's3' }),
    P({ id: 'cond', effect: 'allow', when: { all: [{ fact: 'x', op: 'eq', value: 1 }] }, scope: 's4' }),
  ], { now: NOW, riskLevel: 0 })
  assert.equal(row(r, 'old').reasonCode, 'superseded-by-id')
  assert.equal(row(r, 'old').supersededById, 'new')
  assert.equal(row(r, 'new').reasonCode, 'applies')
  assert.equal(row(r, 'gone').reasonCode, 'expired')
  assert.equal(row(r, 'later').reasonCode, 'not-yet-effective')
  assert.equal(row(r, 'cond').reasonCode, 'conditions-not-met')
})

test('Supersession: a policy that is not yet effective no longer supersedes its predecessor early', () => {
  const r = checkAuthority(act(['cur', 'next']), [
    P({ id: 'cur', effect: 'require-approval' }),
    P({ id: 'next', effect: 'allow', supersedesIds: ['cur'], effectiveDate: '2027-01-01' }),
  ], { now: NOW, riskLevel: 0 })
  assert.equal(row(r, 'cur').result, 'applies')
  assert.equal(r.approvalReasons.length, 1)
})

test('Cycle: two live candidates superseding each other route to a human, and neither is picked', () => {
  const policies = [P({ id: 'a', effect: 'allow', supersedesIds: ['b'] }), P({ id: 'b', effect: 'allow', supersedesIds: ['a'] })]
  const r = checkAuthority(act(['a', 'b']), policies, { now: NOW, riskLevel: 0 })
  assert.deepEqual(r.applicablePolicyIds, [])
  assert.equal(row(r, 'a').result, 'conflicts')
  assert.equal(row(r, 'b').reasonCode, 'supersession-cycle')
  assert.equal(r.conflicts.length, 1)
  assert.match(r.conflicts[0]!, /Supersession cycle among live policies: a → b → a/)
  const d = authorize({ action: act(['a', 'b']), actor, capabilities: cap([]), policies, evidence: ev })
  assert.equal(d.recommendation, 'request-approval')
  assert.ok(d.concerns.some((c) => /cycle/.test(c)))
})

test('Cycle: a three-policy cycle is caught too; a policy outside it still applies', () => {
  const r = checkAuthority(act(['a', 'b', 'c', 'x']), [
    P({ id: 'a', supersedesIds: ['b'] }), P({ id: 'b', supersedesIds: ['c'] }), P({ id: 'c', supersedesIds: ['a'] }),
    P({ id: 'x', scope: 'other', effect: 'require-approval' }),
  ], { now: NOW })
  assert.deepEqual(r.checks.filter((c) => c.reasonCode === 'supersession-cycle').map((c) => c.policyId), ['a', 'b', 'c'])
  assert.match(r.conflicts[0]!, /a → b → c → a/)
  assert.deepEqual(r.applicablePolicyIds, ['x'])
})

test('Cycle: a "cycle" through an expired policy is not a cycle among live candidates', () => {
  const r = checkAuthority(act(['a', 'b']), [
    P({ id: 'a', effect: 'require-approval', supersedesIds: ['b'] }),
    P({ id: 'b', supersedesIds: ['a'], expirationDate: '2026-02-01' }),
  ], { now: NOW })
  assert.deepEqual(r.conflicts, [])
  assert.equal(row(r, 'a').result, 'applies')
})

// ── Scope nesting ───────────────────────────────────────────────────────────

test('Scopes: dot-separated ancestry', () => {
  assert.equal(scopeIncludes('finance', 'finance'), true)
  assert.equal(scopeIncludes('finance', 'finance.payments.refunds'), true)
  assert.equal(scopeIncludes('fin', 'finance.payments'), false)
  assert.equal(scopeIncludes('finance.payments', 'finance'), false)
  assert.equal(scopeIncludes('', 'finance'), false)
})

test('Scopes: an ancestor-scope policy governs a capability in a descendant scope; a descendant does not govern the ancestor', () => {
  const policies = [P({ id: 'fin', scope: 'finance', effect: 'deny' }), P({ id: 'refunds', scope: 'finance.payments.refunds', effect: 'deny' })]
  const r = checkAuthority(act([]), policies, { now: NOW, governingScopes: ['finance.payments'] })
  assert.deepEqual(r.uncitedPolicyIds, ['fin'])
  assert.equal(r.blockingReasons.length, 1)
  const d = authorize({ action: act([]), actor, capabilities: cap(['finance.payments']), policies, evidence: ev })
  assert.equal(d.recommendation, 'reject')
})

test('Scopes: a more specific, stricter scope prevails', () => {
  const r = checkAuthority(act(['fin', 'pay']), [
    P({ id: 'fin', scope: 'finance', effect: 'require-approval' }),
    P({ id: 'pay', scope: 'finance.payments', effect: 'deny' }),
  ], { now: NOW })
  assert.deepEqual(r.blockingReasons, ['Policy in scope "finance.payments" denies this action.'])
  assert.deepEqual(r.approvalReasons, [])
  assert.match(r.resolutions[0]!, /More specific scope "finance.payments" \(deny\) prevails over ancestor scope "finance"/)
})

test('Scopes: a more specific scope can never silently loosen an ancestor (deny → human)', () => {
  const r = checkAuthority(act(['fin', 'pay']), [
    P({ id: 'fin', scope: 'finance', effect: 'deny' }),
    P({ id: 'pay', scope: 'finance.payments', effect: 'allow', priority: 99 }),
  ], { now: NOW, riskLevel: 0 })
  assert.deepEqual(r.blockingReasons, [])
  assert.equal(r.approvalReasons.length, 1)
  assert.match(r.approvalReasons[0]!, /would loosen ancestor scope "finance" \(deny\); a human must confirm/)
})

test('Scopes: loosening an ancestor\'s require-approval still needs a human', () => {
  const r = checkAuthority(act(['fin', 'pay']), [
    P({ id: 'fin', scope: 'finance', effect: 'require-approval' }),
    P({ id: 'pay', scope: 'finance.payments', effect: 'allow' }),
  ], { now: NOW, riskLevel: 0 })
  assert.equal(r.approvalReasons.length, 1)
  assert.match(r.approvalReasons[0]!, /loosen/)
})

test('Scopes: agreeing nested scopes give one reason, from the more specific scope', () => {
  const r = checkAuthority(act(['fin', 'pay']), [
    P({ id: 'fin', scope: 'finance', effect: 'require-approval' }),
    P({ id: 'pay', scope: 'finance.payments', effect: 'require-approval' }),
  ], { now: NOW })
  assert.deepEqual(r.approvalReasons, ['Policy in scope "finance.payments" requires human approval.'])
  assert.deepEqual(r.conflicts, [])
})

test('Scopes: a deeper scope that restores a restriction wins over a loosening middle scope', () => {
  const r = checkAuthority(act(['a', 'b', 'c']), [
    P({ id: 'a', scope: 'finance', effect: 'deny' }),
    P({ id: 'b', scope: 'finance.payments', effect: 'allow' }),
    P({ id: 'c', scope: 'finance.payments.refunds', effect: 'deny' }),
  ], { now: NOW, riskLevel: 0 })
  assert.deepEqual(r.blockingReasons, ['Policy in scope "finance.payments.refunds" denies this action.'])
})

test('Scopes: free-text policies in nested scopes go to a human, like a shared scope', () => {
  const r = checkAuthority(act(['fin', 'pay']), [P({ id: 'fin', scope: 'finance' }), P({ id: 'pay', scope: 'finance.payments' })], { now: NOW })
  assert.equal(r.conflicts.length, 1)
  assert.match(r.conflicts[0]!, /nested scopes "finance" and "finance.payments"/)
})

// ── validatePolicySet ───────────────────────────────────────────────────────

const codes = (ps: PolicyRef[]) => validatePolicySet(ps).map((p) => `${p.severity}:${p.code}`)

test('validatePolicySet: a clean set has no problems (and cross-scope supersession is not flagged)', () => {
  assert.deepEqual(codes([
    P({ id: 'a', lineageId: 'L', version: 1 }), P({ id: 'b', lineageId: 'L', version: 2 }),
    P({ id: 'c', scope: 'production', supersedesIds: ['d'] }), P({ id: 'd', scope: 'finance' }),
  ]), [])
})

test('validatePolicySet: supersession cycles of any length, including a policy superseding itself', () => {
  const two = validatePolicySet([P({ id: 'a', supersedesIds: ['b'] }), P({ id: 'b', supersedesIds: ['a'] })])
  assert.equal(two[0]!.code, 'supersession-cycle')
  assert.deepEqual(two[0]!.policyIds, ['a', 'b'])
  const four = validatePolicySet([
    P({ id: 'a', supersedesIds: ['b'] }), P({ id: 'b', supersedesIds: ['c'] }), P({ id: 'c', supersedesIds: ['d'] }), P({ id: 'd', supersedesIds: ['a'] }),
  ])
  assert.match(four[0]!.message, /a → b → c → d → a/)
  assert.deepEqual(codes([P({ id: 'self', supersedesIds: ['self'] })]), ['error:supersession-cycle'])
})

test('validatePolicySet: an unknown superseded id is a warning, not an error', () => {
  assert.deepEqual(codes([P({ id: 'a', supersedesIds: ['ghost'] })]), ['warning:unknown-superseded-policy'])
})

test('validatePolicySet: version problems', () => {
  assert.deepEqual(codes([P({ id: 'a', lineageId: 'L', version: 2 }), P({ id: 'b', lineageId: 'L', version: 2 })]), ['error:duplicate-lineage-version'])
  assert.deepEqual(codes([P({ id: 'a', lineageId: 'L', version: 1 }), P({ id: 'b', lineageId: 'L' })]), ['error:lineage-missing-version'])
  assert.ok(codes([P({ id: 'a', lineageId: 'L', version: 0 })]).includes('error:invalid-version'))
  assert.ok(codes([P({ id: 'a', lineageId: 'L', version: 1.5 })]).includes('error:invalid-version'))
  assert.deepEqual(codes([P({ id: 'a', version: 3 })]), ['warning:version-without-lineage'])
  assert.deepEqual(codes([P({ id: 'a' }), P({ id: 'a' })]), ['error:duplicate-policy-id'])
})

test('validatePolicySet: supersession that contradicts version order, and partial supersession of another lineage', () => {
  assert.deepEqual(
    codes([P({ id: 'v1', lineageId: 'L', version: 1, supersedesIds: ['v2'] }), P({ id: 'v2', lineageId: 'L', version: 2 })]),
    ['error:supersession-against-version-order'],
  )
  // Superseding a lower version of one's own lineage is consistent: not flagged.
  assert.deepEqual(codes([P({ id: 'v1', lineageId: 'L', version: 1 }), P({ id: 'v2', lineageId: 'L', version: 2, supersedesIds: ['v1'] })]), [])
  // X replaces rule M's version 1, but M already has a version 2 that X leaves alone: ambiguous.
  assert.deepEqual(
    codes([P({ id: 'x', supersedesIds: ['m1'] }), P({ id: 'm1', lineageId: 'M', version: 1 }), P({ id: 'm2', lineageId: 'M', version: 2 })]),
    ['warning:partial-lineage-supersession'],
  )
  // Superseding the newest version of another lineage is an unambiguous replacement.
  assert.deepEqual(
    codes([P({ id: 'x', supersedesIds: ['m2'] }), P({ id: 'm1', lineageId: 'M', version: 1 }), P({ id: 'm2', lineageId: 'M', version: 2 })]),
    [],
  )
})
