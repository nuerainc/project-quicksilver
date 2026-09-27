import type { Facts } from '../process.ts'
import type { RiskLevel } from '../types.ts'
import { moneyTotals, spendRiskLevel, startExperiment, type Experiment, type MoneyLedger, type MoneyTotals } from './economics.ts'
import { decideSpend, genesisFacts, type SpendDecision, type SpendPolicy, type SpendRequest } from './genesis.ts'
import { DEFAULT_HAND_OVER, type DepartmentReport, type HandOverRules } from './shadow.ts'

/**
 * Operate (M6): steady-state operations, reinvestment, and bounded
 * experiments inside a running business.
 *
 * Rules enforced here:
 *   - A department's effective autonomy is min(the provider's grant, what its
 *     shadow evidence supports). Nothing granted means advise. The grant is
 *     the ceiling: evidence never raises autonomy above it. Acting within
 *     limits (without a human each time) needs shadow evidence that is ready
 *     for hand-over; without it the department is held at act-with-approval.
 *   - The reinvestment plan is a proposal. Capital allocation is the
 *     founder's call, so every plan says needsFounder: true.
 *   - Experiments are bounded by the latest founder-approved pool and by
 *     maxExperimentUsd, and spend under the same rules as Genesis
 *     (`decideSpend`): category lists, daily cap, auto limits, experiment
 *     budget. Kill stays automatic (economics.ts).
 *   - Everything here is pure: nothing moves money or executes.
 */

type Actor = { id: string; kind: 'human' | 'agent' | 'service' }
const cents = (n: number) => Math.round(n * 100) / 100

// ── Config ────────────────────────────────────────────────────────────────

export interface OperateConfig {
  schemaVersion: 1
  runId: string
  playbookId: 'operate'
  /** Length of one operating cycle (the reinvestment period). */
  periodDays: number
  /** Cash the business keeps before any surplus is reinvested. */
  reserveFloorUsd: number
  /** Share (0..1) of the surplus after the reserve top-up proposed for reinvestment. */
  reinvestShare: number
  /** Share (0..1) of the reinvestment that may fund experiments. */
  experimentShare: number
  /** Hard cap on the experiment pool, and on any one experiment's budget. */
  maxExperimentUsd: number
  spend: {
    /** A single experiment spend at or below this, with risk ≤ autoMaxRisk, may go ahead without the founder. */
    autoMaxUsd: number
    autoMaxRisk: RiskLevel
    /** Total experiment spend per UTC day. */
    dailyCapUsd: number
  }
  allowedCategories: string[]
  prohibitedCategories: string[]
  waesRequired: true
  /** Accept a manual founder review in place of a WAES run (default false); see GenesisRunConfig. */
  waesManualReviewAllowed?: boolean
  /** Shadow-evidence rules for acting within limits (default DEFAULT_HAND_OVER). */
  handOver?: HandOverRules
  prerequisites: {
    /** Set only by the founder, once an entity path is approved. */
    entityApproved: boolean
    /** Vault secret names for payment accounts (never the secrets themselves). */
    paymentAccounts: string[]
  }
  /** The intent-ledger company whose autonomy grants apply (default: the tenant's). */
  companyId?: string
  owner: string
}

const share = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1

