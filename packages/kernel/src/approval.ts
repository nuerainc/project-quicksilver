import type { CapabilityRef, EvidenceRef, EntityRef, PolicyCheck, PolicyRef, ProposedAction, RiskLevel } from './types.ts'
import { checkCapability } from './capability.ts'
import { checkAuthority } from './authority.ts'
import { averageEvidenceConfidence, computeRisk } from './risk.ts'
import { WAES_BLOCK_REASONS, type WaesReviewFact } from './waes.ts'

/** Defaults used when the QUICKSILVER_RISK_* env vars are unset or invalid. */
export const DEFAULT_RISK_AUTO_MAX: RiskLevel = 2
export const DEFAULT_RISK_REVIEW: RiskLevel = 3

/**
 * Read a 0–5 risk threshold from the environment.
 *
 * Unset, empty, non-numeric, or out-of-range values fall back to `fallback`.
 * (`Number(undefined)` is NaN, and `NaN ?? x` never falls through — which made
 * every risk comparison false and let any action run autonomously.)
 */
function readRiskThreshold(name: string, fallback: RiskLevel): RiskLevel {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 && n <= 5 ? (n as RiskLevel) : fallback
}

/**
 * Approval gate.
 *
 * Returns whether the action may proceed autonomously,
 * requires human approval, or must be rejected.
 *
 * Risk thresholds are environment-driven so the kernel is not a universal policy —
 * it's *your* policy, expressed as configuration.
 */
export interface AuthorizeArgs {
  action: ProposedAction
  actor: EntityRef
  capabilities: CapabilityRef[]
  policies: PolicyRef[]
  evidence: EvidenceRef[]
  /** Facts for structured policy conditions (see authority.ts). */
  facts?: import('./process.ts').Facts
  thresholds?: {
    autoMax?: RiskLevel     // risk ≤ this → autonomous
    review?: RiskLevel      // risk ≤ this → additional validation, no human needed
  }
}

export interface AuthorizeResult {
  authorized: boolean
  riskLevel: RiskLevel
  requiresApproval: boolean
  blockingReasons: string[]
  concerns: string[]
  policyConflicts: string[]
  /** Per-policy audit rows (applies / superseded / inapplicable) for the decision record. */
  policyChecks: PolicyCheck[]
  /** Policy disagreements resolved deterministically by priority. */
  policyResolutions: string[]
  /** Governing policies the kernel applied that the planner did not cite. */
  uncitedPolicyIds: string[]
  averageEvidenceConfidence: number
  recommendation: 'execute-autonomously' | 'request-approval' | 'reject'
}

export function authorize(args: AuthorizeArgs): AuthorizeResult {
  const {
    action,
    actor,
    capabilities,
    policies,
    evidence,
    facts,
    thresholds = {},
  } = args

  const autoMax = thresholds.autoMax ?? readRiskThreshold('QUICKSILVER_RISK_AUTO_MAX', DEFAULT_RISK_AUTO_MAX)
  const review = thresholds.review ?? readRiskThreshold('QUICKSILVER_RISK_REVIEW_THRESHOLD', DEFAULT_RISK_REVIEW)

  const capability = capabilities.find((c) => c.id === action.capabilityId)
  const capabilityCheck = checkCapability(actor, action, capabilities)

  // Filter the evidence pool to only what the action actually cites.
  const actionEvidence = evidence.filter((e) => action.evidenceIds.includes(e.id))
  const riskLevel = computeRisk(action, capability, actionEvidence)
  const authority = checkAuthority(action, policies, {
    riskLevel,
    governingScopes: capability?.policyScopes ?? [],
    actorId: actor.id,
    facts: {
      'action.riskLevel': riskLevel,
      'action.reversible': action.reversible,
      ...(typeof action.financialExposure === 'number' ? { 'action.financialExposure': action.financialExposure } : {}),
      ...(facts ?? {}),
    },
  })
  const evidenceConf = averageEvidenceConfidence(actionEvidence)

  // Hard blocks: the actor fundamentally cannot do this.
  const blockingReasons: string[] = []
  if (!capabilityCheck.allowed) blockingReasons.push(capabilityCheck.reason)
  blockingReasons.push(...authority.blockingReasons)

  // Soft concerns: the actor can attempt this, but humans should review.
  const concerns: string[] = []
  if (authority.conflicts.length > 0) concerns.push(...authority.conflicts)
  concerns.push(...authority.approvalReasons)
  // WAES gate (M5): customer-facing actions are hard-blocked without a passing review of this content.
  if (action.customerFacing === true || facts?.['action.customerFacing'] === true) {
    const review = (facts?.['waes.review'] ?? 'missing') as WaesReviewFact
    if (review !== 'pass') blockingReasons.push(WAES_BLOCK_REASONS[review] ?? WAES_BLOCK_REASONS.missing)
  }
  if (actionEvidence.length === 0) {
    blockingReasons.push('No evidence supports this action.')
  } else if (evidenceConf < 0.5) {
    concerns.push(`Low evidence confidence (${evidenceConf.toFixed(2)} < 0.5).`)
  }

  const riskExceedsReview = riskLevel > review
  const riskExceedsAuto = riskLevel > autoMax

  let recommendation: AuthorizeResult['recommendation']
  let authorized: boolean

  if (blockingReasons.length > 0) {
    // Hard block — actor doesn't have the capability/authority to attempt this.
    recommendation = 'reject'
    authorized = false
  } else if (riskExceedsReview || riskExceedsAuto || concerns.length > 0) {
    // Within the actor's authority, but humans must review before execution.
    // NOTE: `riskExceedsAuto` (not just `riskExceedsReview`) belongs in this
    // condition. Risk strictly between autoMax and review used to fall through
    // to the 'execute-autonomously' branch below while `requiresApproval` was
    // independently computed as true from `riskExceedsAuto` -- a real tier
    // quirk where the UI (which keys off `recommendation`) could label an
    // action "execute autonomously" even though it required approval.
    recommendation = 'request-approval'
    authorized = true
  } else {
    recommendation = 'execute-autonomously'
    authorized = true
  }

  const requiresApproval = recommendation !== 'execute-autonomously'

  return {
    authorized,
    riskLevel,
    requiresApproval,
    blockingReasons,
    concerns,
    policyConflicts: authority.conflicts,
    policyChecks: authority.checks,
    policyResolutions: authority.resolutions,
    uncitedPolicyIds: authority.uncitedPolicyIds,
    averageEvidenceConfidence: evidenceConf,
    recommendation,
  }
}
