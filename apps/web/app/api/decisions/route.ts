import { NextResponse } from 'next/server'
import { guardWebRoute } from '@/lib/route-guard'
import { publicationRefusal } from '@/lib/workflow-publication-http'
import { getSanityClient } from '@/lib/sanity-client'

export const dynamic = 'force-dynamic'

const STATUSES = ['proposed', 'awaiting-approval', 'approved', 'executed', 'failed', 'rejected', 'rollback-proposed', 'rolled-back'] as const

const LIST_QUERY = `*[_type == "decision" && (count($statuses) == 0 || status in $statuses) && (!defined($before) || coalesce(createdAt, _createdAt) < $before)]
  | order(coalesce(createdAt, _createdAt) desc)[0...$limit]{
  _id, question, selectedAction, status, riskLevel, requiredApproval, safetyDecision, requestedBy, createdAt, kind
}`

const COUNTS_QUERY = `{
  "proposed": count(*[_type == "decision" && status == "proposed"]),
  "awaiting-approval": count(*[_type == "decision" && status == "awaiting-approval"]),
  "approved": count(*[_type == "decision" && status == "approved"]),
  "executed": count(*[_type == "decision" && status == "executed"]),
  "failed": count(*[_type == "decision" && status == "failed"]),
  "rejected": count(*[_type == "decision" && status == "rejected"]),
  "rollback-proposed": count(*[_type == "decision" && status == "rollback-proposed"]),
  "rolled-back": count(*[_type == "decision" && status == "rolled-back"])
}`

interface Row { kind?: string | null; _id: string; question?: string | null; selectedAction?: string | null; status?: string | null; riskLevel?: number | null; requiredApproval?: boolean | null; safetyDecision?: string | null; requestedBy?: string | null; createdAt?: string | null }

/**
 * GET /api/decisions?status=&limit=&before= — recent decisions, newest first. Read-only; needs decision:read.
 *
 * `status` may name up to four statuses, comma separated. `before` is the createdAt of the last row
 * already shown, to load the next page. The reply says whether there are more, and counts every
 * status across all decisions so tabs can show how many are waiting.
 */
export async function GET(request: Request) {
  const caller = await guardWebRoute(request, 'decisions')
  if (!caller.ok) return publicationRefusal(caller)

  const url = new URL(request.url)
  const statuses = (url.searchParams.get('status') ?? '').split(',').map((value) => value.trim()).filter(Boolean)
  if (statuses.length > 4 || statuses.some((value) => !(STATUSES as readonly string[]).includes(value))) {
    return NextResponse.json({ error: `status must be up to four of ${STATUSES.join(', ')}, comma separated.` }, { status: 400 })
  }
  const rawLimit = url.searchParams.get('limit')
  const limit = rawLimit === null ? 25 : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return NextResponse.json({ error: 'limit must be a whole number from 1 to 50.' }, { status: 400 })
  const before = url.searchParams.get('before')
  if (before !== null && (before.length > 40 || Number.isNaN(Date.parse(before)))) return NextResponse.json({ error: 'before must be a date and time.' }, { status: 400 })

  try {
    const client = getSanityClient('read')
    const [found, counts] = await Promise.all([
      client.fetch<Row[]>(LIST_QUERY, { statuses, before, limit: limit + 1 }),
      client.fetch<Record<string, number>>(COUNTS_QUERY),
    ])
    const rows = (found ?? []).slice(0, limit)
    return NextResponse.json({
      observedAt: new Date().toISOString(),
      hasMore: (found ?? []).length > limit,
      counts,
      decisions: rows.map((row) => ({
        id: row._id,
        title: row.question?.trim() || row.selectedAction?.trim() || 'Untitled decision',
        action: row.selectedAction ?? null,
        status: row.status ?? 'proposed',
        riskLevel: row.riskLevel ?? null,
        requiredApproval: row.requiredApproval === true,
        safetyDecision: row.safetyDecision ?? null,
        requestedBy: row.requestedBy ?? null,
        kind: row.kind ?? null,
        createdAt: row.createdAt ?? null,
      })),
    }, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    console.error('[decisions] list failed', error instanceof Error ? error.name : 'UnknownError')
    return NextResponse.json({ error: 'Could not load decisions. Check the configured Quicksilver read data source.' }, { status: 503, headers: { 'cache-control': 'no-store' } })
  }
}
