import { test } from 'node:test'
import assert from 'node:assert/strict'

import { signWebhook } from '@quicksilver/kernel/triggers'

import { ActionService, MemoryActionStore } from './actions.ts'
import { emailRecipientAllowed, isPrivateAddress, resendNotificationTool, signedWebhookTool, type HttpFetch } from './tool-adapters.ts'
import { dryRunTools, EffectfulToolExecutor, type ToolCall } from './tool-executor.ts'

// No network: every call goes to a fake that records what it was asked.

interface Sent { url: string; headers: Record<string, string>; body: string; redirect: string }
function fakeHttp(answer: { status?: number; body?: string } | Error = {}) {
  const sent: Sent[] = []
  const fetcher: HttpFetch = async (url, init) => {
    sent.push({ url, headers: init.headers, body: init.body, redirect: init.redirect })
    if (answer instanceof Error) throw answer
    return { status: answer.status ?? 200, text: async () => answer.body ?? '{}' }
  }
  return { fetcher, sent }
}

const API_KEY = 're_' + 'k'.repeat(24)
const SECRET = 'webhook-signing-secret-0123456789abcdef'
const call = (toolId: string, input: unknown): ToolCall => ({ toolId, input, tenantId: 'acme', runId: 'ap-1', nodeId: 'action', idempotencyKey: 'ap-1' })

// ── Email ─────────────────────────────────────────────────────────────────

test('email: only addresses on the list qualify, and look-alikes do not', () => {
  const list = ['ops@example.com', '@team.example.org']
  assert.equal(emailRecipientAllowed('OPS@example.com', list), true)
  assert.equal(emailRecipientAllowed('anyone@team.example.org', list), true)
  for (const bad of ['boss@example.com', 'a@evil.team.example.org', 'a@team.example.org.evil.com', 'x@y@team.example.org', 'ops@example.com, spy@evil.com', 'Ops <ops@example.com>', '', 'ops@example']) {
    assert.equal(emailRecipientAllowed(bad, list), false, bad)
  }
})

test('email: a valid call posts once to Resend with the key, the idempotency key and one allowed recipient', async () => {
  const http = fakeHttp({ body: '{"id":"msg_123"}' })
  const tool = resendNotificationTool({ apiKey: API_KEY, from: 'quicksilver@example.com', recipients: ['ops@example.com'], fetcher: http.fetcher })
  const out = await tool.run(call('notification.send', { to: 'Ops@Example.com', subject: 'Report ready', text: 'The margin report is ready.' })) as Record<string, unknown>
  assert.equal(http.sent.length, 1)
  assert.equal(http.sent[0]!.url, 'https://api.resend.com/emails')
  assert.equal(http.sent[0]!.headers.authorization, `Bearer ${API_KEY}`)
  assert.equal(http.sent[0]!.headers['idempotency-key'], 'ap-1')
  assert.equal(http.sent[0]!.redirect, 'error')
  assert.deepEqual(JSON.parse(http.sent[0]!.body), { from: 'quicksilver@example.com', to: ['ops@example.com'], subject: 'Report ready', text: 'The margin report is ready.' })
  assert.deepEqual({ executed: out.executed, dryRun: out.dryRun, messageId: out.messageId }, { executed: true, dryRun: false, messageId: 'msg_123' })
  assert.ok(!JSON.stringify(out).includes(API_KEY), 'the key is never in a result')
})

test('email: a recipient off the list, a multi-line subject or an oversized body never reaches the network', async () => {
  const http = fakeHttp()
  const tool = resendNotificationTool({ apiKey: API_KEY, from: 'quicksilver@example.com', recipients: ['ops@example.com'], fetcher: http.fetcher })
  for (const input of [
    { to: 'customer@gmail.com', subject: 's', text: 't' },
    { to: 'ops@example.com', subject: 'a\nBcc: spy@evil.com', text: 't' },
    { to: 'ops@example.com', subject: '', text: 't' },
    { to: 'ops@example.com', subject: 's', text: 'x'.repeat(5001) },
    { to: ['ops@example.com'], subject: 's', text: 't' },
  ]) {
    assert.ok(tool.validate!(input), JSON.stringify(input).slice(0, 50))
    await assert.rejects(tool.run(call('notification.send', input)))
  }
  assert.equal(http.sent.length, 0)
})

