import { scoreImpact, type ImpactItem } from './impact.ts'
import { parseObjectiveBaseline, type ObjectiveParser, type ParsedObjective } from './parse.ts'
import { provenanceReport, validateIntentGraph, type GraphIssue } from './provenance.ts'
import type { AutonomyDepth, DecisionEdge, GraphVariable, IntentGraph, OperatingMode, VariableSource } from './types.ts'

/**
 * The intent entry point: one plain-language objective in, a decision graph
 * out, plus the open unknowns ranked by impact and the questions to ask next.
 *
 * - Values the human literally wrote become HUMAN_SPECIFIED, with the quote.
 * - The operating mode is AGENT_INFERRED, explained by the cue that matched.
 * - Every slot the chosen mode needs but the text did not give becomes an open
 *   unknown. Aura asks about the highest-impact ones instead of guessing.
 * - Standing rules (NQC Kernel authority, WAES review) are SYSTEM_CONSTRAINTs.
 */

export interface CreateIntentOptions {
  requestedBy: string
  id?: string
  /** Defaults to the rule-based baseline parser. */
  parser?: ObjectiveParser
  /** Overrides the parsed mode (a human choice, recorded as HUMAN_SPECIFIED). */
  mode?: OperatingMode
  autonomyDepth?: AutonomyDepth
  now?: Date
}

export interface IntentResult {
  graph: IntentGraph
  parsed: ParsedObjective
  impact: ImpactItem[]
  questions: string[]
  issues: GraphIssue[]
  report: ReturnType<typeof provenanceReport>
}

/** Slots each mode needs before Quicksilver can plan well. */
export const MODE_SLOTS: Record<OperatingMode, Array<{ id: string; label: string; importance: number }>> = {
  genesis: [
    { id: 'budget', label: 'Budget', importance: 0.9 },
    { id: 'timeframe', label: 'Timeframe', importance: 0.7 },
    { id: 'risk_tolerance', label: 'Risk tolerance', importance: 0.8 },
    { id: 'success_metric', label: 'Success metric', importance: 0.8 },
    { id: 'skills', label: 'Skills and assets', importance: 0.6 },
    { id: 'weekly_hours', label: 'Weekly hours available', importance: 0.5 },
  ],
  onboard: [
    { id: 'business_type', label: 'Business type', importance: 0.9 },
    { id: 'revenue_model', label: 'Revenue model', importance: 0.8 },
    { id: 'data_sources', label: 'Data sources', importance: 0.7 },
    { id: 'scope', label: 'Scope', importance: 0.7 },
    { id: 'success_metric', label: 'Success metric', importance: 0.8 },
  ],
  operate: [
    { id: 'scope', label: 'Scope', importance: 0.7 },
    { id: 'cadence', label: 'Cadence', importance: 0.5 },
    { id: 'success_metric', label: 'Success metric', importance: 0.8 },
  ],
}

const MODE_EXPLANATION: Record<OperatingMode, string> = {
  genesis: 'Genesis: the objective describes starting a new business or making money from scratch',
  onboard: 'Onboard: the objective refers to a business that already exists',
  operate: 'Operate: the objective describes ongoing, recurring work',
}

