/**
 * Cross-site request checks for every state-changing API call (threat model
 * A-3, T-30). middleware.ts runs this once for every `/api/*` request, before
 * any route handler.
 *
 * For any method other than GET, HEAD and OPTIONS:
 * - `Content-Type` must be `application/json` (415 otherwise). An HTML form
 *   or a `text/plain` fetch from another site cannot send that without a CORS
 *   preflight, which this app never answers.
 * - A browser's `Sec-Fetch-Site`, when sent, must be `same-origin` (403).
 * - A browser's `Origin`, when sent, must be this app's own origin or one
 *   listed in `QUICKSILVER_WEB_ALLOWED_ORIGINS` (comma-separated, for a proxy
 *   that rewrites the host) (403). `Origin: null` is refused.
 *
 * Requests with neither header come from non-browser clients (scripts, curl,
 * `npm run e2e:live`); a browser always sends `Origin` on a cross-origin POST.
 * They still need a bearer token on every route (route-guard.ts), and a
 * cross-site page cannot attach one: the console keeps it in sessionStorage.
 *
 * Edge-safe: no Node imports.
 */

export interface RequestGuardInput {
  method: string
  /** The full request URL; its origin is the app's own origin. */
  url: string
  headers: { get(name: string): string | null }
}

export type RequestGuardResult = { ok: true } | { ok: false; status: 403 | 415; error: string; code: 'cross-site' | 'unsupported-media-type' }

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/** Origins allowed besides the request's own, from `QUICKSILVER_WEB_ALLOWED_ORIGINS`. */
export function allowedOrigins(env: Readonly<Record<string, string | undefined>>): string[] {
  return (env.QUICKSILVER_WEB_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
    .flatMap((o) => {
      try {
        return [new URL(o).origin]
      } catch {
        return []
      }
    })
}

/** Check one request. Only `/api/*` paths with a state-changing method are checked; everything else passes. */
export function checkApiRequest(input: RequestGuardInput, env: Readonly<Record<string, string | undefined>> = {}): RequestGuardResult {
  const url = new URL(input.url)
  if (!url.pathname.startsWith('/api/')) return { ok: true }
  if (SAFE_METHODS.has(input.method.toUpperCase())) return { ok: true }

  const fetchSite = input.headers.get('sec-fetch-site')
  if (fetchSite !== null && fetchSite.trim().toLowerCase() !== 'same-origin') {
    return { ok: false, status: 403, code: 'cross-site', error: 'Cross-site requests are refused.' }
  }
  const origin = input.headers.get('origin')
  if (origin !== null) {
    const trimmed = origin.trim()
    const permitted = [url.origin, ...allowedOrigins(env)]
    if (trimmed === 'null' || !permitted.includes(trimmed)) {
      return { ok: false, status: 403, code: 'cross-site', error: 'Cross-site requests are refused.' }
    }
  }

  const contentType = input.headers.get('content-type') ?? ''
  if (!/^application\/json\s*(;|$)/i.test(contentType.trim())) {
    return { ok: false, status: 415, code: 'unsupported-media-type', error: 'Content-Type must be application/json.' }
  }
  return { ok: true }
}
