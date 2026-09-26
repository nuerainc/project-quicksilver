import type { Facts } from '../process.ts'
import type { RiskLevel } from '../types.ts'
import { waesFacts, type WaesFacts, type WaesReview } from '../waes.ts'
import { spendRiskLevel, type Experiment, type MoneyLedger, type MoneyTotals, moneyTotals } from './economics.ts'

/**
 * Genesis run configuration (M5): the $500, 30-day, digital-only demonstration.
 *
 * The config is data. It fixes, before the run starts:
 *   - the budget (compute included) and the duration
 *   - what money may be spent on, and what is never allowed
 *   - when a spend may go ahead on its own, when it needs the founder,
 *     and when it is refused
 *   - the prerequisites: an approved legal entity and payment accounts held
 *     in the vault. The run cannot start without them.
 */

export interface GenesisRunConfig {
  schemaVersion: 1
  runId: string
  playbookId: string
  budgetUsd: number
  durationDays: number
  digitalOnly: true
  allowedCategories: string[]
  prohibitedCategories: string[]
  spend: {
    /** A single spend at or below this, with risk ≤ autoMaxRisk, may go ahead without the founder. */
    autoMaxUsd: number
    autoMaxRisk: RiskLevel
    /** Total spend per UTC day. */
    dailyCapUsd: number
  }
  /** Customer-facing content needs a passing WAES review (the kernel enforces it; this must be true). */
  waesRequired: true
  /**
   * Accept a manual founder review in place of a WAES run (default false).
   * On while the WAES suites do not run as a service; turn it off once they do.
   * A manual pass is always recorded as manual (`waes.reviewKind: 'manual'`).
   */
  waesManualReviewAllowed?: boolean
  prerequisites: {
    /** Set only by the founder, once an entity path is approved. */
    entityApproved: boolean
    /** Vault secret names for payment accounts (never the secrets themselves). */
    paymentAccounts: string[]
  }
  owner: string
}

export function validateGenesisConfig(c: GenesisRunConfig): string[] {
  const errors: string[] = []
  if (c?.schemaVersion !== 1) errors.push('schemaVersion must be 1.')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(c?.runId ?? '')) errors.push('runId is invalid.')
  if (!(c.budgetUsd > 0) || c.budgetUsd > 5_000) errors.push('budgetUsd must be more than 0 and at most 5,000 (a small-budget run).')
  if (!Number.isInteger(c.durationDays) || c.durationDays < 1 || c.durationDays > 90) errors.push('durationDays must be 1 to 90.')
  if (c.digitalOnly !== true) errors.push('Genesis runs are digital-only.')
  if (c.waesRequired !== true) errors.push('waesRequired must be true.')
  if (c.waesManualReviewAllowed !== undefined && typeof c.waesManualReviewAllowed !== 'boolean') errors.push('waesManualReviewAllowed must be true or false.')
  if (!c.allowedCategories?.length) errors.push('allowedCategories must list at least one category.')
  const overlap = (c.allowedCategories ?? []).filter((x) => (c.prohibitedCategories ?? []).includes(x))
  if (overlap.length) errors.push(`Categories cannot be both allowed and prohibited: ${overlap.join(', ')}.`)
  if (!(c.spend?.autoMaxUsd >= 0) || c.spend.autoMaxUsd > c.budgetUsd * 0.05) errors.push('spend.autoMaxUsd must be from 0 to 5% of the budget.')
  if (!Number.isInteger(c.spend?.autoMaxRisk) || c.spend.autoMaxRisk < 0 || c.spend.autoMaxRisk > 2) errors.push('spend.autoMaxRisk must be 0, 1 or 2.')
  if (!(c.spend?.dailyCapUsd > 0) || c.spend.dailyCapUsd > c.budgetUsd) errors.push('spend.dailyCapUsd must be more than 0 and at most the budget.')
  if (typeof c.prerequisites?.entityApproved !== 'boolean') errors.push('prerequisites.entityApproved must be true or false.')
  if (!Array.isArray(c.prerequisites?.paymentAccounts) || c.prerequisites.paymentAccounts.some((s) => !/^[a-z0-9][a-z0-9-]{0,62}$/.test(s))) errors.push('prerequisites.paymentAccounts must list vault secret names.')
  if (!c.owner?.trim()) errors.push('owner is required.')
  return errors
}

/** Why the run can't start yet (empty when it can). */
export function genesisBlockers(c: GenesisRunConfig, vaultSecretNames: string[]): string[] {
  const blockers = validateGenesisConfig(c)
  if (!c.prerequisites?.entityApproved) blockers.push('No approved legal entity: the founder decides the entity path first.')
  if (!c.prerequisites?.paymentAccounts?.length) blockers.push('No payment accounts are named.')
  for (const s of c.prerequisites?.paymentAccounts ?? []) if (!vaultSecretNames.includes(s)) blockers.push(`Payment account "${s}" is not in the vault.`)
  return blockers
}

