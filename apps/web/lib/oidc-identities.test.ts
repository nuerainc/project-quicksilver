import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'

import { mapVerifiedOidcIdentity, parseOidcIdentityBindings, verifyOidcIdToken } from './oidc-identities.ts'

const binding = { issuer: 'https://id.example.test/tenant', subject: 'idp-subject-17', tenantId: 'nuera', principalId: 'user:brodi', roles: ['supervisor'], displayName: 'Brodi' }
const claims = { iss: binding.issuer, sub: binding.subject, email: 'untrusted@example.test', roles: ['tenant-admin'], tenantId: 'another-tenant' }

test('OIDC maps an exact verified issuer and subject to configured human identity, ignoring privilege claims', () => {
  const bindings = parseOidcIdentityBindings(JSON.stringify([binding]))
  assert.ok(bindings)
  assert.deepEqual(mapVerifiedOidcIdentity(claims, bindings, 'nuera'), {
    ok: true,
    principal: { id: 'user:brodi', kind: 'human', tenantId: 'nuera', roles: ['supervisor'], displayName: 'Brodi' },
  })
})

test('OIDC refuses unknown subjects and issuer substitution', () => {
  const bindings = parseOidcIdentityBindings(JSON.stringify([binding]))
  assert.ok(bindings)
  assert.deepEqual(mapVerifiedOidcIdentity({ ...claims, sub: 'other' }, bindings, 'nuera'), { ok: false, reason: 'unmapped' })
  assert.deepEqual(mapVerifiedOidcIdentity({ ...claims, iss: 'https://attacker.test' }, bindings, 'nuera'), { ok: false, reason: 'unmapped' })
})

test('OIDC refuses cross-tenant identity mappings and absent config', () => {
  const bindings = parseOidcIdentityBindings(JSON.stringify([binding]))
  assert.ok(bindings)
  assert.deepEqual(mapVerifiedOidcIdentity(claims, bindings, 'globex'), { ok: false, reason: 'tenant-mismatch' })
  assert.deepEqual(mapVerifiedOidcIdentity(claims, null, 'nuera'), { ok: false, reason: 'misconfigured' })
})

test('OIDC binding parser rejects malformed, duplicate, insecure, and role-injection entries', () => {
  assert.equal(parseOidcIdentityBindings(undefined), null)
  assert.equal(parseOidcIdentityBindings('{'), null)
  assert.equal(parseOidcIdentityBindings(JSON.stringify([{ ...binding, issuer: 'http://id.example.test' }])), null)
  assert.equal(parseOidcIdentityBindings(JSON.stringify([{ ...binding, roles: [] }])), null)
  assert.equal(parseOidcIdentityBindings(JSON.stringify([binding, binding])), null)
  assert.equal(parseOidcIdentityBindings(JSON.stringify([{ ...binding, admin: true }])), null)
  assert.equal(parseOidcIdentityBindings(JSON.stringify([{ ...binding, principalId: 'bad id' }])), null)
})

async function signedIdToken(input: { issuer: string; audience: string | string[]; nonce: string; subject?: string; expired?: boolean; azp?: string }) {
  const keys = await generateKeyPair('RS256')
  const kid = randomUUID()
  const jwk = await exportJWK(keys.publicKey)
  Object.assign(jwk, { kid, alg: 'RS256', use: 'sig' })
  const now = new Date()
  const exp = input.expired ? Math.floor(now.getTime() / 1000) - 1 : Math.floor(now.getTime() / 1000) + 300
  const token = await new SignJWT({ nonce: input.nonce, name: 'Test User', ...(input.azp ? { azp: input.azp } : {}) })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(input.issuer)
    .setAudience(input.audience)
    .setSubject(input.subject ?? 'idp-subject-17')
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .setExpirationTime(exp)
    .sign(keys.privateKey)
  return { token, jwk, kid, now }
}

