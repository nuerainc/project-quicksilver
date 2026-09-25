import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authorize, checkAuthority } from './index.ts'
import type { CapabilityRef, EntityRef, EvidenceRef, PolicyRef, ProposedAction } from './index.ts'

const NOW = new Date('2026-10-01T00:00:00Z')
const base = { scope: 'production.parameter_changes', effectiveDate: '2026-01-01', expirationDate: null, supersedesIds: [], approvalRequirementIds: [] }
const P = (p: Partial<PolicyRef> & { id: string }): PolicyRef => ({ name: p.id, priority: 5, ...base, ...p }) as PolicyRef
const act = (ids: string[], extra: Partial<ProposedAction> = {}): ProposedAction => ({
  description: 'Adjust parameter', actorId: 'agent', capabilityId: 'cap', applicablePolicyIds: ids,
  evidenceIds: ['ev'], reversible: true, operationalImpact: 0, uncertainty: 0, ...extra,
})

test('Structured: agreeing policies in one scope are not a conflict', () => {
  const r = checkAuthority(act(['a', 'b']), [P({ id: 'a', effect: 'require-approval' }), P({ id: 'b', effect: 'require-approval', priority: 9 })], { now: NOW })
  assert.deepEqual(r.conflicts, [])
  assert.equal(r.approvalReasons.length, 1)
  assert.deepEqual(r.resolutions, [])
})

test('Structured: higher-priority stricter policy prevails without extra review', () => {
  const r = checkAuthority(act(['allow', 'strict']), [P({ id: 'allow', effect: 'allow', priority: 3 }), P({ id: 'strict', effect: 'require-approval', priority: 8 })], { now: NOW, riskLevel: 1 })
  assert.deepEqual(r.conflicts, [])
  assert.equal(r.resolutions.length, 1)
  assert.match(r.approvalReasons[0]!, /requires human approval/)
})

test('Structured: priority can never silently loosen a stricter policy', () => {
  const r = checkAuthority(act(['allow', 'strict']), [P({ id: 'allow', effect: 'allow', priority: 9 }), P({ id: 'strict', effect: 'require-approval', priority: 2 })], { now: NOW, riskLevel: 1 })
  assert.equal(r.resolutions.length, 1)
  assert.equal(r.approvalReasons.length, 1)
  assert.match(r.approvalReasons[0]!, /loosen/)
})

test('Structured: equal-priority disagreement is an unresolved conflict', () => {
  const r = checkAuthority(act(['a', 'b']), [P({ id: 'a', effect: 'allow' }), P({ id: 'b', effect: 'deny' })], { now: NOW, riskLevel: 0 })
  assert.equal(r.conflicts.length, 1)
  assert.match(r.conflicts[0]!, /Equal-priority/)
  assert.equal(r.blockingReasons.length, 1, 'falls back to the most restrictive effect')
})

test('Structured: a prevailing deny is a hard block in authorize()', () => {
  const actor: EntityRef = { id: 'agent', name: 'Agent', entityType: 'agent', capabilityIds: ['cap'] }
  const caps: CapabilityRef[] = [{ id: 'cap', name: 'Cap', baseRiskLevel: 1, authorizedEntityIds: ['agent'] }]
  const ev: EvidenceRef[] = [{ id: 'ev', title: 'E', confidence: 0.9 }]
  const r = authorize({ action: act(['d']), actor, capabilities: caps, policies: [P({ id: 'd', effect: 'deny', effectiveDate: '2020-01-01' })], evidence: ev })
  assert.equal(r.recommendation, 'reject')
  assert.ok(r.blockingReasons.some((b) => /denies/.test(b)))
})

test('Structured: allow above its maxRiskLevel becomes require-approval', () => {
  const r = checkAuthority(act(['a']), [P({ id: 'a', effect: 'allow', maxRiskLevel: 2 })], { now: NOW, riskLevel: 4 })
  assert.equal(r.approvalReasons.length, 1)
})

test('Fail-closed conditions: permissive policy with a missing fact does not apply', () => {
  const when = { all: [{ fact: 'incident.classification', op: 'eq' as const, value: 'emergency' }] }
  const r = checkAuthority(act(['e']), [P({ id: 'e', effect: 'allow', when })], { now: NOW, riskLevel: 0 })
  assert.equal(r.checks[0]!.result, 'inapplicable')
  const ok = checkAuthority(act(['e']), [P({ id: 'e', effect: 'allow', when })], { now: NOW, riskLevel: 0, facts: { 'incident.classification': 'emergency' } })
  assert.equal(ok.checks[0]!.result, 'applies')
})

