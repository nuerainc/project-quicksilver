/**
 * Browser-side sign-in for the decision console (no server imports).
 *
 * The person pastes their supervisor or principal token once. It is kept only
 * in `sessionStorage` for this tab (the browser clears it when the tab
 * closes), never in `localStorage` or a cookie, and it is sent only as
 * `Authorization: Bearer` to this app's own `/api/decisions/*` routes and
 * `/api/whoami`. Every storage access is wrapped: storage can be missing or
 * throw (private windows, blocked site data), and the console must still work.
 */

export const CONSOLE_TOKEN_KEY = 'quicksilver.console.token'

export interface TokenStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** `window.sessionStorage`, or undefined when there is no window or access throws. */
export function browserSessionStorage(): TokenStorage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage
  } catch {
    return undefined
  }
}

export function readConsoleToken(storage: () => TokenStorage | undefined = browserSessionStorage): string | null {
  try {
    const value = storage()?.getItem(CONSOLE_TOKEN_KEY)
    return value && value.trim() ? value.trim() : null
  } catch {
    return null
  }
}

/** Returns false when the token could not be stored (it is then kept in memory only). */
export function saveConsoleToken(token: string, storage: () => TokenStorage | undefined = browserSessionStorage): boolean {
  try {
    const target = storage()
    if (!target) return false
    target.setItem(CONSOLE_TOKEN_KEY, token.trim())
    return true
  } catch {
    return false
  }
}

export function clearConsoleToken(storage: () => TokenStorage | undefined = browserSessionStorage): void {
  try {
    storage()?.removeItem(CONSOLE_TOKEN_KEY)
  } catch {
    // Nothing stored, or storage blocked: nothing to clear.
  }
}

/** The only paths the console token is ever sent to: this app's own decision routes and whoami. */
export function mayCarryConsoleToken(url: string): boolean {
  return /^\/api\/decisions\/[^/?#]+\/(action|execute|observe|resume|rollback)$/.test(url) || url === '/api/whoami'
}

/** The shape `GET /api/whoami` returns on 200 (mirrors `WhoamiBody` in nqc-approval.ts; no secrets). */
export interface ConsoleWhoami {
  principalId: string
  kind: string
  tenantId: string
  displayName?: string
  permissions: string[]
  credential: 'principal' | 'shared-supervisor'
}

export type ConsoleDecisionRoute = 'action' | 'execute' | 'observe' | 'resume' | 'rollback'

/** The permission each decision route checks (observe and resume also accept `decision:propose`). */
export const CONSOLE_ROUTE_PERMISSION: Readonly<Record<ConsoleDecisionRoute, string>> = Object.freeze({
  action: 'decision:approve',
  execute: 'decision:execute',
  observe: 'decision:read',
  resume: 'decision:read',
  rollback: 'decision:rollback',
})

/** The message the console shows for an auth refusal, or null for any other status. */
export function authFailureMessage(status: number, route: ConsoleDecisionRoute, serverMessage?: string): string | null {
  if (status === 401) return 'Sign in to do this'
  if (status === 403) {
    const base = `Your account can't do this (needs ${CONSOLE_ROUTE_PERMISSION[route]})`
    return serverMessage ? `${base}. Server: ${serverMessage}` : base
  }
  return null
}

/** Headers for a console call; the token is attached only for an allowed path. */
export function consoleHeaders(url: string, token: string | null, base: Record<string, string> = {}): Record<string, string> {
  if (!token || !mayCarryConsoleToken(url)) return { ...base }
  return { ...base, authorization: `Bearer ${token}` }
}
