import { governMemoryWrite } from '@quicksilver/kernel/nqc/memory'

import { validateVariable, type GraphIssue } from './provenance.ts'
import type { BeliefChange, GraphVariable, IntentGraph, Provenance, VariableKind, VariableSource } from './types.ts'

/**
 * Governed belief updates.
 *
 * Aura has no authority, and its beliefs change only under these rules:
 *   - Agents and services may add or revise AGENT_INFERRED values, and may
 *     record OBSERVED values backed by evidence or an observation.
 *   - Agents can never overwrite what a human stated (HUMAN_SPECIFIED) or what
 *     a policy or WAES sets (SYSTEM_CONSTRAINT). An inference never replaces an
 *     observation; only a newer observation can.
 *   - Only a human can state or change a HUMAN_SPECIFIED value.
 *   - SYSTEM_CONSTRAINT values are not changed here at all: they follow the
 *     policy or WAES criterion, which changes through the kernel's governed path.
 *   - Every accepted update also passes the NQC memory governor, which refuses
 *     credentials and personal or payment data before anything is stored.
 * Updates are pure: the input graph is never mutated.
 */

export interface BeliefActor {
  id: string
  kind: 'human' | 'agent' | 'service'
}

export interface BeliefUpdate {
  variableId: string
  value: string | number | boolean
  provenance: Exclude<Provenance, 'SYSTEM_CONSTRAINT'>
  confidence: number
  sources: VariableSource[]
  explanation?: string
  /** Kind when filling an open unknown (default "assumption" for inferences, "goal"/"constraint" stay as-is). */
  kind?: Exclude<VariableKind, 'unknown'>
}

export type BeliefResult =
  | { accepted: true; graph: IntentGraph; change: BeliefChange }
  | { accepted: false; reasons: string[]; issues?: GraphIssue[] }

export function applyBeliefUpdate(graph: IntentGraph, actor: BeliefActor, update: BeliefUpdate, now = new Date()): BeliefResult {
  const reasons: string[] = []
  const current = graph.variables.find((v) => v.id === update.variableId)
  if (!current) return { accepted: false, reasons: [`Variable "${update.variableId}" does not exist.`] }
  if (!actor?.id?.trim()) return { accepted: false, reasons: ['A named actor is required.'] }

  const provenance = update.provenance as Provenance
  if (provenance === 'SYSTEM_CONSTRAINT') reasons.push('System constraints follow their policy or WAES criterion and are not changed here.')
  if (current.provenance === 'SYSTEM_CONSTRAINT') reasons.push(`"${current.label}" is set by policy or WAES; change the policy through the kernel instead.`)

  if (actor.kind === 'human') {
    if (provenance !== 'HUMAN_SPECIFIED' && current.provenance === 'HUMAN_SPECIFIED') {
      reasons.push('A stated value is replaced only by another statement; record the new value as HUMAN_SPECIFIED.')
    }
  } else {
    if (provenance === 'HUMAN_SPECIFIED') reasons.push('Only a human can state a value.')
    if (current.provenance === 'HUMAN_SPECIFIED') reasons.push(`"${current.label}" was stated by a human; an agent cannot overwrite it. Ask a targeted question instead.`)
    if (current.provenance === 'OBSERVED' && current.kind !== 'unknown' && provenance === 'AGENT_INFERRED') {
      reasons.push('An inference cannot replace an observation; only a newer observation can.')
    }
  }
  if (reasons.length) return { accepted: false, reasons }

  const at = now.toISOString()
  const kind: VariableKind = current.kind === 'unknown' ? (update.kind ?? (provenance === 'AGENT_INFERRED' ? 'assumption' : 'goal')) : current.kind
  const next: GraphVariable = {
    ...current,
    kind,
    value: update.value,
    provenance,
    confidence: update.confidence,
    sources: update.sources,
    ...(update.explanation !== undefined ? { explanation: update.explanation } : {}),
    updatedAt: at,
    updatedBy: actor.id,
  }
  if (provenance !== 'AGENT_INFERRED' && update.explanation === undefined) delete next.explanation
  const issues = validateVariable(next)
  if (issues.length) return { accepted: false, reasons: issues.map((i) => i.message), issues }

  const memory = governMemoryWrite({
    id: `belief:${graph.id}:${next.id}:${now.getTime()}`,
    kind: 'domain-pattern',
    domain: `intent:${graph.id}`,
    content: `${next.label} = ${String(next.value)}${next.unit ? ` ${next.unit}` : ''} (${next.provenance}, confidence ${next.confidence})${next.explanation ? `. ${next.explanation}` : ''}`,
    source: actor.id,
    confidence: next.confidence,
    retentionDays: 365,
  })
  if (!memory.allowed) return { accepted: false, reasons: memory.reasons.map((r) => `Memory governor: ${r}`) }

  const change: BeliefChange = {
    at,
    variableId: next.id,
    actor: actor.id,
    ...(current.value !== undefined ? { from: current.value } : {}),
    to: next.value,
    provenance: next.provenance,
    confidence: next.confidence,
    reason: next.explanation ?? `${actor.kind} update`,
  }
  return {
    accepted: true,
    change,
    graph: {
      ...graph,
      variables: graph.variables.map((v) => (v.id === next.id ? next : v)),
      history: [...graph.history, change],
    },
  }
}
