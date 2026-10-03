import { NextResponse } from 'next/server'
import { checkWhoamiPrincipal } from '@/lib/nqc-approval'
import { oidcConfigProblems, readBrowserSession } from '@/lib/oidc-browser-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/auth/status — is anyone signed in with the organisation account, and what may they do?
 *
 * Always answers 200 so a visitor who is not signed in is not an error in the browser console
 * (`/api/auth/session` answers 401 for that, and stays as it is). It reads only the browser
 * session cookie; a pasted token is a different thing, checked by each route that receives it.
 * It returns no secret: the person's id, name, roles and permissions, or `signedIn: false`.
 */
export async function GET(request: Request): Promise<Response> {
  const headers = { 'cache-control': 'no-store' }
  const available = oidcConfigProblems(process.env).length === 0
  try {
    const session = await readBrowserSession(request, process.env)
    if (!session) return NextResponse.json({ signedIn: false, signInAvailable: available }, { headers })
    const who = checkWhoamiPrincipal({ id: session.id, kind: session.kind, tenantId: session.tenantId, roles: session.roles, ...(session.displayName ? { displayName: session.displayName } : {}) }, process.env)
    if (!who.ok) return NextResponse.json({ signedIn: false, signInAvailable: available }, { headers })
    return NextResponse.json({ signedIn: true, signInAvailable: available, ...who.body }, { headers })
  } catch (error) {
    console.error('[oidc] status lookup failed', error instanceof Error ? error.name : 'UnknownError')
    return NextResponse.json({ signedIn: false, signInAvailable: false, unavailable: true }, { headers })
  }
}
