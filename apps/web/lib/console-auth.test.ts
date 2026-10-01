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
  soleOperatorPrompt,
  type TokenStorage,
} from './console-auth.ts'
import { DecisionActionBody, separationRefusal } from './decision-action-body.ts'

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
  assert.deepEqual(ok.body.permissions, ['decision:read', 'decision:propose', 'decision:approve', 'decision:execute', 'decision:rollback', 'workflow:read', 'finance:read'])
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

test('console token: sent only as a bearer header to this app\'s own API routes (decisions, whoami, plan, query, agents, workflows)', () => {
  for (const url of ['/api/decisions/decision-plan-abc-1/action', '/api/decisions/d/execute', '/api/decisions/d/observe', '/api/decisions/d/resume', '/api/decisions/d/rollback', '/api/whoami', '/api/plan', '/api/query', '/api/agents/run', '/api/dashboard/overview', '/api/workflows/validate', '/api/workflows/simulate', '/api/workflows/run']) {
    assert.equal(mayCarryConsoleToken(url), true, url)
    assert.deepEqual(consoleHeaders(url, 't0k', { 'content-type': 'application/json' }), { 'content-type': 'application/json', authorization: 'Bearer t0k' })
  }
  for (const url of ['https://evil.example/api/plan', '//evil.example/api/plan', '/api/plan?x=1', '/api/plan/', '/api/query#x', '/api/agents/run?key=finance', '/api/agents/run/', '/api/workflows/other', '/api/workflows/run/x', 'https://evil.example/api/decisions/d/action', '//evil.example/api/whoami', '/api/decisions/d/action?x=1', '/api/decisions/a/b/action', '/api/whoami/x', '/api/other']) {
    assert.equal(mayCarryConsoleToken(url), false, url)
    assert.deepEqual(consoleHeaders(url, 't0k'), {}, url)
  }
  assert.deepEqual(consoleHeaders('/api/whoami', null), {})
})

test('dashboard finance request attaches the token only to the exact same-origin route', () => {
  assert.equal(mayCarryConsoleToken('/api/dashboard/finance'), true)
  assert.equal(mayCarryConsoleToken('/api/dashboard/finance?tenant=other'), false)
})

test('agent catalog token access is limited to the declared same-origin routes', () => {
  for (const url of ['/api/agents/catalog', '/api/agents/definitions?agentId=nuera-quicksilver%3Acompliance', '/api/agents/drafts', '/api/agents/drafts/submit', '/api/agents/review', '/api/agents/publish', '/api/agents/rollback']) {
    assert.equal(mayCarryConsoleToken(url), true, url)
    assert.equal(consoleHeaders(url, 'agent-token').authorization, 'Bearer agent-token')
  }
  for (const url of ['/api/agents/definitions?agentId=../../secrets', '/api/agents/catalog?other=1', '/api/agents/unknown', 'https://evil.example/api/agents/catalog']) {
    assert.equal(mayCarryConsoleToken(url), false, url)
  }
})

test('console messages: 401 asks to sign in, 403 names the permission, anything else is left to the caller', () => {
  assert.equal(authFailureMessage(401, 'execute'), 'Sign in to do this')
  assert.equal(authFailureMessage(403, 'action'), "Your account can't do this (needs decision:approve)")
  assert.equal(authFailureMessage(403, 'execute'), "Your account can't do this (needs decision:execute)")
  assert.equal(authFailureMessage(403, 'observe'), "Your account can't do this (needs decision:read)")
  assert.equal(authFailureMessage(403, 'resume'), "Your account can't do this (needs decision:read)")
  assert.equal(authFailureMessage(403, 'rollback', 'Separation of duties'), "Your account can't do this (needs decision:rollback). Server: Separation of duties")
  assert.equal(authFailureMessage(401, 'plan'), 'Sign in to do this')
  assert.equal(authFailureMessage(403, 'plan'), "Your account can't do this (needs decision:propose)")
  assert.equal(authFailureMessage(403, 'workflows/run'), "Your account can't do this (needs run:enqueue)")
  assert.equal(authFailureMessage(429, 'plan', undefined, 7), 'Too many requests; try again in 7 s')
  assert.equal(authFailureMessage(429, 'action'), 'Too many requests; try again in a moment')
  for (const status of [200, 400, 404, 409, 500, 503]) assert.equal(authFailureMessage(status, 'execute'), null)
})

test('sole-operator prompt (A-3): the approve flow asks for a justification only when the server says the override is open', () => {
  const conflict = { allowed: false, conflicts: ['The approver requested this decision.'], reasons: ['The approver requested this decision.', 'As the sole operator you may approve this, but only with a written justification of at least 20 characters.'], soleOperatorOverride: false }
  const open = separationRefusal(conflict, 'entity-ana', 'entity-ana')
  assert.deepEqual(open.soleOperatorOverride, { available: true, minJustificationLength: 20 })
  assert.deepEqual(soleOperatorPrompt(403, open), { reasons: conflict.reasons, minJustificationLength: 20 })
  // Someone else is the sole operator, or there is none: another human must approve.
  assert.equal(separationRefusal(conflict, 'entity-ana', 'entity-bo').soleOperatorOverride.available, false)
  assert.equal(separationRefusal(conflict, 'entity-ana', null).soleOperatorOverride.available, false)
  assert.equal(soleOperatorPrompt(403, separationRefusal(conflict, 'entity-ana', null)), null)
  // Any other refusal or status is not a prompt.
  assert.equal(soleOperatorPrompt(401, open), null)
  assert.equal(soleOperatorPrompt(403, { error: 'This credential is not permitted to perform this supervisor action.' }), null)
  assert.equal(soleOperatorPrompt(403, null), null)
  assert.equal(soleOperatorPrompt(403, 'Separation of duties'), null)
})

test('approve body: the approver can never come from the request body', () => {
  assert.equal(DecisionActionBody.safeParse({ action: 'approve' }).success, false)
  assert.equal(DecisionActionBody.safeParse({ action: 'approve', comment: 'ok' }).success, false)
  assert.equal(DecisionActionBody.safeParse({ action: 'approve', expectedActionFingerprint: `sha256:${'a'.repeat(64)}` }).success, true)
  assert.equal(DecisionActionBody.safeParse({ action: 'approve', expectedActionFingerprint: 'sha256:stale' }).success, false)
  assert.equal(DecisionActionBody.safeParse({ action: 'reject' }).success, true)
  for (const field of ['approvedBy', 'supervisorId', 'approverId', 'actorId', 'principalId']) {
    assert.equal(DecisionActionBody.safeParse({ action: 'approve', [field]: 'entity-mallory' }).success, false, field)
  }
})
