import { randomUUID } from 'node:crypto'
import { buildEvaluationRecord, type EvaluationRecordInput } from '@quicksilver/kernel'
import { getSanityClient } from '@/lib/sanity-client'
import { safeErrorName } from './safe-log.ts'

export interface PersistResult {
  persisted: boolean
  ids: string[]
  error?: string
}

export type PendingEvaluation = Omit<EvaluationRecordInput, 'id' | 'now'>
type EvaluationWriter = (documents: ReturnType<typeof buildEvaluationRecord>[]) => Promise<void>

/**
 * Persist Quicksilver Engine evaluations as `evaluationRecord` documents.
 *
 * Read-only query answers are still returned if the audit write fails, but
 * the response says so (`audit.persisted: false`) and the failure is logged,
 * so a gap in the audit trail is never silent.
 */
export async function persistEvaluationRecords(
  records: PendingEvaluation[],
  writer: EvaluationWriter,
  warn: (message: string, error: unknown) => void = (message, error) => console.error(message, safeErrorName(error)),
): Promise<PersistResult> {
  if (records.length === 0) return { persisted: true, ids: [] }
  const now = new Date().toISOString()
  const docs = records.map((r) =>
    buildEvaluationRecord({ ...r, id: `evaluation-${r.source}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`, now }),
  )
  try {
    await writer(docs)
    return { persisted: true, ids: docs.map((d) => d._id) }
  } catch (err) {
    warn('[evaluation-store] audit write failed', err)
    return { persisted: false, ids: [], error: 'The evaluation could not be saved to the audit store.' }
  }
}

export function persistEvaluations(records: PendingEvaluation[]): Promise<PersistResult> {
  return persistEvaluationRecords(records, async (docs) => {
    // Evaluation records are writes: SANITY_WRITE_TOKEN (A-7).
    const client = getSanityClient('write')
    const tx = client.transaction()
    for (const doc of docs) tx.create(doc)
    await tx.commit()
  })
}
