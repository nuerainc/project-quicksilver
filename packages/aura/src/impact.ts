import type { GraphVariable, IntentGraph } from './types.ts'

/**
 * Deterministic impact scoring for open unknowns and weak beliefs.
 * Scorer version: IMPACT_SCORER_VERSION (recorded with human rankings, so an
 * agreement score always names the scorer it measured).
 *
 * For each candidate variable (open unknowns, and inferences or observations
 * below `confidenceThreshold`):
 *
 *   impact = uncertainty × importance × (1 + leverage)
 *
 *   uncertainty = 1 − confidence            (open unknowns: 1)
 *   importance  = the variable's own importance
 *   leverage    = 0.5 × Σ importance of the variables that depend on it,
 *                 discounted 0.8 per extra hop, capped at 1
 *
 * The objective itself is excluded from leverage: every slot hangs off the
 * objective, so counting it would give every question the same score.
 * The same inputs always give the same ranking, and every score comes with
 * the arithmetic that produced it. The top items become targeted questions.
 */

export const IMPACT_SCORER_VERSION = 2

export interface ImpactItem {
  variableId: string
  label: string
  score: number
  uncertainty: number
  stakes: number
  dependents: string[]
  explanation: string
  question: string
}

export interface ImpactOptions {
  confidenceThreshold?: number
  hopDiscount?: number
  limit?: number
}

export function scoreImpact(graph: IntentGraph, options: ImpactOptions = {}): ImpactItem[] {
  const threshold = options.confidenceThreshold ?? 0.7
  const discount = options.hopDiscount ?? 0.8
  const byId = new Map(graph.variables.map((v) => [v.id, v]))
  // Reverse edges: who depends on X?
  const dependentsOf = new Map<string, string[]>()
  for (const e of graph.edges) dependentsOf.set(e.to, [...(dependentsOf.get(e.to) ?? []), e.from])

  const items: ImpactItem[] = []
  for (const v of graph.variables) {
    const open = v.kind === 'unknown'
    const weak = !open && (v.provenance === 'AGENT_INFERRED' || v.provenance === 'OBSERVED') && v.confidence < threshold
    if (!open && !weak) continue

    // Breadth-first walk of everything that depends on v.
    const seen = new Map<string, number>()
    let frontier = [{ id: v.id, hop: 0 }]
    while (frontier.length) {
      const next: { id: string; hop: number }[] = []
      for (const { id, hop } of frontier) {
        for (const d of dependentsOf.get(id) ?? []) {
          if (seen.has(d) || d === v.id) continue
          seen.set(d, hop + 1)
          next.push({ id: d, hop: hop + 1 })
        }
      }
      frontier = next
    }
    const dependents = [...seen.keys()].filter((id) => byId.get(id)?.id !== 'objective').sort()
    let leverage = 0
    const leverageParts: string[] = []
    for (const id of dependents) {
      const d = byId.get(id)
      const contribution = 0.5 * (d?.importance ?? 0) * discount ** ((seen.get(id) ?? 1) - 1)
      leverage += contribution
      leverageParts.push(`"${d?.label ?? id}" ${round(contribution)}`)
    }
    leverage = Math.min(1, round(leverage))
    const uncertainty = open ? 1 : round(1 - v.confidence)
    const stakes = round(v.importance * (1 + leverage))
    const score = round(uncertainty * stakes)
    items.push({
      variableId: v.id,
      label: v.label,
      score,
      uncertainty,
      stakes,
      dependents,
      explanation:
        `uncertainty ${uncertainty} (${open ? 'open unknown' : `confidence ${v.confidence}`}) × importance ${v.importance}` +
        ` × (1 + leverage ${leverage}${leverageParts.length ? ` from ${leverageParts.join(', ')}` : ', nothing else depends on it'}) = ${score}`,
      question: questionFor(v),
    })
  }
  items.sort((a, b) => b.score - a.score || a.variableId.localeCompare(b.variableId))
  return options.limit ? items.slice(0, options.limit) : items
}

/** The targeted questions Aura would ask next, highest impact first. */
export function targetedQuestions(graph: IntentGraph, limit = 3): string[] {
  return scoreImpact(graph, { limit }).map((i) => i.question)
}

function questionFor(v: GraphVariable): string {
  if (v.kind === 'unknown') return QUESTION_TEMPLATES[v.id] ?? `What is the ${v.label.toLowerCase()}?`
  return `I inferred ${v.label.toLowerCase()} = ${String(v.value)}${v.unit ? ` ${v.unit}` : ''} (${v.explanation ?? 'no explanation'}). Is that right?`
}

const QUESTION_TEMPLATES: Record<string, string> = {
  mode: 'Are you starting something new, bringing in a business you already run, or handing over recurring work?',
  budget: 'How much money can this objective use in total?',
  timeframe: 'By when should this be achieved?',
  risk_tolerance: 'How much of the budget are you willing to lose while testing ideas?',
  success_metric: 'How will you know this worked? Name the number you will look at.',
  skills: 'What skills, assets or audiences can the business use from day one?',
  business_type: 'What does the business sell, and to whom?',
  revenue_model: 'How does the business make money today?',
  data_sources: 'Where does the business keep its sales, customer and financial records?',
  cadence: 'How often should Quicksilver report or act?',
  scope: 'Which parts of the business should Quicksilver cover first?',
  weekly_hours: 'How many hours a week can you give this?',
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}
