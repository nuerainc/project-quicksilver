import { evaluateExperiment, type Experiment, type ExperimentEvaluation, type MoneyLedger } from '../playbooks/economics.ts'
import { cents, checkRunsAndSeed, mulberry32, normal, quantile, randomIndex, share } from './random.ts'

/**
 * Experiment outcome odds (M7 part 3, the what-if engine).
 *
 * An ESTIMATE, never a decision. It answers: "if the metric keeps moving the
 * way it has, how likely is this experiment to end at kill, hold, continue or
 * scale by its end date, under its own fixed thresholds?"
 *
 * Method:
 *   - Steps: future measurements at the average gap between past ones, until
 *     the end date.
 *   - Each step adds a change drawn from the observed changes between
 *     consecutive measurements (bootstrap), plus optional normal noise.
 *   - Every step is judged by evaluateExperiment itself (the real verdict
 *     logic), just before the end date so the metric band shows rather than
 *     "expired". Kill and over-budget end a run, because they apply on their
 *     own; otherwise the last verdict is the outcome.
 *   - Spend: daily experiment spend so far (from the ledger) is resampled for
 *     the days left; without a ledger, spend continues in a straight line.
 */

export type ExperimentOutcome = 'kill' | 'over-budget' | 'hold' | 'continue' | 'scale'

export interface SimulateExperimentOptions {
  runs: number
  seed: number
  /** Standard deviation of extra normal noise per step, in metric units (default 0). */
  noise?: number
  /** Ledger to read this experiment's spend from (preferred). */
  ledger?: MoneyLedger
  /** Spend so far, when no ledger is passed. */
  spentUsd?: number
  /** "Now" (default: the latest measurement). */
  now?: Date
}

export interface ExperimentSimulation {
  ok: true
  kind: 'estimate'
  experimentId: string
  seed: number
  runs: number
  measurements: number
  observedChanges: number
  stepsLeft: number
  current: ExperimentEvaluation
  odds: Record<ExperimentOutcome, number>
  /** Share of runs where the metric reaches the scale threshold at any step. */
  pReachesScale: number
  finalValue: { p5: number; p50: number; p95: number }
  spentUsd: number
  budgetUsd: number
  /** Share of runs where spend, continuing at its observed pace to the end date, goes over budget. */
  pOverBudget: number
  historyTooShort: boolean
  assumptions: string[]
  warnings: string[]
}

export type ExperimentSimulationResult = ExperimentSimulation | { ok: false; kind: 'estimate'; reasons: string[] }

const DAY = 86_400_000
const MAX_STEPS = 1_000

