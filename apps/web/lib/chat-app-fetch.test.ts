/**
 * The chat assistant's window onto the app: route handlers run in this process with the
 * asking person's credentials. These calls go through the real route modules, so the checks
 * that decide what a person may see are the ones under test.
 */
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { test } from 'node:test'

import { digestToken } from '../../../packages/kernel/src/identity/tokens.ts'
import { setAuthorizationAuditAppender } from './authorization-audit-store.ts'

setAuthorizationAuditAppender(async () => 'test-authorization-audit-record')
register('./route-test-loader.mjs', import.meta.url)

const token = (name: string) => `${name}-${'c'.repeat(40)}`
const TOKENS = { viewer: token('viewer'), supervisor: token('supervisor') }
process.env.QUICKSILVER_TENANT_ID = 'acme'
process.env.QUICKSILVER_PRINCIPALS = JSON.stringify([
  { id: 'entity-vic', kind: 'human', tenantId: 'acme', roles: ['viewer'], tokenDigest: digestToken(TOKENS.viewer) },
  { id: 'entity-ana', kind: 'human', tenantId: 'acme', roles: ['supervisor'], tokenDigest: digestToken(TOKENS.supervisor) },
])
for (const name of ['NEXT_PUBLIC_SANITY_PROJECT_ID', 'SANITY_AUTH_TOKEN', 'SANITY_READ_TOKEN', 'SANITY_WRITE_TOKEN', 'NQC_SUPERVISOR_TOKEN']) delete process.env[name]

const as = async (authorization: string | null) => {
  const { appFetchFor } = await import('./chat-app-fetch.ts')
  return appFetchFor(new Request('http://localhost:3000/api/chat', { method: 'POST', headers: authorization ? { authorization } : {} }))
}

test('the assistant sees who the person is and what they may do', async () => {
  const result = await (await as(`Bearer ${TOKENS.viewer}`))('/api/whoami')
  assert.equal(result.status, 200)
  const body = result.body as { principalId: string; permissions: string[] }
  assert.equal(body.principalId, 'entity-vic')
  assert.ok(body.permissions.includes('decision:read'))
  assert.ok(!body.permissions.includes('decision:approve'))
})

test('a read the person is not permitted is refused with what they need, so the assistant cannot get around it', async () => {
  const result = await (await as(`Bearer ${TOKENS.viewer}`))('/api/dashboard/finance')
  assert.equal(result.status, 403)
  assert.deepEqual((result.body as { needs: string[] }).needs, ['finance:read'])
})

test('a permitted read passes the person\'s check and then reaches the data layer', async () => {
  const result = await (await as(`Bearer ${TOKENS.supervisor}`))('/api/decisions?limit=5')
  assert.notEqual(result.status, 401)
  assert.notEqual(result.status, 403)
})

test('with no credentials every read is refused as not signed in', async () => {
  const fetchApp = await as(null)
  for (const path of ['/api/decisions', '/api/decisions/decision-plan-1-0', '/api/dashboard/overview', '/api/monitoring/traces', '/api/agents/catalog', '/api/entities']) {
    assert.equal((await fetchApp(path)).status, 401, path)
  }
})

test('anything that is not one of the listed reads is not served: no writes, no model routes, no other paths', async () => {
  const fetchApp = await as(`Bearer ${TOKENS.supervisor}`)
  for (const path of ['/api/plan', '/api/chat', '/api/workflows/run', '/api/decisions/decision-plan-1-0/action', '/api/decisions/a/b', '/api/agents/drafts', '/api/auth/logout', '/studio', '/api/../etc']) {
    assert.equal((await fetchApp(path)).status, 404, path)
  }
})
