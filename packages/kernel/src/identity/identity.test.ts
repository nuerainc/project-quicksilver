/**
 * Identity, RBAC, token authentication, and queue access control. Run with:
 *   node --experimental-strip-types --no-warnings --test packages/kernel/src/identity/identity.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  AccessController,
  AccessDeniedError,
  AUTHORITY_PERMISSIONS,
  BUILT_IN_ROLES,
  PERMISSIONS,
  type AccessDecision,
  type Principal,
  type WorkflowGraph,
} from '../index.ts'
import { StaticTokenIdentityProvider, digestToken, generateToken, principalsFromJson, MIN_TOKEN_LENGTH } from './tokens.ts'
import { InMemoryWorkflowRunStore, WorkflowRunQueue } from '../runtime/index.ts'

const ana: Principal = { id: 'user:ana@acme.com', kind: 'human', tenantId: 'acme', roles: ['supervisor'] }
const dev: Principal = { id: 'user:dev@acme.com', kind: 'human', tenantId: 'acme', roles: ['developer'] }
const viewer: Principal = { id: 'user:val@acme.com', kind: 'human', tenantId: 'acme', roles: ['viewer'] }
const hook: Principal = { id: 'svc:erp-webhook', kind: 'service', tenantId: 'acme', roles: ['trigger'] }
const agent: Principal = { id: 'agent:nuera-quicksilver:query', kind: 'agent', tenantId: 'acme', roles: ['agent-worker', 'supervisor'] }
const rival: Principal = { id: 'user:eve@globex.com', kind: 'human', tenantId: 'globex', roles: ['supervisor', 'tenant-admin'] }
const acme = { tenantId: 'acme' }

// ── RBAC ──────────────────────────────────────────────────────────────────

test('RBAC: built-in roles only reference known permissions', () => {
  const known = new Set<string>(PERMISSIONS)
  for (const role of BUILT_IN_ROLES) for (const p of role.permissions) assert.ok(known.has(p), `${role.id}:${p}`)
})

test('RBAC: deny by default, allow only through a granting role', () => {
  const access = new AccessController()
  assert.equal(access.authorize(viewer, 'run:read', acme).allowed, true)
  const denied = access.authorize(viewer, 'run:enqueue', acme)
  assert.equal(denied.allowed, false)
  assert.match(denied.reasons[0]!, /No role grants "run:enqueue"/)
  assert.deepEqual(access.authorize(dev, 'run:enqueue', acme).grantedBy, ['developer'])
  assert.equal(access.authorize(undefined, 'run:read', acme).allowed, false)
  assert.equal(access.authorize({ ...viewer, roles: ['nonexistent'] }, 'run:read', acme).allowed, false)
  assert.equal(access.authorize(viewer, 'root:everything' as 'run:read', acme).allowed, false)
})

test('RBAC: tenants are hard boundaries, even for supervisors and admins', () => {
  const access = new AccessController()
  for (const permission of ['run:read', 'decision:approve', 'secret:read', 'tenant:admin'] as const) {
    const decision = access.authorize(rival, permission, acme)
    assert.equal(decision.allowed, false, permission)
    assert.ok(decision.reasons.some((r) => r.includes('different tenants')))
  }
})

test('RBAC: agents never gain authority, even if a role would grant it', () => {
  const access = new AccessController()
  for (const permission of AUTHORITY_PERMISSIONS) {
    const decision = access.authorize(agent, permission, acme)
    assert.equal(decision.allowed, false, permission)
  }
  assert.equal(access.authorize(agent, 'decision:propose', acme).allowed, true)
  assert.equal(access.effectivePermissions(agent).has('decision:approve'), false)
})

test('RBAC: separation of duties blocks self-approval', () => {
  const access = new AccessController()
  const self = access.authorize(ana, 'decision:approve', { ...acme, requestedBy: ana.id, id: 'dec-1' })
  assert.equal(self.allowed, false)
  assert.match(self.reasons.join(' '), /Separation of duties/)
  assert.equal(access.authorize(ana, 'decision:approve', { ...acme, requestedBy: dev.id }).allowed, true)
  assert.equal(access.authorize(ana, 'run:cancel', { ...acme, requestedBy: ana.id }).allowed, true, 'cancelling your own run is fine')
})

test('RBAC: disabled and malformed principals are refused', () => {
  const access = new AccessController()
  assert.equal(access.authorize({ ...ana, disabled: true }, 'run:read', acme).allowed, false)
  assert.equal(access.authorize({ ...ana, id: '' }, 'run:read', acme).allowed, false)
  assert.equal(access.authorize({ ...ana, kind: 'root' as 'human' }, 'run:read', acme).allowed, false)
  assert.equal(access.authorize({ ...ana, roles: ['Supervisor!'] }, 'run:read', acme).allowed, false)
  assert.equal(access.authorize(ana, 'run:read', { tenantId: '' }).allowed, false)
})

test('RBAC: custom roles are tenant-scoped and cannot shadow built-ins', () => {
  const access = new AccessController({ customRoles: [{ id: 'release-manager', tenantId: 'acme', description: 'Publish workflows', permissions: ['workflow:read', 'workflow:publish'] }] })
  const rm: Principal = { id: 'user:rm@acme.com', kind: 'human', tenantId: 'acme', roles: ['release-manager'] }
  assert.equal(access.authorize(rm, 'workflow:publish', acme).allowed, true)
  const outsider: Principal = { ...rm, id: 'user:rm@globex.com', tenantId: 'globex' }
  assert.equal(access.authorize(outsider, 'workflow:publish', { tenantId: 'globex' }).allowed, false, 'acme role does not exist in globex')
  assert.throws(() => access.defineRole({ id: 'supervisor', tenantId: 'acme', description: 'x', permissions: ['run:read'] }), /built-in/)
  assert.throws(() => access.defineRole({ id: 'global', description: 'x', permissions: ['run:read'] }), /one tenant/)
  assert.throws(() => access.defineRole({ id: 'bad', tenantId: 'acme', description: 'x', permissions: ['everything' as 'run:read'] }), /unknown permission/)
  assert.throws(() => access.defineRole({ id: 'release-manager', tenantId: 'acme', description: 'x', permissions: ['run:read'] }), /already exists/)
})

test('RBAC: every decision reaches the audit sink, and a failing sink changes nothing', () => {
  const log: AccessDecision[] = []
  const access = new AccessController({ audit: (d) => log.push(d), now: () => 42 })
  access.authorize(ana, 'run:redrive', { ...acme, id: 'run-9', kind: 'workflow-run' })
  access.authorize(viewer, 'run:redrive', acme)
  assert.deepEqual(log.map((d) => [d.principalId, d.permission, d.allowed, d.at]), [[ana.id, 'run:redrive', true, 42], [viewer.id, 'run:redrive', false, 42]])
  assert.equal(log[0]!.resourceId, 'run-9')
  const noisy = new AccessController({ audit: () => { throw new Error('sink down') } })
  assert.equal(noisy.authorize(ana, 'run:read', acme).allowed, true)
})

test('RBAC: assert throws AccessDeniedError carrying the decision', () => {
  const access = new AccessController()
  assert.throws(() => access.assert(viewer, 'secret:read', acme), (error: unknown) => error instanceof AccessDeniedError && error.decision.permission === 'secret:read')
})

// ── tokens ────────────────────────────────────────────────────────────────

test('Tokens: only digests are stored; authentication is exact and returns a copy', () => {
  const { token, tokenDigest } = generateToken()
  assert.ok(token.length >= MIN_TOKEN_LENGTH)
  assert.equal(tokenDigest, digestToken(token))
  const provider = new StaticTokenIdentityProvider([{ ...ana, tokenDigest }])
  const principal = provider.authenticate(token)
  assert.equal(principal?.id, ana.id)
  assert.equal('tokenDigest' in (principal ?? {}), false)
  ;(principal!.roles as string[]).push('tenant-admin')
  assert.deepEqual(provider.authenticate(token)?.roles, ['supervisor'], 'callers cannot mutate the registry')
  assert.equal(provider.authenticate(`${token}x`), undefined)
  assert.equal(provider.authenticate('short'), undefined)
  assert.equal(provider.authenticate(undefined), undefined)
  assert.equal(provider.authenticateHeader(`Bearer ${token}`)?.id, ana.id)
  assert.equal(provider.authenticateHeader(`Basic ${token}`), undefined)
  assert.equal(provider.authenticateHeader(null), undefined)
})

test('Tokens: disabled principals, shared tokens, duplicates, and bad digests are refused', () => {
  const a = generateToken()
  const provider = new StaticTokenIdentityProvider([{ ...ana, disabled: true, tokenDigest: a.tokenDigest }])
  assert.equal(provider.authenticate(a.token), undefined)
  assert.throws(() => provider.add({ ...dev, tokenDigest: a.tokenDigest }), /share a token/)
  assert.throws(() => provider.add({ ...ana, tokenDigest: generateToken().tokenDigest }), /already registered/)
  assert.throws(() => provider.add({ ...dev, tokenDigest: 'plaintext-token' }), /tokenDigest/)
})

test('Tokens: JSON configuration fails loudly instead of granting access', () => {
  assert.deepEqual(principalsFromJson(undefined), [])
  assert.throws(() => principalsFromJson('{not json'), /not valid JSON/)
  assert.throws(() => principalsFromJson('{"id":"x"}'), /JSON array/)
  const { tokenDigest } = generateToken()
  assert.equal(principalsFromJson(JSON.stringify([{ ...dev, tokenDigest }]))[0]!.id, dev.id)
})

// ── queue access control ──────────────────────────────────────────────────

const graph: WorkflowGraph = {
  schemaVersion: 1, id: 'wf', version: 1, entryNodeId: 'start',
  nodes: [
    { id: 'start', kind: 'trigger', label: 'Start' },
    { id: 'agent-1', kind: 'agent', label: 'Agent', config: { agentId: 'nuera-quicksilver:query', evaluationRequired: true } },
    { id: 'done', kind: 'output', label: 'Done' },
  ],
  edges: [{ id: 'e1', from: 'start', to: 'agent-1' }, { id: 'e2', from: 'agent-1', to: 'done' }],
}

function securedQueue() {
  const audit: AccessDecision[] = []
  let ids = 0
  const queue = new WorkflowRunQueue({ store: new InMemoryWorkflowRunStore(), access: new AccessController({ audit: (d) => audit.push(d) }), newRunId: () => `run-${++ids}`, defaultMaxAttempts: 1 })
  return { queue, audit }
}

test('Queue ACL: enqueue needs an authorized principal of the same tenant', async () => {
  const { queue } = securedQueue()
  const anonymous = await queue.enqueue({ graph, input: 1, tenantId: 'acme' })
  assert.equal(!anonymous.accepted && anonymous.code, 'forbidden')
  const wrongRole = await queue.enqueue({ graph, input: 1, tenantId: 'acme', principal: viewer })
  assert.equal(!wrongRole.accepted && wrongRole.code, 'forbidden')
  const wrongTenant = await queue.enqueue({ graph, input: 1, tenantId: 'acme', principal: rival })
  assert.equal(!wrongTenant.accepted && wrongTenant.code, 'forbidden')
  const ok = await queue.enqueue({ graph, input: 1, tenantId: 'acme', principal: hook, trigger: { kind: 'webhook', source: 'erp' } })
  assert.ok(ok.accepted)
  assert.equal(ok.accepted && ok.run.requestedBy, hook.id)
  assert.equal((await queue.store.events('run-1'))[0]!.actor, hook.id)
})

test('Queue ACL: cancel and redrive need principals; denials are recorded on the run', async () => {
  const { queue } = securedQueue()
  await queue.enqueue({ graph, input: 1, tenantId: 'acme', principal: dev })
  await assert.rejects(queue.cancel('run-1', 'ops@acme'), /authenticated principal/)
  await assert.rejects(queue.cancel('run-1', viewer), AccessDeniedError)
  await assert.rejects(queue.cancel('run-1', rival), AccessDeniedError)
  const denied = (await queue.store.events('run-1')).filter((e) => e.type === 'access-denied')
  assert.deepEqual(denied.map((e) => e.actor), [viewer.id, rival.id])

  await queue.claim('worker-1')
  await queue.complete('run-1', 'worker-1', { status: 'failed', outputs: {}, steps: [], error: 'down' })
  assert.equal((await queue.get('run-1'))?.status, 'dead-lettered')
  await assert.rejects(queue.redrive('run-1', dev, 'retry please'), AccessDeniedError, 'developers cannot redrive')
  await assert.rejects(queue.redrive('run-1', agent, 'retry'), AccessDeniedError, 'agents cannot redrive')
  const redriven = await queue.redrive('run-1', ana, 'provider restored')
  assert.equal(redriven.status, 'queued')
  assert.equal((await queue.store.events('run-1')).at(-1)?.actor, ana.id)
  const cancelled = await queue.cancel('run-1', dev, 'no longer needed')
  assert.equal(cancelled?.status, 'cancelled')
  assert.equal(cancelled?.cancelRequest?.actor, dev.id)
})

test('Queue ACL: without an access controller, named actors still work (local development)', async () => {
  const queue = new WorkflowRunQueue({ store: new InMemoryWorkflowRunStore(), newRunId: () => 'run-x' })
  await queue.enqueue({ graph, input: 1, tenantId: 'acme' })
  assert.equal((await queue.cancel('run-x', 'ops@acme'))?.status, 'cancelled')
  const malformed = await queue.enqueue({ graph, input: 2, tenantId: 'acme', principal: { id: '', kind: 'human', tenantId: 'acme', roles: [] } })
  assert.equal(!malformed.accepted && malformed.code, 'invalid-request')
})
