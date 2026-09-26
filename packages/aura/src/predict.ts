import type { ProfileResult } from './profile.ts'

/**
 * Choice predictor v1: predicts which option an intent provider would pick in
 * a choice scenario, from their intent profile alone.
 *
 * The method was frozen (eval/choice-predictor-v1.json) before any scenario
 * answers existed, so its result cannot have been tuned to them:
 *   - Each option lists the profile dimensions it expresses, with a pole and
 *     a weight. Every action option also expresses "decide yourself"
 *     (autonomy, left); every "ask" option expresses "ask me first".
 *   - Fit = Σ weight × (profile score × confidence/10), signed toward the pole.
 *   - The highest fit wins; ties go to the earliest of a, b, c, ask.
 *   - If no action option expresses any profile dimension, the predictor
 *     abstains, and the headline number counts that as a miss.
 */

export type Pole = 'left' | 'right'

export interface OptionLoadings {
  [dimension: string]: [Pole, number]
}

export interface ScenarioAnnotation {
  covered: boolean
  options?: Record<string, OptionLoadings>
}

export interface PredictorSpec {
  version: number
  annotations: Record<string, ScenarioAnnotation>
}

export interface ChoiceScenarioLite {
  id: string
  category: string
  options: Record<string, string>
}

export interface Prediction {
  scenarioId: string
  choice: string | null
  fits: Record<string, number>
  explanation: string
}

const OPTION_ORDER = ['a', 'b', 'c', 'ask']

export function predictChoice(profile: ProfileResult, spec: PredictorSpec, scenario: ChoiceScenarioLite): Prediction {
  const ann = spec.annotations[scenario.id]
  if (!ann?.covered || !ann.options) return { scenarioId: scenario.id, choice: null, fits: {}, explanation: 'No profile dimension applies to these options; abstained.' }
  const signal = new Map(profile.dimensions.map((d) => [d.dimension, d.score * (d.confidence / 10)]))
  const fits: Record<string, number> = {}
  const parts: string[] = []
  for (const id of OPTION_ORDER.filter((o) => o in scenario.options)) {
    const loadings: OptionLoadings = id === 'ask' ? { autonomy: ['right', 1] } : { ...(ann.options[id] ?? {}), autonomy: ann.options[id]?.autonomy ?? ['left', 1] }
    let fit = 0
    for (const [dim, [pole, weight]] of Object.entries(loadings)) {
      const s = signal.get(dim) ?? 0
      fit += weight * (pole === 'right' ? s : -s)
    }
    fits[id] = Math.round(fit * 1000) / 1000
  }
  let best: string | null = null
  for (const id of OPTION_ORDER) if (id in fits && (best === null || fits[id]! > fits[best]! + 1e-9)) best = id
  for (const id of OPTION_ORDER) if (id in fits) parts.push(`${id} ${fits[id]}`)
  return { scenarioId: scenario.id, choice: best, fits, explanation: `Fit by option: ${parts.join(', ')}.` }
}

export interface ChoiceAgreementReport {
  scenarios: number
  covered: number
  correct: number
  /** Correct / all scenarios; abstentions count as misses. The charter headline. */
  agreement: number
  /** Correct / covered scenarios. */
  coveredAgreement: number
  chance: number
  askScenarios: number
  askCorrect: number
  unneededAsks: number
  meetsCharterTarget: boolean
  rows: Array<{ id: string; category: string; predicted: string | null; actual: string; correct: boolean }>
}

/** Charter target: ≥ 70% and at least double chance. */
export function choiceAgreement(profile: ProfileResult, spec: PredictorSpec, scenarios: ChoiceScenarioLite[], answers: Record<string, string>): ChoiceAgreementReport {
  const rows: ChoiceAgreementReport['rows'] = []
  let chanceSum = 0
  for (const s of scenarios) {
    const actual = answers[s.id]
    if (!actual) continue
    const p = predictChoice(profile, spec, s)
    rows.push({ id: s.id, category: s.category, predicted: p.choice, actual, correct: p.choice === actual })
    chanceSum += 1 / Object.keys(s.options).length
  }
  const n = rows.length
  const correct = rows.filter((r) => r.correct).length
  const covered = rows.filter((r) => r.predicted !== null)
  const agreement = n ? correct / n : 0
  const chance = n ? chanceSum / n : 0
  const askRows = rows.filter((r) => r.actual === 'ask')
  return {
    scenarios: n,
    covered: covered.length,
    correct,
    agreement,
    coveredAgreement: covered.length ? covered.filter((r) => r.correct).length / covered.length : 0,
    chance,
    askScenarios: askRows.length,
    askCorrect: askRows.filter((r) => r.predicted === 'ask').length,
    unneededAsks: rows.filter((r) => r.predicted === 'ask' && r.actual !== 'ask').length,
    meetsCharterTarget: n > 0 && agreement >= 0.7 && agreement >= 2 * chance,
    rows,
  }
}
