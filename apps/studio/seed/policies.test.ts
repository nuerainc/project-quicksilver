/** Seed policies carry structured effects that the kernel's M1 resolver uses. */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { checkAuthority } from '../../../packages/kernel/src/authority.ts'
import { conditionFromSanity, conditionToSanity } from '../../../packages/kernel/src/process-document.ts'
import type { PolicyRef, ProposedAction, RiskLevel } from '../../../packages/kernel/src/types.ts'
import { policies } from './policies.ts'

const NOW = new Date('2026-09-26T12:00:00Z')

const refs: PolicyRef[] = policies.map((p) => ({
  id: p._id, name: p.name, scope: p.scope, priority: p.priority, effectiveDate: p.effectiveDate, expirationDate: p.expirationDate,
  supersedesIds: p.supersedesIds, approvalRequirementIds: p.approvalRequirementIds, effect: p.effect ?? null, maxRiskLevel: p.maxRiskLevel ?? null,
  // Round-trip the conditions through their Sanity shape, as the loader and the plan route do.
  when: p.whenAll?.length ? { all: p.whenAll.map((c, i) => conditionFromSanity(conditionToSanity(c, i))) } : null,
}))

const action = (policyIds: string[], extra: Partial<ProposedAction> = {}): ProposedAction => ({
  description: 'test', actorId: 'agent', capabilityId: 'cap', applicablePolicyIds: policyIds, evidenceIds: [], reversible: true, operationalImpact: 2, uncertainty: 2, ...extra,
})
const run = (ids: string[], riskLevel: RiskLevel, facts = {}) => checkAuthority(action(ids), refs, { now: NOW, riskLevel, facts: { 'action.riskLevel': riskLevel, ...facts } })

test('every live seed policy has a structured effect, so live decisions use the resolver', () => {
  for (const p of policies) assert.ok(p.effect, `${p._id} has no structured effect`)
})

test('outside a declared emergency, Ops 17 governs parameter changes: approval required, no conflict', () => {
  const r = run(['policy-ops-17', 'policy-emergency-4'], 2)
  assert.ok(r.approvalReasons.length > 0)
  assert.deepEqual(r.conflicts, [])
  assert.equal(r.checks.find((c) => c.policyId === 'policy-emergency-4')!.result, 'inapplicable')
  assert.equal(r.checks.find((c) => c.policyId === 'policy-ops-17-superseded')?.result ?? 'inapplicable', 'inapplicable', 'the 2024 policy expired')
})

test('in a declared emergency, Emergency 4 applies up to risk 2; above that approval is still required', () => {
  const low = run(['policy-ops-17', 'policy-emergency-4'], 2, { 'incident.classification': 'emergency' })
  assert.equal(low.checks.find((c) => c.policyId === 'policy-emergency-4')!.result, 'applies')
  assert.deepEqual(low.conflicts, [])
  const high = run(['policy-ops-17', 'policy-emergency-4'], 4, { 'incident.classification': 'emergency' })
  assert.ok(high.approvalReasons.length > 0)
})

test('Budget 3 requires approval above $50,000 and fails closed when exposure is unknown', () => {
  assert.equal(run(['policy-budget-3'], 1, { 'action.financialExposure': 20000 }).approvalReasons.length, 0)
  assert.ok(run(['policy-budget-3'], 1, { 'action.financialExposure': 80000 }).approvalReasons.length > 0)
  assert.ok(run(['policy-budget-3'], 1).approvalReasons.length > 0)
})
