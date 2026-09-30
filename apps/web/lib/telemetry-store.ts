import { buildTraceSpan, type TraceSpan, type TraceSpanDocument, type TraceSpanInput } from './telemetry.ts'
import { getSanityClient } from './sanity-client.ts'

export interface TraceWriteResult { persisted: boolean; count: number }
type TraceWriter = (documents: TraceSpanDocument[]) => Promise<void>

export async function persistTraceSpanBatch(
  records: TraceSpanInput[],
  writer: TraceWriter,
  tenantId = process.env.QUICKSILVER_TENANT_ID?.trim() || 'default',
): Promise<TraceWriteResult> {
  if (records.length === 0) return { persisted: true, count: 0 }
  if (records.length > 500) return { persisted: false, count: 0 }
  let documents: TraceSpanDocument[]
  try { documents = records.map((record) => buildTraceSpan(record, tenantId)) }
  catch { return { persisted: false, count: 0 } }
  try {
    await writer(documents)
    return { persisted: true, count: documents.length }
  } catch {
    return { persisted: false, count: 0 }
  }
}

export function persistTraceSpans(records: TraceSpanInput[]): Promise<TraceWriteResult> {
  return persistTraceSpanBatch(records, async (documents) => {
    const client = getSanityClient('write')
    const transaction = client.transaction()
    for (const document of documents) transaction.createIfNotExists(document)
    await transaction.commit()
  })
}

const SPAN_FIELDS = '_id,tenantId,traceId,spanId,parentSpanId,source,kind,name,status,startedAt,completedAt,durationMs,requestedBy,runId,workflowId,decisionId,agentId,modelId,toolName,toolSucceeded,inputTokens,outputTokens,totalTokens,estimatedCostUsd,safetyDecision'

/** Convert Sanity datetime strings to epoch milliseconds for alerting and UI consumers. */
export function normalizeTraceSpanDocuments(documents: TraceSpanDocument[]): TraceSpan[] {
  return documents.flatMap(({ _id: _ignored, _type: _alsoIgnored, tenantId: _tenant, completedAt: _completedAt, startedAt, ...span }) => {
    const timestamp = Date.parse(startedAt)
    return Number.isFinite(timestamp) ? [{ ...span, startedAt: timestamp }] : []
  })
}

/** Tenant-scoped query returns bounded metadata only; payloads are never stored in spans. */
export async function listRecentTraceSpans(limit = 200): Promise<TraceSpan[]> {
  const client = getSanityClient('read')
  const tenantId = process.env.QUICKSILVER_TENANT_ID?.trim() || 'default'
  const boundedLimit = Math.max(1, Math.min(500, Math.floor(limit)))
  const documents = await client.fetch<TraceSpanDocument[]>(
    `*[_type == "telemetryTraceSpan" && tenantId == $tenantId] | order(startedAt desc)[0...$limit]{${SPAN_FIELDS}}`,
    { tenantId, limit: boundedLimit },
  )
  return normalizeTraceSpanDocuments(documents)
}
