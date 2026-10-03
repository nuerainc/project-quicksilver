export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-out' }
  | { status: 'signed-in'; name: string; roles: string[] }
  | { status: 'unavailable' }

type SessionFetch = (input: string, init?: { signal?: AbortSignal; credentials?: 'same-origin' }) => Promise<{ status: number; json(): Promise<unknown> }>

/**
 * Ask the host who is signed in. 200 is a signed-in person, 401 is nobody, and
 * anything else (503 when sign-in is not configured, a network failure) is
 * "unavailable" so the console shows no broken button.
 */
export async function loadSessionState(fetcher: SessionFetch, signal?: AbortSignal): Promise<SessionState> {
  try {
    const res = await fetcher('/api/auth/session', { signal, credentials: 'same-origin' })
    if (res.status === 401) return { status: 'signed-out' }
    if (res.status !== 200) return { status: 'unavailable' }
    const body = await res.json() as { principalId?: unknown; displayName?: unknown; roles?: unknown }
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
