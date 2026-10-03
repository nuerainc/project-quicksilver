import assert from 'node:assert/strict'
import { test } from 'node:test'

import { authorize, explainWhy } from './index.ts'
import type { AuthorizeArgs } from './index.ts'
import type { CapabilityRef, EntityRef, EvidenceRef, PolicyRef, ProposedAction } from './types.ts'

const agent: EntityRef = { id: 'agent-1', name: 'Ops Agent', entityType: 'agent', capabilityIds: ['cap-sim'] }
const capabilities: CapabilityRef[] = [
  { id: 'cap-sim', name: 'Simulation', baseRiskLevel: 1, authorizedEntityIds: ['agent-1'] },
  { id: 'cap-pay', name: 'Payments', baseRiskLevel: 2, authorizedEntityIds: [] },
]
const evidence: EvidenceRef[] = [{ id: 'ev-1', title: 'Report', confidence: 0.9 }]
const thresholds = { autoMax: 2 as const, review: 3 as const }

const action = (patch: Partial<ProposedAction> = {}): ProposedAction => ({
  description: 'Run a simulation', actorId: 'agent-1', capabilityId: 'cap-sim', applicablePolicyIds: [], evidenceIds: ['ev-1'],
  reversible: true, operationalImpact: 0, uncertainty: 0, ...patch,
})
const args = (patch: Partial<ProposedAction> = {}, extra: Partial<AuthorizeArgs> = {}): AuthorizeArgs => ({
  action: action(patch), actor: agent, capabilities, policies: [], evidence, thresholds, ...extra,
})

test('an allowed action says so and offers nothing to change', () => {
  const why = explainWhy(args())
  assert.equal(why.recommendation, 'execute-autonomously')
  assert.equal(why.risk.band, 'within-autonomous-ceiling')
  assert.deepEqual(why.whatWouldChangeIt, [])
  assert.match(why.headline, /risk 1 is within the autonomous ceiling of 2/)
})

test('the risk lines add up to the kernel risk and the ceilings are the ones in force', () => {
  const a = args({ reversible: false, uncertainty: 4, financialExposure: 5000 })
  const why = explainWhy(a)
  const sum = why.risk.lines.reduce((total, line) => total + line.value, 0)
  assert.equal(Math.min(5, sum), why.risk.preMultiplierRisk)
  assert.equal(why.risk.finalRisk, authorize(a).riskLevel)
  assert.equal(why.risk.autoMax, 2)
  assert.equal(why.risk.review, 3)
  assert.equal(why.risk.band, 'above-review-ceiling')
})

test('a risky action names each change that would lower it, and all of them together reach autonomy', () => {
  const why = explainWhy(args({ reversible: false, uncertainty: 4, financialExposure: 5000 }))
  assert.equal(why.recommendation, 'request-approval')
  assert.match(why.approvalDrivers[0]!, /Risk 4 is above the autonomous ceiling of 2/)
  const changes = why.whatWouldChangeIt
  assert.ok(changes.every((c) => c.simulated && c.improves))
  assert.ok(changes.some((c) => /reversible/.test(c.change) && c.outcome!.riskLevel === 3))
  const all = changes.find((c) => /All of the above/.test(c.change))
  assert.ok(all, 'a combined entry is listed')
  assert.equal(all!.outcome!.recommendation, 'execute-autonomously')
  assert.equal(all!.outcome!.riskLevel, 1)
})

test('every simulated outcome is exactly what authorize() gives for that change', () => {
  const base = args({ reversible: false })
  const why = explainWhy(base)
  const reversible = why.whatWouldChangeIt.find((c) => /reversible/.test(c.change))!
  const direct = authorize({ ...base, action: { ...base.action, reversible: true } })
  assert.equal(reversible.outcome!.recommendation, direct.recommendation)
  assert.equal(reversible.outcome!.riskLevel, direct.riskLevel)
})

test('an actor without the capability is refused, and granting it is the listed way forward', () => {
  const why = explainWhy(args({ capabilityId: 'cap-pay' }))
  assert.equal(why.recommendation, 'reject')
  assert.match(why.headline, /^Refused: Ops Agent does not have capability "Payments"/)
  const grant = why.whatWouldChangeIt.find((c) => /Grant Ops Agent the capability "Payments"/.test(c.change))
  assert.ok(grant)
  assert.equal(grant!.simulated, true)
  assert.notEqual(grant!.outcome!.recommendation, 'reject')
})

test('missing evidence is a stated requirement, not a simulation', () => {
  const why = explainWhy(args({ evidenceIds: [] }))
  assert.equal(why.recommendation, 'reject')
  const need = why.whatWouldChangeIt.find((c) => c.kind === 'evidence')!
  assert.equal(need.simulated, false)
  assert.equal(need.outcome, undefined)
})

test('a customer-facing action without a review names the review that would clear it', () => {
  const why = explainWhy(args({ customerFacing: true }))
  assert.equal(why.recommendation, 'reject')
  const review = why.whatWouldChangeIt.find((c) => c.kind === 'review')!
  assert.match(review.change, /passing WAES review.*different reviewer/)
  assert.equal(review.outcome!.recommendation, 'execute-autonomously')
})

test('the policy revision digest and the guard rows are the kernel\'s own', () => {
  const policies: PolicyRef[] = [{ id: 'pol-1', name: 'Simulation policy', scope: 'sim', priority: 1, effectiveDate: '2026-01-01', expirationDate: null, supersedesIds: [], approvalRequirementIds: [] }]
  const a = args({ applicablePolicyIds: ['pol-1'] }, { policies, capabilities: [{ ...capabilities[0]!, policyScopes: ['sim'] }, capabilities[1]!] })
  const result = authorize(a)
  const why = explainWhy(a, result)
  assert.equal(why.policySnapshot, result.policySnapshot)
  assert.match(why.policySnapshot, /^sha256:[0-9a-f]{64}$/)
  assert.equal(why.guards.length, result.policyChecks.length)
  assert.ok(why.guards.some((g) => g.policyId === 'pol-1' && g.citedByPlanner))
})
