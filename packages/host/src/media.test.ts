/**
 * P-025: media. Run with `npm run host:test`.
 *
 * No real provider exists here. Every call goes to a scriptable fake that records what it was asked.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateToken, type TokenPrincipalConfig } from '@quicksilver/kernel/identity/tokens'

import { parseHostConfig } from './config.ts'
import { QuicksilverHost } from './host.ts'
import { Logger } from './log.ts'
import {
  assetsFrom,
  FakeMediaProvider,
  FileMediaStore,
  inputDigest,
  MediaService,
  MediaStoreError,
  MemoryMediaStore,
  MEDIA_CONTRACT_VERSION,
  MEDIA_KINDS,
  parseMediaInput,
  parseMediaPolicy,
  spentUsd,
  TermModerator,
  verifyMediaEvents,
  type MediaEvent,
  type MediaInput,
  type MediaModerator,
  type MediaPolicy,
  type MediaResult,
} from './media.ts'

const T0 = Date.parse('2026-10-03T12:00:00Z')
const DAY = 86_400_000
const TENANT = 'nuera'

const policy = (over: Partial<MediaPolicy> = {}): MediaPolicy => ({
  budgetUsd: 1,
  autoMaxUsd: 0.1,
  maxRequestUsd: 0.5,
  defaultRetentionDays: 30,
  maxRetentionDays: 365,
  allowedKinds: MEDIA_KINDS,
  blockedTerms: ['forbidden'],
  ...over,
})

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).toString('base64')
const WAV = Buffer.from('RIFF....WAVEfmt ').toString('base64')
const human = { id: 'entity-founder', kind: 'human' }
const agent = { id: 'agent-genesis', kind: 'agent' }

// ── Input ─────────────────────────────────────────────────────────────────

test('parseMediaInput: every kind, its defaults, and its limits', () => {
  const ok = (kind: string, input: unknown) => { const r = parseMediaInput(kind, input); assert.ok(r.ok, `${kind} ${JSON.stringify(input).slice(0, 60)}`); return r.input }
  const bad = (kind: unknown, input: unknown, pattern: RegExp) => { const r = parseMediaInput(kind, input); assert.ok(!r.ok); assert.match(r.ok ? '' : r.error, pattern) }

  assert.deepEqual(ok('image-generation', { prompt: ' a barn ' }), { kind: 'image-generation', prompt: 'a barn', size: '1024x1024' })
  assert.deepEqual(ok('image-generation', { prompt: 'a barn', size: '256x256' }), { kind: 'image-generation', prompt: 'a barn', size: '256x256' })
  assert.deepEqual(ok('video-generation', { prompt: 'a barn', seconds: 5 }), { kind: 'video-generation', prompt: 'a barn', seconds: 5 })
  assert.deepEqual(ok('speech', { text: 'Hello', voice: 'warm-1' }), { kind: 'speech', text: 'Hello', voice: 'warm-1' })
  assert.deepEqual(ok('transcription', { audioBase64: WAV, mediaType: 'audio/wav' }), { kind: 'transcription', audioBase64: WAV, mediaType: 'audio/wav' })
  assert.deepEqual(ok('diagram', { spec: 'a -> b' }), { kind: 'diagram', spec: 'a -> b' })
  assert.deepEqual(ok('image-understanding', { imageBase64: PNG, mediaType: 'image/png', question: ' What is this? ' }), { kind: 'image-understanding', imageBase64: PNG, mediaType: 'image/png', question: 'What is this?' })

  bad('film', {}, /kind must be one of/)
  bad(undefined, {}, /kind must be one of/)
  bad('speech', 'text', /input must be an object/)
  bad('speech', [], /input must be an object/)
  bad('image-generation', { prompt: '' }, /prompt must be/)
  bad('image-generation', { prompt: 'x'.repeat(4001) }, /prompt must be/)
  bad('image-generation', { prompt: 'x', size: '4096x4096' }, /size must be/)
  bad('video-generation', { prompt: 'x', seconds: 0 }, /seconds must be/)
  bad('video-generation', { prompt: 'x', seconds: 31 }, /seconds must be/)
  bad('video-generation', { prompt: 'x', seconds: 1.5 }, /seconds must be/)
  bad('speech', { text: 'x', voice: 'Bad Voice!' }, /voice must be/)
  bad('transcription', { audioBase64: '***', mediaType: 'audio/wav' }, /audioBase64 must be/)
  bad('transcription', { audioBase64: 'abc', mediaType: 'audio/wav' }, /audioBase64 must be/)
  bad('transcription', { audioBase64: WAV, mediaType: 'video/mp4' }, /mediaType must be/)
  bad('transcription', { audioBase64: 'A'.repeat(14 * 1024 * 1024), mediaType: 'audio/wav' }, /audioBase64 must be/)
  bad('diagram', { spec: '' }, /spec must be/)
  bad('diagram', { spec: 'x'.repeat(8001) }, /spec must be/)
  bad('image-understanding', { imageBase64: PNG, mediaType: 'image/gif' }, /mediaType must be/)
  bad('image-understanding', { imageBase64: PNG, mediaType: 'image/png', question: '' }, /question must be/)

  assert.equal(inputDigest(ok('speech', { text: 'Hello' }) as MediaInput), inputDigest(ok('speech', { text: ' Hello ' }) as MediaInput), 'the digest is of the cleaned input')
  assert.match(inputDigest(ok('speech', { text: 'Hello' }) as MediaInput), /^sha256:[0-9a-f]{64}$/)
})

test('parseMediaPolicy: defaults, relations between the numbers, and bad values', () => {
  const good = parseMediaPolicy({ budgetUsd: 50, autoMaxUsd: 0.5, maxRequestUsd: 5 })
  assert.ok(good.ok)
  assert.equal(good.policy.defaultRetentionDays, 30)
  assert.equal(good.policy.maxRetentionDays, 365)
  assert.deepEqual(good.policy.allowedKinds, [...MEDIA_KINDS])
  assert.deepEqual(good.policy.blockedTerms, [])

  const errs = (v: unknown) => { const r = parseMediaPolicy(v); assert.ok(!r.ok); return r.ok ? [] : r.errors }
  assert.ok(errs(null)[0]!.includes('must be an object'))
  assert.ok(errs({}).length >= 3)
  assert.ok(errs({ budgetUsd: 10, autoMaxUsd: 5, maxRequestUsd: 1 }).some((e) => e.includes('autoMaxUsd cannot exceed maxRequestUsd')))
  assert.ok(errs({ budgetUsd: 1, autoMaxUsd: 1, maxRequestUsd: 5 }).some((e) => e.includes('maxRequestUsd cannot exceed budgetUsd')))
  assert.ok(errs({ budgetUsd: -1, autoMaxUsd: 1, maxRequestUsd: 1 }).some((e) => e.includes('budgetUsd')))
  assert.ok(errs({ budgetUsd: 10, autoMaxUsd: 1, maxRequestUsd: 1, defaultRetentionDays: 400, maxRetentionDays: 365 }).some((e) => e.includes('defaultRetentionDays cannot exceed')))
  assert.ok(errs({ budgetUsd: 10, autoMaxUsd: 1, maxRequestUsd: 1, defaultRetentionDays: 0 }).some((e) => e.includes('defaultRetentionDays')))
  assert.ok(errs({ budgetUsd: 10, autoMaxUsd: 1, maxRequestUsd: 1, allowedKinds: ['film'] }).some((e) => e.includes('allowedKinds')))
  assert.ok(errs({ budgetUsd: 10, autoMaxUsd: 1, maxRequestUsd: 1, allowedKinds: [] }).some((e) => e.includes('allowedKinds')))
  assert.ok(errs({ budgetUsd: 10, autoMaxUsd: 1, maxRequestUsd: 1, blockedTerms: [''] }).some((e) => e.includes('blockedTerms')))
  assert.ok(errs({ budgetUsd: 10, autoMaxUsd: 1, maxRequestUsd: 1, blockedTerms: 'x' }).some((e) => e.includes('blockedTerms')))
})

// ── The log and the stores ────────────────────────────────────────────────

const hashOf = (e: Omit<MediaEvent, 'hash'>) => {
  const canon = (v: unknown): string => v === null || typeof v !== 'object' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canon).join(',')}]` : `{${Object.keys(v as object).filter((k) => (v as any)[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon((v as any)[k])}`).join(',')}}`
  return createHash('sha256').update(canon(e)).digest('hex')
}
const eventAt = (seq: number, prev: string, over: Partial<MediaEvent> = {}): MediaEvent => {
  const base = { seq, type: 'failed' as const, at: new Date(T0).toISOString(), by: 'a', assetId: 'ma-00000000-0000-0000-0000-000000000001', data: { kind: 'speech' }, prevHash: prev, ...over }
  const { hash: _h, ...rest } = base as MediaEvent
  return { ...rest, hash: hashOf(rest) }
}

test('verifyMediaEvents: a valid chain passes; an edited, removed, reordered or forged event is caught', () => {
  const e1 = eventAt(1, '0'.repeat(64))
  const e2 = eventAt(2, e1.hash)
  const e3 = eventAt(3, e2.hash)
  assert.deepEqual(verifyMediaEvents([]), { valid: true, errors: [] })
  assert.deepEqual(verifyMediaEvents([e1, e2, e3]), { valid: true, errors: [] })
  assert.equal(verifyMediaEvents([e1, { ...e2, data: { kind: 'speech', edited: true } }, e3]).valid, false, 'an edited event')
  assert.equal(verifyMediaEvents([e1, e3]).valid, false, 'a removed event')
  assert.equal(verifyMediaEvents([e2, e1, e3]).valid, false, 'reordered events')
  assert.equal(verifyMediaEvents([{ ...e1, by: 'someone-else' }, e2, e3]).valid, false, 'a forged author')
})

test('media stores (file and memory): append-only log, content that is never overwritten, deletion, tenants, ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'qs-media-'))
  try {
    for (const make of [() => new FileMediaStore(dir, 'nuera'), () => new MemoryMediaStore('nuera')]) {
      const s = make()
      assert.deepEqual(await s.events(), [])
      const e1 = eventAt(1, '0'.repeat(64))
      await s.append(e1)
      await s.append(eventAt(2, e1.hash))
      assert.equal((await s.events()).length, 2)
      await assert.rejects(s.append(eventAt(2, e1.hash)), MediaStoreError, 'a taken sequence number')
      await assert.rejects(s.append(eventAt(4, e1.hash)), /next event is 3/)
      await assert.rejects(s.append(eventAt(3, '1'.repeat(64))), /does not follow/)
      await assert.rejects(s.append({ ...eventAt(3, (await s.events())[1]!.hash), by: 'forged' }), /does not match its hash/)
      assert.equal((await s.events()).length, 2, 'refused events are not stored')

      const id = 'ma-00000000-0000-0000-0000-0000000000aa'
      assert.equal(await s.getContent(id), undefined)
      await s.putContent(id, Buffer.from('bytes'))
      assert.equal((await s.getContent(id))!.toString(), 'bytes')
      await assert.rejects(s.putContent(id, Buffer.from('other')), /wx|EEXIST|already has content/)
      assert.equal((await s.getContent(id))!.toString(), 'bytes', 'content is never overwritten')
      await s.deleteContent(id)
      assert.equal(await s.getContent(id), undefined)
      await s.deleteContent(id) // idempotent
      await assert.rejects(s.putContent('../escape', Buffer.from('x')), /Invalid asset id/)
      await assert.rejects(s.getContent('ma-not-an-id'), /Invalid asset id/)
    }
    assert.deepEqual(await new FileMediaStore(dir, 'other-tenant').events(), [], 'another tenant never sees this log')
    const a = new MemoryMediaStore('a')
    await a.append(eventAt(1, '0'.repeat(64)))
    assert.deepEqual(await new MemoryMediaStore('b').events(), [])
    assert.deepEqual((await readdir(join(dir, 'nuera', 'media'))).sort(), ['content', 'events.json'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// ── The service ───────────────────────────────────────────────────────────

function setup(over: { policy?: Partial<MediaPolicy>; providers?: FakeMediaProvider[]; moderator?: MediaModerator; store?: MemoryMediaStore } = {}) {
  const clock = { t: T0 }
  const provider = new FakeMediaProvider()
  const store = over.store ?? new MemoryMediaStore(TENANT)
  const service = new MediaService({
    store,
    policy: policy(over.policy),
    providers: over.providers ?? [provider],
    ...(over.moderator ? { moderator: over.moderator } : {}),
    now: () => new Date(clock.t),
  })
  return { service, provider, store, clock }
}

const speech = (text = 'Hello there') => ({ kind: 'speech', input: { text } })

test('service: with no provider registered nothing is called and the answer says so', async () => {
  const { service, store } = setup({ providers: [] })
  const r = await service.run(speech(), human)
  assert.ok(!r.ok)
  assert.equal(r.status, 503)
  assert.match(r.error, /No media provider is registered for speech/)
  assert.deepEqual(await store.events(), [], 'not even a record: nothing happened')
  const s = await service.summary()
  assert.deepEqual(s.providers, [])
  assert.equal(s.spentUsd, 0)
})

test('service: every kind runs once through a provider and is recorded with provenance, never the prompt', async () => {
  const { service, provider, store } = setup({ policy: { budgetUsd: 100, autoMaxUsd: 1, maxRequestUsd: 1 } })
  const requests: Array<{ kind: string; input: unknown; type: string }> = [
    { kind: 'image-generation', input: { prompt: 'a secret barn plan' }, type: 'image/png' },
    { kind: 'video-generation', input: { prompt: 'barn video', seconds: 3 }, type: 'video/mp4' },
    { kind: 'speech', input: { text: 'a private line' }, type: 'audio/mpeg' },
    { kind: 'transcription', input: { audioBase64: WAV, mediaType: 'audio/wav' }, type: 'text/plain' },
    { kind: 'diagram', input: { spec: 'a -> b' }, type: 'image/png' },
    { kind: 'image-understanding', input: { imageBase64: PNG, mediaType: 'image/png', question: 'What?' }, type: 'text/plain' },
  ]
  for (const q of requests) {
    const r = await service.run({ ...q, experimentId: 'exp-landing' }, agent)
    assert.ok(r.ok, q.kind)
    assert.equal(r.asset.kind, q.kind)
    assert.equal(r.asset.status, 'stored')
    assert.equal(r.asset.contractVersion, MEDIA_CONTRACT_VERSION)
    assert.equal(r.asset.provider.id, 'fake')
    assert.equal(r.asset.output.mediaType, q.type)
    assert.equal(r.asset.requestedBy, 'agent-genesis')
    assert.equal(r.asset.experimentId, 'exp-landing')
    assert.match(r.asset.inputDigest, /^sha256:[0-9a-f]{64}$/)
    const stored = await store.getContent(r.asset.id)
    assert.ok(stored)
    assert.equal(r.asset.output.sha256, `sha256:${createHash('sha256').update(stored).digest('hex')}`, 'the recorded digest is of the stored bytes')
    assert.equal(r.asset.output.bytes, stored.length)
    assert.equal(r.asset.expiresAt, new Date(T0 + 30 * DAY).toISOString())
    assert.equal(r.ledgerSuggestion.kind, 'compute')
    assert.equal(r.ledgerSuggestion.amountUsd, 0.05)
    assert.deepEqual(r.ledgerSuggestion.source, { type: 'provider-usage', ref: r.asset.id })
    assert.equal(typeof (r as { text?: string }).text, q.type === 'text/plain' ? 'string' : 'undefined')
  }
  assert.equal(provider.calls.length, 6)
  const events = await store.events()
  assert.deepEqual(verifyMediaEvents(events), { valid: true, errors: [] })
  assert.equal(events.length, 6)
  const log = JSON.stringify(events)
  for (const secret of ['a secret barn plan', 'a private line', 'barn video', WAV, PNG]) assert.ok(!log.includes(secret), 'the log holds digests, never prompts or media')
  assert.ok(Math.abs(spentUsd(events) - 0.3) < 1e-9)
  assert.equal((await service.summary()).assets, 6)
})

test('moderation: blocked input never reaches the provider and is recorded; a moderator that throws blocks too', async () => {
  const a = setup()
  const blocked = await a.service.run({ kind: 'image-generation', input: { prompt: 'something FORBIDDEN here' } }, human)
  assert.ok(!blocked.ok)
  assert.equal(blocked.status, 422)
  assert.equal(blocked.blocked, true)
  assert.match(blocked.reasons![0]!, /blocked term/)
  assert.equal(a.provider.calls.length, 0, 'the provider was never called')
  const events = await a.store.events()
  assert.equal(events.length, 1)
  assert.equal(events[0]!.type, 'blocked')
  assert.equal(events[0]!.data.stage, 'input')
  assert.ok(!JSON.stringify(events).toLowerCase().includes('something'), 'the blocked prompt is not kept')
  assert.equal(assetsFrom(events).length, 0, 'a blocked request is not an asset')
  assert.equal(spentUsd(events), 0)

  const throwing: MediaModerator = { moderateInput: async () => { throw new Error('down') }, moderateOutput: async () => ({ allowed: true, reasons: [] }) }
  const b = setup({ moderator: throwing })
  const failedClosed = await b.service.run(speech(), human)
  assert.ok(!failedClosed.ok && failedClosed.blocked)
  assert.match(failedClosed.reasons![0]!, /fails closed/)
  assert.equal(b.provider.calls.length, 0)
})

test('moderation: blocked output is not stored, but the money the provider charged is counted', async () => {
  const { service, provider, store } = setup()
  provider.outputText = 'this transcript says forbidden things'
  provider.costUsd = { transcription: 0.07 }
  const r = await service.run({ kind: 'transcription', input: { audioBase64: WAV, mediaType: 'audio/wav' } }, human)
  assert.ok(!r.ok)
  assert.equal(r.blocked, true)
  assert.match(r.error, /output was blocked/)
  const events = await store.events()
  assert.equal(events.length, 1)
  assert.equal(events[0]!.data.stage, 'output')
  assert.equal(events[0]!.data.costUsd, 0.07)
  assert.match(events[0]!.data.outputDigest as string, /^sha256:/)
  assert.equal(assetsFrom(events).length, 0)
  assert.equal(spentUsd(events), 0.07, 'the provider charged for it')
  assert.ok(!JSON.stringify(events).includes('forbidden things'), 'the blocked output is not kept')

  const throwing: MediaModerator = { moderateInput: async () => ({ allowed: true, reasons: [] }), moderateOutput: async () => { throw new Error('down') } }
  const b = setup({ moderator: throwing })
  const out = await b.service.run(speech(), human)
  assert.ok(!out.ok && out.blocked)
  assert.equal((await b.store.events()).length, 1)
})

test('cost cap: a person may spend up to maxRequestUsd, anything else only up to autoMaxUsd, and the budget is never passed', async () => {
  const { service, provider, store } = setup({ policy: { budgetUsd: 1, autoMaxUsd: 0.1, maxRequestUsd: 0.5 } })
  provider.estimateUsd = { speech: 0.3 }
  provider.costUsd = { speech: 0.3 }

  const refused = await service.run(speech(), agent)
  assert.ok(!refused.ok)
  assert.equal(refused.status, 422)
  assert.equal(refused.blocked, true)
  assert.match(refused.reasons![0]!, /over the \$0\.1 limit for a request that is not made by a person/)
  assert.match(refused.reasons![0]!, /\$0\.5 when a person asks/)
  assert.equal(provider.calls.length, 0, 'refused before the provider was called')
  assert.equal((await store.events()).at(-1)!.data.stage, 'cost')

  assert.ok((await service.run(speech(), human)).ok, 'a person can spend 0.30')
  assert.ok((await service.run(speech('two'), human)).ok)
  assert.ok((await service.run(speech('three'), human)).ok)
  assert.equal(provider.calls.length, 3)
  const over = await service.run(speech('four'), human)
  assert.ok(!over.ok)
  assert.match(over.reasons!.join(' '), /past the \$1 budget/)
  assert.equal(provider.calls.length, 3)
  provider.estimateUsd = { speech: 0.6 }
  const perRequest = await service.run(speech('five'), human)
  assert.ok(!perRequest.ok)
  assert.match(perRequest.reasons![0]!, /over the \$0\.5 per-request cap/)
  assert.ok(Math.abs((await service.summary()).spentUsd - 0.9) < 1e-9)
  assert.ok(Math.abs((await service.summary()).remainingUsd - 0.1) < 1e-9)
})

test('cost cap: what the provider actually charged is what is recorded, even above the estimate, and it counts against the next request', async () => {
  const { service, provider } = setup({ policy: { budgetUsd: 0.5, autoMaxUsd: 0.5, maxRequestUsd: 0.5 } })
  provider.estimateUsd = { speech: 0.2 }
  provider.costUsd = { speech: 0.4 }
  const r = await service.run(speech(), human)
  assert.ok(r.ok)
  assert.equal(r.costUsd, 0.4)
  provider.estimateUsd = { speech: 0.2 }
  const next = await service.run(speech('again'), human)
  assert.ok(!next.ok, '0.4 spent + 0.2 would pass 0.5')
  assert.match(next.reasons!.join(' '), /past the \$0\.5 budget/)
})

test('cost cap: simultaneous requests cannot jointly overspend the budget', async () => {
  class SlowProvider extends FakeMediaProvider {
    override async run(input: MediaInput): Promise<MediaResult> {
      await new Promise((r) => setTimeout(r, 25))
      return super.run(input)
    }
  }
  const slow = new SlowProvider()
  slow.costUsd = { speech: 0.3 }
  slow.estimateUsd = { speech: 0.3 }
  const { service, store } = setup({ providers: [slow], policy: { budgetUsd: 1, autoMaxUsd: 0.5, maxRequestUsd: 0.5 } })
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => service.run(speech(`line ${i}`), agent)))
  assert.equal(results.filter((r) => r.ok).length, 3, 'only three 0.30 requests fit in a budget of 1')
  assert.equal(slow.calls.length, 3, 'the rest never reached the provider')
  const events = await store.events()
  assert.ok(spentUsd(events) <= 1)
  assert.deepEqual(verifyMediaEvents(events), { valid: true, errors: [] }, 'concurrent appends kept one valid chain')
})

test('provider problems: a failure is recorded and costs nothing; bad output, type or cost is refused and not stored', async () => {
  const { service, provider, store } = setup()
  provider.failNext = true
  const failed = await service.run(speech(), human)
  assert.ok(!failed.ok)
  assert.equal(failed.status, 502)
  assert.match(failed.error, /provider failed: provider unavailable/)
  assert.equal((await store.events()).at(-1)!.type, 'failed')
  assert.equal(spentUsd(await store.events()), 0)
  assert.ok((await service.run(speech('after'), human)).ok, 'the next request still works')

  provider.override = { mediaType: 'application/x-msdownload' }
  const wrongType = await service.run(speech('type'), human)
  assert.ok(!wrongType.ok && wrongType.blocked)
  assert.match(wrongType.reasons![0]!, /allows audio\/mpeg, audio\/wav/)
  provider.override = { content: Buffer.alloc(0) }
  assert.ok(!(await service.run(speech('empty'), human)).ok)
  provider.override = { content: Buffer.alloc(25 * 1024 * 1024 + 1) }
  assert.ok(!(await service.run(speech('big'), human)).ok)
  provider.override = { costUsd: -1 }
  const negative = await service.run(speech('neg'), human)
  assert.ok(!negative.ok)
  assert.match(negative.error, /invalid cost/)
  provider.override = undefined
  assert.equal((await service.summary()).assets, 1, 'only the one good request became an asset')
  assert.equal((await service.summary()).provenance.valid, true)
})

test('request checks: kind, policy, retention, provider choice and experiment id', async () => {
  const { service, provider } = setup({ policy: { allowedKinds: ['speech', 'diagram'] }, providers: [new FakeMediaProvider('a', ['speech']), new FakeMediaProvider('b', ['speech', 'diagram'])] })
  assert.equal((await service.run({ kind: 'film', input: {} }, human)).ok, false)
  const notAllowed = await service.run({ kind: 'image-generation', input: { prompt: 'x' } }, human)
  assert.ok(!notAllowed.ok)
  assert.equal(notAllowed.status, 409)
  assert.match(notAllowed.error, /not enabled/)
  for (const retentionDays of [0, 366, 1.5, '30']) {
    const r = await service.run({ ...speech(), retentionDays }, human)
    assert.ok(!r.ok && r.status === 422, String(retentionDays))
  }
  assert.ok(!(await service.run({ ...speech(), experimentId: 'bad id!' }, human)).ok)
  const named = await service.run({ ...speech(), provider: 'b' }, human)
  assert.ok(named.ok)
  assert.equal(named.asset.provider.id, 'b')
  const first = await service.run(speech('x'), human)
  assert.ok(first.ok && first.asset.provider.id === 'a', 'the first registered provider that supports the kind')
  const missing = await service.run({ ...speech(), provider: 'nope' }, human)
  assert.ok(!missing.ok && missing.status === 503)
  const wrong = await service.run({ kind: 'diagram', input: { spec: 'a' }, provider: 'a' }, human)
  assert.ok(!wrong.ok && wrong.status === 503, 'a provider that does not support the kind')
  void provider
})

test('contract version: a provider speaking another version, or two with one id, is refused at construction', () => {
  const store = new MemoryMediaStore()
  assert.throws(() => new MediaService({ store, policy: policy(), providers: [new FakeMediaProvider('old', MEDIA_KINDS, 0)] }), /implements contract 0/)
  assert.throws(() => new MediaService({ store, policy: policy(), providers: [new FakeMediaProvider('dup'), new FakeMediaProvider('dup')] }), /must be unique/)
})

test('retention: assets expire on their date, bytes go and provenance stays, and a person can delete early', async () => {
  const { service, store, clock } = setup()
  const short = await service.run({ ...speech('short'), retentionDays: 2 }, human)
  const long = await service.run({ ...speech('long'), retentionDays: 90 }, human)
  const early = await service.run(speech('early'), human)
  assert.ok(short.ok && long.ok && early.ok)
  assert.equal(short.asset.expiresAt, new Date(T0 + 2 * DAY).toISOString())

  clock.t = T0 + 1 * DAY
  assert.deepEqual(await service.purgeExpired(), [])
  assert.ok(await service.content(short.asset.id))

  const gone = await service.deleteAsset(early.asset.id, 'entity-founder', 'Not needed.')
  assert.equal(gone?.status, 'deleted')
  assert.equal(gone?.endedBy, 'entity-founder')
  assert.equal(gone?.endReason, 'Not needed.')
  assert.equal(await store.getContent(early.asset.id), undefined)
  assert.equal(await service.deleteAsset(early.asset.id, 'entity-founder', 'again'), undefined, 'already gone')
  assert.equal(await service.deleteAsset('ma-00000000-0000-0000-0000-000000000000', 'x', 'y'), undefined)

  clock.t = T0 + 3 * DAY
  assert.deepEqual(await service.purgeExpired('entity-founder'), [short.asset.id])
  assert.equal(await store.getContent(short.asset.id), undefined, 'the bytes are gone')
  assert.equal(await service.content(short.asset.id), undefined)
  const view = (await service.assets()).find((a) => a.id === short.asset.id)!
  assert.equal(view.status, 'expired')
  assert.equal(view.output.sha256, short.asset.output.sha256, 'the provenance stays')
  assert.equal(view.endedBy, 'entity-founder')
  assert.deepEqual((await service.assets()).map((a) => a.status).sort(), ['deleted', 'expired', 'stored'])
  assert.ok(await service.content(long.asset.id), 'a longer retention is untouched')
  assert.deepEqual(verifyMediaEvents(await store.events()), { valid: true, errors: [] })

  // A request purges what has expired as a side effect, with no one asking.
  clock.t = T0 + 100 * DAY
  assert.ok((await service.run(speech('later'), human)).ok)
  assert.equal((await service.assets()).find((a) => a.id === long.asset.id)!.status, 'expired')
})

test('provenance: tampering with the stored log is detected by the summary', async () => {
  const { service, store } = setup()
  await service.run(speech(), human)
  await service.run(speech('two'), human)
  assert.equal((await service.summary()).provenance.valid, true)
  const events = await store.events()
  const tampered = events.map((e, i) => (i === 0 ? { ...e, data: { ...e.data, costUsd: 0 } } : e))
  assert.equal(verifyMediaEvents(tampered).valid, false)
  assert.ok(verifyMediaEvents(tampered).errors[0]!.includes('event 1'))
})

test('TermModerator: case-insensitive terms on inputs and text outputs; binary output has no text to check', async () => {
  const m = new TermModerator([' Bad Word ', ''])
  assert.equal((await m.moderateInput({ kind: 'speech', text: 'this has a BAD WORD in it' })).allowed, false)
  assert.equal((await m.moderateInput({ kind: 'speech', text: 'perfectly fine' })).allowed, true)
  assert.equal((await m.moderateOutput({ kind: 'transcription', mediaType: 'text/plain', bytes: 5, sha256: 'x', text: 'bad word' })).allowed, false)
  assert.equal((await m.moderateOutput({ kind: 'speech', mediaType: 'audio/mpeg', bytes: 5, sha256: 'x' })).allowed, true)
  assert.equal((await new TermModerator([]).moderateInput({ kind: 'speech', text: 'anything' })).allowed, true)
  assert.equal((await m.moderateInput({ kind: 'transcription', audioBase64: WAV, mediaType: 'audio/wav' })).allowed, true, 'audio input has no text to check here')
})

// ── HTTP ──────────────────────────────────────────────────────────────────

function who(id: string, kind: 'human' | 'agent', roles: string[]): { config: TokenPrincipalConfig; token: string } {
  const { token, tokenDigest } = generateToken()
  return { token, config: { id, kind, tenantId: TENANT, roles, tokenDigest } }
}

async function startHost(options: { media?: boolean; policy?: Partial<MediaPolicy> } = {}) {
  const founder = who('entity-founder', 'human', ['intent-provider'])
  const agentP = who('agent-genesis', 'agent', ['agent-worker'])
  const viewer = who('entity-viewer', 'human', ['viewer'])
  const clock = { t: T0 }
  const provider = new FakeMediaProvider()
  const store = new MemoryMediaStore(TENANT)
  const media = new MediaService({ store, policy: policy(options.policy), providers: [provider], now: () => new Date(clock.t) })
  const auditDir = await mkdtemp(join(tmpdir(), 'qs-media-audit-'))
  const host = new QuicksilverHost(parseHostConfig({ tenantId: TENANT, http: { host: '127.0.0.1', port: 0 }, workflows: {} }), {
    principals: [founder.config, agentP.config, viewer.config],
    env: { QUICKSILVER_AUTHORIZATION_AUDIT_PATH: join(auditDir, 'authorization.jsonl') },
    logger: new Logger({ level: 'error', sink: { write: () => {} } }),
    now: () => clock.t,
    ...(options.media === false ? {} : { media }),
  })
  const { port } = await host.start()
  const call = (path: string, token: string, body?: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() as any }))
  const stop = async () => { await host.stop(); await rm(auditDir, { recursive: true, force: true }) }
  return { call, stop, provider, store, clock, tokens: { founder: founder.token, agent: agentP.token, viewer: viewer.token } }
}

const M = '/api/media'

test('routes: absent without a media service; reads need decision:read; requests need a provider or proposer; delete and purge are humans only', async () => {
  const none = await startHost({ media: false })
  try { assert.equal((await none.call(M, none.tokens.viewer)).status, 404) } finally { await none.stop() }

  const h = await startHost()
  try {
    const status = await h.call(M, h.tokens.viewer)
    assert.equal(status.status, 200)
    assert.equal(status.body.contractVersion, 1)
    assert.deepEqual(status.body.providers, [{ id: 'fake', kinds: [...MEDIA_KINDS] }])
    assert.equal(status.body.policy.blockedTerms, 1, 'the terms are counted, not shown')
    assert.equal(status.body.spentUsd, 0)
    assert.equal((await h.call(`${M}/requests`, h.tokens.viewer, speech())).status, 403, 'a viewer cannot request')
    const made = await h.call(`${M}/requests`, h.tokens.agent, speech())
    assert.equal(made.status, 201, 'an agent can request within the limit')
    const id = made.body.asset.id as string
    assert.equal((await h.call(`${M}/assets/${id}/delete`, h.tokens.agent, { reason: 'x' })).status, 403)
    assert.equal((await h.call(`${M}/assets/${id}/delete`, h.tokens.viewer, { reason: 'x' })).status, 403)
    assert.equal((await h.call(`${M}/purge`, h.tokens.agent, {})).status, 403)
    assert.equal((await h.call(`${M}/purge`, h.tokens.viewer, {})).status, 403)
    assert.equal((await h.call(`${M}/assets/nope`, h.tokens.viewer)).status, 404)
    assert.equal((await h.call(`${M}/assets/ma-00000000-0000-0000-0000-000000000000`, h.tokens.viewer)).status, 404)
    assert.equal((await h.call(`${M}/assets/ma-00000000-0000-0000-0000-000000000000/content`, h.tokens.viewer)).status, 404)
  } finally { await h.stop() }
})

test('routes: requests run, answer with provenance and a ledger suggestion, and refusals say why', async () => {
  const h = await startHost()
  try {
    h.provider.costUsd = { speech: 0.3 }
    h.provider.estimateUsd = { speech: 0.3 }
    const agentTry = await h.call(`${M}/requests`, h.tokens.agent, speech())
    assert.equal(agentTry.status, 422)
    assert.equal(agentTry.body.blocked, true)
    assert.match(agentTry.body.reasons[0], /not made by a person/)
    assert.ok(agentTry.body.eventSeq >= 1)
    assert.equal(h.provider.calls.length, 0)

    const ok = await h.call(`${M}/requests`, h.tokens.founder, { ...speech(), retentionDays: 7, experimentId: 'exp-landing' })
    assert.equal(ok.status, 201)
    assert.equal(ok.body.asset.requestedBy, 'entity-founder')
    assert.equal(ok.body.asset.retentionDays, 7)
    assert.equal(ok.body.costUsd, 0.3)
    assert.deepEqual(ok.body.ledgerSuggestion.source, { type: 'provider-usage', ref: ok.body.asset.id })
    assert.match(ok.body.ledgerSuggestion.note, /Not recorded/)

    assert.equal((await h.call(`${M}/requests`, h.tokens.founder, { kind: 'speech', input: { text: '' } })).status, 422)
    assert.equal((await h.call(`${M}/requests`, h.tokens.founder, { kind: 'speech', input: { text: 'a forbidden word' } })).status, 422)
    const list = await h.call(`${M}/assets`, h.tokens.viewer)
    assert.equal(list.body.assets.length, 1, 'refusals are not assets')
    assert.ok(!JSON.stringify(list.body).includes('Hello there'), 'no prompt in a response')
    const one = await h.call(`${M}/assets/${ok.body.asset.id}`, h.tokens.viewer)
    assert.equal(one.body.asset.id, ok.body.asset.id)

    const prov = await h.call(`${M}/provenance`, h.tokens.viewer)
    assert.equal(prov.body.valid, true)
    assert.deepEqual(prov.body.events.map((e: any) => e.type), ['blocked', 'created', 'blocked'])
  } finally { await h.stop() }
})

test('routes: content comes back as text or base64, and after deletion or expiry only the provenance does', async () => {
  const h = await startHost()
  try {
    h.provider.outputText = 'Hello from the transcript.'
    const text = await h.call(`${M}/requests`, h.tokens.founder, { kind: 'transcription', input: { audioBase64: WAV, mediaType: 'audio/wav' } })
    assert.equal(text.status, 201)
    assert.equal(text.body.text, 'Hello from the transcript.')
    const bin = await h.call(`${M}/requests`, h.tokens.founder, { kind: 'image-generation', input: { prompt: 'a barn' }, retentionDays: 1 })
    assert.equal(bin.status, 201)

    const tc = await h.call(`${M}/assets/${text.body.asset.id}/content`, h.tokens.viewer)
    assert.equal(tc.status, 200)
    assert.equal(tc.body.mediaType, 'text/plain')
    assert.equal(tc.body.text, 'Hello from the transcript.')
    assert.equal(tc.body.base64, undefined)
    const bc = await h.call(`${M}/assets/${bin.body.asset.id}/content`, h.tokens.viewer)
    assert.equal(bc.body.mediaType, 'image/png')
    assert.equal(createHash('sha256').update(Buffer.from(bc.body.base64, 'base64')).digest('hex'), bin.body.asset.output.sha256.slice(7), 'the bytes match the provenance digest')

    assert.equal((await h.call(`${M}/assets/${text.body.asset.id}/delete`, h.tokens.founder, {})).status, 422, 'a reason is required')
    const del = await h.call(`${M}/assets/${text.body.asset.id}/delete`, h.tokens.founder, { reason: 'Customer asked.' })
    assert.equal(del.status, 200)
    assert.equal(del.body.asset.status, 'deleted')
    const gone = await h.call(`${M}/assets/${text.body.asset.id}/content`, h.tokens.viewer)
    assert.equal(gone.status, 410)
    assert.equal(gone.body.asset.status, 'deleted')
    assert.equal((await h.call(`${M}/assets/${text.body.asset.id}/delete`, h.tokens.founder, { reason: 'again' })).status, 409)

    h.clock.t = T0 + 2 * DAY
    const purged = await h.call(`${M}/purge`, h.tokens.founder, {})
    assert.deepEqual(purged.body.purged, [bin.body.asset.id])
    assert.equal((await h.call(`${M}/assets/${bin.body.asset.id}/content`, h.tokens.viewer)).status, 410)
    assert.equal((await h.call(`${M}/assets/${bin.body.asset.id}`, h.tokens.viewer)).body.asset.status, 'expired')
    assert.deepEqual((await h.call(`${M}/purge`, h.tokens.founder, {})).body.purged, [])
  } finally { await h.stop() }
})