export function validateOperateConfig(c: OperateConfig): string[] {
  const errors: string[] = []
  if (c?.schemaVersion !== 1) errors.push('schemaVersion must be 1.')
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(c?.runId ?? '')) errors.push('runId is invalid.')
  if (c?.playbookId !== 'operate') errors.push('playbookId must be "operate".')
  if (!Number.isInteger(c?.periodDays) || c.periodDays < 1 || c.periodDays > 92) errors.push('periodDays must be 1 to 92.')
  if (!(c?.reserveFloorUsd >= 0) || !Number.isFinite(c.reserveFloorUsd)) errors.push('reserveFloorUsd must be zero or more.')
  if (!share(c?.reinvestShare)) errors.push('reinvestShare must be from 0 to 1.')
  if (!share(c?.experimentShare)) errors.push('experimentShare must be from 0 to 1.')
  if (!(c?.maxExperimentUsd > 0) || c.maxExperimentUsd > 5_000) errors.push('maxExperimentUsd must be more than 0 and at most 5,000 (experiments stay small).')
  if (!(c?.spend?.autoMaxUsd >= 0) || !(c.spend.autoMaxUsd <= c.maxExperimentUsd * 0.05)) errors.push('spend.autoMaxUsd must be from 0 to 5% of maxExperimentUsd.')
  if (!Number.isInteger(c?.spend?.autoMaxRisk) || c.spend.autoMaxRisk < 0 || c.spend.autoMaxRisk > 2) errors.push('spend.autoMaxRisk must be 0, 1 or 2.')
  if (!(c?.spend?.dailyCapUsd > 0) || !(c.spend.dailyCapUsd <= c.maxExperimentUsd)) errors.push('spend.dailyCapUsd must be more than 0 and at most maxExperimentUsd.')
  if (!c?.allowedCategories?.length) errors.push('allowedCategories must list at least one category.')
  const overlap = (c?.allowedCategories ?? []).filter((x) => (c.prohibitedCategories ?? []).includes(x))
  if (overlap.length) errors.push(`Categories cannot be both allowed and prohibited: ${overlap.join(', ')}.`)
  if (!Array.isArray(c?.prohibitedCategories)) errors.push('prohibitedCategories must be a list.')
  if (c?.waesRequired !== true) errors.push('waesRequired must be true.')
  if (c?.waesManualReviewAllowed !== undefined && typeof c.waesManualReviewAllowed !== 'boolean') errors.push('waesManualReviewAllowed must be true or false.')
  if (c?.handOver !== undefined) {
    if (!Number.isInteger(c.handOver.minJudged) || c.handOver.minJudged < 1) errors.push('handOver.minJudged must be a whole number of at least 1.')
    if (!(c.handOver.minAgreement > 0) || c.handOver.minAgreement > 1) errors.push('handOver.minAgreement must be more than 0 and at most 1.')
  }
  if (typeof c?.prerequisites?.entityApproved !== 'boolean') errors.push('prerequisites.entityApproved must be true or false.')
  if (!Array.isArray(c?.prerequisites?.paymentAccounts) || c.prerequisites.paymentAccounts.some((s) => !/^[a-z0-9][a-z0-9-]{0,62}$/.test(s))) errors.push('prerequisites.paymentAccounts must list vault secret names.')
  if (c?.companyId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(c.companyId)) errors.push('companyId is invalid.')
  if (!c?.owner?.trim()) errors.push('owner is required.')
  return errors
}

/** Why Operate can't move money yet (empty when it can). Mirrors genesisBlockers. */
export function operateBlockers(c: OperateConfig, vaultSecretNames: string[]): string[] {
  const blockers = validateOperateConfig(c)
  if (!c?.prerequisites?.entityApproved) blockers.push('No approved legal entity: the founder decides the entity path first.')
  if (!c?.prerequisites?.paymentAccounts?.length) blockers.push('No payment accounts are named.')
  for (const s of c?.prerequisites?.paymentAccounts ?? []) if (!vaultSecretNames.includes(s)) blockers.push(`Payment account "${s}" is not in the vault.`)
  return blockers
}

export const handOverRules = (c: OperateConfig): HandOverRules => c.handOver ?? DEFAULT_HAND_OVER

// ── Autonomy ──────────────────────────────────────────────────────────────

/** Same strings, same order, as Aura's AUTONOMY_DEPTHS (least to most). */
export const AUTONOMY_DEPTHS = ['advise', 'propose', 'act-with-approval', 'act-within-limits'] as const
export type AutonomyDepth = (typeof AUTONOMY_DEPTHS)[number]

const rank = (d: AutonomyDepth) => AUTONOMY_DEPTHS.indexOf(d)
export const minDepth = (a: AutonomyDepth, b: AutonomyDepth): AutonomyDepth => (rank(a) <= rank(b) ? a : b)

export interface DepartmentAutonomy {
  department: string
  granted: AutonomyDepth | null
  effective: AutonomyDepth
  reasons: string[]
}

/**
 * Effective autonomy = min(the provider's grant, what the shadow evidence supports).
 * Evidence supports act-within-limits only when the department is ready for
 * hand-over; otherwise it supports at most act-with-approval. Pure.
 */
export function departmentAutonomy(report: DepartmentReport | undefined, granted: AutonomyDepth | undefined, department = report?.department ?? 'unknown'): DepartmentAutonomy {
  if (granted === undefined || !AUTONOMY_DEPTHS.includes(granted)) {
    return {
      department,
      granted: null,
      effective: 'advise',
      reasons: [granted === undefined ? 'The provider has not granted autonomy: advise only.' : `Unknown autonomy depth "${String(granted)}": advise only.`],
    }
  }
  const evidence: AutonomyDepth = report?.readyForHandOver ? 'act-within-limits' : 'act-with-approval'
  const effective = minDepth(granted, evidence)
  const reasons: string[] = []
  if (effective !== granted) {
    reasons.push('Granted act-within-limits, but the shadow evidence is not ready for hand-over: held at act-with-approval.')
    if (!report) reasons.push('No shadow recommendations for this department.')
    else reasons.push(...report.reasons)
  }
  return { department, granted, effective, reasons }
}

