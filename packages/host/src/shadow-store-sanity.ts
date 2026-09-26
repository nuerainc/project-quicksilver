import type { LearnerState } from '@quicksilver/aura'
import type { ShadowLog, ShadowRecommendation } from '@quicksilver/kernel/playbooks/shadow'

import { assertAllowedSanityProject, idSegment, isSanityConflict, type SanityMutation, type SanityStoreClient } from './sanity-client.ts'
import { ShadowRecordConflictError, type ShadowStore } from './shadow-api.ts'

/**
 * Shadow mode (M4) records in the company's Content Lake.
 *
 *   shadowRecommendation  one per recommendation,
 *                         id "shadow-recommendation.<intentId>.<recId>"
 *   auraVerdictLearner    one per intent, id "aura-verdict-learner.<intentId>",
 *                         provenance AGENT_INFERRED (Aura's inference, never authority)
 *
 * Ids contain a dot, which keeps them out of unauthenticated reads.
 *
 * A recommendation is append-only. Its verdict and its outcome are each set
 * once; after that the store refuses any change. Every save is one
 * transaction: new recommendations use `create` (fails if the id is taken)
 * and every change to an existing document carries ifRevisionID, so a second
 * writer racing the first gets a conflict instead of overwriting it.
 */

const INTENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/

type Stamp = { value: string; by: string; at: string; note?: string }

export interface SanityShadowRecommendationDocument {
  _id: string
  _type: 'shadowRecommendation'
  _rev?: string
  intentId: string
  recId: string
  /** Position in the shadow log (1-based). */
  seq: number
  department: string
  description: string
  proposedAt: string
  source?: 'human' | 'agent'
  kernelRecommendation: ShadowRecommendation['kernel']['recommendation']
  kernelRiskLevel: number
  executed: false
  featuresJson?: string
  prediction?: { accept: number; observations: number; model: string }
  verdict?: Stamp
  outcome?: Stamp
}

export interface SanityAuraVerdictLearnerDocument {
  _id: string
  _type: 'auraVerdictLearner'
  _rev?: string
  intentId: string
  provenance: 'AGENT_INFERRED'
  observations: number
  weightsJson: string
  /** The full learner state, exactly as Aura uses it. */
  stateJson: string
}

function checkIntentId(intentId: string): void {
  if (!INTENT_ID.test(intentId)) throw new Error('Invalid intent id.')
}

export const shadowRecommendationId = (intentId: string, recId: string) => {
  checkIntentId(intentId)
  return `shadow-recommendation.${intentId}.${idSegment(recId)}`
}
export const auraVerdictLearnerId = (intentId: string) => {
  checkIntentId(intentId)
  return `aura-verdict-learner.${intentId}`
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const o = value as Record<string, unknown>
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
}

export function toShadowRecommendationDocument(intentId: string, rec: ShadowRecommendation, seq: number): SanityShadowRecommendationDocument {
  return {
    _id: shadowRecommendationId(intentId, rec.id),
    _type: 'shadowRecommendation',
    intentId,
    recId: rec.id,
    seq,
    department: rec.department,
    description: rec.description,
    proposedAt: rec.proposedAt,
    ...(rec.source ? { source: rec.source } : {}),
    kernelRecommendation: rec.kernel.recommendation,
    kernelRiskLevel: rec.kernel.riskLevel,
    executed: false,
    ...(rec.features ? { featuresJson: JSON.stringify(rec.features) } : {}),
    ...(rec.prediction ? { prediction: { ...rec.prediction } } : {}),
    ...(rec.verdict ? { verdict: { ...rec.verdict } } : {}),
    ...(rec.outcome ? { outcome: { ...rec.outcome } } : {}),
  }
}

export function fromShadowRecommendationDocument(doc: SanityShadowRecommendationDocument): ShadowRecommendation {
  const stamp = <T>(s: Stamp) => ({ value: s.value as T, by: s.by, at: s.at, ...(s.note ? { note: s.note } : {}) })
  return {
    id: doc.recId,
    department: doc.department,
    description: doc.description,
    proposedAt: doc.proposedAt,
    kernel: { recommendation: doc.kernelRecommendation, riskLevel: doc.kernelRiskLevel },
    executed: false,
    ...(doc.source ? { source: doc.source } : {}),
    ...(doc.featuresJson !== undefined ? { features: JSON.parse(doc.featuresJson) as Record<string, number> } : {}),
    ...(doc.prediction ? { prediction: { accept: doc.prediction.accept, observations: doc.prediction.observations, model: doc.prediction.model } } : {}),
    ...(doc.verdict ? { verdict: stamp<NonNullable<ShadowRecommendation['verdict']>['value']>(doc.verdict) } : {}),
    ...(doc.outcome ? { outcome: stamp<NonNullable<ShadowRecommendation['outcome']>['value']>(doc.outcome) } : {}),
  }
}

