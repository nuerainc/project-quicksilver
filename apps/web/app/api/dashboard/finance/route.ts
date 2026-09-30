import { NextResponse } from 'next/server'
import { guardWebRoute } from '@/lib/route-guard'
import { publicationRefusal } from '@/lib/workflow-publication-http'
import { getSanityClient } from '@/lib/sanity-client'
import type { FinanceOverview } from '@/lib/business-dashboard'

export const dynamic = 'force-dynamic'

const FINANCE_QUERY = `{
  "entryCount": count(*[_type == "moneyEntry"]),
  "spendUsd": coalesce(sum(*[_type == "moneyEntry" && kind == "spend"].amountUsd), 0),
  "computeUsd": coalesce(sum(*[_type == "moneyEntry" && kind == "compute"].amountUsd), 0),
  "revenueUsd": coalesce(sum(*[_type == "moneyEntry" && kind == "revenue"].amountUsd), 0),
  "refundsUsd": coalesce(sum(*[_type == "moneyEntry" && kind == "refund"].amountUsd), 0)
}`

/** Finance-only, read-only rollup of the append-only recorded ledger. */
export async function GET(request: Request) {
  const caller = await guardWebRoute(request, 'dashboard/finance')
  if (!caller.ok) return publicationRefusal(caller)

  try {
    const ledger = await getSanityClient('read').fetch<FinanceOverview['ledger']>(FINANCE_QUERY)
    return NextResponse.json({ observedAt: new Date().toISOString(), ledger }, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    console.error('[dashboard-finance] ledger read failed', error instanceof Error ? error.name : 'UnknownError')
    return NextResponse.json({ error: 'Could not load recorded ledger totals.' }, { status: 503, headers: { 'cache-control': 'no-store' } })
  }
}
