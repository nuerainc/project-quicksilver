import { NextResponse } from 'next/server'
import { guardWebRoute } from '@/lib/route-guard'
import { publicationRefusal } from '@/lib/workflow-publication-http'
import { getSanityClient } from '@/lib/sanity-client'

export const dynamic = 'force-dynamic'

const STATUSES = ['proposed', 'awaiting-approval', 'approved', 'executed', 'failed', 'rejected', 'rollback-proposed', 'rolled-back'] as const

const LIST_QUERY = `*[_type == "decision" && (!defined($status) || status == $status)] | order(coalesce(createdAt, _createdAt) desc)[0...$limit]{
  _id, question, selectedAction, status, riskLevel, requiredApproval, safetyDecision, requestedBy, createdAt
}`

interface Row { _id: string; question?: string | null; selectedAction?: string | null; status?: string | null; riskLevel?: number | null; requiredApproval?: boolean | null; safetyDecision?: string | null; requestedBy?: string | null; createdAt?: string | null }

/** GET /api/decisions?status=&limit= — recent decisions, newest first. Read-only; needs decision:read. */
export async function GET(request: Request) {
  const caller = await guardWebRoute(request, 'decisions')
  if (!caller.ok) return publicationRefusal(caller)

  const url = new URL(request.url)
  const status = url.searchParams.get('status')
  if (status !== null && !(STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: `status must be one of ${STATUSES.join(', ')}.` }, { status: 400 })
  }
  const rawLimit = url.searchParams.get('limit')
  const limit = rawLimit === null ? 25 : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return NextResponse.json({ error: 'limit must be a whole number from 1 to 50.' }, { status: 400 })

  try {
    const rows = await getSanityClient('read').fetch<Row[]>(LIST_QUERY, { status, limit })
    return NextResponse.json({
      observedAt: new Date().toISOString(),
      decisions: (rows ?? []).map((row) => ({
        id: row._id,
        title: row.question?.trim() || row.selectedAction?.trim() || 'Untitled decision',
        action: row.selectedAction ?? null,
        status: row.status ?? 'proposed',
        riskLevel: row.riskLevel ?? null,
        requiredApproval: row.requiredApproval === true,
        safetyDecision: row.safetyDecision ?? null,
        requestedBy: row.requestedBy ?? null,
        createdAt: row.createdAt ?? null,
      })),
    }, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    console.error('[decisions] list failed', error instanceof Error ? error.name : 'UnknownError')
    return NextResponse.json({ error: 'Could not load decisions. Check the configured Quicksilver read data source.' }, { status: 503, headers: { 'cache-control': 'no-store' } })
  }
}
