import { test } from 'node:test'
import assert from 'node:assert/strict'

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

function factory(authorizationKey?: { keyId: string; secret: string }) {
  return createHandlerFactory({
    execution: { maxAgentSteps: 3, allowedAgents: ['query'] },
    log: new Logger({ level: 'error', sink: { write: () => {} } }),
    metrics: createHostMetrics(),
    ...(authorizationKey ? { authorizationKey } : {}),
  })(run())
}

test('Host handlers: configured signing key issues and consumes a protected authorization', async () => {
  const handlers = factory({ keyId: 'acme:host-1', secret: '0123456789abcdef0123456789abcdef' })
  const node = graph.nodes[1]!
  const context = { input: null, runId: 'run-1', tenantId: 'acme', outputs: {}, evaluations: {} }
  const decision = await handlers.authorizeExecution!(node, null, context)
  assert.equal(decision.status, 'ready-to-execute')
  const consumed = await handlers.consumeExecutionAuthorization!(node, decision.authorization!, context)
  assert.deepEqual(consumed, { consumed: true })
})

test('Host handlers: missing signing key fails closed before protected execution', async () => {
  const handlers = factory()
  const node = graph.nodes[1]!
  const context = { input: null, runId: 'run-1', tenantId: 'acme', outputs: {}, evaluations: {} }
  const decision = await handlers.authorizeExecution!(node, null, context)
  assert.equal(decision.status, 'blocked')
  assert.match(decision.reasons[0] ?? '', /signing key/i)
})
