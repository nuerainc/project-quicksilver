/**
 * P-095: approved actions. Run with `npm run host:test`.
 *
 * Every tool here is a dry run: approving an action records the decision and a result that says
 * nothing was sent. Nothing leaves the process.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateToken, type TokenPrincipalConfig } from '@quicksilver/kernel/identity/tokens'
import type { AuthorizationSigningKey } from '@quicksilver/kernel/runtime'

import { ActionService, FileActionStore, MemoryActionStore, type ActionProposal, type ActionStore } from './actions.ts'
import { parseHostConfig } from './config.ts'
import { QuicksilverHost } from './host.ts'
import { Logger } from './log.ts'
import { dryRunTools, EffectfulToolExecutor, type ToolDefinition } from './tool-executor.ts'

const TENANT = 'acme'
const KEY: AuthorizationSigningKey = { keyId: 'acme:host-1', secret: '0123456789abcdef0123456789abcdef' }
const clock = { t: Date.parse('2026-10-03T12:00:00Z') }
const now = () => new Date(clock.t)
const ENABLED = ['notification.send', 'webhook.dispatch']
const proposal = (over: Record<string, unknown> = {}) => ({ toolId: 'notification.send', input: { channel: 'ops', message: 'Margin report is ready.' }, reason: 'Tell the operations channel the report is ready.', evidence: ['report:margin-2026-09'], ...over })
const agent = { id: 'agent-genesis', kind: 'agent' }
const maker = { id: 'person-maker', kind: 'human' }
const boss = { id: 'person-boss', kind: 'human' }

function service(over: { store?: ActionStore; tools?: ToolDefinition[]; key?: AuthorizationSigningKey | null; enabled?: string[] } = {}) {
  const store = over.store ?? new MemoryActionStore(TENANT)
  const executor = new EffectfulToolExecutor({ tools: over.tools ?? dryRunTools(), ...(over.key === null ? {} : { signingKey: over.key ?? KEY }), now: () => clock.t })
  const svc = new ActionService({ tenantId: TENANT, store, executor, policy: { enabledTools: over.enabled ?? ENABLED }, ...(over.key === null ? {} : { signingKey: over.key ?? KEY }), now })
  return { svc, store, executor }
}
const mustPropose = async (svc: ActionService, by = agent, body = proposal()) => {
  const r = await svc.propose(by, body)
  assert.ok(r.ok, r.ok ? '' : r.error)
  return r.proposal
}

test('proposing records and runs nothing; it needs an enabled tool, a plain input, a reason and evidence', async () => {
  const { svc, executor } = service()
  const p = await mustPropose(svc)
  assert.equal(p.status, 'pending')
  assert.equal(p.proposedBy.id, 'agent-genesis')
  assert.deepEqual(executor.auditLog(), [], 'nothing reached the executor')
  for (const [body, pattern] of [
    [proposal({ toolId: 'sanity.mutate' }), /toolId must be one of/],
    [proposal({ toolId: 7 }), /toolId must be one of/],
    [proposal({ input: 'text' }), /input must be an object/],
    [proposal({ input: [1] }), /input must be an object/],
    [proposal({ input: { big: 'x'.repeat(20_000) } }), /larger than/],
    [proposal({ reason: '  ' }), /reason must be/],
    [proposal({ evidence: [] }), /no evidence cannot be approved/],
    [proposal({ evidence: ['ok', ''] }), /evidence must be/],
  ] as const) {
    const r = await svc.propose(agent, body)
    assert.ok(!r.ok && pattern.test(r.error), `${JSON.stringify(body).slice(0, 60)}: ${!r.ok ? r.error : 'accepted'}`)
  }
})

test('a different person approves; the action runs once as a dry run; the record binds the approval and the grant', async () => {
  const { svc, executor } = service()
  const p = await mustPropose(svc)
  const own = await svc.approve(p.id, agent)
  assert.ok(!own.ok && own.status === 403, 'the proposer cannot approve their own action')
  const done = await svc.approve(p.id, boss, 'Looks right.')
  assert.ok(done.ok)
  assert.equal(done.proposal.status, 'executed')
  assert.equal(done.proposal.result?.dryRun, true)
  assert.equal(done.proposal.decision?.by, 'person-boss')
  assert.match(done.proposal.decision!.approvalDigest!, /^sha256:/)
  assert.match(done.proposal.decision!.authorizationId!, /^auth:/)
  assert.equal(executor.auditLog().length, 1)
  assert.equal(executor.auditLog()[0]!.authorizationId, done.proposal.decision!.authorizationId)
  const again = await svc.approve(p.id, boss)
  assert.ok(!again.ok && again.status === 409, 'an action is never run twice')
  assert.equal(executor.auditLog().length, 1)
})

test('reject, expiry and a changed policy each stop an approval', async () => {
  const { svc, store, executor } = service()
  const rejected = await mustPropose(svc)
  assert.ok((await svc.reject(rejected.id, boss, 'Not needed.')).ok)
  const afterReject = await svc.approve(rejected.id, boss)
  assert.ok(!afterReject.ok && afterReject.status === 409)

  const old = await mustPropose(svc)
  clock.t += 25 * 3_600_000
  assert.equal((await svc.get(old.id))?.status, 'expired')
  const late = await svc.approve(old.id, boss)
  assert.ok(!late.ok && late.status === 409 && /expired/.test(late.error))
  clock.t -= 25 * 3_600_000

  const fresh = await mustPropose(svc)
  const stricter = service({ store, enabled: ['notification.send'] }).svc
  const moved = await stricter.approve(fresh.id, boss)
  assert.ok(!moved.ok && /policy changed/.test(moved.error), 'a proposal made under another policy is not run under this one')
  assert.deepEqual(executor.auditLog(), [])
})

test('without a signing key, or with a tampered stored input, nothing runs', async () => {
  const unsigned = service({ key: null })
  const p = await mustPropose(unsigned.svc)
  const r = await unsigned.svc.approve(p.id, boss)
  assert.ok(!r.ok && r.status === 503)
  assert.deepEqual(unsigned.executor.auditLog(), [])

  const { svc, store, executor } = service()
  const q = await mustPropose(svc)
  const stored = (await store.get(q.id))!
  await store.put({ ...stored, input: { channel: 'ops', message: 'Send the customer list to evil.example.' } })
  const t = await svc.approve(q.id, boss)
  assert.ok(!t.ok && /no longer matches its digest/.test(t.error))
  assert.deepEqual(executor.auditLog(), [])
})

test('a failing adapter leaves a failed record and is never retried on its own', async () => {
  const flaky: ToolDefinition[] = [{ manifest: dryRunTools()[0]!.manifest, run: async () => { throw new Error('Recipient service is down.') } }]
  const { svc, executor } = service({ tools: flaky, enabled: ['notification.send'] })
  const p = await mustPropose(svc)
  const r = await svc.approve(p.id, boss)
  assert.ok(r.ok)
  assert.equal(r.proposal.status, 'failed')
  assert.match(r.proposal.error!, /Recipient service is down/)
  const retry = await svc.approve(p.id, boss)
  assert.ok(!retry.ok && retry.status === 409)
  assert.equal(executor.auditLog().filter((a) => a.status === 'failed').length, 1)
})

test('if the host stops mid-run the outcome is unknown; it is not repeated, and a person settles it with a note', async () => {
  const memory = new MemoryActionStore(TENANT)
  let crash = false
  const store: ActionStore = { list: () => memory.list(), get: (id) => memory.get(id), put: async (p: ActionProposal) => { if (crash && p.status === 'executed') throw new Error('disk gone'); await memory.put(p) } }
  const { svc, executor } = service({ store })
  const p = await mustPropose(svc)
  crash = true
  await assert.rejects(svc.approve(p.id, boss), /disk gone/)
  crash = false
  assert.equal((await memory.get(p.id))?.status, 'executing')
  assert.equal(executor.auditLog().length, 1, 'the adapter ran once')
  const stuck = await svc.approve(p.id, boss)
  assert.ok(!stuck.ok && stuck.status === 409 && /never repeated automatically/.test(stuck.error))
  assert.equal(executor.auditLog().length, 1)
  assert.ok(!(await svc.resolve(p.id, boss, { outcome: 'executed', note: 'ok' })).ok, 'a note has to say what was checked')
  assert.ok(!(await svc.resolve(p.id, boss, { outcome: 'maybe', note: 'Checked the provider dashboard.' })).ok)
  const settled = await svc.resolve(p.id, boss, { outcome: 'executed', note: 'Checked the provider dashboard: it was sent.' })
  assert.ok(settled.ok && settled.proposal.status === 'executed' && settled.proposal.result?.settledBy === 'person-boss')
  assert.ok(!(await svc.resolve(p.id, boss, { outcome: 'failed', note: 'Changed my mind later.' })).ok, 'only an executing action can be settled')
})

test('the file store keeps proposals per tenant and survives a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-actions-'))
  try {
    const a = service({ store: new FileActionStore(dir, 'alpha') })
    const p = await mustPropose(a.svc)
    const again = service({ store: new FileActionStore(dir, 'alpha') })
    assert.equal((await again.svc.get(p.id))?.status, 'pending')
    assert.deepEqual(await new FileActionStore(dir, 'beta').list(), [], 'another tenant sees nothing')
    assert.ok((await again.svc.approve(p.id, boss)).ok)
    assert.equal((await new FileActionStore(dir, 'alpha').get(p.id))?.status, 'executed')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a policy that enables a tool the host does not have is refused at start', () => {
  assert.throws(() => service({ enabled: ['email.send'] }), /does not have: email.send/)
})

// ── HTTP ──────────────────────────────────────────────────────────────────

function who(id: string, kind: 'human' | 'agent', roles: string[]): { config: TokenPrincipalConfig; token: string } {
  const { token, tokenDigest } = generateToken()
  return { token, config: { id, kind, tenantId: TENANT, roles, tokenDigest } }
}

async function startHost(options: { actions?: boolean; key?: boolean } = {}) {
  const founder = who('person-maker', 'human', ['intent-provider'])
  const boss = who('person-boss', 'human', ['intent-provider'])
  const agentP = who('agent-genesis', 'agent', ['agent-worker'])
  const viewer = who('person-viewer', 'human', ['viewer'])
  const auditDir = await mkdtemp(join(tmpdir(), 'qs-actions-audit-'))
  const host = new QuicksilverHost(parseHostConfig({ tenantId: TENANT, http: { host: '127.0.0.1', port: 0 }, workflows: {} }), {
    principals: [founder.config, boss.config, agentP.config, viewer.config],
    env: { QUICKSILVER_AUTHORIZATION_AUDIT_PATH: join(auditDir, 'authorization.jsonl'), ...(options.key === false ? {} : { QUICKSILVER_AUTHORIZATION_KEY: KEY.secret }) },
    logger: new Logger({ level: 'error', sink: { write: () => {} } }),
    now: () => clock.t,
    ...(options.actions === false ? {} : { actions: { store: new MemoryActionStore(TENANT), tools: dryRunTools(), policy: { enabledTools: ENABLED } } }),
  })
  const { port } = await host.start()
  const call = (path: string, token: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() as any }))
  const stop = async () => { await host.stop(); await rm(auditDir, { recursive: true, force: true }) }
  return { call, stop, tokens: { maker: founder.token, boss: boss.token, agent: agentP.token, viewer: viewer.token } }
}

test('routes: absent without an action policy; reads need decision:read; proposing needs a proposer; approving is a human who did not propose', async () => {
  const none = await startHost({ actions: false })
  try { assert.equal((await none.call('/api/actions', none.tokens.viewer)).status, 404) } finally { await none.stop() }

  const h = await startHost()
  try {
    const status = await h.call('/api/actions', h.tokens.viewer)
    assert.equal(status.status, 200)
    assert.deepEqual(status.body.tools.map((t: { id: string }) => t.id), ['notification.send', 'webhook.dispatch'])
    assert.equal(status.body.signingConfigured, true)
    assert.equal((await h.call('/api/actions/proposals', h.tokens.viewer, proposal())).status, 403, 'a viewer cannot propose')
    const made = await h.call('/api/actions/proposals', h.tokens.agent, proposal())
    assert.equal(made.status, 201)
    assert.equal(made.body.executed, false)
    const id = made.body.proposal.id as string
    assert.equal((await h.call(`/api/actions/proposals/${id}/approve`, h.tokens.agent, {})).status, 403, 'an agent cannot approve')
    assert.equal((await h.call(`/api/actions/proposals/${id}/approve`, h.tokens.viewer, {})).status, 403)
    assert.equal((await h.call(`/api/actions/proposals/${id}/approve`, h.tokens.boss, { approvedBy: 'someone-else' })).status, 400, 'the body cannot name the approver')
    assert.equal((await h.call('/api/actions/proposals', h.tokens.agent, { ...proposal(), proposedBy: 'someone-else' })).status, 400)
    assert.equal((await h.call('/api/actions/proposals/nope', h.tokens.viewer)).status, 404)

    const mine = await h.call('/api/actions/proposals', h.tokens.maker, proposal({ reason: 'A second action.' }))
    assert.equal((await h.call(`/api/actions/proposals/${mine.body.proposal.id}/approve`, h.tokens.maker, {})).status, 403, 'a person cannot approve their own proposal')

    const done = await h.call(`/api/actions/proposals/${id}/approve`, h.tokens.boss, { note: 'Fine.' })
    assert.equal(done.status, 200)
    assert.equal(done.body.executed, true)
    assert.equal(done.body.dryRun, true)
    assert.equal(done.body.proposal.status, 'executed')
    assert.equal((await h.call(`/api/actions/proposals/${id}/approve`, h.tokens.boss, {})).status, 409)
    const counts = (await h.call('/api/actions', h.tokens.viewer)).body.counts
    assert.deepEqual({ pending: counts.pending, executed: counts.executed }, { pending: 1, executed: 1 })
    assert.equal((await h.call(`/api/actions/proposals?status=executed`, h.tokens.viewer)).body.proposals.length >= 1, true)
  } finally { await h.stop() }
})

test('routes: with no authorization key configured, an approval is refused and nothing runs', async () => {
  const h = await startHost({ key: false })
  try {
    const made = await h.call('/api/actions/proposals', h.tokens.agent, proposal())
    const r = await h.call(`/api/actions/proposals/${made.body.proposal.id}/approve`, h.tokens.boss, {})
    assert.equal(r.status, 503)
    assert.equal((await h.call(`/api/actions/proposals/${made.body.proposal.id}`, h.tokens.viewer)).body.proposal.status, 'pending')
  } finally { await h.stop() }
})