export function toAuraVerdictLearnerDocument(intentId: string, learner: LearnerState): SanityAuraVerdictLearnerDocument {
  return {
    _id: auraVerdictLearnerId(intentId),
    _type: 'auraVerdictLearner',
    intentId,
    provenance: 'AGENT_INFERRED',
    observations: learner.observations,
    weightsJson: JSON.stringify(learner.weights),
    stateJson: JSON.stringify(learner),
  }
}

/** The recommendation without the two once-only fields. */
const body = (rec: ShadowRecommendation) => {
  const { verdict, outcome, ...rest } = rec
  void verdict
  void outcome
  return canonical(rest)
}

export class SanityShadowStore implements ShadowStore {
  private readonly client: SanityStoreClient
  constructor(client: SanityStoreClient) {
    assertAllowedSanityProject(client.projectId)
    this.client = client
  }

  private async fetchRecommendations(intentId: string): Promise<SanityShadowRecommendationDocument[]> {
    checkIntentId(intentId)
    const docs = await this.client.fetch<SanityShadowRecommendationDocument[]>(
      '*[_type == $type && intentId == $intentId && !(_id in path("drafts.**"))] | order(seq asc)',
      { type: 'shadowRecommendation', intentId },
    )
    return [...docs].sort((a, b) => a.seq - b.seq)
  }

  async load(intentId: string): Promise<{ log: ShadowLog; learner: LearnerState | null }> {
    const docs = await this.fetchRecommendations(intentId)
    const learnerDoc = await this.client.getDocument<SanityAuraVerdictLearnerDocument>(auraVerdictLearnerId(intentId))
    return {
      log: { recommendations: docs.map(fromShadowRecommendationDocument) },
      learner: learnerDoc ? (JSON.parse(learnerDoc.stateJson) as LearnerState) : null,
    }
  }

  async save(intentId: string, log: ShadowLog, learner: LearnerState | null): Promise<void> {
    const stored = new Map((await this.fetchRecommendations(intentId)).map((d) => [d.recId, d]))
    const inLog = new Set(log.recommendations.map((r) => r.id))
    for (const id of stored.keys()) {
      if (!inLog.has(id)) throw new ShadowRecordConflictError(`Recommendation "${id}" is stored but missing from this save; another writer added it, or it was dropped. Reload and try again.`)
    }
    const mutations: SanityMutation[] = []
    log.recommendations.forEach((rec, i) => {
      const doc = stored.get(rec.id)
      if (!doc) {
        mutations.push({ create: { ...toShadowRecommendationDocument(intentId, rec, i + 1) } })
        return
      }
      const before = fromShadowRecommendationDocument(doc)
      if (body(before) !== body(rec)) throw new ShadowRecordConflictError(`Recommendation "${rec.id}" was already recorded; recommendations are append-only.`)
      const set: Record<string, unknown> = {}
      for (const field of ['verdict', 'outcome'] as const) {
        const was = before[field]
        const now = rec[field]
        if (was) {
          if (!now || canonical(was) !== canonical(now)) throw new ShadowRecordConflictError(`The ${field} of "${rec.id}" was already recorded; it is not rewritten.`)
        } else if (now) {
          set[field] = { ...now }
        }
      }
      if (Object.keys(set).length) mutations.push({ patch: { id: doc._id, ...(doc._rev ? { ifRevisionID: doc._rev } : {}), set } })
    })
    if (learner) {
      const next = toAuraVerdictLearnerDocument(intentId, learner)
      const current = await this.client.getDocument<SanityAuraVerdictLearnerDocument>(next._id)
      if (!current) mutations.push({ create: { ...next } })
      else if (current.stateJson !== next.stateJson) {
        mutations.push({ patch: { id: next._id, ...(current._rev ? { ifRevisionID: current._rev } : {}), set: { observations: next.observations, weightsJson: next.weightsJson, stateJson: next.stateJson } } })
      }
    }
    if (!mutations.length) return
    try {
      await this.client.mutate(mutations)
    } catch (error) {
      if (isSanityConflict(error)) throw new ShadowRecordConflictError('Another writer changed this shadow log first. Reload and try again.')
      throw error
    }
  }
}
