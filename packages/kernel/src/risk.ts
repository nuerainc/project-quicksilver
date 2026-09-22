import type { CapabilityRef, EvidenceRef, ProposedAction, RiskLevel } from './types.ts'

/**
 * Risk computation — a small, deterministic engine.
 *
 * risk = capability base risk
 *       + financial exposure tier
 *       + operational impact
 *       + (reversible ? 0 : 1)
 *       + uncertainty
 *
 * Clamped to 0..5.
 *
 * Day-9 work: calibrate against the demo dataset.
 */
export function computeRisk(
  action: ProposedAction,
  capability: CapabilityRef | undefined,
  evidence: EvidenceRef[],
): RiskLevel {
  const base = capability?.baseRiskLevel ?? 2
  const financial = financialExposureTier(action.financialExposure ?? 0)
  const operational = action.operationalImpact
  const reversibility = action.reversible ? 0 : 1
  const uncertainty = action.uncertainty

  const total = base + financial + operational + reversibility + uncertainty
  return Math.max(0, Math.min(5, total)) as RiskLevel
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