/**
 * The channel gateway (M8 part 4): deny by default, pairing, one
 * conversation per person across channels, approvals in the chat bound to
 * the call, de-duplication, and the platform adapters' parsing and
 * signatures (no network: fetch and sockets are fakes).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { signWebhook } from '@quicksilver/kernel/triggers'

import {
  chunkText, DiscordAdapter, EmailAdapter, Gateway, historyAsContext, PairingRegistry, SlackAdapter, TelegramAdapter, TwilioSmsAdapter, twilioSignature,
  type ChannelAdapter, type InboundMessage, type SocketLike, type TurnRequest,
} from './index.ts'

class TestAdapter implements ChannelAdapter {
  readonly kind = 'test' as const
  sent: Array<{ to: string; text: string }> = []
  private on?: (m: InboundMessage) => void
  readonly id: string
  constructor(id: string) { this.id = id }
  async start(on: (m: InboundMessage) => void) { this.on = on }
  async send(to: string, text: string) { this.sent.push({ to, text }) }
  async stop() {}
  say(senderId: string, text: string, extra: Partial<InboundMessage> = {}) {
    this.on!({ channel: this.id, kind: 'test', senderId, replyTo: `chat-${senderId}`, text, direct: true, ...extra })
  }
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs} ms.`)
    await tick(10)
  }
}

async function setup(turn: (r: TurnRequest) => Promise<{ reply: string }>) {
  const dir = await mkdtemp(join(tmpdir(), 'qs-gw-'))
  const pairing = new PairingRegistry(join(dir, 'pairing.json'))
  await pairing.addPerson({ id: 'entity-founder', name: 'Brodi', canApprove: true })
  const a = new TestAdapter('tg')
  const b = new TestAdapter('sms')
  const gw = new Gateway({ adapters: [a, b], pairing, turn, dir, approvalTimeoutMs: 500 })
  await gw.start()
  return { dir, pairing, a, b, gw }
}

test('gateway: strangers are not heard; a one-time code pairs them; group chats are ignored', async () => {
  const turns: string[] = []
  const { pairing, a, gw } = await setup(async (r) => { turns.push(r.message.text); return { reply: 'ok' } })
  a.say('u1', 'hello?')
  a.say('u1', 'hello again')
  await gw.idle()
  assert.equal(turns.length, 0)
  assert.equal(a.sent.length, 1, 'one instruction, then silence')
  a.say('u1', 'ABCDEFGH')
  await gw.idle()
  assert.match(a.sent.at(-1)!.text, /not valid/)
  const code = await pairing.createCode('entity-founder')
  a.say('u1', code.toLowerCase())
  await gw.idle()
  assert.match(a.sent.at(-1)!.text, /Paired\. Hello Brodi/)
  a.say('u2', code)
  await gw.idle()
  assert.match(a.sent.at(-1)!.text, /not valid/, 'a code works once')
  a.say('u1', 'in a group', { direct: false })
  a.say('u1', 'what is on today?')
  await gw.idle(); await tick()
  assert.deepEqual(turns, ['what is on today?'])
})

test('gateway: one conversation per person across channels, and duplicates are dropped', async () => {
  const seen: TurnRequest[] = []
  const { pairing, a, b, gw } = await setup(async (r) => { seen.push(r); return { reply: `re: ${r.message.text}` } })
  a.say('u1', await pairing.createCode('entity-founder'))
  b.say('+15550001', await pairing.createCode('entity-founder'))
  await gw.idle()
  a.say('u1', 'first', { messageId: 'm1' })
  a.say('u1', 'first', { messageId: 'm1' })
  await gw.idle(); await tick()
  b.say('+15550001', 'second')
  await gw.idle(); await tick()
  assert.equal(seen.length, 2)
  assert.equal(seen[1]!.history.length, 1)
  assert.equal(seen[1]!.history[0]!.channel, 'tg', 'the SMS turn sees the Telegram turn')
  assert.match(historyAsContext(seen[1]!.history), /via tg\] They said: first/)
  assert.equal(b.sent.at(-1)!.text, 're: second')
})

test('pairing: concurrent code writes serialize atomic replacement and persist every code', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-pairing-race-'))
  const path = join(dir, 'pairing.json')
  const pairing = new PairingRegistry(path)
  await pairing.addPerson({ id: 'entity-founder', name: 'Brodi', canApprove: true })
  const codes = await Promise.all(Array.from({ length: 20 }, () => pairing.createCode('entity-founder')))
  assert.equal(new Set(codes).size, 20)
  assert.equal((await pairing.list()).codes.length, 20)
  assert.equal((await new PairingRegistry(path).list()).codes.length, 20, 'all concurrent writes survive reopening')
})

test('gateway: approvals happen in the chat, bound to the call; no answer means no', async () => {
  const answers: Array<{ approved: boolean; bound: boolean }> = []
  const { pairing, a, gw } = await setup(async (r) => {
    const req = { id: 'x', runId: 'r', tool: 'run_command', summary: '$ rm -r dist', callHash: 'sha256:abc', reasons: ['Deletes recursively.'], at: '' }
    const ans = await r.approver(req)
    answers.push({ approved: ans.approved, bound: ans.callHash === req.callHash })
    return { reply: ans.approved ? 'done' : 'skipped' }
  })
  a.say('u1', await pairing.createCode('entity-founder'))
  await gw.idle()
  a.say('u1', 'clean the build')
  await gw.idle(); await tick()
  const prompt = a.sent.at(-1)!.text
  const code = /approve ([A-Z2-9]{4})/.exec(prompt)![1]!
  assert.match(prompt, /rm -r dist/)
  a.say('u1', 'approve ZZZZ')
  await gw.idle()
  assert.match(a.sent.at(-1)!.text, /no approval waiting/)
  a.say('u1', `approve ${code}`)
  await gw.idle(); await tick()
  assert.deepEqual(answers[0], { approved: true, bound: true })
  a.say('u1', 'again')
  await gw.idle(); await tick(700)
  assert.deepEqual(answers[1], { approved: false, bound: true }, 'timeout denies')
})

test('gateway: messages during a run wait their turn', async () => {
  let release!: () => void
  const order: string[] = []
  const { pairing, a, gw } = await setup(async (r) => {
    order.push(r.message.text)
    if (r.message.text === 'slow') await new Promise<void>((res) => { release = res })
    return { reply: 'ok' }
  })
  a.say('u1', await pairing.createCode('entity-founder'))
  await gw.idle()
  a.say('u1', 'slow')
  await gw.idle(); await tick()
  a.say('u1', 'next')
  await gw.idle()
  assert.match(a.sent.at(-1)!.text, /this one is next/)
  release()
  await waitFor(() => order.length === 2)
  assert.deepEqual(order, ['slow', 'next'])
})

test('pairing: wrong codes are rate-limited and codes expire', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-pair-'))
  let now = new Date('2026-09-27T12:00:00Z')
  const p = new PairingRegistry(join(dir, 'p.json'), () => now)
  await p.addPerson({ id: 'e1', name: 'A', canApprove: false })
  const code = await p.createCode('e1')
  now = new Date('2026-09-27T13:01:00Z')
  assert.deepEqual(await p.tryPair('tg', 'x', code), { paired: null, reason: 'invalid' })
  const results = []
  for (let i = 0; i < 8; i++) results.push((await p.tryPair('tg', 'y', 'WRONGCDE')).paired === null ? (await p.tryPair('tg', 'y', 'WRONGCDE') as any).reason : 'paired')
  assert.ok(results.includes('rate-limited'))
  await assert.rejects(p.createCode('nobody'))
})

test('adapters: Telegram updates, Slack envelopes (acknowledged), Discord identify and heartbeat', async () => {
  const u = { update_id: 7, message: { text: 'hi', from: { id: 42, first_name: 'Bo' }, chat: { id: 42, type: 'private' } } }
  assert.deepEqual(TelegramAdapter.toMessage(u), { channel: 'telegram', kind: 'telegram', senderId: '42', senderName: 'Bo', replyTo: '42', text: 'hi', messageId: '7', direct: true })
  assert.equal(TelegramAdapter.toMessage({ update_id: 8, message: { text: 'x', from: { id: 1, is_bot: true }, chat: { id: 1, type: 'private' } } }), null)
  const calls: string[] = []
  const tg = new TelegramAdapter({ token: `123:${'a'.repeat(35)}`, fetch: async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ result: [u] }), text: async () => '' } } })
  const got: InboundMessage[] = []
  await tg.pollOnce((m) => got.push(m), 0)
  assert.equal(got.length, 1)
  await tg.pollOnce(() => undefined, 0)
  assert.match(calls[1]!, /offset=8/, 'the offset moves past handled updates')

  const sock = (): SocketLike & { out: string[] } => ({ out: [], send(d: string) { this.out.push(d) }, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null })
  const s = sock()
  const slack = new SlackAdapter({ appToken: 'xapp-1', botToken: 'xoxb-1', socket: () => s, fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, url: 'wss://x' }), text: async () => '' }) })
  const sm: InboundMessage[] = []
  await slack.start((m) => sm.push(m))
  s.onmessage!({ data: JSON.stringify({ envelope_id: 'e1', type: 'events_api', payload: { event: { type: 'message', user: 'U1', text: 'yo', channel: 'D1', channel_type: 'im', ts: '1.1' } } }) })
  s.onmessage!({ data: JSON.stringify({ envelope_id: 'e2', type: 'events_api', payload: { event: { type: 'message', bot_id: 'B', text: 'me', channel: 'D1' } } }) })
  assert.deepEqual(s.out.map((x) => JSON.parse(x).envelope_id), ['e1', 'e2'], 'every envelope is acknowledged')
  assert.equal(sm.length, 1)
  assert.equal(sm[0]!.direct, true)
  await slack.stop()

  const d = sock()
  const discord = new DiscordAdapter({ token: 'x'.repeat(60), socket: () => d })
  const dm: InboundMessage[] = []
  await discord.start((m) => dm.push(m))
  d.onmessage!({ data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60000 } }) })
  assert.equal(JSON.parse(d.out[0]!).op, 2, 'identifies after hello')
  d.onmessage!({ data: JSON.stringify({ op: 0, s: 3, t: 'MESSAGE_CREATE', d: { id: '9', channel_id: 'C', content: 'hey', author: { id: '5', username: 'bo' } } }) })
  d.onmessage!({ data: JSON.stringify({ op: 1 }) })
  assert.deepEqual(JSON.parse(d.out.at(-1)!), { op: 1, d: 3 }, 'heartbeats carry the last sequence')
  assert.equal(dm[0]!.direct, true)
  await discord.stop()
})

test('adapters: Twilio and inbound email webhooks are verified before anything is heard', async () => {
  const tw = new TwilioSmsAdapter({ accountSid: `AC${'0'.repeat(32)}`, authToken: 'secret-token', from: '+15550000', webhookUrl: 'https://gw.example.com/inbound/sms' })
  const heard: InboundMessage[] = []
  await tw.start((m) => heard.push(m))
  const body = new URLSearchParams({ From: '+15551234', Body: 'hello', MessageSid: 'SM1' }).toString()
  assert.equal(tw.receive(body, 'bad').status, 403)
  const sig = twilioSignature('secret-token', 'https://gw.example.com/inbound/sms', { From: '+15551234', Body: 'hello', MessageSid: 'SM1' })
  assert.equal(tw.receive(body, sig).status, 200)
  assert.equal(heard[0]!.senderId, '+15551234')

  const secret = 's'.repeat(40)
  const mail = new EmailAdapter({ from: 'op@example.com', apiKey: 'k', inboundSecret: secret })
  const mailHeard: InboundMessage[] = []
  await mail.start((m) => mailHeard.push(m))
  const raw = JSON.stringify({ from: 'Bo <Bo@Example.com>', subject: 'Report', text: 'Send me the report.\n\nOn Mon, someone wrote:\n> old text', messageId: 'x1' })
  const ts = Math.floor(Date.now() / 1000)
  assert.equal(mail.receive(raw, String(ts), 'nope').status, 403)
  assert.equal(mail.receive(raw, String(ts - 3600), signWebhook(secret, ts - 3600, raw)).status, 403, 'old deliveries are refused')
  assert.equal(mail.receive(raw, String(ts), signWebhook(secret, ts, raw)).status, 200)
  assert.deepEqual([mailHeard[0]!.senderId, mailHeard[0]!.text], ['bo@example.com', 'Send me the report.'])
})

test('long replies are split at natural breaks', () => {
  const parts = chunkText(`${'a'.repeat(30)}\n\n${'b'.repeat(30)}`, 40)
  assert.deepEqual(parts, ['a'.repeat(30), 'b'.repeat(30)])
})
