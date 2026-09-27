/** M7 wiring: Sanity company-model documents → authorize() inputs (used by the web plan route). */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CAPABILITIES_QUERY,
  ENTITY_QUERY,
  POLICIES_QUERY,
  authorize,
  capabilityFromSanity,
  entityFromSanity,
  policyFromSanity,
  policyScopesToFetch,
  scopesWithAncestors,
  snapshotPolicyIds,
} from './index.ts'
import type { SanityCapabilityDocument, SanityPolicyDocument } from './index.ts'

test('Queries are parameterized and project the M7 fields', () => {
  for (const q of [CAPABILITIES_QUERY, ENTITY_QUERY, POLICIES_QUERY]) assert.doesNotMatch(q, /\$\{/)
  for (const p of ['$ids', '$scopes', '$actorId']) assert.ok(POLICIES_QUERY.includes(p), p)
  assert.match(POLICIES_QUERY, /lineageId in \*\[_type == "policy"/, 'lineage siblings are fetched')
  assert.match(POLICIES_QUERY, /version, lineageId \}$/)
  for (const f of ['"inheritsIds": inherits[]._ref', '"requiresIds": requires[]._ref', '"conflictsWithIds": conflictsWith[]._ref', 'riskMultiplier']) {
    assert.ok(CAPABILITIES_QUERY.includes(f), f)
  }
  assert.ok(ENTITY_QUERY.includes('$id'))
})

test('Scopes to fetch: each scope plus every ancestor, exact scopes always kept', () => {
  assert.deepEqual(scopesWithAncestors(['finance.payments.refunds', 'ops']), ['finance', 'finance.payments', 'finance.payments.refunds', 'ops'])
  assert.deepEqual(scopesWithAncestors(['production.parameter_changes']), ['production', 'production.parameter_changes'])
  assert.deepEqual(scopesWithAncestors(['', 'a..b']), ['a', 'a..b'])
})

test('Scopes to fetch include scopes inherited through the capability graph', () => {
  const caps = [
    capabilityFromSanity({ _id: 'refund', name: 'Refund', riskLevel: 2, policyScopes: ['finance.payments'] }),
    capabilityFromSanity({ _id: 'refund-large', name: 'Large refund', riskLevel: 3, policyScopes: ['finance.large'], inheritsIds: ['refund'] }),
  ]
  assert.deepEqual(policyScopesToFetch('refund-large', caps), ['finance', 'finance.large', 'finance.payments'])
  assert.deepEqual(policyScopesToFetch('missing', caps), [])
})

test('Capability mapping: legacy documents map exactly as before; graph fields only when set', () => {
  assert.deepEqual(
    capabilityFromSanity({ _id: 'c', name: 'C', riskLevel: null, authorizedEntityIds: null, policyScopes: null, inheritsIds: null, requiresIds: [], riskMultiplier: null }),
    { id: 'c', name: 'C', baseRiskLevel: 2, authorizedEntityIds: [], policyScopes: [] },
  )
  const doc: SanityCapabilityDocument = {
    _id: 'c', name: 'C', riskLevel: 1, authorizedEntityIds: ['e'], policyScopes: ['s'],
    inheritsIds: ['p', null as unknown as string], requiresIds: ['r'], conflictsWithIds: ['x'], riskMultiplier: 1.5,
  }
  assert.deepEqual(capabilityFromSanity(doc), {
    id: 'c', name: 'C', baseRiskLevel: 1, authorizedEntityIds: ['e'], policyScopes: ['s'],
    inherits: ['p'], requires: ['r'], conflictsWith: ['x'], riskMultiplier: 1.5,
  })
  // An invalid stored multiplier is passed through so the graph check fails closed on it.
  assert.equal(capabilityFromSanity({ _id: 'b', name: 'B', riskMultiplier: 0.5 }).riskMultiplier, 0.5)
})

test('Policy and entity mapping: legacy documents map exactly as before; version and lineage when set', () => {
  const legacy: SanityPolicyDocument = {
    _id: 'p', _rev: 'r1', name: 'P', scope: 's', priority: 5, effectiveDate: null, expirationDate: null,
    supersedesIds: null, approvalRequirementIds: null, appliesToEntityIds: null, effect: null, maxRiskLevel: null, whenAll: null,
  }
  assert.deepEqual(policyFromSanity(legacy), {
    id: 'p', name: 'P', scope: 's', priority: 5, effectiveDate: undefined, expirationDate: undefined, supersedesIds: [],
    approvalRequirementIds: [], appliesToEntityIds: [], effect: null, maxRiskLevel: null, when: null,
  })
  const v = policyFromSanity({ ...legacy, version: 2, lineageId: ' refund-limit ' })
  assert.equal(v.version, 2)
  assert.equal(v.lineageId, 'refund-limit')
  assert.equal(policyFromSanity({ ...legacy, lineageId: '  ' }).lineageId, undefined)
  assert.deepEqual(entityFromSanity({ _id: 'e', name: 'E', entityType: 'agent', capabilityIds: null }), { id: 'e', name: 'E', entityType: 'agent', capabilityIds: [] })
})

test('End to end from documents: ancestor-scope policy, lineage sibling, requirements and the snapshot ids', () => {
  const capabilities = [
    { _id: 'pay', name: 'Pay', riskLevel: 1, authorizedEntityIds: ['agent'], policyScopes: ['finance.payments'], requiresIds: ['kyc'] },
    { _id: 'kyc', name: 'KYC', riskLevel: 0, authorizedEntityIds: ['agent'] },
  ].map(capabilityFromSanity)
  const P = (p: Partial<SanityPolicyDocument> & { _id: string }): SanityPolicyDocument =>
    ({ _rev: `${p._id}-rev`, name: p._id, scope: 'finance', priority: 5, effectiveDate: '2020-01-01', ...p }) as SanityPolicyDocument
  // What POLICIES_QUERY returns for $scopes = ['finance', 'finance.payments']:
  // the ancestor-scope policies and a lineage sibling that moved to another scope.
  const docs = [
    P({ _id: 'fin-v1', effect: 'require-approval', lineageId: 'fin', version: 1 }),
    P({ _id: 'fin-v2', effect: 'require-approval', lineageId: 'fin', version: 2, scope: 'finance.payroll' }),
    P({ _id: 'fin-cap', effect: 'allow', maxRiskLevel: 5 }),
  ]
  assert.deepEqual(policyScopesToFetch('pay', capabilities), ['finance', 'finance.payments'])
  const run = (held: string[]) => authorize({
    action: { description: 'Pay', actorId: 'agent', capabilityId: 'pay', applicablePolicyIds: [], evidenceIds: ['ev'], reversible: true, operationalImpact: 0, uncertainty: 0 },
    actor: entityFromSanity({ _id: 'agent', name: 'Agent', entityType: 'agent', capabilityIds: held }),
    capabilities,
    policies: docs.map(policyFromSanity),
    evidence: [{ id: 'ev', title: 'E', confidence: 0.9 }],
  })
  const missing = run(['pay'])
  assert.equal(missing.recommendation, 'reject')
  assert.deepEqual(missing.capabilityGraph!.missingRequires, ['kyc'])

  const d = run(['pay', 'kyc'])
  assert.deepEqual(d.uncitedPolicyIds, ['fin-v1', 'fin-cap'], 'the `finance` policies reach a `finance.payments` capability')
  assert.equal(d.policyChecks.find((c) => c.policyId === 'fin-v1')!.reasonCode, 'superseded-by-version')
  assert.equal(d.policyChecks.find((c) => c.policyId === 'fin-v2')!.reasonCode, 'out-of-scope')
  assert.equal(d.recommendation, 'request-approval')
  assert.deepEqual(snapshotPolicyIds(d.policyChecks), ['fin-cap', 'fin-v1', 'fin-v2'])
})
