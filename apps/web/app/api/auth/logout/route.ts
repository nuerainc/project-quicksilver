import { revokeBrowserSession, signedOutResponse } from '@/lib/oidc-browser-auth'
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  try {
    const revoked = await revokeBrowserSession(request, process.env)
    if (!revoked) return NextResponse.json({ error: 'Session revocation could not be confirmed.' }, { status: 503, headers: { 'cache-control': 'no-store' } })
    return signedOutResponse(request)
  } catch (error) {
    console.error('[oidc] logout failed', error instanceof Error ? error.name : 'UnknownError')
    return NextResponse.json({ error: 'Session revocation is unavailable.' }, { status: 503, headers: { 'cache-control': 'no-store' } })
  }
}
