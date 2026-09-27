import type { MoneyEntry, MoneyLedger } from '../playbooks/economics.ts'
import { cents, checkRunsAndSeed, median, mulberry32, normal, quantile, randomIndex, share } from './random.ts'

/**
 * Monte Carlo cash (M7 part 3, the what-if engine).
 *
 * An ESTIMATE, never a decision: nothing here authorizes, spends or changes
 * state. The same inputs and seed always give the same numbers.
 *
 * Method:
 *   - The money ledger is cut into periods of `periodDays` (default 30),
 *     counted back from `asOf` (default: the last entry). Revenue is money in;
 *     cost is capital used (spend + compute − refunds), as in MoneyTotals.
 *   - Each run walks the horizon one period at a time. Every step draws a
 *     block of whole historical periods (block bootstrap, block length 1 by
 *     default), so a period's revenue and cost stay paired.
 *   - Planned spends and shocks are applied on top; cash moves by
 *     revenue − cost − planned spend.
 *   - With no history, it refuses, unless the caller passes explicit assumed
 *     distributions; those results say "assumed, not from history".
 */

export interface PeriodFlow {
  /** Money in during the period. */
  revenueUsd: number
  /** Capital used during the period (spend + compute − refunds). */
  costUsd: number
  from?: string
  to?: string
}

/** A change applied to simulated periods. Periods are 1-based horizon steps; defaults cover the whole horizon. */
export type CashShock =
  | { kind: 'revenue-scale'; factor: number; fromPeriod?: number; toPeriod?: number }
  | { kind: 'revenue-drop'; amountUsd: number; fromPeriod?: number; toPeriod?: number }
  | { kind: 'revenue-delay'; share: number; delayPeriods: number; fromPeriod?: number; toPeriod?: number }
  | { kind: 'cost-scale'; factor: number; fromPeriod?: number; toPeriod?: number }
  | { kind: 'cost-add'; amountUsd: number; fromPeriod?: number; toPeriod?: number }

export interface AssumedDistribution {
  /** Normal draws, floored at zero. */
  meanUsd: number
  sdUsd: number
}

export interface SimulateCashOptions {
  ledger?: MoneyLedger
  /** Pre-built history, used when no ledger is passed. */
  periodHistory?: PeriodFlow[]
  periodDays?: number
  /** The end of the newest history period (default: the latest ledger entry). */
  asOf?: Date | string
  startCashUsd: number
  horizonPeriods: number
  /** Extra spend per horizon step: index 0 is step 1. */
  plannedSpendsUsd?: number[]
  reserveFloorUsd?: number
  runs: number
  seed: number
  shocks?: CashShock[]
  /** Consecutive historical periods drawn together (default 1). */
  blockLength?: number
  /** Used ONLY when there is no history; results are labeled "assumed, not from history". */
  assumed?: { revenue: AssumedDistribution; cost: AssumedDistribution }
}

export interface CashStep {
  period: number
  cash: { p5: number; p25: number; p50: number; p75: number; p95: number }
  /** Share of runs whose cash fell below the reserve floor at any step up to this one. */
  pBelowReserve: number
  /** Share of runs whose cash fell below zero at any step up to this one. */
  pOutOfCash: number
  medianRevenueUsd: number
  /** Median of (revenue ÷ capital used) summed from step 1 to here; null when no run used capital. */
  medianReturnOnCapital: number | null
}

export interface CashSimulation {
  ok: true
  kind: 'estimate'
  basis: 'history' | 'assumed'
  /** "estimate from N periods of history" or "assumed, not from history". */
  label: string
  seed: number
  runs: number
  horizonPeriods: number
  periodDays: number
  startCashUsd: number
  reserveFloorUsd: number
  history: { periods: number; from: string | null; to: string | null; meanRevenueUsd: number | null; meanCostUsd: number | null }
  historyTooShort: boolean
  steps: CashStep[]
  /** Over the whole horizon. */
  pBelowReserve: number
  pOutOfCash: number
  /** Delayed revenue that would arrive after the horizon (median per run). */
  medianRevenueDelayedPastHorizonUsd: number
  assumptions: string[]
  warnings: string[]
}

export type CashSimulationResult = CashSimulation | { ok: false; kind: 'estimate'; reasons: string[] }

export const MIN_HISTORY_PERIODS = 3
const DAY = 86_400_000

const when = (e: MoneyEntry) => new Date(e.occurredAt ?? e.recordedAt).getTime()