test('Fail-closed conditions: restrictive policy with a missing fact still applies', () => {
  const when = { all: [{ fact: 'site.region', op: 'eq' as const, value: 'EU' }] }
  const missing = checkAuthority(act(['r']), [P({ id: 'r', effect: 'require-approval', when })], { now: NOW })
  assert.equal(missing.checks[0]!.result, 'applies')
  const provablyFalse = checkAuthority(act(['r']), [P({ id: 'r', effect: 'require-approval', when })], { now: NOW, facts: { 'site.region': 'US' } })
  assert.equal(provablyFalse.checks[0]!.result, 'inapplicable')
})

test('Dates: a policy not yet effective does not apply', () => {
  const r = checkAuthority(act(['f']), [P({ id: 'f', effect: 'deny', effectiveDate: '2027-01-01' })], { now: NOW })
  assert.equal(r.checks[0]!.result, 'inapplicable')
  assert.deepEqual(r.blockingReasons, [])
})

test('Supersession: a policy that supersedes another can itself be superseded', () => {
  const r = checkAuthority(act(['v1', 'v2', 'v3']), [
    P({ id: 'v1' }), P({ id: 'v2', supersedesIds: ['v1'] }), P({ id: 'v3', supersedesIds: ['v2'] }),
  ], { now: NOW })
  assert.deepEqual(r.checks.map((c) => `${c.policyId}:${c.result}`), ['v1:superseded', 'v2:superseded', 'v3:applies'])
  assert.deepEqual(r.conflicts, [])
})

test('Legacy: free-text policies sharing a scope still go to a human', () => {
  const r = checkAuthority(act(['x', 'y']), [P({ id: 'x' }), P({ id: 'y' })], { now: NOW })
  assert.equal(r.conflicts.length, 1)
})

// ── M1 item 3: the kernel finds governing policies itself ─────────────────

test('Scope lookup: an uncited policy in a governing scope still applies', () => {
  const r = checkAuthority(act([]), [P({ id: 'strict', effect: 'require-approval' })], {
    now: NOW,
    governingScopes: ['production.parameter_changes'],
  })
  assert.deepEqual(r.uncitedPolicyIds, ['strict'])
  assert.equal(r.checks[0]!.result, 'applies')
  assert.match(r.checks[0]!.reason, /Added by the kernel/)
  assert.equal(r.approvalReasons.length, 1)
})

test('Scope lookup: an uncited deny cannot be dodged by omitting it', () => {
  const actor: EntityRef = { id: 'agent', name: 'Agent', entityType: 'agent', capabilityIds: ['cap'] }
  const caps: CapabilityRef[] = [
    { id: 'cap', name: 'Cap', baseRiskLevel: 0, authorizedEntityIds: ['agent'], policyScopes: ['production.parameter_changes'] },
  ]
  const ev: EvidenceRef[] = [{ id: 'ev', title: 'E', confidence: 0.9 }]
  const r = authorize({ action: act([]), actor, capabilities: caps, policies: [P({ id: 'd', effect: 'deny', effectiveDate: '2020-01-01' })], evidence: ev })
  assert.equal(r.recommendation, 'reject')
  assert.deepEqual(r.uncitedPolicyIds, ['d'])
})

test('Scope lookup: a policy naming the actor applies even outside the governing scopes', () => {
  const r = checkAuthority(act([]), [P({ id: 'named', scope: 'finance.expenditure', appliesToEntityIds: ['agent'] })], {
    now: NOW,
    actorId: 'agent',
  })
  assert.deepEqual(r.uncitedPolicyIds, ['named'])
  assert.match(r.approvalReasons[0]!, /not cited by the planner/)
})

test('Scope lookup: policies outside the governing scopes and not naming the actor are ignored', () => {
  const r = checkAuthority(act([]), [P({ id: 'other', scope: 'finance.expenditure' })], {
    now: NOW,
    governingScopes: ['production.parameter_changes'],
    actorId: 'agent',
  })
  assert.deepEqual(r.checks, [])
  assert.deepEqual(r.uncitedPolicyIds, [])
})

test('Scope lookup: an uncited but expired policy does not force review', () => {
  const r = checkAuthority(act([]), [P({ id: 'old', expirationDate: '2025-01-01' })], {
    now: NOW,
    governingScopes: ['production.parameter_changes'],
  })
  assert.equal(r.checks[0]!.result, 'inapplicable')
  assert.deepEqual(r.approvalReasons, [])
})
