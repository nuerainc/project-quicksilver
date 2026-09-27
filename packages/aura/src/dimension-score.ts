/**
 * Graded scoring of choice predictions on measured dimensions.
 *
 * Exact agreement says only right or wrong. Here every option carries a
 * rating on each dimension (-2..2, relative to the other options in the same
 * scenario; eval/option-ratings.json, rated blind to anyone's answers), so a
 * prediction is scored by how far the picked option sits from the provider's
 * on each dimension, and in which direction:
 *
 *   bias  = mean(predicted - actual)   (+ means Aura leans higher than the provider)
 *   gap   = mean(|predicted - actual|) (0 = same place, even on a miss)
 *   random gap = the gap a uniformly random pick would have, for scale
 *
 * The 70% exact-agreement target is unchanged; this shows what to correct.
 */

export interface OptionRatings {
  dimensions: string[]
  ratings: Record<string, Record<string, number[]>>
}

export interface DimensionRow { dimension: string; bias: number; gap: number; randomGap: number }

export interface DimensionReport {
  scenarios: number
  exact: number
  rows: DimensionRow[]
  totalGap: number
  totalRandomGap: number
  /** 1 - totalGap / totalRandomGap: 1 = always the provider's option, 0 = no better than random. */
  closerThanRandom: number
}

const round = (x: number) => Math.round(x * 100) / 100

/** Score predicted picks against actual choices on every rated dimension. Scenarios missing a rating, pick or answer are skipped. */
export function dimensionReport(r: OptionRatings, picks: Record<string, string | null>, actual: Record<string, string>): DimensionReport {
  const n = r.dimensions.length
  const bias = Array(n).fill(0), gap = Array(n).fill(0), rnd = Array(n).fill(0)
  let count = 0, exact = 0
  for (const [id, choice] of Object.entries(actual)) {
    const opts = r.ratings[id], pick = picks[id]
    if (!opts || !pick || !opts[choice] || !opts[pick]) continue
    const y = opts[choice]!, p = opts[pick]!, all = Object.values(opts)
    count++
    if (pick === choice) exact++
    for (let i = 0; i < n; i++) {
      bias[i] += p[i]! - y[i]!
      gap[i] += Math.abs(p[i]! - y[i]!)
      rnd[i] += all.reduce((s, o) => s + Math.abs(o[i]! - y[i]!), 0) / all.length
    }
  }
  const per = (x: number) => (count ? x / count : 0)
  const rows = r.dimensions.map((dimension, i) => ({ dimension, bias: round(per(bias[i])), gap: round(per(gap[i])), randomGap: round(per(rnd[i])) }))
  const totalGap = round(per(gap.reduce((a, b) => a + b, 0)))
  const totalRandomGap = round(per(rnd.reduce((a, b) => a + b, 0)))
  return { scenarios: count, exact, rows, totalGap, totalRandomGap, closerThanRandom: totalRandomGap ? round(1 - totalGap / totalRandomGap) : 0 }
}

/** Where the provider's choices sit relative to the average option, per dimension (+ = higher than a typical option). */
export function providerLean(r: OptionRatings, actual: Record<string, string>): Record<string, number> {
  const n = r.dimensions.length, sum = Array(n).fill(0)
  let count = 0
  for (const [id, choice] of Object.entries(actual)) {
    const opts = r.ratings[id]
    if (!opts?.[choice]) continue
    const all = Object.values(opts)
    count++
    for (let i = 0; i < n; i++) sum[i] += opts[choice]![i]! - all.reduce((s, o) => s + o[i]!, 0) / all.length
  }
  return Object.fromEntries(r.dimensions.map((d, i) => [d, round(count ? sum[i] / count : 0)]))
}
