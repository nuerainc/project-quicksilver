import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createSignedAuthorizationCoordinator } from './authorization-coordinator.ts'
import type { WorkflowNode } from '../workflows/graph.ts'

const key = { keyId: 'kernel-key-1', secret: '0123456789abcdef0123456789abcdef' }
const node: WorkflowNode = {
  id: 'tool-1', kind: 'tool', label: 'Send order',
  config: { toolId: 'orders.send', sideEffect: true, evaluationRequired: true, supervisorApprovalRequired: true },
}
const context = { input: null, runId: 'run-1', tenantId: 'acme', outputs: {}, evaluations: {} }
const options = { now: () => 1_000, ttlMs: 10_000, workflowDigest: 'sha256:wf1' }

test('Coordinator: issues a signed authorization bound to the hosted run context', async () => {
  const coordinator = createSignedAuthorizationCoordinator(key, options)
  const result = await coordinator.authorizeExecution(node, {}, context)
  assert.equal(result.status, 'ready-to-execute')
  assert.equal(result.authorization?.tenantId, 'acme')
  assert.equal(result.authorization?.runId, 'run-1')
  assert.equal(result.authorization?.nodeId, 'tool-1')
  assert.equal(result.authorization?.keyId, 'kernel-key-1')
  assert.equal(result.authorization?.status, 'issued')
  assert.equal(result.authorization?.workflowDigest, 'sha256:wf1')
  assert.match(result.authorization?.signature ?? '', /^hmac-sha256:/)
})

test('Coordinator: consumes once and rejects altered or cross-tenant dispatch', async () => {
  const coordinator = createSignedAuthorizationCoordinator(key, options)
  const issued = await coordinator.authorizeExecution(node, {}, context)
  const authorization = issued.authorization!
  assert.deepEqual(await coordinator.consumeExecutionAuthorization(node, authorization, context), { consumed: true })
  assert.deepEqual(await coordinator.consumeExecutionAuthorization(node, authorization, context), { consumed: false, reason: 'Authorization has already been consumed by this executor.' })

  const other = createSignedAuthorizationCoordinator(key, options)
  const forged = { ...authorization, actionFingerprint: 'action:tool-1:orders.refund' }
  const rejected = await other.consumeExecutionAuthorization(node, forged, context)
  assert.equal(rejected.consumed, false)
  assert.match(rejected.reason ?? '', /signature|fingerprint/i)

  const crossTenant = await other.consumeExecutionAuthorization(node, authorization, { ...context, tenantId: 'globex' })
  assert.equal(crossTenant.consumed, false)
  assert.match(crossTenant.reason ?? '', /tenant/i)
})

test('Coordinator: a grant is refused for different workflow content', async () => {
  const issued = await createSignedAuthorizationCoordinator(key, options).authorizeExecution(node, {}, context)
  const other = createSignedAuthorizationCoordinator(key, { ...options, workflowDigest: 'sha256:wf2' })
  const result = await other.consumeExecutionAuthorization(node, issued.authorization!, context)
  assert.equal(result.consumed, false)
  assert.match(result.reason ?? '', /workflow content/i)
})

test('Coordinator: missing durable identity and invalid TTL fail closed', async () => {
  const missing = createSignedAuthorizationCoordinator(key, options)
  const result = await missing.authorizeExecution(node, {}, { input: null, outputs: {}, evaluations: {} })
  assert.equal(result.status, 'blocked')
  assert.match(result.reasons[0] ?? '', /identity/)

  const invalidTtl = createSignedAuthorizationCoordinator(key, { ...options, ttlMs: 0 })
  const blocked = await invalidTtl.authorizeExecution(node, {}, context)
  assert.equal(blocked.status, 'blocked')
  assert.match(blocked.reasons[0] ?? '', /TTL/)
})

test('Coordinator: without a workflow digest protected execution stops rather than issuing a grant', async () => {
  const coordinator = createSignedAuthorizationCoordinator(key, { now: () => 1_000, ttlMs: 10_000 })
  const result = await coordinator.authorizeExecution(node, {}, context)
  assert.equal(result.status, 'blocked')
  assert.match(result.reasons[0] ?? '', /digest/i)
})
