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
import { checkWhoami, checkWhoamiPrincipal } from '@/lib/nqc-approval'
import { readBrowserSession } from '@/lib/oidc-browser-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const headers = { 'cache-control': 'no-store' }
  const authorization = req.headers.get('authorization')
  // A pasted token wins. Without one, a signed-in browser session answers the same question.
  if (authorization === null) {
    try {
      const session = await readBrowserSession(req, process.env)
      if (session) {
        const result = checkWhoamiPrincipal({ id: session.id, kind: session.kind, tenantId: session.tenantId, roles: session.roles, ...(session.displayName ? { displayName: session.displayName } : {}) }, process.env)
        return NextResponse.json(result.body, { status: result.status, headers })
      }
    } catch (error) {
      console.error('[oidc] session lookup failed', error instanceof Error ? error.name : 'UnknownError')
      return NextResponse.json({ error: 'Browser session storage is unavailable.' }, { status: 503, headers })
    }
  }
  const result = checkWhoami(authorization, process.env)
  return NextResponse.json(result.body, { status: result.status, headers: { 'cache-control': 'no-store' } })
}
