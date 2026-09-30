export type DecisionSnapshot = {
  id: string
  title: string
  status: string
  riskLevel: number | null
  requiredApproval: boolean
  safetyDecision: string | null
  createdAt: string | null
}

export type OperatingMetric = {
  id: string
  name: string
  value: number
  unit: string | null
  baseline: number | null
  direction: 'higher-better' | 'lower-better' | null
  updatedAt: string | null
}

export type ExperimentSnapshot = { id: string; hypothesis: string; status: string; budgetUsd: number | null; endsAt: string | null }
export type LedgerTotals = { entryCount: number; spendUsd: number; computeUsd: number; revenueUsd: number; refundsUsd: number }
export type FinanceOverview = { observedAt: string; ledger: LedgerTotals }

export type BusinessOverview = {
  observedAt: string
  decisionCounts: { total: number; awaitingApproval: number; approved: number; executed: number; blocked: number; failed: number }
  recentDecisions: DecisionSnapshot[]
  metrics: OperatingMetric[]
  experiments: ExperimentSnapshot[]
}

export type BusinessDashboardError = { error: string }

export function summarizeDecisions(decisions: DecisionSnapshot[]): BusinessOverview['decisionCounts'] {
  return decisions.reduce((counts, decision) => {
    counts.total += 1
    if (decision.status === 'awaiting-approval' || decision.status === 'proposed' || decision.status === 'rollback-proposed') counts.awaitingApproval += 1
    if (decision.status === 'approved') counts.approved += 1
    if (decision.status === 'executed' || decision.status === 'rolled-back') counts.executed += 1
    if (decision.status === 'rejected' || decision.safetyDecision === 'BLOCK') counts.blocked += 1
    if (decision.status === 'failed') counts.failed += 1
    return counts
  }, { total: 0, awaitingApproval: 0, approved: 0, executed: 0, blocked: 0, failed: 0 })
}

export function recordedNetUsd(ledger: LedgerTotals): number {
  return ledger.revenueUsd + ledger.refundsUsd - ledger.spendUsd - ledger.computeUsd
}
