import { approvalDigest, NO_APPROVAL_DIGEST, type HumanApprovalBinding, type SupervisorControlResult } from '../supervisor.ts'
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
  /**
   * Digest of the policy state in force, from `policySnapshot()`. Required: the
   * previous default was the literal `kernel:current`, which made every grant
   * look current no matter how the policy had moved.
   */
  policySnapshot?: string
  evidenceDigest?: string
  /** Digest of the exact workflow content this coordinator admits. Required. */
  workflowDigest?: string
  /**
   * The human approval this grant rests on. When supplied, its digest is bound
   * into the signed record, so the grant cannot later be paired with a
   * different or expired approval. Omitting it records an explicit
   * no-approval grant, which the Supervisor gate will not accept for an action
   * that required human approval.
   */
  approval?: HumanApprovalBinding
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
  const policySnapshot = options.policySnapshot?.trim() ?? ''
  const boundApprovalDigest = options.approval ? approvalDigest(options.approval) : NO_APPROVAL_DIGEST

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
      if (!policySnapshot) {
        return { status: 'blocked', reasons: ['Policy snapshot is required to issue authorization; the policy state in force must be known.'] }
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
        policySnapshot,
        evidenceDigest: options.evidenceDigest ?? 'evidence:runtime',
        workflowDigest,
        approvalDigest: boundApprovalDigest,
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
        approvalDigest: boundApprovalDigest,
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
