import { createHash } from 'node:crypto'

import type { AccessController, Principal } from '../identity/rbac.ts'
import {
  authorizeTransition,
  nextAutomaticTransition,
  validateProcessDefinition,
  type Facts,
  type FactValue,
  type ProcessActor,
  type ProcessDefinition,
  type TransitionDecision,
} from '../process.ts'
import { validateWorkflowGraph, type WorkflowGraph } from '../workflows/graph.ts'
import type { WorkflowExecutionResult } from '../workflows/runtime.ts'

/**
 * Playbooks (Layer 3, M4): business processes as content.
 *
 * A playbook combines the two process formats the kernel already runs:
 *   - a process definition holds the business stages (it can loop, and it
 *     holds the human-only transitions);
 *   - each working stage runs a workflow graph (an acyclic set of agent and
 *     tool steps) whose result supplies facts that guard the next transition.
 * Both are data only, so a playbook can never add executable logic.
 *
 * Rules enforced here:
 *   - Every agent and tool step names the capability it uses.
 *   - Metrics carry kill / hold / scale thresholds fixed before a run starts,
 *     and ordered for the metric's direction.
 *   - Publishing needs a human with `workflow:publish` who is not the author
 *     (separation of duties), and pins the playbook's content digest.
 *   - A run is pinned to the digest it started with; a changed playbook is a
 *     new version, never a silent edit.
 *   - Every stage transition still goes through the kernel's transition rules;
 *     every step's proposal still goes through the kernel.
 */

export const PLAYBOOK_MODES = ['genesis', 'onboard', 'operate'] as const
export type PlaybookMode = (typeof PLAYBOOK_MODES)[number]

export interface PlaybookMetric {
  id: string
  label: string
  unit?: string
  /** Which way is good. */
  direction: 'higher-is-better' | 'lower-is-better'
  /** Thresholds fixed before the run. For higher-is-better: kill < hold ≤ scale. */
  kill: number
  hold: number
  scale: number
}

export type PlaybookTrigger =
  | { kind: 'manual' }
  | { kind: 'schedule'; cron: string }
  | { kind: 'event'; event: string }

export interface PlaybookDefinition {
  schemaVersion: 1
  id: string
  version: number
  name: string
  description?: string
  modes: PlaybookMode[]
  trigger: PlaybookTrigger
  /** Aura graph variables that must be known before the playbook starts. */
  requiredVariables: string[]
  process: ProcessDefinition
  /** The workflow graph each working stage runs, by process state id. */
  stageGraphs: Record<string, WorkflowGraph>
  /** Capability for every agent and tool step: key `<stageId>/<nodeId>`. */
  stepCapabilities: Record<string, string>
  budget: { amountUsd: number; includesCompute: boolean }
  metrics: PlaybookMetric[]
  outputs: string[]
  /** Kernel principal or entity accountable for the playbook. */
  owner: string
}

export interface PlaybookValidation {
  valid: boolean
  errors: string[]
}

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/

