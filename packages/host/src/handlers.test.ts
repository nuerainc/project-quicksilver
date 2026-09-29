import { test } from 'node:test'
import assert from 'node:assert/strict'

import type { PolicyRef } from '@quicksilver/kernel'
import type { WorkflowGraph } from '@quicksilver/kernel/workflows/graph'
import { createHandlerFactory } from './handlers.ts'
import { Logger } from './log.ts'
import { createHostMetrics } from './metrics.ts'

const graph: WorkflowGraph = {
  schemaVersion: 1, id: 'protected', version: 1, entryNodeId: 'start',
  nodes: [
    { id: 'start', kind: 'trigger', label: 'Start' },
    { id: 'send', kind: 'tool', label: 'Send', config: { toolId: 'email.send', sideEffect: true, evaluationRequired: true, supervisorApprovalRequired: true } },
    { id: 'done', kind: 'output', label: 'Done' },
  ],
  edges: [{ id: 'e1', from: 'start', to: 'send' }, { id: 'e2', from: 'send', to: 'done' }],
}

function run() {
  return {
    runId: 'run-1', tenantId: 'acme', workflowId: 'protected', workflowVersion: 1,
    graph, graphDigest: 'sha256:test', input: null, status: 'running' as const, attempt: 1, maxAttempts: 1,
    contractVersion: 1 as const, revision: 1, createdAt: 1, updatedAt: 1, availableAt: 1, trigger: { kind: 'manual' as const }, priority: 0,
  }
}

function factory(authorizationKey?: { keyId: string; secret: string }, policies?: PolicyRef[], evidenceCount?: number) {
  return createHandlerFactory({
    execution: { maxAgentSteps: 3, allowedAgents: ['query'] },
    log: new Logger({ level: 'error', sink: { write: () => {} } }),
    metrics: createHostMetrics(),
    ...(authorizationKey ? { authorizationKey } : {}),
    ...(policies ? { policies } : {}),
    ...(evidenceCount ? { evidenceCount } : {}),
  })(run())
}

const hostPolicies: PolicyRef[] = [{
  id: 'acme.max-risk', name: 'Max risk', scope: 'acme', priority: 10,
  supersedesIds: [], approvalRequirementIds: [], version: 1, lineageId: 'lin.max-risk',
}]

test('Host handlers: configured signing key issues and consumes a protected authorization', async () => {
  const handlers = factory({ keyId: 'acme:host-1', secret: '0123456789abcdef0123456789abcdef' }, hostPolicies, 2)
  const node = graph.nodes[1]!
  const context = { input: null, runId: 'run-1', tenantId: 'acme', outputs: {}, evaluations: {} }
  const decision = await handlers.authorizeExecution!(node, null, context)
  assert.equal(decision.status, 'ready-to-execute')
  const consumed = await handlers.consumeExecutionAuthorization!(node, decision.authorization!, context)
  assert.deepEqual(consumed, { consumed: true })
})

test('Host handlers: a signing key without a known policy state cannot issue a grant', async () => {
  // Without a policy set the host cannot know whether the policy in force is
  // the one the decision was made under, so protected execution stops.
  const handlers = factory({ keyId: 'acme:host-1', secret: '0123456789abcdef0123456789abcdef' })
  const node = graph.nodes[1]!
  const context = { input: null, runId: 'run-1', tenantId: 'acme', outputs: {}, evaluations: {} }
  const decision = await handlers.authorizeExecution!(node, null, context)
  assert.equal(decision.status, 'blocked')
  assert.match(decision.reasons.join(' '), /policy snapshot/i)
})

test('Host handlers: a host that declares no evidence cannot issue a grant', async () => {
  const key = { keyId: 'acme:host-1', secret: '0123456789abcdef0123456789abcdef' }
  const node = graph.nodes[1]!
  const context = { input: null, runId: 'run-1', tenantId: 'acme', outputs: {}, evaluations: {} }
  // Policy known, evidence not: an action with nothing behind it is refused
  // rather than granted on the strength of a digest that happens to be valid.
  const decision = await factory(key, hostPolicies).authorizeExecution!(node, null, context)
  assert.equal(decision.status, 'blocked')
  assert.match(decision.reasons.join(' '), /evidence/i)
})

test('Host handlers: a changed policy produces a different snapshot on the grant', async () => {
  const key = { keyId: 'acme:host-1', secret: '0123456789abcdef0123456789abcdef' }
  const node = graph.nodes[1]!
  const context = { input: null, runId: 'run-1', tenantId: 'acme', outputs: {}, evaluations: {} }
  const before = await factory(key, hostPolicies, 2).authorizeExecution!(node, null, context)
  const after = await factory(key, [{ ...hostPolicies[0]!, version: 2 }], 2).authorizeExecution!(node, null, context)
  assert.equal(before.status, 'ready-to-execute')
  assert.equal(after.status, 'ready-to-execute')
  assert.notEqual(before.authorization?.policySnapshot, after.authorization?.policySnapshot)
})

test('Host handlers: missing signing key fails closed before protected execution', async () => {
  const handlers = factory()
  const node = graph.nodes[1]!
  const context = { input: null, runId: 'run-1', tenantId: 'acme', outputs: {}, evaluations: {} }
  const decision = await handlers.authorizeExecution!(node, null, context)
  assert.equal(decision.status, 'blocked')
  assert.match(decision.reasons[0] ?? '', /signing key/i)
})
