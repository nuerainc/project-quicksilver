/**
 * The shared token bucket (threat model A-5) and the Sanity token choice
 * (A-7). Both are pure; the host, the web app and the Studio scripts use them.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_RATE_LIMIT_KEYS, TokenBucketLimiter, parseRateLimitSetting } from './rate-limit.ts'
import { createOnceWarner, resolveSanityToken } from './sanity-tokens.ts'

test('Rate limit (A-5): a bucket per key allows the burst, then refuses with a whole-second Retry-After, then refills', () => {
  let t = 0
  const limiter = new TokenBucketLimiter({ burst: 2, perMinute: 6 }, () => t)
  assert.deepEqual(limiter.take('ana'), { ok: true })
  assert.deepEqual(limiter.take('ana'), { ok: true })
  const refused = limiter.take('ana')
  assert.equal(refused.ok, false)
  assert.equal(!refused.ok && refused.retryAfterSeconds, 10, '6 a minute is one every 10 s')
  assert.deepEqual(limiter.take('bo'), { ok: true }, 'buckets are per key')
  t += 9_000
  assert.equal(limiter.take('ana').ok, false)
  t += 2_000
  assert.equal(limiter.take('ana').ok, true, 'refills at perMinute')
  t += 10 * 60_000
  assert.equal(limiter.take('ana').ok, true)
  assert.equal(limiter.take('ana').ok, true)
  assert.equal(limiter.take('ana').ok, false, 'never more than the burst after a long idle')
})

test('Rate limit (A-5): a clock that goes backwards never adds tokens; key count is bounded', () => {
  let t = 100_000
  const limiter = new TokenBucketLimiter({ burst: 1, perMinute: 1 }, () => t)
  assert.equal(limiter.take('k').ok, true)
  t -= 50_000
  assert.equal(limiter.take('k').ok, false)
  const many = new TokenBucketLimiter({ burst: 1, perMinute: 1 }, () => 0)
  for (let i = 0; i < MAX_RATE_LIMIT_KEYS + 5; i++) many.take(`key-${i}`)
  assert.equal(many.take('key-0').ok, true, 'the oldest keys are dropped (bounded memory), not kept forever')
})

test('Rate limit (A-5): bad configs are refused; "burst/perMinute" settings parse or return null', () => {
  assert.throws(() => new TokenBucketLimiter({ burst: 0, perMinute: 10 }), /burst must be at least 1/)
  assert.throws(() => new TokenBucketLimiter({ burst: 1, perMinute: 0 }), /perMinute above 0/)
  assert.throws(() => new TokenBucketLimiter({ burst: Number.NaN, perMinute: 1 }))
  const fallback = { burst: 5, perMinute: 10 }
  assert.deepEqual(parseRateLimitSetting(undefined, fallback), fallback)
  assert.deepEqual(parseRateLimitSetting('  ', fallback), fallback)
  assert.deepEqual(parseRateLimitSetting('3/6', fallback), { burst: 3, perMinute: 6 })
  assert.deepEqual(parseRateLimitSetting(' 20 / 0.5 ', fallback), { burst: 20, perMinute: 0.5 })
  for (const bad of ['0/5', '5/0', '5', 'five/ten', '5/10/2', '-1/5', '2000/5', '5/9000']) assert.equal(parseRateLimitSetting(bad, fallback), null, bad)
})

test('Sanity tokens (A-7): reads use SANITY_READ_TOKEN and writes SANITY_WRITE_TOKEN; neither falls back to the other', () => {
  const env = { SANITY_READ_TOKEN: 'viewer-token', SANITY_WRITE_TOKEN: 'editor-token', SANITY_AUTH_TOKEN: 'combined-token' }
  assert.deepEqual(resolveSanityToken('read', env), { access: 'read', token: 'viewer-token', source: 'SANITY_READ_TOKEN' })
  assert.deepEqual(resolveSanityToken('write', env), { access: 'write', token: 'editor-token', source: 'SANITY_WRITE_TOKEN' })
  const writeOnly = resolveSanityToken('read', { SANITY_WRITE_TOKEN: 'editor-token' })
  assert.equal(writeOnly.token, undefined, 'a read path never borrows the write token')
  assert.equal(writeOnly.source, 'none')
  const readOnly = resolveSanityToken('write', { SANITY_READ_TOKEN: 'viewer-token' })
  assert.equal(readOnly.token, undefined, 'a write path never borrows the read token')
})

test('Sanity tokens (A-7): the legacy combined token is a fallback with a warning; a public dataset reads without a token', () => {
  const legacy = { SANITY_AUTH_TOKEN: 'combined-token' }
  const read = resolveSanityToken('read', legacy)
  assert.equal(read.token, 'combined-token')
  assert.equal(read.source, 'SANITY_AUTH_TOKEN')
  assert.match(read.warning ?? '', /SANITY_READ_TOKEN is not set/)
  const write = resolveSanityToken('write', legacy)
  assert.equal(write.token, 'combined-token')
  assert.match(write.warning ?? '', /SANITY_WRITE_TOKEN is not set/)
  assert.ok(!JSON.stringify([read.warning, write.warning]).includes('combined-token'), 'warnings never carry the token')
  const pub = resolveSanityToken('read', { ...legacy, SANITY_DATASET_PUBLIC: 'on' })
  assert.deepEqual(pub, { access: 'read', source: 'public-dataset' }, 'a public dataset is read without any token')
  assert.equal(resolveSanityToken('write', { SANITY_DATASET_PUBLIC: 'on' }).token, undefined, 'a public dataset still needs a write token')

  const printed: string[] = []
  const once = createOnceWarner((m) => printed.push(m))
  once(read); once(read); once(write); once(resolveSanityToken('read', { SANITY_READ_TOKEN: 'v' }))
  assert.equal(printed.length, 2, 'each warning is printed once per process')
})