test('OIDC verifies a signed ID token against exact issuer, audience, expiry, nonce and JWKS key', async () => {
  const issuer = `https://id.example.test/${randomUUID()}`
  const nonce = 'nonce-value-that-is-long-enough-123'
  const signed = await signedIdToken({ issuer, audience: 'quicksilver-client', nonce })
  let fetched = 0
  const fetcher: typeof fetch = async (input) => {
    fetched++
    assert.equal(String(input), `${issuer}/jwks`)
    return new Response(JSON.stringify({ keys: [signed.jwk] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const claims = await verifyOidcIdToken(signed.token, { issuer, audience: 'quicksilver-client', jwksUri: `${issuer}/jwks`, nonce }, { fetcher, now: signed.now })
  assert.deepEqual(claims, { iss: issuer, sub: 'idp-subject-17', name: 'Test User' })
  assert.equal(fetched, 1)
})

test('OIDC ID token verification rejects wrong nonce, audience, issuer, expiry, and altered signatures', async () => {
  const issuer = `https://id.example.test/${randomUUID()}`
  const nonce = 'nonce-value-that-is-long-enough-456'
  const signed = await signedIdToken({ issuer, audience: 'quicksilver-client', nonce })
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ keys: [signed.jwk] }), { status: 200 })
  const base = { issuer, audience: 'quicksilver-client', jwksUri: `${issuer}/jwks`, nonce }
  await assert.rejects(verifyOidcIdToken(signed.token, { ...base, nonce: 'wrong-nonce-value-1234567890' }, { fetcher, now: signed.now }))
  await assert.rejects(verifyOidcIdToken(signed.token, { ...base, audience: 'other-client' }, { fetcher, now: signed.now }))
  await assert.rejects(verifyOidcIdToken(signed.token, { ...base, issuer: `${issuer}/wrong` }, { fetcher, now: signed.now }))
  const expired = await signedIdToken({ issuer, audience: base.audience, nonce, expired: true })
  const expiredFetch: typeof fetch = async () => new Response(JSON.stringify({ keys: [expired.jwk] }), { status: 200 })
  await assert.rejects(verifyOidcIdToken(expired.token, base, { fetcher: expiredFetch, now: signed.now }))
  const [header, payload, signature] = signed.token.split('.')
  const alteredSignature = `${header}.${payload}.${signature![0] === 'A' ? 'B' : 'A'}${signature!.slice(1)}`
  await assert.rejects(verifyOidcIdToken(alteredSignature, base, { fetcher, now: signed.now }))
})

test('OIDC refuses untrusted JWKS URLs and malformed verification inputs before fetching', async () => {
  let fetched = false
  const fetcher: typeof fetch = async () => { fetched = true; return new Response('{}') }
  const base = { issuer: 'https://id.example.test', audience: 'client', nonce: 'nonce-value-that-is-long-enough-789' }
  await assert.rejects(verifyOidcIdToken('a'.repeat(40), { ...base, jwksUri: 'http://attacker.example/jwks' }, { fetcher }))
  await assert.rejects(verifyOidcIdToken('a'.repeat(40), { ...base, issuer: 'http://localhost:9000' , jwksUri: 'https://id.example.test/jwks' }, { fetcher }))
  await assert.rejects(verifyOidcIdToken('short', { ...base, jwksUri: 'https://id.example.test/jwks' }, { fetcher }))
  assert.equal(fetched, false)
})

test('OIDC multi-audience tokens require an authorized-party claim matching the client', async () => {
  const issuer = `https://id.example.test/${randomUUID()}`
  const nonce = 'nonce-value-that-is-long-enough-999'
  const signed = await signedIdToken({ issuer, audience: ['quicksilver-client', 'other-client'], nonce, azp: 'other-client' })
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({ keys: [signed.jwk] }), { status: 200 })
  await assert.rejects(verifyOidcIdToken(signed.token, { issuer, audience: 'quicksilver-client', jwksUri: `${issuer}/jwks`, nonce }, { fetcher, now: signed.now }))
  const approvedIssuer = `https://id.example.test/${randomUUID()}`
  const approved = await signedIdToken({ issuer: approvedIssuer, audience: ['quicksilver-client', 'other-client'], nonce, azp: 'quicksilver-client' })
  const approvedFetch: typeof fetch = async () => new Response(JSON.stringify({ keys: [approved.jwk] }), { status: 200 })
  assert.equal((await verifyOidcIdToken(approved.token, { issuer: approvedIssuer, audience: 'quicksilver-client', jwksUri: `${approvedIssuer}/jwks`, nonce }, { fetcher: approvedFetch, now: approved.now })).sub, 'idp-subject-17')
})
