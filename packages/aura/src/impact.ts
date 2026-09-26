import type { GraphVariable, IntentGraph } from './types.ts'

/**
 * Deterministic impact scoring for open unknowns and weak beliefs.
 *
 * For each candidate variable (open unknowns, and inferences or observations
 * below `confidenceThreshold`):
 *
 *   impact = uncertainty × stakes × (1 + reachBonus)
 *
 *   uncertainty = 1 − confidence            (open unknowns: 1)
 *   stakes      = max(own importance, importance of everything that depends
 *                 on it, directly or transitively, discounted 0.8 per hop)
 *   reachBonus  = 0.1 × number of dependents, capped at 0.5
 *
 * The same inputs always give the same ranking, and every score comes with
 * the arithmetic that produced it, so a human can check why Aura asks what
 * it asks. The top items become targeted questions.
 */

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
    const dependents = [...seen.keys()].sort()
    let stakes = v.importance
    let stakesFrom = v.id
    for (const [id, hop] of seen) {
      const s = (byId.get(id)?.importance ?? 0) * discount ** (hop - 1)
      if (s > stakes) {
        stakes = s
        stakesFrom = id
      }
    }
    const uncertainty = open ? 1 : round(1 - v.confidence)
    const reachBonus = Math.min(0.5, 0.1 * dependents.length)
    const score = round(uncertainty * stakes * (1 + reachBonus))
    items.push({
      variableId: v.id,
      label: v.label,
      score,
      uncertainty,
      stakes: round(stakes),
      dependents,
      explanation:
        `uncertainty ${uncertainty} (${open ? 'open unknown' : `confidence ${v.confidence}`}) × stakes ${round(stakes)}` +
        ` (${stakesFrom === v.id ? 'its own importance' : `via "${byId.get(stakesFrom)?.label ?? stakesFrom}"`})` +
        ` × (1 + ${round(reachBonus)} for ${dependents.length} dependent${dependents.length === 1 ? '' : 's'}) = ${score}`,
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