export function validatePlaybook(def: PlaybookDefinition): PlaybookValidation {
  const errors: string[] = []
  if (!def || typeof def !== 'object') return { valid: false, errors: ['Playbook must be an object.'] }
  if (def.schemaVersion !== 1) errors.push('schemaVersion must be 1.')
  if (!ID.test(def.id ?? '')) errors.push('id is invalid.')
  if (!Number.isInteger(def.version) || def.version < 1) errors.push('version must be a positive integer.')
  if (!def.name?.trim()) errors.push('name is required.')
  if (!Array.isArray(def.modes) || !def.modes.length || def.modes.some((m) => !PLAYBOOK_MODES.includes(m))) errors.push(`modes must list one or more of ${PLAYBOOK_MODES.join(', ')}.`)
  if (!def.owner?.trim()) errors.push('owner is required.')
  if (!def.budget || !(def.budget.amountUsd >= 0)) errors.push('budget.amountUsd must be zero or more.')
  if (def.trigger?.kind === 'schedule' && !/^\S+( \S+){4}$/.test(def.trigger.cron ?? '')) errors.push('A schedule trigger needs a five-field cron expression.')
  if (!['manual', 'schedule', 'event'].includes(def.trigger?.kind as string)) errors.push('trigger.kind must be manual, schedule or event.')

  const process = validateProcessDefinition(def.process)
  if (!process.valid) errors.push(...process.errors.map((e) => `process: ${e}`))
  const states = new Map((def.process?.states ?? []).map((s) => [s.id, s]))

  for (const [stageId, graph] of Object.entries(def.stageGraphs ?? {})) {
    if (!states.has(stageId)) errors.push(`stageGraphs.${stageId}: no such process state.`)
    else if (states.get(stageId)!.terminal) errors.push(`stageGraphs.${stageId}: a terminal state does no work.`)
    const v = validateWorkflowGraph(graph)
    if (!v.valid) errors.push(...v.errors.map((e) => `stageGraphs.${stageId}: ${e}`))
    for (const node of graph.nodes ?? []) {
      if ((node.kind === 'agent' || node.kind === 'tool') && !def.stepCapabilities?.[`${stageId}/${node.id}`]) {
        errors.push(`stageGraphs.${stageId}: step "${node.id}" does not name its capability in stepCapabilities.`)
      }
    }
  }
  for (const key of Object.keys(def.stepCapabilities ?? {})) {
    const [stageId, nodeId] = key.split('/')
    if (!def.stageGraphs?.[stageId!]?.nodes.some((n) => n.id === nodeId)) errors.push(`stepCapabilities.${key}: no such step.`)
  }

  const metricIds = new Set<string>()
  for (const m of def.metrics ?? []) {
    if (!ID.test(m.id ?? '') || metricIds.has(m.id)) errors.push(`metric "${m.id}": id missing, invalid or repeated.`)
    metricIds.add(m.id)
    if (![m.kill, m.hold, m.scale].every(Number.isFinite)) errors.push(`metric "${m.id}": kill, hold and scale must be numbers.`)
    else if (m.direction === 'higher-is-better' ? !(m.kill < m.hold && m.hold <= m.scale) : !(m.kill > m.hold && m.hold >= m.scale)) {
      errors.push(`metric "${m.id}": thresholds are out of order for ${m.direction} (kill ${m.kill}, hold ${m.hold}, scale ${m.scale}).`)
    }
  }
  return { valid: errors.length === 0, errors }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const o = value as Record<string, unknown>
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
}

export function playbookDigest(def: PlaybookDefinition): string {
  return createHash('sha256').update(canonical(def)).digest('hex')
}

// ---------------------------------------------------------------------------
// Publishing

export interface PlaybookRecord {
  definition: PlaybookDefinition
  digest: string
  status: 'draft' | 'published' | 'retired'
  authoredBy: string
  publishedBy?: string
  publishedAt?: string
}

export function draftPlaybook(definition: PlaybookDefinition, author: string): PlaybookRecord {
  return { definition, digest: playbookDigest(definition), status: 'draft', authoredBy: author }
}

export type PublishResult = { ok: true; record: PlaybookRecord } | { ok: false; reasons: string[] }

export function publishPlaybook(record: PlaybookRecord, publisher: Principal, access: AccessController, now = new Date()): PublishResult {
  const reasons: string[] = []
  if (record.status !== 'draft') reasons.push(`Only a draft can be published (this one is ${record.status}).`)
  if (playbookDigest(record.definition) !== record.digest) reasons.push('The playbook changed after it was drafted; draft it again.')
  const v = validatePlaybook(record.definition)
  if (!v.valid) reasons.push(...v.errors)
  if (publisher.kind !== 'human') reasons.push('Only a human can publish a playbook.')
  const decision = access.authorize(publisher, 'workflow:publish', { tenantId: publisher.tenantId, requestedBy: record.authoredBy, kind: 'playbook', id: record.definition.id })
  if (!decision.allowed) reasons.push(...decision.reasons)
  if (reasons.length) return { ok: false, reasons: [...new Set(reasons)] }
  return { ok: true, record: { ...record, status: 'published', publishedBy: publisher.id, publishedAt: now.toISOString() } }
}

// ---------------------------------------------------------------------------
// Metrics and runs

