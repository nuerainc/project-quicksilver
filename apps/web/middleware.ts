/**
 * Security headers on every page and API response (threat model T-67), and
 * the cross-site check on every state-changing API request (A-3, T-30).
 *
 * A fresh nonce per request goes into the Content-Security-Policy on both the
 * request (Next.js reads it there and stamps the nonce on its own scripts) and
 * the response. Pages must render per request for the nonce to reach them;
 * the root layout is `force-dynamic` for that reason. The policy itself and
 * the companion headers live in lib/security-headers.ts, where they are tested.
 *
 * A POST (or any other non-GET) to `/api/*` must be `application/json` and,
 * when a browser sends `Origin` or `Sec-Fetch-Site`, come from this app's own
 * origin (lib/request-guard.ts); otherwise it is refused here, before any
 * route handler runs.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { checkApiRequest } from './lib/request-guard'
import { STATIC_SECURITY_HEADERS, contentSecurityPolicy, generateNonce } from './lib/security-headers'

export function middleware(request: NextRequest) {
  const nonce = generateNonce()
  const policy = contentSecurityPolicy({ nonce, development: process.env.NODE_ENV === 'development' })

  const guard = checkApiRequest(request, process.env)
  if (!guard.ok) {
    const refused = NextResponse.json({ error: guard.error, code: guard.code }, { status: guard.status })
    refused.headers.set('content-security-policy', policy)
    refused.headers.set('cache-control', 'no-store')
    for (const { key, value } of STATIC_SECURITY_HEADERS) refused.headers.set(key, value)
    return refused
  }

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set('content-security-policy', policy)

  const response = NextResponse.next({ request: { headers: requestHeaders } })
  response.headers.set('content-security-policy', policy)
  for (const { key, value } of STATIC_SECURITY_HEADERS) response.headers.set(key, value)
  return response
}

export const config = {
  // Everything except Next's hashed static assets and image optimiser.
  matcher: [{ source: '/((?!_next/static|_next/image|favicon.ico).*)' }],
}
