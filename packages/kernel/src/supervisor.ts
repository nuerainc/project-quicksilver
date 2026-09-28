import type { SafetyDecision } from './nqc/index.ts'

/** The Supervisor Agent coordinates these phases; it never grants authority. */
export type SupervisorControlStatus =
  | 'blocked'
  | 'awaiting-human-approval'
  | 'ready-to-execute'

export interface KernelExecutionAuthorization {
  authorizationId: string
  /** Signed durable-record metadata verified by the executor before dispatch. */
  keyId?: string
  signature?: string
  status?: 'issued' | 'consumed' | 'revoked'
  tenantId: string
  runId?: string
  nodeId?: string
  actionFingerprint: string
  policySnapshot: string
  evidenceDigest: string
  capability: string
  issuedAt: number
  expiresAt: number
}

export interface HumanApprovalBinding {
  approvedBy: string
  approvedByKind: 'human' | 'service' | 'agent'
  tenantId: string
  actionFingerprint: string
  policySnapshot: string
  evidenceDigest: string
  approvedAt: number
}

export interface SupervisorControlRequest {
  supervisorAgentId: string
  tenantId: string
  actionFingerprint: string
  policySnapshot: string
  evidenceDigest: string
  capability: string
  safetyDecision: SafetyDecision
  requiresHumanApproval: boolean
  authorization?: KernelExecutionAuthorization
  approval?: HumanApprovalBinding
  now?: number
}

export interface SupervisorControlResult {
  status: SupervisorControlStatus
  reasons: string[]
  /** Only present when the request is ready for an executor. */
  authorization?: KernelExecutionAuthorization
}

/**
 * Validate the Supervisor Agent's control-plane hand-off.
 *
 * This function intentionally accepts a kernel-issued authorization as input;
 * it does not mint one. A Supervisor Agent can coordinate approval and submit
 * an execution request, but only the NQC Kernel can produce the authorization
 * that makes execution eligible.
 */
export function coordinateSupervisorControl(request: SupervisorControlRequest): SupervisorControlResult {
  const reasons: string[] = []
  const now = request.now ?? Date.now()

  if (request.supervisorAgentId !== 'nuera-quicksilver:supervisor') {
    reasons.push('Only the registered Supervisor Agent may coordinate execution.')
  }
  if (!request.tenantId.trim()) reasons.push('Tenant binding is required.')
  if (!request.actionFingerprint.trim()) reasons.push('Exact action fingerprint is required.')
  if (!request.policySnapshot.trim()) reasons.push('Policy snapshot binding is required.')
  if (!request.evidenceDigest.trim()) reasons.push('Evidence digest binding is required.')
  if (!request.capability.trim()) reasons.push('Capability binding is required.')

  if (request.safetyDecision === 'BLOCK') {
    reasons.push('The NQC Kernel blocked this action; the Supervisor Agent cannot override it.')
    return { status: 'blocked', reasons }
  }

  if (reasons.length > 0) return { status: 'blocked', reasons }

  if (request.requiresHumanApproval && !request.approval) {
    return {
      status: 'awaiting-human-approval',
      reasons: ['A Human Supervisor approval binding is required before execution.'],
    }
  }

  const approval = request.approval
  if (approval) {
    if (approval.approvedByKind !== 'human') reasons.push('Only a human principal may provide this approval binding.')
    if (!approval.approvedBy.trim()) reasons.push('Approval principal is required.')
    if (approval.tenantId !== request.tenantId) reasons.push('Approval and action belong to different tenants.')
    if (approval.actionFingerprint !== request.actionFingerprint) reasons.push('Approval is not bound to the exact action fingerprint.')
    if (approval.policySnapshot !== request.policySnapshot) reasons.push('Approval is bound to a different policy snapshot.')
    if (approval.evidenceDigest !== request.evidenceDigest) reasons.push('Approval is bound to a different evidence digest.')
    if (approval.approvedAt > now) reasons.push('Approval timestamp is in the future.')
  }

  const authorization = request.authorization
  if (!authorization) reasons.push('A current NQC Kernel execution authorization is required.')
  else {
    if (authorization.tenantId !== request.tenantId) reasons.push('Authorization and action belong to different tenants.')
    if (authorization.actionFingerprint !== request.actionFingerprint) reasons.push('Authorization is not bound to the exact action fingerprint.')
    if (authorization.policySnapshot !== request.policySnapshot) reasons.push('Authorization is bound to a different policy snapshot.')
    if (authorization.evidenceDigest !== request.evidenceDigest) reasons.push('Authorization is bound to a different evidence digest.')
    if (authorization.capability !== request.capability) reasons.push('Authorization is bound to a different capability.')
    if (authorization.issuedAt > now) reasons.push('Authorization timestamp is in the future.')
    if (authorization.expiresAt <= now) reasons.push('Kernel execution authorization has expired.')
  }

  if (reasons.length > 0) return { status: 'blocked', reasons }
  return { status: 'ready-to-execute', reasons: [], authorization }
}