export async function createIntent(objective: string, options: CreateIntentOptions): Promise<IntentResult> {
  const now = options.now ?? new Date()
  const at = now.toISOString()
  const who = options.requestedBy
  const parsed = await (options.parser ?? parseObjectiveBaseline)(objective)
  const human = (quote: string): VariableSource[] => [{ type: 'human', ref: who, quote }]
  const variables: GraphVariable[] = []
  const edges: DecisionEdge[] = []
  const base = { updatedAt: at, updatedBy: who }

  variables.push({ id: 'objective', label: 'Objective', kind: 'goal', value: objective.trim(), provenance: 'HUMAN_SPECIFIED', confidence: 1, importance: 1, sources: human(objective.trim()), ...base })

  // Mode: a human choice wins; otherwise infer from a cue; otherwise ask.
  let mode: OperatingMode | null = null
  if (options.mode) {
    mode = options.mode
    variables.push({ id: 'mode', label: 'Operating mode', kind: 'assumption', value: mode, provenance: 'HUMAN_SPECIFIED', confidence: 1, importance: 0.9, sources: [{ type: 'human', ref: who }], ...base })
  } else if (parsed.mode) {
    mode = parsed.mode.value
    variables.push({
      id: 'mode', label: 'Operating mode', kind: 'assumption', value: mode, provenance: 'AGENT_INFERRED', confidence: 0.75, importance: 0.9,
      sources: human(parsed.mode.cue.text), explanation: `${MODE_EXPLANATION[mode]} ("${parsed.mode.cue.text}").`, updatedAt: at, updatedBy: 'aura:baseline-parser',
    })
  } else {
    variables.push({ id: 'mode', label: 'Operating mode', kind: 'unknown', provenance: 'AGENT_INFERRED', confidence: 0, importance: 0.9, sources: [], updatedAt: at, updatedBy: 'aura:baseline-parser' })
  }
  edges.push({ from: 'objective', to: 'mode', relation: 'depends-on' })

  // Values stated in the text.
  const stated: Record<string, { value: number; quote: string; unit: string; label: string; kind: GraphVariable['kind']; importance: number }> = {}
  if (parsed.budget) stated.budget = { value: parsed.budget.value, quote: parsed.budget.span.text, unit: 'USD', label: 'Budget', kind: 'constraint', importance: 0.9 }
  if (parsed.timeframeDays) stated.timeframe = { value: parsed.timeframeDays.value, quote: parsed.timeframeDays.span.text, unit: 'days', label: 'Timeframe', kind: 'constraint', importance: 0.7 }
  if (parsed.weeklyHours) stated.weekly_hours = { value: parsed.weeklyHours.value, quote: parsed.weeklyHours.span.text, unit: 'hours/week', label: 'Weekly hours available', kind: 'constraint', importance: 0.5 }
  if (parsed.revenueTarget) stated.success_metric = { value: parsed.revenueTarget.value, quote: parsed.revenueTarget.span.text, unit: 'USD revenue', label: 'Success metric', kind: 'metric', importance: 0.8 }
  for (const [id, s] of Object.entries(stated)) {
    variables.push({ id, label: s.label, kind: s.kind, value: s.value, unit: s.unit, provenance: 'HUMAN_SPECIFIED', confidence: 1, importance: s.importance, sources: human(s.quote), ...base })
    edges.push({ from: 'objective', to: id, relation: 'depends-on' })
  }

  // Slots the mode needs that were not stated become open unknowns.
  for (const slot of mode ? MODE_SLOTS[mode] : []) {
    if (variables.some((v) => v.id === slot.id)) continue
    variables.push({ id: slot.id, label: slot.label, kind: 'unknown', provenance: 'AGENT_INFERRED', confidence: 0, importance: slot.importance, sources: [], updatedAt: at, updatedBy: 'aura:baseline-parser' })
    edges.push({ from: 'objective', to: slot.id, relation: 'depends-on' })
  }
  // How the budget is used depends on how much of it may be lost.
  if (variables.some((v) => v.id === 'risk_tolerance') && variables.some((v) => v.id === 'budget')) {
    edges.push({ from: 'budget', to: 'risk_tolerance', relation: 'depends-on' })
  }

  for (const c of parsed.constraints) {
    const id = `constraint.${c.id}`
    variables.push({ id, label: c.label, kind: 'constraint', value: true, provenance: 'HUMAN_SPECIFIED', confidence: 1, importance: 0.8, sources: human(c.span.text), ...base })
    edges.push({ from: 'objective', to: id, relation: 'constrains' })
  }

  // Standing rules that apply to every objective.
  variables.push(
    { id: 'rule.kernel_authority', label: 'Every action passes the NQC Kernel', kind: 'constraint', value: true, provenance: 'SYSTEM_CONSTRAINT', confidence: 1, importance: 1, sources: [{ type: 'policy', ref: 'nqc-kernel' }], updatedAt: at, updatedBy: 'system' },
    { id: 'rule.waes_review', label: 'Customer-facing proposals need a passing WAES review', kind: 'constraint', value: true, provenance: 'SYSTEM_CONSTRAINT', confidence: 1, importance: 1, sources: [{ type: 'waes', ref: 'waes-core' }], updatedAt: at, updatedBy: 'system' },
  )
  edges.push({ from: 'objective', to: 'rule.kernel_authority', relation: 'constrains' }, { from: 'objective', to: 'rule.waes_review', relation: 'constrains' })

  const graph: IntentGraph = {
    id: options.id ?? `intent-${now.getTime().toString(36)}`,
    objective: objective.trim(),
    mode,
    autonomyDepth: options.autonomyDepth ?? parsed.autonomy?.value ?? 'propose',
    requestedBy: who,
    createdAt: at,
    variables,
    edges,
    history: [],
  }
  const impact = scoreImpact(graph)
  return { graph, parsed, impact, questions: impact.slice(0, 3).map((i) => i.question), issues: validateIntentGraph(graph), report: provenanceReport(graph) }
}
