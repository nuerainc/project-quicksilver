/** Risk 0 to 5 as a word as well as a number, so it is never carried by colour alone. */
const WORDS = ['None', 'Very low', 'Low', 'Moderate', 'High', 'Severe'] as const
export type RiskTone = 'low' | 'mid' | 'high' | 'unknown'

export function riskWord(level: number | null | undefined): string {
  return typeof level === 'number' && Number.isInteger(level) && level >= 0 && level <= 5 ? WORDS[level]! : 'Not rated'
}

export function riskTone(level: number | null | undefined): RiskTone {
  if (typeof level !== 'number' || !Number.isInteger(level) || level < 0 || level > 5) return 'unknown'
  return level <= 1 ? 'low' : level <= 3 ? 'mid' : 'high'
}

/** "3 of 5 · Moderate", or "Not rated". */
export function riskLabel(level: number | null | undefined): string {
  return riskTone(level) === 'unknown' ? 'Not rated' : `${level} of 5 · ${riskWord(level)}`
}
