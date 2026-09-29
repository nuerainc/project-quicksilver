import type { SupervisorControlResult } from '../supervisor.ts'
import type { WorkflowNode } from '../workflows/graph.ts'
import type { WorkflowRuntimeContext } from '../workflows/runtime.ts'
import {
  consumeExecutionAuthorization,
  issueExecutionAuthorization,
  verifyExecutionAuthorization,
  type AuthorizationSigningKey,
  type ExecutionAuthorizationRecord,
} from './authorization.ts'

export interface SignedAuthorizationCoordinatorOptions {
  ttlMs?: number
  now?: () => number
  policySnapshot?: string
  evidenceDigest?: string
  /** Digest of the exact workflow content this coordinator admits. Required. */
  workflowDigest?: string
}

/**
 * Adapter used by a hosted executor to turn a kernel authorization decision into
 * a signed record and consume that record exactly once at dispatch.
 */
export function createSignedAuthorizationCoordinator(
  key: AuthorizationSigningKey,
  options: SignedAuthorizationCoordinatorOptions = {},
): {
  authorizeExecution(node: WorkflowNode, _output: unknown, context: WorkflowRuntimeContext): Promise<SupervisorControlResult>
  consumeExecutionAuthorization(node: WorkflowNode, authorization: NonNullable<SupervisorControlResult['authorization']>, context: WorkflowRuntimeContext): Promise<{ consumed: boolean; reason?: string }>
} {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? 60_000
  const consumed = new Set<string>()
  const workflowDigest = options.workflowDigest?.trim() ?? ''

  return {
    async authorizeExecution(node, _output, context) {
      const timestamp = now()
      if (!context.runId || !context.tenantId) {
        return { status: 'blocked', reasons: ['Durable run and tenant identity are required to issue authorization.'] }
      }
      // Without the workflow digest the grant would not be bound to the content
      // that was admitted, so protected execution stops rather than issuing one.
      if (!workflowDigest) {
        return { status: 'blocked', reasons: ['Workflow content digest is required to issue authorization.'] }
      }
      if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 86_400_000) {
        return { status: 'blocked', reasons: ['Authorization TTL is outside the supported range.'] }
      }
      const capability = node.config?.toolId ?? node.config?.agentId ?? `workflow.${node.kind}`
      const record = issueExecutionAuthorization({
        tenantId: context.tenantId,
        runId: context.runId,
        nodeId: node.id,
        actionFingerprint: actionFingerprint(node, capability),
        policySnapshot: options.policySnapshot ?? 'kernel:current',
        evidenceDigest: options.evidenceDigest ?? 'evidence:runtime',
        workflowDigest,
        capability,
        expiresAt: timestamp + ttlMs,
      }, key, timestamp)
      return { status: 'ready-to-execute', reasons: [], authorization: record }
    },

    async consumeExecutionAuthorization(node, authorization, context) {
      if (!context.runId || !context.tenantId) return { consumed: false, reason: 'Durable run and tenant identity are required to consume authorization.' }
      if (!workflowDigest) return { consumed: false, reason: 'Workflow content digest is required to consume authorization.' }
      if (consumed.has(authorization.authorizationId)) return { consumed: false, reason: 'Authorization has already been consumed by this executor.' }
      const record = authorization as ExecutionAuthorizationRecord
      const capability = node.config?.toolId ?? node.config?.agentId ?? `workflow.${node.kind}`
      const verification = verifyExecutionAuthorization(record, key, {
        tenantId: context.tenantId,
        runId: context.runId,
        nodeId: node.id,
        actionFingerprint: actionFingerprint(node, capability),
        workflowDigest,
        now: now(),
      })
      if (!verification.valid) return { consumed: false, reason: verification.reasons.join(' ') }
      try {
        consumeExecutionAuthorization(record, key, now())
      } catch (error) {
        return { consumed: false, reason: (error as Error).message }
      }
      consumed.add(authorization.authorizationId)
      return { consumed: true }
    },
  }
}

function actionFingerprint(node: WorkflowNode, capability: string): string {
  return `action:${node.id}:${capability}`
}
