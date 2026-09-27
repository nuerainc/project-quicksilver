/**
 * Console sign-in: `GET /api/whoami` (the pure `checkWhoami`), the browser
 * token helpers in `console-auth.ts`, and the strict approve body. Run by the
 * root `seed:test` script (the web app has no test runner of its own).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { digestToken } from '../../../packages/kernel/src/identity/tokens.ts'
import { checkWhoami, type CredentialEnv } from './nqc-approval.ts'
import {
  CONSOLE_TOKEN_KEY,
  authFailureMessage,
  clearConsoleToken,
  consoleHeaders,
  mayCarryConsoleToken,
  readConsoleToken,
  saveConsoleToken,
  type TokenStorage,
} from './console-auth.ts'
import { DecisionActionBody } from './decision-action-body.ts'

const token = (name: string) => `${name}-${'y'.repeat(40)}`
const TOKENS = {
  supervisor: token('supervisor'),
  viewer: token('viewer'),
  agent: token('agent'),
  otherTenant: token('other-tenant'),
}
const principals = [
  { id: 'entity-ana', kind: 'human', tenantId: 'acme', roles: ['supervisor'], displayName: 'Ana', tokenDigest: digestToken(TOKENS.supervisor) },
  { id: 'entity-vic', kind: 'human', tenantId: 'acme', roles: ['viewer'], tokenDigest: digestToken(TOKENS.viewer) },
  { id: 'agent:worker', kind: 'agent', tenantId: 'acme', roles: ['supervisor'], tokenDigest: digestToken(TOKENS.agent) },
  { id: 'entity-zed', kind: 'human', tenantId: 'globex', roles: ['supervisor'], tokenDigest: digestToken(TOKENS.otherTenant) },
]
const env: CredentialEnv = { QUICKSILVER_PRINCIPALS: JSON.stringify(principals), QUICKSILVER_TENANT_ID: 'acme' }
const bearer = (t: string) => `Bearer ${t}`

/** No token, digest or configured secret may appear anywhere in a whoami body. */
function assertNoSecrets(body: unknown, secrets: string[]) {
  const text = JSON.stringify(body)
  for (const secret of secrets) assert.equal(text.includes(secret), false, 'whoami leaked a secret')
  assert.equal(/sha256:|tokenDigest|token/i.test(text), false, `whoami body mentions a token or digest: ${text}`)
}
const ALL_SECRETS = [...Object.values(TOKENS), ...Object.values(TOKENS).map(digestToken), ...Object.values(TOKENS).map((t) => digestToken(t).slice('sha256:'.length))]

test('whoami: no credential or an unknown one is 401 with only an error message', () => {
  for (const auth of [null, '', 'Bearer', 'Basic abc', bearer('not-a-known-token-at-all-000000000000')]) {
    const r = checkWhoami(auth, env)
    assert.equal(r.ok, false)
    assert.equal(r.status, 401, `auth=${JSON.stringify(auth)}`)
    assert.deepEqual(Object.keys(r.body), ['error'])
    assertNoSecrets(r.body, ALL_SECRETS)
  }
})

test('whoami: a supervisor gets 200 with id, kind, tenant and permissions, and no secrets', () => {
  const r = checkWhoami(bearer(TOKENS.supervisor), env)
  assert.equal(r.status, 200)
  assert.ok(r.ok)
  assert.deepEqual(Object.keys(r.body).sort(), ['credential', 'displayName', 'kind', 'permissions', 'principalId', 'tenantId'])
  assert.equal(r.body.principalId, 'entity-ana')
  assert.equal(r.body.kind, 'human')
  assert.equal(r.body.tenantId, 'acme')
  assert.equal(r.body.displayName, 'Ana')
  assert.equal(r.body.credential, 'principal')
  for (const p of ['decision:read', 'decision:approve', 'decision:execute', 'decision:rollback'] as const) assert.ok(r.body.permissions.includes(p), p)
  assert.equal(r.body.permissions.includes('tenant:admin'), false)
  assertNoSecrets(r.body, ALL_SECRETS)
})

test('whoami: permissions reflect RBAC (viewer reads only; agents hold no authority; another tenant holds nothing here)', () => {
  const viewer = checkWhoami(bearer(TOKENS.viewer), env)
  assert.ok(viewer.ok)
  assert.deepEqual(viewer.body.permissions.filter((p) => p.startsWith('decision:')), ['decision:read'])
  assert.equal('displayName' in viewer.body, false)

  const agent = checkWhoami(bearer(TOKENS.agent), env)
  assert.ok(agent.ok)
  assert.equal(agent.body.kind, 'agent')
  for (const p of ['decision:approve', 'decision:execute', 'decision:rollback'] as const) assert.equal(agent.body.permissions.includes(p), false, p)

  const other = checkWhoami(bearer(TOKENS.otherTenant), env)
  assert.ok(other.ok)
  assert.equal(other.body.tenantId, 'globex')
  assert.deepEqual(other.body.permissions, [])
  for (const r of [viewer, agent, other]) assertNoSecrets(r.body, ALL_SECRETS)
})

