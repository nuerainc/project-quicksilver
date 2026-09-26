import {
  AUTONOMY_DEPTHS,
  OPERATING_MODES,
  PROVENANCES,
  VARIABLE_KINDS,
  type GraphVariable,
  type IntentGraph,
  type Provenance,
  type SourceType,
} from './types.ts'

/**
 * Provenance rules. A graph that breaks any of them is refused, so the
 * charter's "100% provenance tagging" and "0 unsupported inferences" are
 * enforced by construction, not measured after the fact.
 *
 *   HUMAN_SPECIFIED   needs a human source (and a quote when it came from text); confidence 1
 *   SYSTEM_CONSTRAINT needs a policy or WAES source; confidence 1
 *   OBSERVED          needs an evidence or observation source
 *   AGENT_INFERRED    needs an explanation and at least one supporting source
 *                     (a human quote, evidence, observation, or policy), never
 *                     only another agent's say-so
 */

const ALLOWED_SOURCES: Record<Provenance, readonly SourceType[]> = {
  HUMAN_SPECIFIED: ['human'],
  SYSTEM_CONSTRAINT: ['policy', 'waes'],
  OBSERVED: ['evidence', 'observation'],
  AGENT_INFERRED: ['human', 'evidence', 'observation', 'policy', 'waes', 'agent'],
}

const ID = /^[a-z][a-z0-9_.-]{0,63}$/

export interface GraphIssue {
  variableId?: string
  rule: string
  message: string
}

export function validateVariable(v: GraphVariable): GraphIssue[] {
  const issues: GraphIssue[] = []
  const add = (rule: string, message: string) => issues.push({ variableId: v?.id, rule, message })
  if (!v || typeof v !== 'object') return [{ rule: 'shape', message: 'Variable must be an object.' }]
  if (typeof v.id !== 'string' || !ID.test(v.id)) add('id', 'Variable id must be lowercase letters, digits, "_", "." or "-".')
  if (!VARIABLE_KINDS.includes(v.kind)) add('kind', `Unknown kind "${String(v.kind)}".`)
  if (!PROVENANCES.includes(v.provenance)) {
    add('provenance', 'Every variable needs a provenance tag.')
    return issues
  }
  if (!(v.confidence >= 0 && v.confidence <= 1)) add('confidence', 'Confidence must be 0–1.')
  if (!(v.importance >= 0 && v.importance <= 1)) add('importance', 'Importance must be 0–1.')
  if (!Array.isArray(v.sources)) add('sources', 'Sources must be a list.')
  const sources = Array.isArray(v.sources) ? v.sources : []
  const hasValue = v.value !== undefined

  if (v.kind === 'unknown' && hasValue) add('unknown', 'An open unknown has no value yet; give it another kind once answered.')
  if (v.kind !== 'unknown' && !hasValue) add('value', 'Only open unknowns may be missing a value.')
  if (!hasValue) return issues

  const allowed = ALLOWED_SOURCES[v.provenance]
  const bad = sources.filter((s) => !allowed.includes(s.type))
  if (bad.length) add('source-type', `${v.provenance} cannot rest on ${bad.map((s) => s.type).join(', ')} sources.`)

  switch (v.provenance) {
    case 'HUMAN_SPECIFIED':
      if (!sources.some((s) => s.type === 'human')) add('human-source', 'A human-specified value needs the human who stated it.')
      if (v.confidence !== 1) add('confidence', 'Human-specified values have confidence 1.')
      break
    case 'SYSTEM_CONSTRAINT':
      if (!sources.some((s) => s.type === 'policy' || s.type === 'waes')) add('constraint-source', 'A system constraint needs the policy or WAES criterion that sets it.')
      if (v.confidence !== 1) add('confidence', 'System constraints have confidence 1.')
      break
    case 'OBSERVED':
      if (!sources.some((s) => s.type === 'evidence' || s.type === 'observation')) add('observation-source', 'An observed value needs the evidence or observation it came from.')
      break
    case 'AGENT_INFERRED':
      if (!v.explanation || v.explanation.trim().length < 10) add('explanation', 'Every inferred value needs an explanation.')
      if (!sources.some((s) => s.type !== 'agent')) add('unsupported-inference', 'An inference needs at least one non-agent source (a human quote, evidence, observation or policy).')
      if (v.confidence >= 1) add('confidence', 'An inference cannot be certain; confidence must be below 1.')
      break
  }
  for (const s of sources) if (s.type === 'human' && s.quote !== undefined && !s.quote.trim()) add('quote', 'An empty quote supports nothing.')
  return issues
}

/** Validate a whole graph: every variable, unique ids, edges that resolve, and no dependency cycles. */
export function validateIntentGraph(graph: IntentGraph): GraphIssue[] {
  const issues: GraphIssue[] = []
  if (!graph || typeof graph !== 'object') return [{ rule: 'shape', message: 'Graph must be an object.' }]
  if (typeof graph.objective !== 'string' || !graph.objective.trim()) issues.push({ rule: 'objective', message: 'An objective is required.' })
  if (graph.mode !== null && !OPERATING_MODES.includes(graph.mode)) issues.push({ rule: 'mode', message: `Unknown mode "${String(graph.mode)}".` })
  if (!AUTONOMY_DEPTHS.includes(graph.autonomyDepth)) issues.push({ rule: 'autonomy', message: `Unknown autonomy depth "${String(graph.autonomyDepth)}".` })

  const ids = new Set<string>()
  for (const v of graph.variables ?? []) {
    if (ids.has(v.id)) issues.push({ variableId: v.id, rule: 'duplicate', message: `Variable "${v.id}" appears twice.` })
    ids.add(v.id)
    issues.push(...validateVariable(v))
  }
  for (const e of graph.edges ?? []) {
    if (!ids.has(e.from) || !ids.has(e.to)) issues.push({ rule: 'edge', message: `Edge ${e.from} → ${e.to} references a missing variable.` })
    if (e.from === e.to) issues.push({ rule: 'edge', message: `Variable "${e.from}" cannot depend on itself.` })
  }
  if (hasCycle(graph)) issues.push({ rule: 'cycle', message: 'The decision graph has a dependency cycle.' })
  return issues
}

function hasCycle(graph: IntentGraph): boolean {
  const out = new Map<string, string[]>()
  for (const e of graph.edges ?? []) out.set(e.from, [...(out.get(e.from) ?? []), e.to])
  const state = new Map<string, 1 | 2>()
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return true
    if (state.get(id) === 2) return false
    state.set(id, 1)
    for (const next of out.get(id) ?? []) if (visit(next)) return true
    state.set(id, 2)
    return false
  }
  return [...out.keys()].some((id) => visit(id))
}

/** The charter's provenance success measures, computed for one graph. */
export function provenanceReport(graph: IntentGraph) {
  const valued = graph.variables.filter((v) => v.value !== undefined)
  const tagged = graph.variables.filter((v) => PROVENANCES.includes(v.provenance))
  const inferred = valued.filter((v) => v.provenance === 'AGENT_INFERRED')
  const issues = validateIntentGraph(graph)
  return {
    variables: graph.variables.length,
    provenanceCoverage: graph.variables.length ? tagged.length / graph.variables.length : 1,
    inferred: inferred.length,
    explainedInferences: inferred.filter((v) => (v.explanation ?? '').trim().length >= 10).length,
    unsupportedInferences: issues.filter((i) => i.rule === 'unsupported-inference').length,
    openUnknowns: graph.variables.filter((v) => v.kind === 'unknown').length,
    valid: issues.length === 0,
  }
}