export function simulateExperiment(exp: Experiment, o: SimulateExperimentOptions): ExperimentSimulationResult {
  const reasons = checkRunsAndSeed(o.runs, o.seed)
  const noise = o.noise ?? 0
  if (!(noise >= 0) || !Number.isFinite(noise)) reasons.push('noise must be zero or more.')
  if (o.spentUsd !== undefined && !(o.spentUsd >= 0)) reasons.push('spentUsd must be zero or more.')
  if (reasons.length) return { ok: false, kind: 'estimate', reasons }
  const id = exp.definition.id
  if (exp.status !== 'running' && exp.status !== 'held') return { ok: false, kind: 'estimate', reasons: [`Experiment ${id} is ${exp.status}: there is nothing left to estimate.`] }
  const ms = exp.measurements
  if (ms.length < 2) return { ok: false, kind: 'estimate', reasons: [`Experiment ${id} has ${ms.length} measurement(s); at least 2 are needed to see how the metric moves. Not enough to say.`] }
  if (!exp.endsAt || !exp.startedAt) return { ok: false, kind: 'estimate', reasons: [`Experiment ${id} has no start or end date.`] }

  const assumptions: string[] = []
  const warnings: string[] = []
  const startMs = new Date(exp.startedAt).getTime()
  const endMs = new Date(exp.endsAt).getTime()
  const lastMs = new Date(ms.at(-1)!.at).getTime()
  const nowMs = Math.max(o.now?.getTime() ?? lastMs, lastMs)

  const changes = ms.slice(1).map((m, i) => m.value - ms[i]!.value)
  const gaps = ms.slice(1).map((m, i) => new Date(m.at).getTime() - new Date(ms[i]!.at).getTime())
  let gap = gaps.reduce((s, g) => s + g, 0) / gaps.length
  if (!(gap > 0)) {
    gap = DAY
    warnings.push('The measurements share one timestamp, so their cadence is unknown; assuming one measurement per day.')
  }
  const remainingMs = Math.max(0, endMs - nowMs)
  let stepsLeft = Math.floor(remainingMs / gap)
  if (stepsLeft > MAX_STEPS) { stepsLeft = MAX_STEPS; warnings.push(`Capped at ${MAX_STEPS} future measurements.`) }

  // Spend so far and its daily pattern.
  const spentOf = (l: MoneyLedger, until: number) => l.entries
    .filter((e) => e.experimentId === id && new Date(e.occurredAt ?? e.recordedAt).getTime() < until)
    .reduce((s, e) => s + (e.kind === 'spend' || e.kind === 'compute' ? e.amountUsd : e.kind === 'refund' ? -e.amountUsd : 0), 0)
  const spent = cents(o.ledger ? spentOf(o.ledger, nowMs + 1) : o.spentUsd ?? 0)
  const elapsedDays = Math.max(1, Math.ceil((nowMs - startMs) / DAY))
  let daily: number[]
  if (o.ledger) {
    daily = Array.from({ length: elapsedDays }, (_, d) => {
      const a = startMs + d * DAY, b = a + DAY
      return o.ledger!.entries
        .filter((e) => e.experimentId === id)
        .filter((e) => { const t = new Date(e.occurredAt ?? e.recordedAt).getTime(); return t >= a && t < b })
        .reduce((s, e) => s + (e.kind === 'spend' || e.kind === 'compute' ? e.amountUsd : e.kind === 'refund' ? -e.amountUsd : 0), 0)
    })
    assumptions.push(`Spend: each day left draws one of the ${elapsedDays} observed day(s) of this experiment's spend.`)
  } else {
    daily = [spent / elapsedDays]
    assumptions.push(`Spend: no ledger passed, so spend continues in a straight line ($${cents(spent / elapsedDays)} a day).`)
  }
  const daysLeft = Math.ceil(remainingMs / DAY)

  const historyTooShort = changes.length < 3
  if (historyTooShort) warnings.push(`Only ${changes.length} observed change(s) in the metric: too short to say much.`)
  assumptions.push(`Metric: ${stepsLeft} more measurement(s) (one every ${cents(gap / DAY)} day(s)); each adds one of the ${changes.length} observed change(s)${noise > 0 ? ` plus normal noise (sd ${noise})` : ''}.`)
  assumptions.push(`Verdicts come from evaluateExperiment with the thresholds fixed at start (kill ${exp.definition.metric.kill}, hold ${exp.definition.metric.hold}, scale ${exp.definition.metric.scale}, ${exp.definition.metric.direction}); kill and over-budget end a run early.`)
  assumptions.push('A held experiment is assumed to keep being measured and to keep its spend pace.')
  assumptions.push('An estimate, not a decision: it applies no verdict and changes nothing.')

  const current = evaluateExperiment(exp, spent, new Date(nowMs))
  const rng = mulberry32(o.seed)
  const counts: Record<ExperimentOutcome, number> = { kill: 0, 'over-budget': 0, hold: 0, continue: 0, scale: 0 }
  let reachesScale = 0, overBudget = 0
  const finals: number[] = []
  const judgeAt = (v: number, spentNow: number, atMs: number) =>
    evaluateExperiment({ ...exp, measurements: [{ at: new Date(atMs).toISOString(), value: v, by: 'simulation', source: 'simulation' }] }, spentNow, new Date(Math.min(atMs, endMs - 1))).verdict

  for (let r = 0; r < o.runs; r++) {
    const cum: number[] = [0]
    for (let d = 0; d < daysLeft; d++) cum.push(cum[d]! + daily[randomIndex(rng, daily.length)]!)
    if (spent + cum[daysLeft]! > exp.definition.budgetUsd) overBudget++
    let v = ms.at(-1)!.value
    let outcome: ExperimentOutcome | null = null
    let scaled = false
    let verdict = judgeAt(v, spent, nowMs)
    if (verdict === 'scale') scaled = true
    for (let k = 1; k <= stepsLeft && verdict !== 'kill' && verdict !== 'over-budget'; k++) {
      v += changes[randomIndex(rng, changes.length)]! + (noise > 0 ? noise * normal(rng) : 0)
      const atMs = lastMs + k * gap
      const day = Math.min(daysLeft, Math.max(0, Math.floor((atMs - nowMs) / DAY)))
      verdict = judgeAt(v, spent + cum[day]!, atMs)
      if (verdict === 'scale') scaled = true
    }
    if (verdict === 'kill' || verdict === 'over-budget' || verdict === 'hold' || verdict === 'continue' || verdict === 'scale') outcome = verdict
    // Unreachable: every judged step has a measurement and falls before the end date.
    if (outcome === null) throw new Error(`Unexpected verdict "${verdict}" while simulating ${id}.`)
    counts[outcome]++
    if (scaled) reachesScale++
    finals.push(v)
  }
  finals.sort((a, b) => a - b)
  const odds = Object.fromEntries(Object.entries(counts).map(([k, n]) => [k, share(n, o.runs)])) as Record<ExperimentOutcome, number>
  const round = (x: number) => Math.round(x * 10_000) / 10_000
  return {
    ok: true,
    kind: 'estimate',
    experimentId: id,
    seed: o.seed,
    runs: o.runs,
    measurements: ms.length,
    observedChanges: changes.length,
    stepsLeft,
    current,
    odds,
    pReachesScale: share(reachesScale, o.runs),
    finalValue: { p5: round(quantile(finals, 0.05)), p50: round(quantile(finals, 0.5)), p95: round(quantile(finals, 0.95)) },
    spentUsd: spent,
    budgetUsd: exp.definition.budgetUsd,
    pOverBudget: share(overBudget, o.runs),
    historyTooShort,
    assumptions,
    warnings,
  }
}