/** The ledger as consecutive periods, oldest first, counted back from asOf. */
export function ledgerPeriods(ledger: MoneyLedger, options: { periodDays?: number; asOf?: Date | string } = {}): { periods: PeriodFlow[]; excludedAfterAsOf: number; oldestPartial: boolean } {
  const periodMs = (options.periodDays ?? 30) * DAY
  const entries = ledger.entries.filter((e) => Number.isFinite(when(e)))
  if (!entries.length) return { periods: [], excludedAfterAsOf: 0, oldestPartial: false }
  const times = entries.map(when)
  const first = Math.min(...times)
  const end = options.asOf !== undefined ? new Date(options.asOf).getTime() : Math.max(...times) + 1
  const included = entries.filter((e) => when(e) < end)
  const excluded = entries.length - included.length
  if (!included.length || end <= first) return { periods: [], excludedAfterAsOf: excluded, oldestPartial: false }
  const count = Math.max(1, Math.ceil((end - first) / periodMs))
  const periods: PeriodFlow[] = []
  for (let i = count - 1; i >= 0; i--) {
    const a = end - (i + 1) * periodMs
    const b = end - i * periodMs
    let revenue = 0, cost = 0
    for (const e of included) {
      const t = when(e)
      if (t < a || t >= b) continue
      if (e.kind === 'revenue') revenue += e.amountUsd
      else if (e.kind === 'spend' || e.kind === 'compute') cost += e.amountUsd
      else if (e.kind === 'refund') cost -= e.amountUsd
    }
    periods.push({ revenueUsd: cents(revenue), costUsd: cents(cost), from: new Date(a).toISOString(), to: new Date(b).toISOString() })
  }
  const oldestPartial = end - count * periodMs < first && first - (end - count * periodMs) > periodMs / 2
  return { periods, excludedAfterAsOf: excluded, oldestPartial }
}

const inRange = (s: { fromPeriod?: number; toPeriod?: number }, t: number) => t >= (s.fromPeriod ?? 1) && t <= (s.toPeriod ?? Number.POSITIVE_INFINITY)

export function validateShocks(shocks: CashShock[]): string[] {
  const errors: string[] = []
  shocks.forEach((s, i) => {
    const at = `shocks[${i}]`
    if (s.fromPeriod !== undefined && (!Number.isInteger(s.fromPeriod) || s.fromPeriod < 1)) errors.push(`${at}.fromPeriod must be a whole number of at least 1.`)
    if (s.toPeriod !== undefined && (!Number.isInteger(s.toPeriod) || s.toPeriod < (s.fromPeriod ?? 1))) errors.push(`${at}.toPeriod must be a whole number no earlier than fromPeriod.`)
    switch (s.kind) {
      case 'revenue-scale':
      case 'cost-scale':
        if (!(s.factor >= 0) || !Number.isFinite(s.factor)) errors.push(`${at}.factor must be zero or more.`)
        break
      case 'revenue-drop':
      case 'cost-add':
        if (!(s.amountUsd >= 0) || !Number.isFinite(s.amountUsd)) errors.push(`${at}.amountUsd must be zero or more.`)
        break
      case 'revenue-delay':
        if (!(s.share >= 0 && s.share <= 1)) errors.push(`${at}.share must be from 0 to 1.`)
        if (!Number.isInteger(s.delayPeriods) || s.delayPeriods < 1) errors.push(`${at}.delayPeriods must be a whole number of at least 1.`)
        break
      default:
        errors.push(`${at}.kind "${(s as { kind: string }).kind}" is not a known shock.`)
    }
  })
  return errors
}

export function describeShock(s: CashShock): string {
  const span = `periods ${s.fromPeriod ?? 1}–${s.toPeriod ?? 'end'}`
  switch (s.kind) {
    case 'revenue-scale': return `revenue × ${s.factor} (${span})`
    case 'revenue-drop': return `revenue − $${cents(s.amountUsd)} per period, floored at 0 (${span})`
    case 'revenue-delay': return `${Math.round(s.share * 100)}% of revenue arrives ${s.delayPeriods} period(s) late (${span})`
    case 'cost-scale': return `cost × ${s.factor} (${span})`
    case 'cost-add': return `cost + $${cents(s.amountUsd)} per period (${span})`
  }
}