export type MetricVerdict = 'kill' | 'hold' | 'continue' | 'scale'

/** Compare a measured value with the thresholds fixed before the run. */
export function judgeMetric(metric: PlaybookMetric, value: number): MetricVerdict {
  const better = (a: number, b: number) => (metric.direction === 'higher-is-better' ? a >= b : a <= b)
  if (better(value, metric.scale)) return 'scale'
  if (!better(value, metric.kill) || value === metric.kill) return 'kill'
  if (better(value, metric.hold)) return 'continue'
  return 'hold'
}

export interface PlaybookRun {
  runId: string
  playbookId: string
  version: number
  /** The digest the run started with; the run refuses any other content. */
  digest: string
  stage: string
  facts: Facts
  history: Array<{ at: string; from: string; to: string; transitionId: string; actorId: string; actorType: string }>
}

export function startPlaybookRun(record: PlaybookRecord, runId: string, knownVariables: string[]): { ok: true; run: PlaybookRun } | { ok: false; reasons: string[] } {
  if (record.status !== 'published') return { ok: false, reasons: ['Only a published playbook can run.'] }
  const missing = record.definition.requiredVariables.filter((v) => !knownVariables.includes(v))
  if (missing.length) return { ok: false, reasons: [`Required graph variables are not yet known: ${missing.join(', ')}. Ask the provider first.`] }
  return { ok: true, run: { runId, playbookId: record.definition.id, version: record.definition.version, digest: record.digest, stage: record.definition.process.initialState, facts: {}, history: [] } }
}

/** Flatten a stage graph's result into facts: `stage.status`, and `stage.<nodeId>.<key>` for primitive outputs. */
export function stageResultFacts(result: WorkflowExecutionResult): Facts {
  const facts: Facts = { 'stage.status': result.status }
  for (const [nodeId, out] of Object.entries(result.outputs)) {
    if (out === null || ['string', 'number', 'boolean'].includes(typeof out)) facts[`stage.${nodeId}`] = out as FactValue
    else if (typeof out === 'object' && !Array.isArray(out)) {
      for (const [k, v] of Object.entries(out as Record<string, unknown>)) {
        if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) facts[`stage.${nodeId}.${k}`] = v as FactValue
      }
    }
  }
  return facts
}

export type AdvanceResult =
  | { moved: true; run: PlaybookRun; decision: TransitionDecision }
  | { moved: false; run: PlaybookRun; reason: string }

/**
 * Advance a run with new facts. With no actor, only an automatic transition
 * whose guard holds is taken. With an actor and a transition id, the kernel's
 * transition rules decide (human-only transitions need a human).
 */
export function advancePlaybookRun(
  record: PlaybookRecord,
  run: PlaybookRun,
  facts: Facts,
  options: { actor?: ProcessActor; transitionId?: string; now?: Date } = {},
): AdvanceResult {
  if (record.digest !== run.digest || playbookDigest(record.definition) !== run.digest) return { moved: false, run, reason: 'The playbook content differs from the version this run started with.' }
  const merged: Facts = { ...run.facts, ...facts }
  const at = (options.now ?? new Date()).toISOString()
  let decision: TransitionDecision | null
  if (options.transitionId) {
    if (!options.actor) return { moved: false, run: { ...run, facts: merged }, reason: 'A named transition needs an actor.' }
    decision = authorizeTransition({ definition: record.definition.process, currentState: run.stage, transitionId: options.transitionId, actor: options.actor, facts: merged })
  } else {
    decision = nextAutomaticTransition(record.definition.process, run.stage, merged)
  }
  if (!decision) return { moved: false, run: { ...run, facts: merged }, reason: 'No automatic transition applies yet.' }
  if (!decision.allowed) return { moved: false, run: { ...run, facts: merged }, reason: decision.reasons.join(' ') }
  const actorId = options.actor?.id ?? 'kernel'
  const actorType = options.actor?.entityType ?? 'system'
  return {
    moved: true,
    decision,
    run: { ...run, stage: decision.to!, facts: merged, history: [...run.history, { at, from: run.stage, to: decision.to!, transitionId: decision.transition!.id, actorId, actorType }] },
  }
}