test('whoami: the shared supervisor token names NQC_SUPERVISOR_ID and never echoes the token; unconfigured is 503', () => {
  const shared = 'shared-supervisor-token-'.padEnd(48, 'z')
  const sharedEnv: CredentialEnv = { NQC_SUPERVISOR_TOKEN: shared, NQC_SUPERVISOR_ID: 'entity-sole' }
  const ok = checkWhoami(bearer(shared), sharedEnv)
  assert.ok(ok.ok)
  assert.equal(ok.body.principalId, 'entity-sole')
  assert.equal(ok.body.kind, 'human')
  assert.equal(ok.body.credential, 'shared-supervisor')
  assert.deepEqual(ok.body.permissions, ['decision:read', 'decision:approve', 'decision:execute', 'decision:rollback'])
  assertNoSecrets(ok.body, [shared])

  const wrong = checkWhoami(bearer('x'.repeat(48)), sharedEnv)
  assert.equal(wrong.status, 401)
  assertNoSecrets(wrong.body, [shared])

  assert.equal(checkWhoami(bearer(shared), {}).status, 503)
  assert.equal(checkWhoami(bearer(shared), { QUICKSILVER_PRINCIPALS: '{not json' }).status, 503)
})

// ── Browser helpers ────────────────────────────────────────────────────────

function memoryStorage(): TokenStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) }
}
const throwing: TokenStorage = {
  getItem: () => { throw new Error('SecurityError') },
  setItem: () => { throw new Error('QuotaExceededError') },
  removeItem: () => { throw new Error('SecurityError') },
}

test('console token: saved, read and cleared under one sessionStorage key; storage failures never throw', () => {
  const store = memoryStorage()
  assert.equal(readConsoleToken(() => store), null)
  assert.equal(saveConsoleToken(`  ${TOKENS.supervisor}\n`, () => store), true)
  assert.equal(store.data.get(CONSOLE_TOKEN_KEY), TOKENS.supervisor)
  assert.equal(readConsoleToken(() => store), TOKENS.supervisor)
  clearConsoleToken(() => store)
  assert.equal(readConsoleToken(() => store), null)

  // Missing or throwing storage (private window, blocked site data, no window).
  assert.equal(readConsoleToken(() => throwing), null)
  assert.equal(saveConsoleToken(TOKENS.supervisor, () => throwing), false)
  assert.doesNotThrow(() => clearConsoleToken(() => throwing))
  assert.equal(readConsoleToken(() => undefined), null)
  assert.equal(saveConsoleToken(TOKENS.supervisor, () => undefined), false)
  const accessorThrows = () => { throw new Error('SecurityError') }
  assert.equal(readConsoleToken(accessorThrows), null)
  assert.equal(saveConsoleToken(TOKENS.supervisor, accessorThrows), false)
  assert.doesNotThrow(() => clearConsoleToken(accessorThrows))
  // Without a window (tests, server render) the default storage is simply absent.
  assert.equal(readConsoleToken(), null)
})

test('console token: sent only as a bearer header to this app\'s decision routes and whoami', () => {
  for (const url of ['/api/decisions/decision-plan-abc-1/action', '/api/decisions/d/execute', '/api/decisions/d/observe', '/api/decisions/d/resume', '/api/decisions/d/rollback', '/api/whoami']) {
    assert.equal(mayCarryConsoleToken(url), true, url)
    assert.deepEqual(consoleHeaders(url, 't0k', { 'content-type': 'application/json' }), { 'content-type': 'application/json', authorization: 'Bearer t0k' })
  }
  for (const url of ['/api/plan', '/api/query', '/api/workflows/run', 'https://evil.example/api/decisions/d/action', '//evil.example/api/whoami', '/api/decisions/d/action?x=1', '/api/decisions/a/b/action', '/api/whoami/x']) {
    assert.equal(mayCarryConsoleToken(url), false, url)
    assert.deepEqual(consoleHeaders(url, 't0k'), {}, url)
  }
  assert.deepEqual(consoleHeaders('/api/whoami', null), {})
})

test('console messages: 401 asks to sign in, 403 names the permission, anything else is left to the caller', () => {
  assert.equal(authFailureMessage(401, 'execute'), 'Sign in to do this')
  assert.equal(authFailureMessage(403, 'action'), "Your account can't do this (needs decision:approve)")
  assert.equal(authFailureMessage(403, 'execute'), "Your account can't do this (needs decision:execute)")
  assert.equal(authFailureMessage(403, 'observe'), "Your account can't do this (needs decision:read)")
  assert.equal(authFailureMessage(403, 'resume'), "Your account can't do this (needs decision:read)")
  assert.equal(authFailureMessage(403, 'rollback', 'Separation of duties'), "Your account can't do this (needs decision:rollback). Server: Separation of duties")
  for (const status of [200, 400, 404, 409, 500, 503]) assert.equal(authFailureMessage(status, 'execute'), null)
})

test('approve body: the approver can never come from the request body', () => {
  assert.equal(DecisionActionBody.safeParse({ action: 'approve' }).success, true)
  assert.equal(DecisionActionBody.safeParse({ action: 'approve', comment: 'ok' }).success, true)
  for (const field of ['approvedBy', 'supervisorId', 'approverId', 'actorId', 'principalId']) {
    assert.equal(DecisionActionBody.safeParse({ action: 'approve', [field]: 'entity-mallory' }).success, false, field)
  }
})