test('email: a provider error or a dropped connection is a failure that names no secret', async () => {
  const rejected = resendNotificationTool({ apiKey: API_KEY, from: 'quicksilver@example.com', recipients: ['ops@example.com'], fetcher: fakeHttp({ status: 403 }).fetcher })
  await assert.rejects(rejected.run(call('notification.send', { to: 'ops@example.com', subject: 's', text: 't' })), (e: Error) => /HTTP 403/.test(e.message) && !e.message.includes(API_KEY))
  const dropped = resendNotificationTool({ apiKey: API_KEY, from: 'quicksilver@example.com', recipients: ['ops@example.com'], fetcher: fakeHttp(new Error(`socket closed ${API_KEY}`)).fetcher })
  await assert.rejects(dropped.run(call('notification.send', { to: 'ops@example.com', subject: 's', text: 't' })), (e: Error) => /may or may not have been delivered/.test(e.message) && !e.message.includes(API_KEY))
  assert.throws(() => resendNotificationTool({ apiKey: '', from: 'a@b.co', recipients: ['a@b.co'] }), /needs an API key/)
  assert.throws(() => resendNotificationTool({ apiKey: API_KEY, from: 'a@b.co', recipients: [] }), /at least one allowed recipient/)
})

// ── Webhook ───────────────────────────────────────────────────────────────

const publicResolver = async () => ['93.184.216.34']
const hook = (over: Partial<Parameters<typeof signedWebhookTool>[0]> = {}, http = fakeHttp()) =>
  ({ http, tool: signedWebhookTool({ allowedHosts: ['hooks.example.com'], signingSecret: SECRET, fetcher: http.fetcher, resolver: publicResolver, now: () => 1_780_000_000_000, ...over }) })

test('webhook: a valid call posts once, signed so the receiver can verify it, to the allowed host only', async () => {
  const { http, tool } = hook()
  const out = await tool.run(call('webhook.dispatch', { url: 'https://hooks.example.com/quicksilver', payload: { report: 'margin', ready: true }, eventType: 'report.ready' })) as Record<string, unknown>
  assert.equal(http.sent.length, 1)
  const sent = http.sent[0]!
  assert.equal(sent.url, 'https://hooks.example.com/quicksilver')
  assert.equal(sent.redirect, 'error')
  assert.equal(sent.headers['idempotency-key'], 'ap-1')
  assert.equal(sent.headers['x-quicksilver-timestamp'], '1780000000')
  assert.equal(sent.headers['x-quicksilver-signature'], signWebhook(SECRET, 1_780_000_000, sent.body), 'the receiver can recompute it')
  assert.deepEqual(JSON.parse(sent.body), { eventType: 'report.ready', actionId: 'ap-1', payload: { report: 'margin', ready: true } })
  assert.deepEqual({ executed: out.executed, dryRun: out.dryRun, targetHost: out.targetHost }, { executed: true, dryRun: false, targetHost: 'hooks.example.com' })
  assert.ok(!JSON.stringify(out).includes(SECRET))
})

test('webhook: anything that could aim it somewhere else is refused before any request', async () => {
  const { http, tool } = hook()
  const payload = { a: 1 }
  for (const url of [
    'http://hooks.example.com/x', 'https://evil.example.net/x', 'https://hooks.example.com.evil.net/x', 'https://user:pw@hooks.example.com/x',
    'https://hooks.example.com:8443/x', 'https://127.0.0.1/x', 'https://[::1]/x', 'https://169.254.169.254/latest/meta-data', 'file:///etc/passwd', 'not a url',
  ]) {
    assert.ok(tool.validate!({ url, payload }), url)
    await assert.rejects(tool.run(call('webhook.dispatch', { url, payload })), (e: Error) => e instanceof Error, url)
  }
  assert.ok(tool.validate!({ url: 'https://hooks.example.com/x', payload: [1] }))
  assert.ok(tool.validate!({ url: 'https://hooks.example.com/x', payload: { big: 'x'.repeat(20_000) } }))
  assert.ok(tool.validate!({ url: 'https://hooks.example.com/x', payload, eventType: 'a b' }))
  assert.equal(http.sent.length, 0)
})

