/**
 * Threat model T-67: the web app's Content-Security-Policy and companion
 * headers (lib/security-headers.ts, applied by middleware.ts). Run by the root
 * `seed:test` script.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { STATIC_SECURITY_HEADERS, contentSecurityPolicy, generateNonce } from './security-headers.ts'

function directives(policy: string): Map<string, string[]> {
  return new Map(policy.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name!, values]))
}

test('CSP (T-67): no unsafe-eval, no wildcard or third-party script source, nonce plus strict-dynamic only', () => {
  const nonce = generateNonce()
  const policy = contentSecurityPolicy({ nonce })
  assert.equal(policy.includes('unsafe-eval'), false)
  const d = directives(policy)
  const script = d.get('script-src')!
  assert.deepEqual(script, [`'nonce-${nonce}'`, "'strict-dynamic'"])
  for (const value of script) {
    assert.equal(value.includes('*'), false, value)
    assert.equal(/^(https?:|data:|blob:)/.test(value) || /\./.test(value.replace(/^'nonce-.*'$/, '')), false, `host source in script-src: ${value}`)
    assert.notEqual(value, "'unsafe-inline'")
  }
  assert.equal(d.has('script-src-elem') || d.has('script-src-attr'), false)
  // No wildcard anywhere in the policy.
  assert.equal(/(^|\s)\*|\*\./.test(policy), false, policy)
})

test('CSP (T-67): same-origin connections only, no framing, no plugins, companions set', () => {
  const d = directives(contentSecurityPolicy({ nonce: generateNonce() }))
  assert.deepEqual(d.get('connect-src'), ["'self'"])
  assert.deepEqual(d.get('frame-ancestors'), ["'none'"])
  assert.deepEqual(d.get('object-src'), ["'none'"])
  assert.deepEqual(d.get('base-uri'), ["'none'"])
  assert.deepEqual(d.get('default-src'), ["'self'"])
  // Inline styles are allowed for style-src only (Next.js/React emit them without a nonce).
  assert.deepEqual(d.get('style-src'), ["'self'", "'unsafe-inline'"])
  const headers = Object.fromEntries(STATIC_SECURITY_HEADERS.map(({ key, value }) => [key.toLowerCase(), value]))
  assert.deepEqual(headers, { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' })
})

test('CSP (T-67): unsafe-eval appears only for next dev, and middleware enables it only when NODE_ENV is development', () => {
  const dev = directives(contentSecurityPolicy({ nonce: generateNonce(), development: true }))
  assert.ok(dev.get('script-src')!.includes("'unsafe-eval'"))
  const middleware = readFileSync(new URL('../middleware.ts', import.meta.url), 'utf8')
  assert.match(middleware, /development: process\.env\.NODE_ENV === 'development'/)
  assert.match(middleware, /response\.headers\.set\('content-security-policy', policy\)/)
  assert.match(middleware, /requestHeaders\.set\('content-security-policy', policy\)/)
  assert.match(middleware, /STATIC_SECURITY_HEADERS/)
  assert.match(middleware, /runtime: 'nodejs'/, 'middleware must use Node.js runtime for Vercel Services')
})

test('CSP (T-67): nonces are fresh, base64 and validated', () => {
  const a = generateNonce()
  const b = generateNonce()
  assert.notEqual(a, b)
  assert.match(a, /^[A-Za-z0-9+/]{22}==$/)
  for (const bad of ['', 'short', "abc' 'unsafe-inline", 'x'.repeat(15)]) {
    assert.throws(() => contentSecurityPolicy({ nonce: bad }), /nonce/)
  }
})
