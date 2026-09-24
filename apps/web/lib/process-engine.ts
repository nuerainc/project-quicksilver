/**
 * Process engine glue for the API routes.
 *
 * Behind a feature flag: QUICKSILVER_PROCESS_ENGINE=on. When it is off (the
 * default), every route keeps its original hard-coded status checks, so the
 * live demo is unaffected until the flag is turned on.
 *
 * When it is on, the routes load the "Decision Lifecycle" process definition
 * from Sanity and ask the kernel (packages/kernel/src/process.ts) to
 * authorize every status change. The definition is content: edit it in
 * Studio and the app's behavior follows, with the definition's version and
 * _rev stamped on every transition.
 *
 * Failure modes, on purpose:
 *   - Definition not in the dataset yet → routes fall back to legacy
 *     behavior (so turning the flag on before seeding breaks nothing).
 *   - Definition present but invalid → nothing moves. A broken playbook
 *     stops the line rather than being bypassed.
 */

import type { SanityClient } from '@sanity/client'
import {
  describeNextSteps,
  historyEntry,
  processFromSanity,
  validateProcessDefinition,
  type Facts,
  type ProcessActor,
  type ProcessDefinition,
  type SanityProcessDocument,
  type TransitionDecision,
} from '@quicksilver/kernel'

export const DECISION_LIFECYCLE_ID = 'workflow-decision-lifecycle'

export const KERNEL_ACTOR: ProcessActor = { id: 'quicksilver-kernel', entityType: 'system' }
export const EXECUTOR_ACTOR: ProcessActor = { id: 'quicksilver-executor', entityType: 'system' }

/** The trusted human supervisor identity resolved after server credential validation. */
export function uiOperator(supervisorId: string): ProcessActor {
  return { id: supervisorId, entityType: 'human' }
}

export function processEngineEnabled(): boolean {
  return (process.env.QUICKSILVER_PROCESS_ENGINE ?? '').trim().toLowerCase() === 'on'
}

export type LifecycleLoad =
  | { kind: 'off' }
  | { kind: 'missing' }
  | { kind: 'invalid'; definition: ProcessDefinition; errors: string[] }
  | { kind: 'ready'; definition: ProcessDefinition }

const LIFECYCLE_QUERY = `*[_type == "workflow" && _id == $id][0]{
  _id, _rev, name, version, initialState,
  states[]{ id, label, terminal },
  transitions[]{ id, from, to, label, automatic, requiresHumanApproval, guardAll, guardAny }
}`

export async function loadDecisionLifecycle(client: SanityClient): Promise<LifecycleLoad> {
  if (!processEngineEnabled()) return { kind: 'off' }
  const doc = await client.fetch<SanityProcessDocument | null>(LIFECYCLE_QUERY, { id: DECISION_LIFECYCLE_ID })
  if (!doc) {
    console.warn(`[process-engine] ${DECISION_LIFECYCLE_ID} not found in dataset; using legacy lifecycle. Run npm run seed:processes.`)
    return { kind: 'missing' }
  }
  const definition = processFromSanity(doc)
  const validation = validateProcessDefinition(definition)
  if (!validation.valid) return { kind: 'invalid', definition, errors: validation.errors }
  return { kind: 'ready', definition }
}

/** Facts the kernel already knows about a stored decision document. */
export interface StoredDecisionFacts {
  status?: string | null
  kind?: string | null
  riskLevel?: number | null
  requiredApproval?: boolean | null
  observedDeviation?: boolean | null
  kernelRecommendation?: string | null
  kernelAuthorized?: boolean | null
}

export function factsFromDecision(d: StoredDecisionFacts): Facts {
  return {
    'decision.kind': d.kind ?? 'plan',
    'decision.status': d.status ?? undefined,
    'kernel.riskLevel': d.riskLevel ?? undefined,
    'kernel.requiresApproval': d.requiredApproval ?? undefined,
    'observation.deviationDetected': d.observedDeviation ?? undefined,
    'kernel.recommendation': d.kernelRecommendation ?? undefined,
    'kernel.authorized': d.kernelAuthorized ?? undefined,
  }
}

/** The fields to write on a decision document for an allowed transition. */
export function transitionFields(
  definition: ProcessDefinition,
  decision: TransitionDecision,
  actor: ProcessActor,
  at: string,
) {
  const entry = historyEntry(definition, decision, actor, at)
  return {
    status: entry.to,
    process: {
      definition: { _type: 'reference' as const, _ref: definition.id },
      version: definition.version,
      ...(definition.revision ? { revision: definition.revision } : {}),
    },
    historyEntry: { _key: `${entry.transitionId}-${Date.parse(at).toString(36)}`, ...entry },
  }
}

/**
 * Apply an allowed transition to a decision document: set status + process
 * stamp and append to processHistory. `ifRevisionId` makes it optimistic --
 * if the document changed since it was read (a double click, two tabs), the
 * write fails instead of applying a transition from a stale state.
 */
export async function commitTransition(
  client: SanityClient,
  docId: string,
  rev: string,
  definition: ProcessDefinition,
  decision: TransitionDecision,
  actor: ProcessActor,
  at: string,
  extra: Record<string, unknown> = {},
) {
  const f = transitionFields(definition, decision, actor, at)
  return client
    .patch(docId)
    .ifRevisionId(rev)
    .set({ status: f.status, process: f.process, ...extra })
    .setIfMissing({ processHistory: [] })
    .append('processHistory', [f.historyEntry])
    .commit()
}

/** Is this a Sanity revision-mismatch error (someone else moved the document first)? */
export function isRevisionConflict(err: unknown): boolean {
  const e = err as { statusCode?: number; message?: string }
  return e?.statusCode === 409 || /revision/i.test(e?.message ?? '')
}

/** What the UI shows: where the decision is in its process and what can happen next. */
export function processView(definition: ProcessDefinition, state: string, facts: Facts, transitionId?: string) {
  return {
    engine: 'on' as const,
    definitionId: definition.id,
    definitionName: definition.name,
    version: definition.version,
    revision: definition.revision ?? null,
    transitionId: transitionId ?? null,
    ...describeNextSteps(definition, state, facts),
  }
}

export type ProcessView = ReturnType<typeof processView>

/** A process status for responses when the engine did not run. */
export function processStatus(load: LifecycleLoad) {
  if (load.kind === 'off') return { engine: 'off' as const }
  if (load.kind === 'missing') return { engine: 'missing' as const }
  if (load.kind === 'invalid') {
    return {
      engine: 'invalid' as const,
      definitionName: load.definition.name,
      version: load.definition.version,
      errors: load.errors,
    }
  }
  return null
}

/** 409 body for a refused transition, with the kernel's reasons. */
export function refusal(decision: TransitionDecision, definition: ProcessDefinition) {
  return {
    error: `The ${definition.name} process (v${definition.version}) does not allow this: ${decision.reasons.join(' ')}`,
    process: { engine: 'on' as const, from: decision.from, to: decision.to, reasons: decision.reasons },
  }
}

export function invalidDefinitionBody(load: Extract<LifecycleLoad, { kind: 'invalid' }>) {
  return {
    error: `Process definition "${load.definition.name}" is invalid, so the kernel will not move any decision until it is fixed in Studio: ${load.errors.join(' ')}`,
    process: processStatus(load),
  }
}
