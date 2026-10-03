import { NextResponse } from 'next/server'
import { buildDecisionAudit, DECISION_DETAIL_QUERY } from '@/lib/decision-audit'
import { guardWebRoute } from '@/lib/route-guard'
import { getSanityClient } from '@/lib/sanity-client'
import { publicationRefusal } from '@/lib/workflow-publication-http'

export const dynamic = 'force-dynamic'

const ID = /^[A-Za-z0-9._:-]{1,200}$/

/**
 * GET /api/decisions/:id/audit — the decision's audit trail as a downloadable JSON file, with a
 * digest of the record. Read-only; needs audit:read. Exporting is itself traced by the request log.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const caller = await guardWebRoute(request, 'decisions/audit')
  if (!caller.ok) return publicationRefusal(caller)

  const { id } = await params
  if (!ID.test(id)) return NextResponse.json({ error: 'That is not a decision id.' }, { status: 400 })
  try {
    const doc = await getSanityClient('read').fetch<Record<string, unknown> | null>(DECISION_DETAIL_QUERY, { id })
    if (!doc) return NextResponse.json({ error: 'Decision not found.' }, { status: 404, headers: { 'cache-control': 'no-store' } })
    const body = buildDecisionAudit(doc, caller.principalId)
    return new NextResponse(JSON.stringify(body, null, 2), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="decision-${id.replace(/[^A-Za-z0-9._-]/g, '_')}-audit.json"`,
        'cache-control': 'no-store',
      },
    })
  } catch (error) {
    console.error('[decisions] audit export failed', error instanceof Error ? error.name : 'UnknownError')
    return NextResponse.json({ error: 'Could not export this decision. Check the configured Quicksilver read data source.' }, { status: 503, headers: { 'cache-control': 'no-store' } })
  }
}
