import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  consumeExecutionAuthorization,
  issueExecutionAuthorization,
  revokeExecutionAuthorization,
  verifyExecutionAuthorization,
} from './authorization.ts'

const key = { keyId: 'kernel-key-1', secret: '0123456789abcdef0123456789abcdef' }
const input = {
  tenantId: 'acme', runId: 'run-1', nodeId: 'tool-1', actionFingerprint: 'action:abc',
  policySnapshot: 'policy:1', evidenceDigest: 'evidence:1', workflowDigest: 'sha256:wf1',
  approvalDigest: 'sha256:ap1', capability: 'orders.send', expiresAt: 2_000,
}
const expected = { tenantId: 'acme', runId: 'run-1', nodeId: 'tool-1', actionFingerprint: 'action:abc', workflowDigest: 'sha256:wf1', approvalDigest: 'sha256:ap1' }

test('Authorization: issued records verify against tenant, run, node, and exact action', () => {
  const record = issueExecutionAuthorization(input, key, 1_000)
  assert.match(record.authorizationId, /^auth:/)
  assert.equal(record.status, 'issued')
  assert.equal(verifyExecutionAuthorization(record, key, { ...expected, now: 1_500 }).valid, true)
  assert.equal(verifyExecutionAuthorization(record, key, { ...expected, tenantId: 'other', now: 1_500 }).valid, false)
  assert.equal(verifyExecutionAuthorization(record, key, { ...expected, actionFingerprint: 'action:other', now: 1_500 }).valid, false)
})

test('Authorization: tampering, wrong key, expiry, and future issue time fail closed', () => {
  const record = issueExecutionAuthorization(input, key, 1_000)
  const tampered = { ...record, capability: 'orders.refund' }
  assert.equal(verifyExecutionAuthorization(tampered, key, { ...expected, now: 1_500 }).valid, false)
  assert.equal(verifyExecutionAuthorization(record, { ...key, keyId: 'kernel-key-2' }, { ...expected, now: 1_500 }).valid, false)
  assert.equal(verifyExecutionAuthorization(record, key, { ...expected, now: 2_000 }).valid, false)
  const future = issueExecutionAuthorization({ ...input, authorizationId: 'auth:future', issuedAt: 2_000, expiresAt: 4_000 }, key, 2_000)
  assert.equal(verifyExecutionAuthorization(future, key, { ...expected, now: 1_999 }).valid, false)
})

test('Authorization: consumption is one-way and revocation is auditable', () => {
  const consumed = consumeExecutionAuthorization(issueExecutionAuthorization(input, key, 1_000), key, 1_200)
  assert.equal(consumed.status, 'consumed')
  assert.equal(verifyExecutionAuthorization(consumed, key, { ...expected, now: 1_300 }).valid, false)

  const revoked = revokeExecutionAuthorization(issueExecutionAuthorization({ ...input, authorizationId: 'auth:revoked' }, key, 1_000), key, 'operator cancelled', 1_100)
  assert.equal(revoked.status, 'revoked')
  assert.equal(revoked.revokeReason, 'operator cancelled')
  assert.equal(verifyExecutionAuthorization(revoked, key, { ...expected, now: 1_200 }).valid, false)
})

test('Authorization: signing keys must be strong enough for production use', () => {
  assert.throws(() => issueExecutionAuthorization(input, { keyId: 'weak', secret: 'short' }, 1_000), /at least 32 characters/)
})

test('Authorization: a record with no signature is refused even when every field matches', () => {
  const record = issueExecutionAuthorization(input, key, 1_000)
  // Every identity binding is correct; only the signature is absent. Verifying
  // the signature only when one is present would let this through.
  const unsigned = { ...record, signature: '' }
  const result = verifyExecutionAuthorization(unsigned, key, { ...expected, now: 1_500 })
  assert.equal(result.valid, false)
  assert.ok(result.reasons.some((reason) => /not signed/.test(reason)), result.reasons.join(' '))
})

test('Authorization: a grant is bound to the workflow content it was issued for', () => {
  const record = issueExecutionAuthorization(input, key, 1_000)
  const other = verifyExecutionAuthorization(record, key, { ...expected, workflowDigest: 'sha256:other', now: 1_500 })
  assert.equal(other.valid, false)
  assert.ok(other.reasons.some((reason) => /workflow content/.test(reason)), other.reasons.join(' '))
  // The same record still verifies for the workflow it was actually issued for.
  assert.equal(verifyExecutionAuthorization(record, key, { ...expected, now: 1_500 }).valid, true)
})

test('Authorization: a grant is bound to the approval it rests on', () => {
  const record = issueExecutionAuthorization(input, key, 1_000)
  const other = verifyExecutionAuthorization(record, key, { ...expected, approvalDigest: 'sha256:ap2', now: 1_500 })
  assert.equal(other.valid, false)
  assert.ok(other.reasons.some((reason) => /this approval/.test(reason)), other.reasons.join(' '))
  assert.equal(verifyExecutionAuthorization(record, key, { ...expected, now: 1_500 }).valid, true)
})