// ── Periods and money ─────────────────────────────────────────────────────

/**
 * The current period: from where the last approved plan ended (so no money is
 * counted twice), else periodDays back; to now.
 */
export function operatePeriod(c: Pick<OperateConfig, 'periodDays'>, lastApprovedTo: string | undefined, now: Date): { from: string; to: string } {
  const from = lastApprovedTo ?? new Date(now.getTime() - c.periodDays * 86_400_000).toISOString()
  return { from, to: now.toISOString() }
}

/** MoneyTotals for entries that moved in [from, to). */
export function periodTotals(ledger: MoneyLedger, from: Date | string, to: Date | string): MoneyTotals {
  const a = new Date(from).getTime()
  const b = new Date(to).getTime()
  const entries = ledger.entries.filter((e) => {
    const t = new Date(e.occurredAt ?? e.recordedAt).getTime()
    return t >= a && t < b
  })
  return moneyTotals({ ...ledger, entries })
}

// ── Reinvestment ──────────────────────────────────────────────────────────

export interface ReinvestmentPlan {
  surplusUsd: number
  toReserveUsd: number
  reinvestUsd: number
  experimentPoolUsd: number
  keptUsd: number
  /** Always true: capital allocation is the founder's call. */
  needsFounder: true
  notes: string[]
}

/**
 * Propose how the period's surplus is used. Surplus is revenue minus capital
 * used, where capital used = spend + compute − refunds (MoneyTotals: a refund
 * is money back on a spend), i.e. MoneyTotals.netUsd. Pure.
 */
export function reinvestmentPlan(c: Pick<OperateConfig, 'reserveFloorUsd' | 'reinvestShare' | 'experimentShare' | 'maxExperimentUsd'>, totals: MoneyTotals, cashOnHandUsd: number): ReinvestmentPlan {
  if (!Number.isFinite(cashOnHandUsd) || cashOnHandUsd < 0) throw new RangeError('cashOnHandUsd must be zero or more.')
  const surplus = cents(totals.revenueUsd - totals.capitalUsedUsd)
  if (!(surplus > 0)) {
    return { surplusUsd: 0, toReserveUsd: 0, reinvestUsd: 0, experimentPoolUsd: 0, keptUsd: 0, needsFounder: true, notes: [`No surplus this period (revenue $${totals.revenueUsd} against capital used $${totals.capitalUsedUsd}): nothing to reinvest.`] }
  }
  const notes: string[] = []
  const toReserve = cents(Math.min(surplus, Math.max(0, c.reserveFloorUsd - cashOnHandUsd)))
  if (toReserve > 0) notes.push(`Cash on hand $${cents(cashOnHandUsd)} is below the $${c.reserveFloorUsd} reserve floor: $${toReserve} tops it up first.`)
  const remainder = cents(surplus - toReserve)
  const reinvest = cents(remainder * c.reinvestShare)
  const uncapped = cents(reinvest * c.experimentShare)
  const pool = cents(Math.min(uncapped, c.maxExperimentUsd))
  if (uncapped > pool) notes.push(`The experiment pool is capped at $${c.maxExperimentUsd} (maxExperimentUsd).`)
  const kept = cents(remainder - reinvest)
  if (remainder <= 0) notes.push('The whole surplus goes to the reserve.')
  notes.push('A proposal: the founder approves it or not.')
  return { surplusUsd: surplus, toReserveUsd: toReserve, reinvestUsd: reinvest, experimentPoolUsd: pool, keptUsd: kept, needsFounder: true, notes }
}

export interface ApprovedPlan {
  seq: number
  approvedAt: string
  approvedBy: string
  period: { from: string; to: string }
  cashOnHandUsd: number
  plan: ReinvestmentPlan
  note?: string
}

