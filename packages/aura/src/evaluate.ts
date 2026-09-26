import type { ObjectiveParser, ParsedObjective } from './parse.ts'
import type { AutonomyDepth, OperatingMode } from './types.ts'

/**
 * Parser evaluation against the labeled objective set (eval/objectives.json).
 *
 * Each labeled objective lists what an ideal parser returns from the literal
 * text: the mode (or null when the text does not say), money amounts, the
 * timeframe in days, weekly hours, the autonomy depth (null = not stated) and
 * constraint ids. An objective is parsed correctly only when every field
 * matches. The charter's 0.4.0 target is ≥ 90% of objectives.
 */

export interface LabeledObjective {
  id: string
  text: string
  expected: {
    mode: OperatingMode | null
    budget: number | null
    revenueTarget: number | null
    timeframeDays: number | null
    weeklyHours: number | null
    autonomy: AutonomyDepth | null
    constraints: string[]
  }
}

export const EVAL_FIELDS = ['mode', 'budget', 'revenueTarget', 'timeframeDays', 'weeklyHours', 'autonomy', 'constraints'] as const
type Field = (typeof EVAL_FIELDS)[number]

export interface EvalMiss {
  id: string
  field: Field
  expected: unknown
  actual: unknown
}

export interface EvalReport {
  objectives: number
  exactMatches: number
  parsingAccuracy: number
  fieldAccuracy: Record<Field, number>
  misses: EvalMiss[]
  /** Objectives where the parser threw (counted as fully wrong). */
  errors: Array<{ id: string; error: string }>
  meetsCharterTarget: boolean
}

export function normalizeParsed(p: ParsedObjective): LabeledObjective['expected'] {
  return {
    mode: p.mode?.value ?? null,
    budget: p.budget?.value ?? null,
    revenueTarget: p.revenueTarget?.value ?? null,
    timeframeDays: p.timeframeDays?.value ?? null,
    weeklyHours: p.weeklyHours?.value ?? null,
    autonomy: p.autonomy?.value ?? null,
    constraints: p.constraints.map((c) => c.id).sort(),
  }
}

export async function evaluateParser(parser: ObjectiveParser, set: LabeledObjective[], target = 0.9): Promise<EvalReport> {
  const misses: EvalMiss[] = []
  const errors: Array<{ id: string; error: string }> = []
  const correct: Record<Field, number> = { mode: 0, budget: 0, revenueTarget: 0, timeframeDays: 0, weeklyHours: 0, autonomy: 0, constraints: 0 }
  let exact = 0
  for (const item of set) {
    let actual: LabeledObjective['expected']
    try {
      actual = normalizeParsed(await parser(item.text))
    } catch (error) {
      errors.push({ id: item.id, error: (error as Error).message })
      actual = { mode: null, budget: null, revenueTarget: null, timeframeDays: null, weeklyHours: null, autonomy: null, constraints: ['<parser error>'] }
    }
    let all = true
    for (const field of EVAL_FIELDS) {
      const want = field === 'constraints' ? [...item.expected.constraints].sort() : item.expected[field]
      const ok = JSON.stringify(actual[field]) === JSON.stringify(want)
      if (ok) correct[field] += 1
      else {
        all = false
        misses.push({ id: item.id, field, expected: want, actual: actual[field] })
      }
    }
    if (all) exact += 1
  }
  const n = set.length || 1
  const fieldAccuracy = Object.fromEntries(EVAL_FIELDS.map((f) => [f, round(correct[f] / n)])) as Record<Field, number>
  const parsingAccuracy = round(exact / n)
  return { objectives: set.length, exactMatches: exact, parsingAccuracy, fieldAccuracy, misses, errors, meetsCharterTarget: parsingAccuracy >= target }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}
