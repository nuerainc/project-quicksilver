/**
 * Threat model F-2: the web app's execute, observe and resume routes check
 * their caller before any read or write. The web app has no test runner, so
 * the pure check (`checkDecisionRouteCaller`) is tested here and run by the
 * root `seed:test` script.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { digestToken } from '../../../packages/kernel/src/identity/tokens.ts'
import { checkDecisionRouteCaller, checkSupervisorCredential, type CredentialEnv } from './nqc-approval.ts'

const token = (name: string) => `${name}-${'x'.repeat(40)}`
const TOKENS = {
  supervisor: token('supervisor'),
  viewer: token('viewer'),
  developer: token('developer'),
  serviceSupervisor: token('service-supervisor'),
  taskClient: token('task-client'),
  otherTenant: token('other-tenant'),
}

const principals = [
  { id: 'entity-ana', kind: 'human', tenantId: 'acme', roles: ['supervisor'], tokenDigest: digestToken(TOKENS.supervisor) },
  { id: 'entity-vic', kind: 'human', tenantId: 'acme', roles: ['viewer'], tokenDigest: digestToken(TOKENS.viewer) },
  { id: 'svc:builder', kind: 'service', tenantId: 'acme', roles: ['developer'], tokenDigest: digestToken(TOKENS.developer) },
  { id: 'svc:ops', kind: 'service', tenantId: 'acme', roles: ['supervisor'], tokenDigest: digestToken(TOKENS.serviceSupervisor) },
  { id: 'svc:client', kind: 'service', tenantId: 'acme', roles: ['task-client'], tokenDigest: digestToken(TOKENS.taskClient) },
  { id: 'entity-zed', kind: 'human', tenantId: 'globex', roles: ['supervisor'], tokenDigest: digestToken(TOKENS.otherTenant) },
]

const env: CredentialEnv = { QUICKSILVER_PRINCIPALS: JSON.stringify(principals), QUICKSILVER_TENANT_ID: 'acme' }
const bearer = (t: string) => `Bearer ${t}`

test('Decision routes: execute without a credential is 401 (F-2)', () => {
  for (const auth of [null, '', 'Bearer', 'Basic abc', bearer('not-a-known-token-at-all-000000000000')]) {
    const r = checkDecisionRouteCaller('execute', auth, env)
    assert.equal(r.ok, false)
    assert.equal(!r.ok && r.status, 401, `auth=${JSON.stringify(auth)}`)
  }
})

test('Decision routes: execute with the wrong permission, a non-human or another tenant is 403 (F-2)', () => {
  for (const t of [TOKENS.viewer, TOKENS.developer, TOKENS.taskClient, TOKENS.serviceSupervisor, TOKENS.otherTenant]) {
    const r = checkDecisionRouteCaller('execute', bearer(t), env)
    assert.equal(!r.ok && r.status, 403, t)
  }
})

test('Decision routes: execute by a human supervisor succeeds and names the executor (F-2)', () => {
  const r = checkDecisionRouteCaller('execute', bearer(TOKENS.supervisor), env)
  assert.deepEqual(r, { ok: true, principalId: 'entity-ana' })
  // The same check the approval route uses, with decision:execute.
  assert.deepEqual(checkSupervisorCredential(bearer(TOKENS.supervisor), 'decision:execute', env), { ok: true, supervisorId: 'entity-ana' })
})

test('Decision routes: observe and resume need a principal with decision:read or decision:propose (F-2)', () => {
  for (const route of ['observe', 'resume'] as const) {
    const none = checkDecisionRouteCaller(route, null, env)
    assert.equal(!none.ok && none.status, 401, `${route} without a credential`)
    const forbidden = checkDecisionRouteCaller(route, bearer(TOKENS.taskClient), env)
    assert.equal(!forbidden.ok && forbidden.status, 403, `${route} by a task client`)
    const otherTenant = checkDecisionRouteCaller(route, bearer(TOKENS.otherTenant), env)
    assert.equal(!otherTenant.ok && otherTenant.status, 403, `${route} from another tenant`)
    assert.deepEqual(checkDecisionRouteCaller(route, bearer(TOKENS.viewer), env), { ok: true, principalId: 'entity-vic' }, `${route} by a viewer (decision:read)`)
    assert.deepEqual(checkDecisionRouteCaller(route, bearer(TOKENS.developer), env), { ok: true, principalId: 'svc:builder' }, `${route} by a developer (decision:propose)`)
    assert.deepEqual(checkDecisionRouteCaller(route, bearer(TOKENS.supervisor), env), { ok: true, principalId: 'entity-ana' })
  }
})

test('Decision routes: without principals only the shared supervisor token is accepted; unconfigured fails closed', () => {
  const shared = 's'.repeat(40)
  const sharedEnv: CredentialEnv = { NQC_SUPERVISOR_TOKEN: shared, NQC_SUPERVISOR_ID: 'entity-ana' }
  for (const route of ['execute', 'observe', 'resume'] as const) {
    const none = checkDecisionRouteCaller(route, null, sharedEnv)
    assert.equal(!none.ok && none.status, 401, route)
    const wrong = checkDecisionRouteCaller(route, bearer('t'.repeat(40)), sharedEnv)
    assert.equal(!wrong.ok && wrong.status, 401, route)
    assert.deepEqual(checkDecisionRouteCaller(route, bearer(shared), sharedEnv), { ok: true, principalId: 'entity-ana' })
    const unconfigured = checkDecisionRouteCaller(route, bearer(shared), {})
    assert.equal(!unconfigured.ok && unconfigured.status, 503, `${route} with no credential configured`)
  }
  const misconfigured = checkDecisionRouteCaller('observe', bearer(TOKENS.viewer), { QUICKSILVER_PRINCIPALS: '{not json' })
  assert.equal(!misconfigured.ok && misconfigured.status, 503)
})
