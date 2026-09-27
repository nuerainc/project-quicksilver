/**
 * Deterministic randomness for the what-if engine (M7 part 3).
 *
 * Library code never calls Math.random: every simulation takes a seed, so the
 * same inputs and seed give the same numbers on any machine.
 */

export type Rng = () => number

/** mulberry32: a small, fast 32-bit PRNG. Returns floats in [0, 1). */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

/** A whole number in [0, n). */
export const randomIndex = (rng: Rng, n: number): number => Math.min(n - 1, Math.floor(rng() * n))

/** A standard normal draw (Box–Muller). */
export function normal(rng: Rng): number {
  let u = 0
  while (u === 0) u = rng()
  const v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** Linear-interpolated quantile of an ascending list (q in [0, 1]). */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN
  const i = (sorted.length - 1) * q
  const lo = Math.floor(i), hi = Math.ceil(i)
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo)
}

export const median = (values: number[]): number | null => (values.length ? quantile([...values].sort((a, b) => a - b), 0.5) : null)

export const cents = (n: number) => Math.round(n * 100) / 100
export const share = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 1000) / 1000 : 0)

/** Checks shared by every simulation. */
export function checkRunsAndSeed(runs: unknown, seed: unknown): string[] {
  const errors: string[] = []
  if (!Number.isInteger(runs) || (runs as number) < 1 || (runs as number) > 100_000) errors.push('runs must be a whole number from 1 to 100,000.')
  if (!Number.isInteger(seed)) errors.push('seed must be a whole number.')
  return errors
}