/** Only the founder (the config's owner, a human) approves a plan; the record is appended, never edited. */
export function approvePlan(c: OperateConfig, plans: ApprovedPlan[], plan: ReinvestmentPlan, period: { from: string; to: string }, cashOnHandUsd: number, actor: Actor, now: Date, note?: string): { ok: true; record: ApprovedPlan } | { ok: false; reasons: string[] } {
  const reasons: string[] = []
  if (actor.kind !== 'human') reasons.push('Only a human approves a reinvestment plan (capital allocation is the founder\'s call).')
  else if (actor.id !== c.owner) reasons.push(`Only the founder (${c.owner}) approves a reinvestment plan.`)
  const last = plans.at(-1)
  if (last && new Date(period.from).getTime() < new Date(last.period.to).getTime()) reasons.push('This period overlaps the last approved plan.')
  if (!(new Date(period.to).getTime() > new Date(period.from).getTime())) reasons.push('The period is empty.')
  if (reasons.length) return { ok: false, reasons }
  return { ok: true, record: { seq: (last?.seq ?? 0) + 1, approvedAt: now.toISOString(), approvedBy: actor.id, period, cashOnHandUsd: cents(cashOnHandUsd), plan, ...(note ? { note } : {}) } }
}

// ── Bounded experiments ───────────────────────────────────────────────────

/**
 * The spend rules an Operate experiment runs under, shaped like a
 * GenesisRunConfig but honest about it: `digitalOnly: false`. `decideSpend`
 * takes a SpendPolicy (the fields it reads), so this is passed to it as is
 * rather than pretending to be a digital-only Genesis run. The budget is the
 * founder-approved pool, never more than maxExperimentUsd.
 */
export interface ExperimentSpendConfig extends SpendPolicy {
  schemaVersion: 1
  runId: string
  playbookId: 'operate'
  budgetUsd: number
  digitalOnly: false
  waesRequired: true
  waesManualReviewAllowed?: boolean
  startedAt?: string
  owner: string
}

export function experimentSpendConfig(c: OperateConfig, approvedPoolUsd: number, startedAt?: string): ExperimentSpendConfig {
  return {
    schemaVersion: 1,
    runId: c.runId,
    playbookId: 'operate',
    budgetUsd: cents(Math.max(0, Math.min(approvedPoolUsd, c.maxExperimentUsd))),
    digitalOnly: false,
    allowedCategories: [...c.allowedCategories],
    prohibitedCategories: [...c.prohibitedCategories],
    spend: { ...c.spend },
    waesRequired: true,
    ...(c.waesManualReviewAllowed !== undefined ? { waesManualReviewAllowed: c.waesManualReviewAllowed } : {}),
    ...(startedAt ? { startedAt } : {}),
    owner: c.owner,
  }
}

/** The approved plan that funds an experiment: the latest one approved at or before it started. */
export function fundingPlan(plans: ApprovedPlan[], startedAt: string | undefined): ApprovedPlan | undefined {
  if (!startedAt) return undefined
  const t = new Date(startedAt).getTime()
  return plans.filter((p) => new Date(p.approvedAt).getTime() <= t).at(-1)
}

const fundedBy = (plan: ApprovedPlan, plans: ApprovedPlan[], experiments: Experiment[]) =>
  experiments.filter((e) => e.status !== 'draft' && fundingPlan(plans, e.startedAt)?.seq === plan.seq)

/** Budgets already committed to experiments started under a plan. */
export function committedUsd(plan: ApprovedPlan, plans: ApprovedPlan[], experiments: Experiment[]): number {
  return cents(fundedBy(plan, plans, experiments).reduce((s, e) => s + e.definition.budgetUsd, 0))
}

/**
 * The pool's own ledger view: entries of experiments funded by the plan, with
 * the pool as the budget. Business spend outside experiments is not in it, so
 * it neither uses the pool nor counts toward the experiment daily cap.
 */
export function poolLedger(ledger: MoneyLedger, plan: ApprovedPlan, plans: ApprovedPlan[], experiments: Experiment[]): MoneyLedger {
  const ids = new Set(fundedBy(plan, plans, experiments).map((e) => e.definition.id))
  return { runId: ledger.runId, budgetUsd: plan.plan.experimentPoolUsd, entries: ledger.entries.filter((e) => e.experimentId !== undefined && ids.has(e.experimentId)) }
}

/**
 * The founder starts an experiment inside the latest approved pool. Refused
 * when its budget exceeds maxExperimentUsd or what is left of the pool.
 */
