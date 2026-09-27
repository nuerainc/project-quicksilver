import { randomUUID } from 'node:crypto'
import { buildEvaluationRecord, type EvaluationRecordInput } from '@quicksilver/kernel'
import { getSanityClient } from '@/lib/sanity-client'

export interface PersistResult {
  persisted: boolean
  ids: string[]
  error?: string
}

type Pending = Omit<EvaluationRecordInput, 'id' | 'now'>

/**
 * Persist Quicksilver Engine evaluations as `evaluationRecord` documents.
 *
 * Read-only query answers are still returned if the audit write fails, but
 * the response says so (`audit.persisted: false`) and the failure is logged,
 * so a gap in the audit trail is never silent.
 */
export async function persistEvaluations(records: Pending[]): Promise<PersistResult> {
  if (records.length === 0) return { persisted: true, ids: [] }
  const now = new Date().toISOString()
  const docs = records.map((r) =>
    buildEvaluationRecord({ ...r, id: `evaluation-${r.source}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`, now }),
  )
  try {
    // Evaluation records are writes: SANITY_WRITE_TOKEN (A-7).
    const client = getSanityClient('write')
    const tx = client.transaction()
    for (const doc of docs) tx.create(doc)
    await tx.commit()
    return { persisted: true, ids: docs.map((d) => d._id) }
  } catch (err) {
    const error = (err as Error).message
    console.error('[evaluation-store] audit write failed', error)
    return { persisted: false, ids: [], error: 'The evaluation could not be saved to the audit store.' }
  }
}