export interface SpendRequest {
  amountUsd: number
  category: string
  description: string
  experimentId?: string
}

export interface SpendDecision {
  recommendation: 'execute-autonomously' | 'request-approval' | 'reject'
  riskLevel: RiskLevel
  reasons: string[]
}

const dayOf = (iso: string) => iso.slice(0, 10)

/** Decide a proposed spend under the run config, the ledger so far and the experiment it serves. */
export function decideSpend(c: GenesisRunConfig, ledger: MoneyLedger, req: SpendRequest, now: Date, experiment?: Experiment): SpendDecision {
  const totals: MoneyTotals = moneyTotals(ledger)
  const risk = spendRiskLevel(req.amountUsd, totals.remainingUsd)
  const reject: string[] = []
  const approve: string[] = []
  if (!(req.amountUsd > 0)) reject.push('The amount must be positive.')
  if (c.prohibitedCategories.includes(req.category)) reject.push(`"${req.category}" is never allowed in a Genesis run.`)
  else if (!c.allowedCategories.includes(req.category)) reject.push(`"${req.category}" is not an allowed category.`)
  if (req.amountUsd > totals.remainingUsd) reject.push(`Only $${totals.remainingUsd} of the budget is left.`)
  const today = dayOf(now.toISOString())
  const spentToday = ledger.entries.filter((e) => (e.kind === 'spend' || e.kind === 'compute') && dayOf(e.occurredAt ?? e.recordedAt) === today).reduce((s, e) => s + e.amountUsd, 0)
  if (spentToday + req.amountUsd > c.spend.dailyCapUsd) reject.push(`Today's cap is $${c.spend.dailyCapUsd}; $${Math.round(spentToday * 100) / 100} is already spent.`)
  if (experiment) {
    if (experiment.status !== 'running' && experiment.status !== 'scaled') reject.push(`Experiment ${experiment.definition.id} is ${experiment.status}; it cannot spend.`)
    const used = totals.byExperiment[experiment.definition.id]?.capitalUsedUsd ?? 0
    if (used + req.amountUsd > experiment.definition.budgetUsd) reject.push(`Experiment ${experiment.definition.id} would exceed its $${experiment.definition.budgetUsd} budget.`)
  } else {
    approve.push('Spend outside an experiment needs the founder.')
  }
  if (req.amountUsd > c.spend.autoMaxUsd) approve.push(`Above the $${c.spend.autoMaxUsd} limit for spending without the founder.`)
  if (risk > c.spend.autoMaxRisk) approve.push(`Spend risk ${risk} (share of what is left) is above ${c.spend.autoMaxRisk}.`)
  if (reject.length) return { recommendation: 'reject', riskLevel: risk, reasons: reject }
  if (approve.length) return { recommendation: 'request-approval', riskLevel: risk, reasons: approve }
  return { recommendation: 'execute-autonomously', riskLevel: risk, reasons: [] }
}

/** Facts for the Genesis playbook's stage guards. */
export function genesisFacts(c: GenesisRunConfig, ledger: MoneyLedger, experiments: Experiment[], startedAt: Date | null, now: Date): Facts {
  const totals = moneyTotals(ledger)
  const current = experiments.filter((e) => e.status !== 'draft').at(-1)
  const daysElapsed = startedAt ? Math.floor((now.getTime() - startedAt.getTime()) / 86_400_000) : 0
  return {
    'budget.remainingUsd': totals.remainingUsd,
    'budget.capitalUsedUsd': totals.capitalUsedUsd,
    'revenue.totalUsd': totals.revenueUsd,
    'run.daysLeft': c.durationDays - daysElapsed,
    'hypotheses.count': experiments.length,
    'experiment.drafted': experiments.some((e) => e.status === 'draft'),
    'experiment.running': current?.status === 'running' || current?.status === 'scaled',
    'experiment.measurements': current?.measurements.length ?? 0,
    ...(current?.decisions.length ? { 'experiment.verdict': current.decisions.at(-1)!.verdict } : {}),
    ...(totals.returnOnCapital !== null ? { 'run.returnOnCapital': totals.returnOnCapital } : {}),
  }
}

/** WAES gate facts under this run's policy: manual founder reviews count only when `waesManualReviewAllowed` is true. */
export function genesisWaesFacts(c: GenesisRunConfig, review: WaesReview | undefined, content: string, actorId: string): WaesFacts {
  return waesFacts(review, content, actorId, { allowManual: c.waesManualReviewAllowed === true })
}
