/**
 * Policy snapshot: the identifier that lets the gate tell whether the policy
 * has moved since a decision was made. Run with `npm run kernel:test`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { policySnapshot, policySnapshotIsCurrent } from './policy-snapshot.ts'
import type { PolicyRef } from './types.ts'

function policy(overrides: Partial<PolicyRef> = {}): PolicyRef {
  return {
    id: 'p.max-risk', name: 'Max risk', scope: 'acme', priority: 10,
    supersedesIds: [], approvalRequirementIds: [],
    version: 2, lineageId: 'lin.max-risk', effect: { type: 'allow', maxRiskLevel: 2 },
    ...overrides,
  } as PolicyRef
}

test('Policy snapshot: the same policy set always digests the same', () => {
  assert.equal(policySnapshot([policy()]), policySnapshot([policy()]))
  // Order of the supplied policies must not matter.
  const a = policy({ id: 'a' })
  const b = policy({ id: 'b', lineageId: 'lin.b' })
  assert.equal(policySnapshot([a, b]), policySnapshot([b, a]))
  assert.match(policySnapshot([a]), /^sha256:[0-9a-f]{64}$/)
})

test('Policy snapshot: an absent set and an empty set agree, and are distinct from any real policy', () => {
  assert.equal(policySnapshot(undefined), policySnapshot(null))
  assert.equal(policySnapshot([]), policySnapshot(undefined))
  assert.notEqual(policySnapshot([]), policySnapshot([policy()]))
})

test('Policy snapshot: every field that changes what a policy does changes the digest', () => {
  const base = policySnapshot([policy()])
  const changes: Array<[string, Partial<PolicyRef>]> = [
    ['version', { version: 3 }],
    ['lineage', { lineageId: 'lin.other' }],
    ['scope', { scope: 'acme.ops' }],
    ['priority', { priority: 20 }],
    ['effect', { effect: { type: 'deny' } as never }],
    ['max risk', { maxRiskLevel: 4 }],
    ['effective date', { effectiveDate: '2026-01-01' }],
    ['expiry', { expirationDate: '2026-12-31' }],
    ['supersedes', { supersedesIds: ['p.old'] }],
    ['approval requirements', { approvalRequirementIds: ['req.1'] }],
    ['applies to', { appliesToEntityIds: ['entity-1'] }],
    ['id', { id: 'p.other' }],
  ]
  for (const [label, override] of changes) {
    assert.notEqual(policySnapshot([policy(override)]), base, `changing ${label} must change the snapshot`)
  }
})

test('Policy snapshot: renaming a policy does not invalidate a decision', () => {
  // The display name is not what a policy *does*; a rename should not stop an
  // otherwise-current action from executing.
  assert.equal(policySnapshot([policy({ name: 'Maximum permitted risk' })]), policySnapshot([policy()]))
})

test('Policy snapshot: supersedes and approval lists are compared as sets', () => {
  assert.equal(
    policySnapshot([policy({ supersedesIds: ['a', 'b'] })]),
    policySnapshot([policy({ supersedesIds: ['b', 'a'] })]),
  )
})

test('Policy snapshot: currency requires an established current state', () => {
  const current = policySnapshot([policy()])
  assert.equal(policySnapshotIsCurrent(current, current), true)
  assert.equal(policySnapshotIsCurrent(current, policySnapshot([policy({ version: 3 })])), false)
  // A caller that cannot determine the live policy has not shown it is current.
  assert.equal(policySnapshotIsCurrent(current, undefined), false)
  assert.equal(policySnapshotIsCurrent(current, null), false)
  assert.equal(policySnapshotIsCurrent(current, ''), false)
  assert.equal(policySnapshotIsCurrent(current, '   '), false)
})
