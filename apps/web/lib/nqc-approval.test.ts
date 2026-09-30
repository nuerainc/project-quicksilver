import assert from 'node:assert/strict'
import { test } from 'node:test'

import { approvalFingerprintWasReviewed, approvalMatchesDecision, decisionActionFingerprint, evaluateDecisionExecutionGate, policySnapshotVersion } from './nqc-approval.ts'

const decision = {
  decisionId: 'decision-17',
  selectedAction: 'Reduce pump pressure by 5%',
  policySnapshotVersion: 'sha256:policy-revision-a',
  riskLevel: 3,
  requiredApproval: true,
  approvedById: 'entity-supervisor',
}
const approval = {
  id: 'approval-17',
  requestId: decision.decisionId,
  actionFingerprint: decisionActionFingerprint(decision),
  policySnapshotVersion: decision.policySnapshotVersion,
  supervisorId: decision.approvedById,
  grantedAt: '2026-09-29T00:00:00.000Z',
}

test('approval is current only for the exact action, risk, policy revision and human approver', () => {
  assert.equal(approvalMatchesDecision({ ...decision, approval }), true)
  for (const changed of [
    { selectedAction: 'Increase pump pressure by 5%' },
    { riskLevel: 4 },
    { requiredApproval: false },
    { policySnapshotVersion: 'sha256:policy-revision-b' },
    { decisionId: 'decision-18' },
    { approvedById: 'entity-other' },
  ]) {
    assert.equal(approvalMatchesDecision({ ...decision, ...changed, approval }), false, JSON.stringify(changed))
  }
})

test('approval fails closed for missing or incomplete records', () => {
  assert.equal(approvalMatchesDecision({ ...decision, approval: null }), false)
  assert.equal(approvalMatchesDecision({ ...decision, policySnapshotVersion: null, approval }), false)
  assert.equal(approvalMatchesDecision({ ...decision, approval: { ...approval, actionFingerprint: undefined } }), false)
  assert.equal(approvalMatchesDecision({ ...decision, approval: { ...approval, supervisorId: undefined } }), false)
  assert.equal(approvalMatchesDecision({ ...decision, approvedById: null, approval }), false)
})

test('policy snapshot hashes ignore retrieval ordering but change when a revision changes', () => {
  const forward = policySnapshotVersion([{ id: 'policy-a', revision: 'r1' }, { id: 'policy-b', revision: 'r2' }])
  const reverse = policySnapshotVersion([{ id: 'policy-b', revision: 'r2' }, { id: 'policy-a', revision: 'r1' }])
  const changed = policySnapshotVersion([{ id: 'policy-a', revision: 'r2' }, { id: 'policy-b', revision: 'r2' }])
  assert.equal(forward, reverse)
  assert.notEqual(forward, changed)
})

test('execution gate requires a live policy snapshot and exact approval at high impact', () => {
  const approvedInput = {
    ...decision,
    safetyDecision: 'ESCALATE',
    livePolicySnapshotVersion: decision.policySnapshotVersion,
    approval,
  }
  const allowed = evaluateDecisionExecutionGate(approvedInput)
  assert.equal(allowed.allowed, true)
  if (allowed.allowed) {
    assert.equal(allowed.approvalRequired, true)
    assert.equal(allowed.actionFingerprint, approval.actionFingerprint)
  }
  assert.deepEqual(evaluateDecisionExecutionGate({
    ...approvedInput,
    livePolicySnapshotVersion: 'sha256:policy-revision-b',
  }), { allowed: false, reason: 'policy-changed' })
  assert.deepEqual(evaluateDecisionExecutionGate({
    ...approvedInput,
    safetyDecision: 'BLOCK',
  }), { allowed: false, reason: 'kernel-blocked' })
  assert.deepEqual(evaluateDecisionExecutionGate({
    ...approvedInput,
    approval: null,
  }), { allowed: false, reason: 'approval-required' })
})

test('execution gate allows a low-impact action only with a current recorded policy snapshot', () => {
  const result = evaluateDecisionExecutionGate({
    ...decision,
    riskLevel: 1,
    requiredApproval: false,
    safetyDecision: 'ALLOW',
    livePolicySnapshotVersion: decision.policySnapshotVersion,
    approvedById: null,
    approval: null,
  })
  assert.equal(result.allowed, true)
  if (result.allowed) assert.equal(result.approvalRequired, false)
})

test('approval request must echo the exact action fingerprint shown to the reviewer', () => {
  const current = approval.actionFingerprint
  assert.equal(approvalFingerprintWasReviewed(current, current), true)
  assert.equal(approvalFingerprintWasReviewed(undefined, current), false)
  assert.equal(approvalFingerprintWasReviewed('sha256:stale', current), false)
  assert.equal(approvalFingerprintWasReviewed(current, null), false)
})