export function simulateCash(o: SimulateCashOptions): CashSimulationResult {
  const reasons = checkRunsAndSeed(o.runs, o.seed)
  const periodDays = o.periodDays ?? 30
  const blockLength = o.blockLength ?? 1
  const reserve = o.reserveFloorUsd ?? 0
  const shocks = o.shocks ?? []
  const planned = o.plannedSpendsUsd ?? []
  if (!Number.isInteger(periodDays) || periodDays < 1 || periodDays > 366) reasons.push('periodDays must be a whole number from 1 to 366.')
  if (!Number.isInteger(o.horizonPeriods) || o.horizonPeriods < 1 || o.horizonPeriods > 120) reasons.push('horizonPeriods must be a whole number from 1 to 120.')
  if (!Number.isFinite(o.startCashUsd)) reasons.push('startCashUsd must be a number.')
  if (!Number.isFinite(reserve) || reserve < 0) reasons.push('reserveFloorUsd must be zero or more.')
  if (!Number.isInteger(blockLength) || blockLength < 1) reasons.push('blockLength must be a whole number of at least 1.')
  if (planned.some((x) => !Number.isFinite(x) || x < 0)) reasons.push('plannedSpendsUsd must be zero or more for each period.')
  reasons.push(...validateShocks(shocks))
  if (reasons.length) return { ok: false, kind: 'estimate', reasons }

  const assumptions: string[] = []
  const warnings: string[] = []
  let history: PeriodFlow[] = []
  if (o.ledger) {
    const lp = ledgerPeriods(o.ledger, { periodDays, asOf: o.asOf })
    history = lp.periods
    assumptions.push(`History: the money ledger in ${periodDays}-day periods counted back from ${o.asOf !== undefined ? new Date(o.asOf).toISOString() : 'the latest entry'}; cost = spend + compute − refunds.`)
    if (lp.excludedAfterAsOf) warnings.push(`${lp.excludedAfterAsOf} ledger entr${lp.excludedAfterAsOf === 1 ? 'y is' : 'ies are'} after asOf and not used.`)
    if (lp.oldestPartial) warnings.push('The ledger starts partway through the oldest period (less than half of it is covered), so that period may understate a normal one.')
  } else if (o.periodHistory) {
    history = o.periodHistory.filter((p) => Number.isFinite(p.revenueUsd) && Number.isFinite(p.costUsd))
    assumptions.push(`History: ${history.length} period(s) passed in by the caller.`)
  }

  let basis: 'history' | 'assumed'
  if (history.length) {
    basis = 'history'
    if (o.assumed) warnings.push('Assumed distributions were passed but ignored: there is history, and history comes first.')
  } else if (o.assumed) {
    const a = o.assumed
    if (![a.revenue.meanUsd, a.revenue.sdUsd, a.cost.meanUsd, a.cost.sdUsd].every((x) => Number.isFinite(x)) || a.revenue.sdUsd < 0 || a.cost.sdUsd < 0) {
      return { ok: false, kind: 'estimate', reasons: ['Assumed distributions need a finite mean and a standard deviation of zero or more.'] }
    }
    basis = 'assumed'
    assumptions.push(`ASSUMED, NOT FROM HISTORY: revenue ~ normal(mean $${a.revenue.meanUsd}, sd $${a.revenue.sdUsd}), cost ~ normal(mean $${a.cost.meanUsd}, sd $${a.cost.sdUsd}) per period, floored at 0, independent of each other.`)
  } else {
    return { ok: false, kind: 'estimate', reasons: ['There is no money history to simulate from. Record money in the ledger first, or pass explicit assumed distributions (the results will say they are assumed, not from history).'] }
  }

  const historyTooShort = basis === 'history' && history.length < MIN_HISTORY_PERIODS
  if (historyTooShort) warnings.push(`Only ${history.length} period(s) of history: too short to say much. The spread below understates how uncertain the future is.`)
  if (basis === 'history') {
    const b = Math.min(blockLength, history.length)
    if (b !== blockLength) warnings.push(`blockLength ${blockLength} is longer than the history; using ${b}.`)
    assumptions.push(b === 1
      ? 'Each future period is a whole historical period drawn at random (revenue and cost stay paired); periods are treated as interchangeable, so trends and seasonality are not modeled.'
      : `Future periods are drawn in blocks of ${b} consecutive historical periods (revenue and cost stay paired); longer trends and seasonality are not modeled.`)
  }
  assumptions.push(`Start cash $${cents(o.startCashUsd)}; reserve floor $${cents(reserve)}; horizon ${o.horizonPeriods} period(s) of ${periodDays} days.`)
  if (planned.some((x) => x > 0)) assumptions.push(`Planned spends by period: ${planned.slice(0, o.horizonPeriods).map((x, i) => `${i + 1}: $${cents(x)}`).join(', ')}.`)
  if (shocks.length) assumptions.push(`Shocks: ${shocks.map(describeShock).join('; ')}.`)
  assumptions.push('An estimate, not a decision: it authorizes, spends and changes nothing.')

  const rng = mulberry32(o.seed)
  const H = o.horizonPeriods
  const b = Math.min(blockLength, Math.max(1, history.length))
  const cashAt: number[][] = Array.from({ length: H }, () => new Array<number>(o.runs))
  const revAt: number[][] = Array.from({ length: H }, () => new Array<number>(o.runs))
  const rocAt: number[][] = Array.from({ length: H }, () => [])
  const belowBy = new Array<number>(H).fill(0)
  const outBy = new Array<number>(H).fill(0)
  const delayedPast: number[] = []

  for (let r = 0; r < o.runs; r++) {
    let cash = o.startCashUsd
    let below = cash < reserve
    let out = cash < 0
    let cumRev = 0, cumCost = 0, lost = 0
    const pending = new Array<number>(H + 1).fill(0)
    let block: PeriodFlow[] = []
    for (let t = 1; t <= H; t++) {
      let rev: number, cost: number
      if (basis === 'history') {
        if (!block.length) {
          const start = randomIndex(rng, history.length - b + 1)
          block = history.slice(start, start + b)
        }
        const p = block.shift()!
        rev = p.revenueUsd
        cost = p.costUsd
      } else {
        rev = Math.max(0, o.assumed!.revenue.meanUsd + o.assumed!.revenue.sdUsd * normal(rng))
        cost = Math.max(0, o.assumed!.cost.meanUsd + o.assumed!.cost.sdUsd * normal(rng))
      }
      for (const s of shocks) {
        if (!inRange(s, t)) continue
        if (s.kind === 'revenue-scale') rev *= s.factor
        else if (s.kind === 'revenue-drop') rev = Math.max(0, rev - s.amountUsd)
        else if (s.kind === 'cost-scale') cost *= s.factor
        else if (s.kind === 'cost-add') cost += s.amountUsd
      }
      for (const s of shocks) {
        if (s.kind !== 'revenue-delay' || !inRange(s, t)) continue
        const moved = rev * s.share
        rev -= moved
        if (t + s.delayPeriods <= H) pending[t + s.delayPeriods]! += moved
        else lost += moved
      }
      rev += pending[t]!
      const spend = planned[t - 1] ?? 0
      cash += rev - cost - spend
      cumRev += rev
      cumCost += cost + spend
      if (cash < reserve) below = true
      if (cash < 0) out = true
      cashAt[t - 1]![r] = cash
      revAt[t - 1]![r] = rev
      if (cumCost > 0) rocAt[t - 1]!.push(cumRev / cumCost)
      if (below) belowBy[t - 1]!++
      if (out) outBy[t - 1]!++
    }
    delayedPast.push(lost)
  }

  const steps: CashStep[] = []
  for (let t = 0; t < H; t++) {
    const sorted = cashAt[t]!.slice().sort((x, y) => x - y)
    const roc = median(rocAt[t]!)
    steps.push({
      period: t + 1,
      cash: { p5: cents(quantile(sorted, 0.05)), p25: cents(quantile(sorted, 0.25)), p50: cents(quantile(sorted, 0.5)), p75: cents(quantile(sorted, 0.75)), p95: cents(quantile(sorted, 0.95)) },
      pBelowReserve: share(belowBy[t]!, o.runs),
      pOutOfCash: share(outBy[t]!, o.runs),
      medianRevenueUsd: cents(median(revAt[t]!) ?? 0),
      medianReturnOnCapital: roc === null ? null : Math.round(roc * 1000) / 1000,
    })
  }
  const mean = (xs: number[]) => (xs.length ? cents(xs.reduce((s, x) => s + x, 0) / xs.length) : null)
  return {
    ok: true,
    kind: 'estimate',
    basis,
    label: basis === 'assumed' ? 'assumed, not from history' : `estimate from ${history.length} period(s) of history`,
    seed: o.seed,
    runs: o.runs,
    horizonPeriods: H,
    periodDays,
    startCashUsd: cents(o.startCashUsd),
    reserveFloorUsd: cents(reserve),
    history: {
      periods: history.length,
      from: history[0]?.from ?? null,
      to: history.at(-1)?.to ?? null,
      meanRevenueUsd: mean(history.map((p) => p.revenueUsd)),
      meanCostUsd: mean(history.map((p) => p.costUsd)),
    },
    historyTooShort,
    steps,
    pBelowReserve: steps.at(-1)!.pBelowReserve,
    pOutOfCash: steps.at(-1)!.pOutOfCash,
    medianRevenueDelayedPastHorizonUsd: cents(median(delayedPast) ?? 0),
    assumptions,
    warnings,
  }
}
