import { startOidcLogin } from '@/lib/oidc-browser-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  try {
    return await startOidcLogin(request, process.env)
  } catch (error) {
    console.error('[oidc] login start failed', error instanceof Error ? error.name : 'UnknownError')
    return new Response(null, { status: 303, headers: { location: new URL('/?auth=failed', request.url).href, 'cache-control': 'no-store' } })
  }
}
