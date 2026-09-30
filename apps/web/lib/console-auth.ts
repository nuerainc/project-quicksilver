/**
 * Browser-side sign-in for the decision console (no server imports).
 *
 * The person pastes their supervisor or principal token once. It is kept only
 * in `sessionStorage` for this tab (the browser clears it when the tab
 * closes), never in `localStorage` or a cookie, and it is sent only as
 * `Authorization: Bearer` to this app's own API routes, each named in
 * `mayCarryConsoleToken`: the decision routes, `/api/whoami`, `/api/plan`,
 * `/api/query` and `/api/workflows/{validate,simulate,run}` (every one of
 * them requires a principal since threat model A-3). Every storage access is wrapped: storage can be missing or
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

/** Same-origin paths (exact, no query) other than the decision routes that the console token may be sent to. */
const TOKEN_PATHS: ReadonlySet<string> = new Set([
  '/api/whoami',
  '/api/plan',
  '/api/query',
  '/api/monitoring/workflows',
  '/api/dashboard/overview',
  '/api/dashboard/finance',
  '/api/agents/catalog',
  '/api/agents/definitions',
  '/api/agents/drafts',
  '/api/agents/drafts/submit',
  '/api/agents/review',
  '/api/agents/publish',
  '/api/agents/rollback',
  '/api/workflows/validate',
  '/api/workflows/simulate',
  '/api/workflows/run',
  '/api/workflows/publications',
  '/api/workflows/diff',
  '/api/workflows/executions',
  '/api/workflows/drafts',
  '/api/workflows/drafts/submit',
  '/api/workflows/review',
  '/api/workflows/publish',
  '/api/workflows/rollback',
])

/** The only paths the console token is ever sent to: this app's own API routes, listed exactly. */
export function mayCarryConsoleToken(url: string): boolean {
  if (/^\/api\/agents\/definitions\?agentId=nuera-quicksilver(?:%3A|:)[a-z][a-z0-9-]{0,62}$/i.test(url)) return true
  if (/^\/api\/workflows\/publications\?workflowId=[a-zA-Z0-9._:%-]{1,256}$/.test(url)) return true
  if (/^\/api\/workflows\/executions\?workflowId=[a-zA-Z0-9._:%-]{1,256}(?:&limit=[0-9]{1,3})?$/.test(url)) return true
  if (/^\/api\/workflows\/diff\?workflowId=[a-zA-Z0-9._:%-]{1,256}&from=[0-9]{1,9}&to=[0-9]{1,9}$/.test(url)) return true
  return /^\/api\/decisions\/[^/?#]+\/(action|execute|observe|resume|rollback)$/.test(url) || TOKEN_PATHS.has(url)
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
/** Every console call that can be refused for auth: the decision routes plus plan, query and the workflow builder. */
export type ConsoleRoute = ConsoleDecisionRoute | 'plan' | 'query'
  | 'dashboard/overview' | 'dashboard/finance'
  | 'monitoring/workflows'
  | 'agents/catalog' | 'agents/definitions' | 'agents/drafts' | 'agents/drafts/submit' | 'agents/review' | 'agents/publish' | 'agents/rollback'
  | 'workflows/validate' | 'workflows/simulate' | 'workflows/run'
  | 'workflows/publications' | 'workflows/executions' | 'workflows/diff' | 'workflows/drafts' | 'workflows/drafts/submit'
  | 'workflows/review' | 'workflows/publish' | 'workflows/rollback'

/** The permission each route checks (observe and resume also accept `decision:propose`). Mirrors route-guard.ts. */
export const CONSOLE_ROUTE_PERMISSION: Readonly<Record<ConsoleRoute, string>> = Object.freeze({
  action: 'decision:approve',
  execute: 'decision:execute',
  observe: 'decision:read',
  resume: 'decision:read',
  rollback: 'decision:rollback',
  plan: 'decision:propose',
  query: 'decision:read',
  'monitoring/workflows': 'workflow:read',
  'dashboard/overview': 'decision:read',
  'dashboard/finance': 'finance:read',
  'agents/catalog': 'agent:read',
  'agents/definitions': 'agent:read',
  'agents/drafts': 'agent:write',
  'agents/drafts/submit': 'agent:write',
  'agents/review': 'agent:review',
  'agents/publish': 'agent:publish',
  'agents/rollback': 'agent:write',
  'workflows/validate': 'workflow:read',
  'workflows/simulate': 'workflow:read',
  'workflows/run': 'run:enqueue',
  'workflows/publications': 'workflow:read',
  'workflows/diff': 'workflow:read',
  'workflows/executions': 'workflow:read',
  'workflows/drafts': 'workflow:write',
  'workflows/drafts/submit': 'workflow:write',
  'workflows/review': 'workflow:publish',
  'workflows/publish': 'workflow:publish',
  'workflows/rollback': 'workflow:publish',
})

/** The message the console shows for an auth refusal or a rate limit, or null for any other status. */
export function authFailureMessage(status: number, route: ConsoleRoute, serverMessage?: string, retryAfterSeconds?: number): string | null {
  if (status === 401) return 'Sign in to do this'
  if (status === 429) return `Too many requests; try again in ${retryAfterSeconds && retryAfterSeconds > 0 ? `${retryAfterSeconds} s` : 'a moment'}`
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

/** What the console needs to ask the sole operator for a written justification. */
export interface SoleOperatorPrompt {
  reasons: string[]
  minJustificationLength: number
}

/**
 * When an approval came back 403 for separation of duties and the server says
 * the sole-operator override is open to this approver, what to ask for;
 * otherwise null (another human has to approve, or it was another refusal).
 */
export function soleOperatorPrompt(status: number, body: unknown): SoleOperatorPrompt | null {
  if (status !== 403 || !body || typeof body !== 'object') return null
  const b = body as { error?: unknown; reasons?: unknown; soleOperatorOverride?: { available?: unknown; minJustificationLength?: unknown } }
  if (b.error !== 'Separation of duties' || b.soleOperatorOverride?.available !== true) return null
  const min = typeof b.soleOperatorOverride.minJustificationLength === 'number' ? b.soleOperatorOverride.minJustificationLength : 20
  const reasons = Array.isArray(b.reasons) ? b.reasons.filter((r): r is string => typeof r === 'string') : []
  return { reasons, minJustificationLength: min }
}
