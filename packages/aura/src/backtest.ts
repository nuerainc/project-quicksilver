/**
 * Back-testing (M4): before Onboard makes a confidence claim about a business,
 * it checks its forecasts against that business's own history.
 *
 * Method (deterministic, fixed in advance):
 *   - Series: monthly revenue.
 *   - Forecast for month t, using only months before t:
 *       seasonal naive (same month last year) when 13+ months precede t,
 *       otherwise the mean of the previous 3 months.
 *   - Rolling origin: every month from the 7th onward is forecast once.
 *   - Error: mean absolute percentage error (MAPE), skipping months with zero
 *     actual revenue (reported separately).
 *   - 80% interval: the forecast ± the 80th percentile of the absolute
 *     percentage errors seen in EARLIER folds only; coverage is the share of
 *     actuals inside their interval.
 *   - Passed when: at least 6 folds, MAPE ≤ the hold threshold (default 0.3),
 *     and interval coverage ≥ 0.7.
 * Small samples are reported with their fold count, never as precise
 * confidence.
 */

export interface BacktestFold {
  month: string
  actual: number
  forecast: number
  method: 'seasonal-naive' | 'mean-3'
  ape: number | null
  interval: [number, number] | null
  covered: boolean | null
}

export interface BacktestReport {
  series: 'monthly revenue'
  months: number
  folds: BacktestFold[]
  mape: number | null
  coverage: number | null
  zeroActualMonths: number
  passed: boolean
  reasons: string[]
  summary: string
}

const MIN_TRAIN = 6
const MIN_FOLDS = 6

function quantile(sorted: number[], q: number): number {
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i), hi = Math.ceil(i)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo)
}

export function backtestRevenue(months: Array<{ month: string; revenue: number }>, options: { maxMape?: number; minCoverage?: number } = {}): BacktestReport {
  const maxMape = options.maxMape ?? 0.3
  const minCoverage = options.minCoverage ?? 0.7
  const folds: BacktestFold[] = []
  const pastApes: number[] = []
  let zeroActual = 0
  for (let t = MIN_TRAIN; t < months.length; t++) {
    const actual = months[t]!.revenue
    const seasonal = t >= 12
    const forecast = seasonal ? months[t - 12]!.revenue : (months[t - 1]!.revenue + months[t - 2]!.revenue + months[t - 3]!.revenue) / 3
    const ape = actual > 0 ? Math.abs(actual - forecast) / actual : null
    if (ape === null) zeroActual++
    let interval: [number, number] | null = null
    let covered: boolean | null = null
    if (pastApes.length >= 3) {
      const w = quantile([...pastApes].sort((a, b) => a - b), 0.8)
      interval = [Math.max(0, Math.round(forecast * (1 - w) * 100) / 100), Math.round(forecast * (1 + w) * 100) / 100]
      covered = actual >= interval[0] && actual <= interval[1]
    }
    folds.push({ month: months[t]!.month, actual, forecast: Math.round(forecast * 100) / 100, method: seasonal ? 'seasonal-naive' : 'mean-3', ape: ape === null ? null : Math.round(ape * 1000) / 1000, interval, covered })
    if (ape !== null) pastApes.push(ape)
  }
  const scored = folds.filter((f) => f.ape !== null)
  const mape = scored.length ? Math.round((scored.reduce((s, f) => s + f.ape!, 0) / scored.length) * 1000) / 1000 : null
  const withInterval = folds.filter((f) => f.covered !== null)
  const coverage = withInterval.length ? Math.round((withInterval.filter((f) => f.covered).length / withInterval.length) * 1000) / 1000 : null
  const reasons: string[] = []
  if (scored.length < MIN_FOLDS) reasons.push(`Only ${scored.length} month(s) could be forecast; at least ${MIN_FOLDS} are needed (${MIN_TRAIN + MIN_FOLDS} months of history).`)
  if (mape !== null && mape > maxMape) reasons.push(`Forecast error ${pct(mape)} is above the ${pct(maxMape)} limit.`)
  if (coverage !== null && coverage < minCoverage) reasons.push(`Only ${pct(coverage)} of months fell inside the 80% range (need ${pct(minCoverage)}).`)
  if (coverage === null && scored.length >= MIN_FOLDS) reasons.push('Not enough folds to check the ranges.')
  const passed = reasons.length === 0
  const summary = mape === null
    ? `Not enough history to back-test (${months.length} months).`
    : `Over ${scored.length} months, revenue forecasts missed by ${pct(mape)} on average; ${coverage === null ? 'ranges not yet checkable' : `${pct(coverage)} of actuals fell inside the 80% range`}. ${passed ? 'Passed.' : 'Not passed.'}`
  return { series: 'monthly revenue', months: months.length, folds, mape, coverage, zeroActualMonths: zeroActual, passed, reasons, summary }
}

function pct(x: number): string {
  return `${Math.round(x * 1000) / 10}%`
}