test('webhook: an allowed host that resolves to a private address is refused; so is one that does not resolve', async () => {
  for (const addresses of [['10.0.0.5'], ['93.184.216.34', '127.0.0.1'], ['::1'], ['::ffff:192.168.1.1'], ['fd00::1'], []]) {
    const { http, tool } = hook({ resolver: async () => addresses })
    await assert.rejects(tool.run(call('webhook.dispatch', { url: 'https://hooks.example.com/x', payload: {} })), /private or reserved address/)
    assert.equal(http.sent.length, 0)
  }
  const { http, tool } = hook({ resolver: async () => { throw new Error('ENOTFOUND') } })
  await assert.rejects(tool.run(call('webhook.dispatch', { url: 'https://hooks.example.com/x', payload: {} })), /could not be resolved/)
  assert.equal(http.sent.length, 0)
  for (const a of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '127.0.0.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::', '::1', 'fe80::1', 'fc00::1']) assert.equal(isPrivateAddress(a), true, a)
  for (const a of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:4700::1111']) assert.equal(isPrivateAddress(a), false, a)
})

test('webhook: a receiver error is a failure; bad settings are refused at start', async () => {
  const { tool } = hook({}, fakeHttp({ status: 500 }))
  await assert.rejects(tool.run(call('webhook.dispatch', { url: 'https://hooks.example.com/x', payload: {} })), /answered HTTP 500/)
  assert.throws(() => signedWebhookTool({ allowedHosts: ['hooks.example.com'], signingSecret: 'short' }), /at least 32/)
  for (const hosts of [[], ['*.example.com'], ['10.0.0.1'], ['bad host']]) assert.throws(() => signedWebhookTool({ allowedHosts: hosts, signingSecret: SECRET }), /exact hostnames/)
})

// ── Through the approval path ─────────────────────────────────────────────

test('approved actions: real adapters are marked live, reject unrunnable proposals up front, and send exactly once on approval', async () => {
  const http = fakeHttp({ body: '{"id":"msg_9"}' })
  const email = resendNotificationTool({ apiKey: API_KEY, from: 'quicksilver@example.com', recipients: ['ops@example.com'], fetcher: http.fetcher })
  const tools = [email, ...dryRunTools().filter((t) => t.manifest.id !== 'notification.send')]
  const key = { keyId: 'acme:host-1', secret: '0123456789abcdef0123456789abcdef' }
  const build = (list = tools) => new ActionService({ tenantId: 'acme', store, executor: new EffectfulToolExecutor({ tools: list, signingKey: key }), policy: { enabledTools: ['notification.send', 'webhook.dispatch'] }, signingKey: key })
  const store = new MemoryActionStore('acme')
  const svc = build()
  assert.deepEqual(svc.summary().tools.map((t) => [t.id, t.live]), [['notification.send', true], ['webhook.dispatch', false]])

  const bad = await svc.propose({ id: 'agent-genesis', kind: 'agent' }, { toolId: 'notification.send', input: { to: 'customer@gmail.com', subject: 's', text: 't' }, reason: 'Tell the customer.', evidence: ['x'] })
  assert.ok(!bad.ok && /allowed recipients/.test(bad.error), 'nobody is asked to approve something that cannot run')

  const ok = await svc.propose({ id: 'agent-genesis', kind: 'agent' }, { toolId: 'notification.send', input: { to: 'ops@example.com', subject: 'Report ready', text: 'The report is ready.' }, reason: 'Tell ops.', evidence: ['report:1'] })
  assert.ok(ok.ok)
  assert.equal(http.sent.length, 0, 'proposing sends nothing')
  const done = await svc.approve(ok.proposal.id, { id: 'person-boss' })
  assert.ok(done.ok && done.proposal.status === 'executed')
  assert.equal(done.proposal.result?.dryRun, undefined, 'a real send is not labeled a dry run')
  assert.equal(http.sent.length, 1)
  const again = await svc.approve(ok.proposal.id, { id: 'person-boss' })
  assert.ok(!again.ok)
  assert.equal(http.sent.length, 1, 'approving twice sends once')

  // Changing who may be emailed changes the policy in force, so a pending proposal made before is stale.
  const pending = await svc.propose({ id: 'agent-genesis', kind: 'agent' }, { toolId: 'notification.send', input: { to: 'ops@example.com', subject: 'Second', text: 'Again.' }, reason: 'Tell ops.', evidence: ['report:2'] })
  assert.ok(pending.ok)
  const wider = build([resendNotificationTool({ apiKey: API_KEY, from: 'quicksilver@example.com', recipients: ['ops@example.com', '@example.com'], fetcher: http.fetcher }), ...dryRunTools().filter((t) => t.manifest.id !== 'notification.send')])
  const stale = await wider.approve(pending.proposal.id, { id: 'person-boss' })
  assert.ok(!stale.ok && /policy changed/.test(stale.error))
  assert.equal(http.sent.length, 1)
})