export function startOperateExperiment(c: OperateConfig, exp: Experiment, actor: Actor, now: Date, plans: ApprovedPlan[], experiments: Experiment[]): { ok: true; experiment: Experiment } | { ok: false; reasons: string[] } {
  const reasons: string[] = []
  const plan = plans.at(-1)
  if (exp.definition.playbookId !== 'operate') reasons.push(`The experiment belongs to playbook "${exp.definition.playbookId}", not "operate".`)
  if (exp.definition.budgetUsd > c.maxExperimentUsd) reasons.push(`Its budget ($${exp.definition.budgetUsd}) is above the $${c.maxExperimentUsd} cap for one experiment.`)
  if (!plan) reasons.push('No approved reinvestment plan funds experiments yet.')
  else {
    const left = cents(Math.min(plan.plan.experimentPoolUsd, c.maxExperimentUsd) - committedUsd(plan, plans, experiments))
    if (exp.definition.budgetUsd > left) reasons.push(`Its budget ($${exp.definition.budgetUsd}) is more than what is left of the approved pool ($${Math.max(0, left)}).`)
  }
  if (reasons.length) return { ok: false, reasons }
  return startExperiment(exp, actor, now, { remainingBudgetUsd: exp.definition.budgetUsd })
}

/**
 * Decide a proposed spend in Operate. Experiment spend goes through Genesis's
 * `decideSpend` against the pool that funds the experiment. Business spend
 * outside an experiment keeps the category rules and always needs the
 * founder; its risk is its share of the reserve floor.
 */
export function decideOperateSpend(c: OperateConfig, ledger: MoneyLedger, plans: ApprovedPlan[], experiments: Experiment[], req: SpendRequest, now: Date, experiment?: Experiment): SpendDecision {
  if (experiment) {
    const plan = fundingPlan(plans, experiment.startedAt)
    if (!plan) return { recommendation: 'reject', riskLevel: 5, reasons: [`Experiment ${experiment.definition.id} is not funded by an approved plan.`] }
    return decideSpend(experimentSpendConfig(c, plan.plan.experimentPoolUsd, experiment.startedAt), poolLedger(ledger, plan, plans, experiments), req, now, experiment)
  }
  const risk = spendRiskLevel(req.amountUsd, c.reserveFloorUsd)
  const reject: string[] = []
  if (!(req.amountUsd > 0)) reject.push('The amount must be positive.')
  if (c.prohibitedCategories.includes(req.category)) reject.push(`"${req.category}" is never allowed in this run.`)
  else if (!c.allowedCategories.includes(req.category)) reject.push(`"${req.category}" is not an allowed category.`)
  if (reject.length) return { recommendation: 'reject', riskLevel: risk, reasons: reject }
  return { recommendation: 'request-approval', riskLevel: risk, reasons: ['Business spend outside an experiment is the founder\'s decision.'] }
}

// ── Facts ─────────────────────────────────────────────────────────────────

export interface OperateFactsInput {
  config: OperateConfig
  departments: DepartmentAutonomy[]
  period: MoneyTotals
  plans: ApprovedPlan[]
  ledger: MoneyLedger
  experiments: Experiment[]
  now: Date
}

/** Facts for the Operate playbook's stage guards. */
export function operateFacts(i: OperateFactsInput): Facts {
  const latest = i.plans.at(-1)
  const facts: Facts = {
    'departments.count': i.departments.length,
    'departments.handedOver': i.departments.filter((d) => d.effective === 'act-within-limits').length,
    'departments.capped': i.departments.filter((d) => d.granted !== null && d.effective !== d.granted).length,
    'period.revenueUsd': i.period.revenueUsd,
    'period.capitalUsedUsd': i.period.capitalUsedUsd,
    'period.surplusUsd': cents(i.period.revenueUsd - i.period.capitalUsedUsd),
    // Approved this cycle: a plan approved within the last period.
    'reinvestment.approved': !!latest && i.now.getTime() - new Date(latest.approvedAt).getTime() < i.config.periodDays * 86_400_000,
    'experiment.poolUsd': latest ? latest.plan.experimentPoolUsd : 0,
  }
  if (latest) {
    const funded = fundedBy(latest, i.plans, i.experiments)
    const drafts = i.experiments.filter((e) => e.status === 'draft')
    const g = genesisFacts({ durationDays: i.config.periodDays }, poolLedger(i.ledger, latest, i.plans, i.experiments), [...funded, ...drafts], new Date(latest.approvedAt), i.now)
    for (const [k, v] of Object.entries(g)) if (k.startsWith('experiment.')) facts[k] = v
    facts['experiment.poolRemainingUsd'] = cents(Math.max(0, Math.min(latest.plan.experimentPoolUsd, i.config.maxExperimentUsd) - committedUsd(latest, i.plans, i.experiments)))
  } else {
    facts['experiment.drafted'] = i.experiments.some((e) => e.status === 'draft')
    facts['experiment.running'] = false
    facts['experiment.poolRemainingUsd'] = 0
  }
  return facts
}
