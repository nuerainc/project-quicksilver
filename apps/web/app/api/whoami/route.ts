/**
 * GET /api/whoami — who does this `Authorization: Bearer` token belong to?
 *
 * Used by the decision console to show who is signed in. It validates the
 * header with the same helpers the decision routes use (`checkWhoami` in
 * `lib/nqc-approval.ts`) and returns the principal id, kind, tenant and the
 * permissions it holds in `QUICKSILVER_TENANT_ID`, or 401. It never returns a
 * token, a digest or any other secret, and it grants nothing: each decision
 * route still checks its own permission.
 */

import { NextResponse } from 'next/server'
import { checkWhoami } from '@/lib/nqc-approval'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const result = checkWhoami(req.headers.get('authorization'), process.env)
  return NextResponse.json(result.body, { status: result.status, headers: { 'cache-control': 'no-store' } })
}
