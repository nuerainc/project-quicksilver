import type { CapabilityRef, EvidenceRef, ProposedAction, RiskLevel } from './types.ts'

/**
 * Risk computation — a small, deterministic engine.
 *
 *   risk = capability base risk            (0-5, from the Sanity capability doc)
 *        + impact tier                     (0-3: the larger of financial exposure
 *                                           and operational impact, both tiered)
 *        + (reversible ? 0 : 1)
 *        + (uncertainty >= 4 ? 1 : 0)
 *
 * Clamped to 0..5.
 *
 * Why tiers (changed Sep 22 after the live stress test): the original formula
 * added operational impact (0-5) and uncertainty (0-5) at full weight on top
 * of the base risk. With real planner output that clamped almost everything
 * to 5/5 -- 17 of 17 live decisions, including a "read-only diagnostic scan"
 * -- so the kernel's autonomous lane could never fire. Tiering keeps the
 * capability's own base risk dominant and lets impact, irreversibility and
 * high uncertainty push a decision up a level or two, not straight to the cap.
 * On the same 17 live inputs this gives 2 x3, 3 x6, 4 x2, 5 x6: read-only
 * work lands at 2 (autonomous), parameter changes and emergency overrides
 * stay at 5.
 */
export function computeRisk(
  action: ProposedAction,
  capability: CapabilityRef | undefined,
  evidence: EvidenceRef[],
): RiskLevel {
  return explainRisk(action, capability, evidence).riskLevel
}

export interface RiskBreakdown {
  baseRisk: RiskLevel
  financialImpact: 0 | 1 | 2 | 3
  operationalImpact: 0 | 1 | 2
  impact: 0 | 1 | 2 | 3
  reversibility: 0 | 1
  uncertainty: 0 | 1
  preMultiplierRisk: RiskLevel
  riskLevel: RiskLevel
}

/** The exact components used by computeRisk, for audit and UI introspection. */
export function explainRisk(
  action: ProposedAction,
  capability: CapabilityRef | undefined,
  _evidence: EvidenceRef[],
): RiskBreakdown {
  const baseRisk = (capability?.baseRiskLevel ?? 2) as RiskLevel
  const financialImpact = financialExposureTier(action.financialExposure ?? 0)
  const operationalImpact = operationalImpactTier(action.operationalImpact)
  const impact = Math.max(financialImpact, operationalImpact) as RiskBreakdown['impact']
  const reversibility = action.reversible ? 0 : 1
  const uncertainty = action.uncertainty >= 4 ? 1 : 0
  const preMultiplierRisk = Math.max(0, Math.min(5, baseRisk + impact + reversibility + uncertainty)) as RiskLevel
  return { baseRisk, financialImpact, operationalImpact, impact, reversibility, uncertainty, preMultiplierRisk, riskLevel: preMultiplierRisk }
}

/** Operational impact 0-5 → tier 0-2 (0-1 negligible, 2-3 moderate, 4-5 severe). */
function operationalImpactTier(impact: number): 0 | 1 | 2 {
  if (impact <= 1) return 0
  if (impact <= 3) return 1
  return 2
}

function financialExposureTier(amount: number): 0 | 1 | 2 | 3 {
  if (amount <= 0) return 0
  if (amount < 1_000) return 0
  if (amount < 10_000) return 1
  if (amount < 100_000) return 2
  return 3
}

/**
 * Average confidence of the supporting evidence.
 * Used to flag low-confidence decisions for additional review.
 */
export function averageEvidenceConfidence(evidence: EvidenceRef[]): number {
  if (evidence.length === 0) return 0
  return evidence.reduce((sum, e) => sum + e.confidence, 0) / evidence.length
}
