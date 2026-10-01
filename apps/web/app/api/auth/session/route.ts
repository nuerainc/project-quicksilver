import { readBrowserSession } from '@/lib/oidc-browser-auth'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  try {
    const principal = await readBrowserSession(request, process.env)
    if (!principal) return NextResponse.json({ error: 'A signed-in session is required.' }, { status: 401, headers: { 'cache-control': 'no-store' } })
    return NextResponse.json({ principalId: principal.id, kind: principal.kind, tenantId: principal.tenantId, ...(principal.displayName ? { displayName: principal.displayName } : {}), roles: principal.roles }, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    console.error('[oidc] session lookup failed', error instanceof Error ? error.name : 'UnknownError')
    return NextResponse.json({ error: 'Session storage is unavailable.' }, { status: 503, headers: { 'cache-control': 'no-store' } })
  }
}
