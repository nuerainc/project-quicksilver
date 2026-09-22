/**
 * Seed shape — denormalized for the kernel and Studio importer.
 * Studio expects `_type`; refs use string ids here and become `{_type:'reference', _ref: id}` at load time.
 */

export type EntityType = 'human' | 'agent' | 'robot' | 'service' | 'contractor' | 'system'
export type RiskLevel = 0 | 1 | 2 | 3 | 4 | 5

export interface OrganizationSeed {
  _id: string
  name: string
  mission: string
  objectiveIds: string[]
  departmentIds: string[]
  policyIds: string[]
  resourceEntityIds: string[]
}

export interface DepartmentSeed {
  _id: string
  name: string
  purpose: string
  parentDepartmentId: string | null
  leaderId: string
  memberIds: string[]
  capabilityIds: string[]
  objectiveIds: string[]
}

export interface EntitySeed {
  _id: string
  name: string
  entityType: EntityType
  title: string
  capabilityIds: string[]
  permissionIds: string[]
  constraintIds: string[]
  reportsToId: string | null
  departmentId: string | null
  availability: string
  riskProfile: RiskLevel
  costProfile: 'low' | 'medium' | 'high' | 'premium'
}

export interface CapabilitySeed {
  _id: string
  name: string
  description: string
  requiredSkills: string[]
  riskLevel: RiskLevel
  authorizedEntityIds: string[]
  requiredTools: string[]
}

export interface ObjectiveSeed {
  _id: string
  name: string
  description: string
  ownerId: string
  priority: number
  deadline: string
  constraints: string[]
  successMetrics: string[]
  budget: { amount: number; currency: string }
  status: 'draft' | 'active' | 'blocked' | 'achieved' | 'abandoned'
}

export interface PolicySeed {
  _id: string
  name: string
  scope: string
  priority: number
  rules: string[]
  effectiveDate: string
  expirationDate: string | null
  supersedesIds: string[]
  approvalRequirementIds: string[]
}

export interface EvidenceSeed {
  _id: string
  title: string
  type: 'report' | 'metric' | 'incident' | 'analysis' | 'observation' | 'external'
  source: string
  claim: string
  confidence: number
  effectiveDate: string
  relatedEntityIds: string[]
  supportsObjectiveIds: string[]
  contradictsEvidenceIds: string[]
}

export interface WorkflowGuardCondition {
  fact: string
  op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'notIn' | 'exists'
  value?: string | number | boolean | string[]
}

/** Mirrors ProcessDefinition in packages/kernel/src/process.ts, plus seed-only fields. */
export interface WorkflowSeed {
  _id: string
  name: string
  version: number
  trigger: string
  initialState: string
  states: Array<{ id: string; label: string; terminal?: boolean }>
  transitions: Array<{
    id: string
    from: string
    to: string
    label?: string
    automatic?: boolean
    requiresHumanApproval?: boolean
    guard?: { all?: WorkflowGuardCondition[]; any?: WorkflowGuardCondition[] }
  }>
  requiredCapabilityIds: string[]
  approvalRequirementIds: string[]
  failureHandlers: string[]
  rollbackProcedure: string
}

export interface DecisionSeed {
  _id: string
  question: string
  contextEntityIds: string[]
  contextCapabilityIds: string[]
  contextPolicyIds: string[]
  candidateActions: Array<{ description: string; actorId: string; capabilityId: string }>
  selectedAction: string
  reasoningSummary: string
  evidenceIds: string[]
  constraints: string[]
  policyChecks: Array<{ policyId: string; result: string; reason: string }>
  riskLevel: RiskLevel
  requiredApproval: boolean
  status: 'proposed' | 'awaiting-approval' | 'approved' | 'rejected' | 'executed' | 'failed' | 'rollback-proposed' | 'rolled-back'
  createdAt: string
  approvedById: string | null
  executedAt: string | null
}