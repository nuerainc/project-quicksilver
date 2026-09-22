/**
 * Quicksilver Kernel — shared types.
 *
 * The kernel operates on facts, not opinions.
 * The LLM proposes; the kernel authorizes.
 */

export type EntityType = 'human' | 'agent' | 'robot' | 'service' | 'contractor' | 'system'

export type RiskLevel = 0 | 1 | 2 | 3 | 4 | 5

/** A candidate action proposed by the planner model. */
export interface ProposedAction {
  description: string
  /** The entity that would perform the action. */
  actorId: string
  /** The capability being invoked. */
  capabilityId: string
  /** Policies the planner believes apply. */
  applicablePolicyIds: string[]
  /** Evidence the planner is relying on. */
  evidenceIds: string[]
  /** Cost or exposure estimate, if known. */
  financialExposure?: number
  /** Whether the action can be undone cleanly. */
  reversible: boolean
  /** Operational impact, 0-5. */
  operationalImpact: RiskLevel
  /** Uncertainty in the planner's confidence in success. */
  uncertainty: RiskLevel
}

/** A capability reference (denormalized for kernel use). */
export interface CapabilityRef {
  id: string
  name: string
  baseRiskLevel: RiskLevel
  authorizedEntityIds: string[]
}

/** A policy reference. */
export interface PolicyRef {
  id: string
  name: string
  scope: string
  priority: number
  effectiveDate?: string
  /** Null/absent = never expires (Sanity returns null for unset fields). */
  expirationDate?: string | null
  supersedesIds: string[]
  approvalRequirementIds: string[]
}

/** A policy check result — one row in the decision record. */
export interface PolicyCheck {
  policyId: string
  policyName: string
  result: 'applies' | 'superseded' | 'conflicts' | 'inapplicable'
  reason: string
}

/** An entity reference for kernel use. */
export interface EntityRef {
  id: string
  name: string
  entityType: EntityType
  capabilityIds: string[]
  reportsToId?: string | null
}

/** Evidence reference. */
export interface EvidenceRef {
  id: string
  title: string
  confidence: number
}

/** The full authorization result. */
export interface KernelDecision {
  authorized: boolean
  riskLevel: RiskLevel
  requiresApproval: boolean
  blockingReasons: string[]
  concerns: string[]
  policyChecks: PolicyCheck[]
  /** Stable id for the resulting decision document (assigned by caller). */
  recommendation: 'execute-autonomously' | 'request-approval' | 'reject'
}