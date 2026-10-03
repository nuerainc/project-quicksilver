export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; name: string; roles: string[] }
  | { status: 'unavailable' }

type SessionFetch = (input: string, init?: { signal?: AbortSignal; credentials?: 'same-origin' }) => Promise<{ status: number; json(): Promise<unknown> }>

/**
 * Ask the app who is signed in, through `/api/auth/status`, which answers 200 either way so a
 * visitor who is not signed in is not an error in the browser console. Signed in is a person; not
 * signed in with sign-in configured is "signed out"; anything else (sign-in not configured, the
 * session store down, a network failure) is "unavailable" so the console shows no broken button.
 */
export async function loadSessionState(fetcher: SessionFetch, signal?: AbortSignal): Promise<SessionState> {
  try {
    const res = await fetcher('/api/auth/status', { signal, credentials: 'same-origin' })
    if (res.status !== 200) return { status: 'unavailable' }
    const body = await res.json() as { signedIn?: unknown; signInAvailable?: unknown; principalId?: unknown; displayName?: unknown; roles?: unknown }
    if (body.signedIn !== true) return body.signInAvailable === true ? { status: 'signed-out' } : { status: 'unavailable' }
    const name = typeof body.displayName === 'string' && body.displayName.trim() ? body.displayName.trim()
      : typeof body.principalId === 'string' && body.principalId ? body.principalId : undefined
    if (!name) return { status: 'unavailable' }
    const roles = Array.isArray(body.roles) ? body.roles.filter((role): role is string => typeof role === 'string') : []
    return { status: 'signed-in', name, roles }
  } catch {
    return { status: 'unavailable' }
  }
}

/** The sign-in link, returning to the current page. Only same-site paths are carried. */
export function signInHref(pathname: string): string {
  const safe = pathname.startsWith('/') && !pathname.startsWith('//') && !pathname.startsWith('/api/') ? pathname : '/'
  return `/api/auth/oidc/start?returnTo=${encodeURIComponent(safe)}`
}

/**
 * Where to go after signing in, from the query string of the sign-in page. Only a page of this
 * app: not another site, not an API route, not a protocol-relative URL, no backslash tricks.
 */
export function returnToFrom(search: string): string {
  const raw = new URLSearchParams(search).get('returnTo') ?? ''
  const ok = raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\') && !raw.startsWith('/api/') && !raw.startsWith('/sign-in') && !/[\u0000-\u001f\\]/.test(raw) && raw.length <= 300
  return ok ? raw : '/'
}

/** The sign-in page, returning to the current page afterwards. */
export function signInPageHref(pathname: string): string {
  const safe = pathname.startsWith('/') && !pathname.startsWith('//') && !pathname.startsWith('/api/') && !pathname.startsWith('/sign-in') ? pathname : '/'
  return safe === '/' ? '/sign-in' : `/sign-in?returnTo=${encodeURIComponent(safe)}`
}
