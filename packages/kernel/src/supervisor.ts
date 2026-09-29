import { createHash } from 'node:crypto'

import { policySnapshotIsCurrent } from './policy-snapshot.ts'
import { verifyExecutionAuthorization, type AuthorizationSigningKey } from './runtime/authorization.ts'
import type { SafetyDecision } from './nqc/index.ts'

/** The Supervisor Agent coordinates these phases; it never grants authority. */
export type SupervisorControlStatus =
  | 'blocked'
  | 'awaiting-human-approval'
  | 'ready-to-execute'

/** Digest recorded in a grant that was issued without any human approval bound. */
export const NO_APPROVAL_DIGEST = 'approval:none'

export interface KernelExecutionAuthorization {
  authorizationId: string
  /** Signed durable-record metadata verified by the executor before dispatch. */
  keyId: string
  signature: string
  status?: 'issued' | 'consumed' | 'revoked'
  tenantId: string
  runId?: string
  nodeId?: string
  actionFingerprint: string
  policySnapshot: string
  evidenceDigest: string
  evidenceCount: number
  workflowDigest: string
  /** Digest of the human approval this grant rests on, or NO_APPROVAL_DIGEST. */
  approvalDigest: string
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
  /**
   * A human approval goes stale. Without this an approval granted once would
   * authorize the same action indefinitely, long after the person stopped
   * considering it.
   */
  expiresAt: number
}

/**
 * Canonical digest of a human approval binding.
 *
 * The kernel-signed grant carries this, so the authority to execute is bound to
 * one specific approval. Presenting a different — or expired — approval at
 * execution time does not match the grant the kernel issued.
 */
export function approvalDigest(approval: HumanApprovalBinding): string {
  const canonical = JSON.stringify({
    actionFingerprint: approval.actionFingerprint,
    approvedAt: approval.approvedAt,
    approvedBy: approval.approvedBy,
    approvedByKind: approval.approvedByKind,
    evidenceDigest: approval.evidenceDigest,
    expiresAt: approval.expiresAt,
    policySnapshot: approval.policySnapshot,
    tenantId: approval.tenantId,
  })
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`
}

export interface SupervisorControlRequest {
  supervisorAgentId: string
  tenantId: string
  /** The durable run this decision belongs to. */
  runId: string
  actionFingerprint: string
  policySnapshot: string
  /**
   * Digest of the policy state in force *now*. Compared against the snapshot
   * this action was evaluated under, so a decision made before a policy
   * changed cannot execute against the new one. A caller that cannot determine
   * the live policy state must leave this empty and be refused.
   */
  currentPolicySnapshot: string
  evidenceDigest: string
  /**
   * How many pieces of evidence support this action. A digest cannot express
   * "none" — the digest of an empty set is a valid digest — so the count is
   * what lets the gate refuse an action that has no evidence behind it.
   */
  evidenceCount: number
  workflowDigest: string
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
 *
 * The signing key is required and the record is verified cryptographically
 * here. Comparing the fields a caller supplies would not prove the record came
 * from the kernel: a hand-built object carrying the right tenant, fingerprint,
 * policy, evidence and capability would otherwise pass on its face alone. A
 * `ready-to-execute` result therefore always means a live kernel signature over
 * exactly these bindings.
 */
export function coordinateSupervisorControl(
  request: SupervisorControlRequest,
  key: AuthorizationSigningKey,
): SupervisorControlResult {
  const reasons: string[] = []
  const now = request.now ?? Date.now()

  if (request.supervisorAgentId !== 'nuera-quicksilver:supervisor') {
    reasons.push('Only the registered Supervisor Agent may coordinate execution.')
  }
  if (!request.tenantId.trim()) reasons.push('Tenant binding is required.')
  if (!request.runId.trim()) reasons.push('Durable run binding is required.')
  if (!request.actionFingerprint.trim()) reasons.push('Exact action fingerprint is required.')
  if (!request.policySnapshot.trim()) reasons.push('Policy snapshot binding is required.')
  if (!request.currentPolicySnapshot.trim()) reasons.push('The policy state in force now could not be established; refusing rather than assuming the decision is current.')
  // The decision was evaluated under one policy state; it may only execute
  // under that same state. A policy that changed in between invalidates it.
  if (request.currentPolicySnapshot.trim() && !policySnapshotIsCurrent(request.policySnapshot, request.currentPolicySnapshot)) {
    reasons.push('The policy has changed since this action was evaluated; the decision must be made again under the current policy.')
  }
  if (!request.evidenceDigest.trim()) reasons.push('Evidence digest binding is required.')
  if (!Number.isInteger(request.evidenceCount) || request.evidenceCount < 1) {
    reasons.push('No evidence supports this action; an action with no evidence cannot be authorized.')
  }
  if (!request.workflowDigest.trim()) reasons.push('Workflow content digest is required.')
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
    if (approval.expiresAt <= now) reasons.push('Human approval has expired.')
    if (approval.expiresAt <= approval.approvedAt) reasons.push('Approval expiry must be after the approval time.')
  }

  const authorization = request.authorization
  if (!authorization) reasons.push('A current NQC Kernel execution authorization is required.')
  else {
    if (authorization.tenantId !== request.tenantId) reasons.push('Authorization and action belong to different tenants.')
    if (authorization.runId !== request.runId) reasons.push('Authorization belongs to a different run.')
    if (authorization.actionFingerprint !== request.actionFingerprint) reasons.push('Authorization is not bound to the exact action fingerprint.')
    if (authorization.policySnapshot !== request.policySnapshot) reasons.push('Authorization is bound to a different policy snapshot.')
    if (authorization.evidenceDigest !== request.evidenceDigest) reasons.push('Authorization is bound to a different evidence digest.')
    if (authorization.evidenceCount !== request.evidenceCount) reasons.push('Authorization is bound to a different amount of evidence.')
    if (authorization.workflowDigest !== request.workflowDigest) reasons.push('Authorization is bound to different workflow content.')
    // The grant must rest on the very approval being presented. Without this an
    // approval could be swapped, or a grant issued with no approval at all
    // could be used to satisfy a human-approval requirement.
    const presentedApprovalDigest = approval ? approvalDigest(approval) : NO_APPROVAL_DIGEST
    if (authorization.approvalDigest !== presentedApprovalDigest) {
      reasons.push('Authorization is not bound to this human approval.')
    }
    if (authorization.capability !== request.capability) reasons.push('Authorization is bound to a different capability.')
    if (authorization.issuedAt > now) reasons.push('Authorization timestamp is in the future.')
    if (authorization.expiresAt <= now) reasons.push('Kernel execution authorization has expired.')
    // Run and node come from the request and the record respectively: the run
    // is an independent binding the Supervisor already knows, and the signature
    // covers both, so a tampered record is still rejected here.
    const verification = verifyExecutionAuthorization(
      authorization as Parameters<typeof verifyExecutionAuthorization>[0],
      key,
      {
        tenantId: request.tenantId,
        runId: request.runId,
        nodeId: authorization.nodeId ?? '',
        actionFingerprint: request.actionFingerprint,
        workflowDigest: request.workflowDigest,
        approvalDigest: presentedApprovalDigest,
        evidenceCount: request.evidenceCount,
        now,
      },
    )
    if (!verification.valid) reasons.push(...verification.reasons)
  }

  if (reasons.length > 0) return { status: 'blocked', reasons }
  return { status: 'ready-to-execute', reasons: [], authorization }
}
