import { mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { exportJWK, SignJWT } from 'jose'
import {
  completeOidcLogin,
  OIDC_LOGIN_COOKIE,
  OIDC_SESSION_COOKIE,
  readBrowserSession,
  revokeBrowserSession,
  startOidcLogin,
  type OidcAuthDependencies,
  type OidcBrowserEnv,
} from './oidc-browser-auth.ts'
import { digestAuthSecret, type OidcLoginTransaction, type OidcSessionStore, type OidcWebSession } from './oidc-session-store.ts'

const NOW = new Date('2026-09-30T18:00:00.000Z')
const ISSUER = 'https://idp.example.test/tenant'
const TENANT = 'nuera'

class MemoryStore implements OidcSessionStore {
  readonly transactions = new Map<string, OidcLoginTransaction>()
  readonly sessions = new Map<string, OidcWebSession>()

  async createLoginTransaction(value: OidcLoginTransaction): Promise<void> { this.transactions.set(value.stateDigest, value) }
  async consumeLoginTransaction(stateDigest: string, bindingDigest: string, now: Date): Promise<OidcLoginTransaction | null> {
    const value = this.transactions.get(stateDigest)
    if (!value || value.expiresAt <= now.toISOString() || this.consumed.has(stateDigest)
      || value.browserBindingDigest !== bindingDigest) return null
    this.consumed.add(stateDigest)
    return value
  }
  async createSession(value: OidcWebSession): Promise<void> { this.sessions.set(value.tokenDigest, value) }
  async getSession(tokenDigest: string): Promise<OidcWebSession | null> {
    const value = this.sessions.get(tokenDigest)
    return value && !value.revokedAt ? value : null
  }
  async revokeSession(tokenDigest: string, at: Date): Promise<boolean> {
    const value = this.sessions.get(tokenDigest)
    if (!value || value.revokedAt) return false
    this.sessions.set(tokenDigest, { ...value, revokedAt: at.toISOString() })
    return true
  }
  private consumed = new Set<string>()
}

const binding = (roles: string[]) => JSON.stringify([{ issuer: ISSUER, subject: 'user-123', tenantId: TENANT, principalId: 'person-owner', roles, displayName: 'Owner' }])

async function setup() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = await exportJWK(publicKey)
  jwk.kid = `key-${randomUUID()}`
  jwk.use = 'sig'
  jwk.alg = 'RS256'
  const jwksUri = `https://idp.example.test/keys/${randomUUID()}`
  const tokenUri = `https://idp.example.test/${randomUUID()}/token`
  const metadata = {
    issuer: ISSUER,
    authorization_endpoint: 'https://idp.example.test/authorize',
    token_endpoint: tokenUri,
    jwks_uri: jwksUri,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post'],
  }
  const store = new MemoryStore()
  const env = {
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: 'quicksilver-client',
    OIDC_CLIENT_SECRET: 'client-secret-long-enough',
    OIDC_REDIRECT_URI: 'https://app.example.test/api/auth/oidc/callback',
    QUICKSILVER_TENANT_ID: TENANT,
    QUICKSILVER_OIDC_USERS: binding(['supervisor', 'developer']),
    NODE_ENV: 'production',
  }
  let tokenRequestBody: URLSearchParams | undefined
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input)
    if (url.endsWith('/.well-known/openid-configuration')) return Response.json(metadata)
    if (url === jwksUri) return Response.json({ keys: [jwk] })
    if (url === tokenUri) {
      tokenRequestBody = new URLSearchParams(String(init.body ?? ''))
      const nonce = [...store.transactions.values()][0]?.nonce
      const idToken = await new SignJWT({ nonce, name: 'Owner' })
        .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
        .setIssuer(ISSUER).setSubject('user-123').setAudience('quicksilver-client')
        .setIssuedAt(Math.floor(NOW.getTime() / 1000)).setExpirationTime(Math.floor(NOW.getTime() / 1000) + 300)
        .sign(privateKey)
      return Response.json({ id_token: idToken })
    }
    throw new Error(`Unexpected test fetch: ${url}`)
  }
  const deps: OidcAuthDependencies = { store, fetcher, now: () => NOW }
  return { deps, env, store, tokenRequestBody: () => tokenRequestBody }
}

async function startFlow(deps: OidcAuthDependencies, env: OidcBrowserEnv) {
  const response = await startOidcLogin(new Request('https://app.example.test/api/auth/oidc/start?returnTo=%2Fworkflows'), env, deps)
  const location = response.headers.get('location')!
  const authorization = new URL(location)
  const cookie = response.headers.get('set-cookie')!
  const bindingValue = new RegExp(`${OIDC_LOGIN_COOKIE}=([^;]+)`).exec(cookie)?.[1]
  assert.ok(bindingValue)
  return { response, authorization, bindingValue }
}

test('OIDC login uses HTTPS discovery, state, nonce and S256 PKCE then creates a revocable server session', async () => {
  const { deps, env, store, tokenRequestBody } = await setup()
  const started = await startFlow(deps, env)
  assert.equal(started.response.status, 303)
  assert.equal(started.authorization.searchParams.get('response_type'), 'code')
  assert.equal(started.authorization.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(started.authorization.searchParams.get('state'))
  assert.ok(started.authorization.searchParams.get('nonce'))

  const callback = new Request(`https://app.example.test/api/auth/oidc/callback?code=authorization-code&state=${encodeURIComponent(started.authorization.searchParams.get('state')!)}`, {
    headers: { cookie: `${OIDC_LOGIN_COOKIE}=${started.bindingValue}` },
  })
  const completed = await completeOidcLogin(callback, env, deps)
  assert.equal(completed.status, 303)
  assert.equal(completed.headers.get('location'), 'https://app.example.test/workflows')
  assert.equal(tokenRequestBody()?.get('code_verifier'), [...store.transactions.values()][0]?.codeVerifier)
  assert.equal(tokenRequestBody()?.get('client_secret'), env.OIDC_CLIENT_SECRET)
  const sessionCookie = completed.headers.get('set-cookie')!
  const sessionToken = new RegExp(`${OIDC_SESSION_COOKIE}=([^;]+)`).exec(sessionCookie)?.[1]
  assert.ok(sessionToken)
  assert.match(sessionCookie, /HttpOnly; Secure; SameSite=Lax/)
  assert.ok(!JSON.stringify([...store.sessions.values()]).includes(sessionToken), 'the session token is never stored in the backing store')
  assert.equal([...store.sessions.values()][0]?.tokenDigest, digestAuthSecret(sessionToken))

  const sessionRequest = new Request('https://app.example.test/api/auth/session', { headers: { cookie: `${OIDC_SESSION_COOKIE}=${sessionToken}` } })
  assert.deepEqual(await readBrowserSession(sessionRequest, env, deps), {
    id: 'person-owner', kind: 'human', tenantId: TENANT, roles: ['supervisor', 'developer'], displayName: 'Owner',
  })
  const refreshedMappingEnv = { ...env, QUICKSILVER_OIDC_USERS: binding(['viewer']) }
  assert.deepEqual((await readBrowserSession(sessionRequest, refreshedMappingEnv, deps))?.roles, ['viewer'], 'session authorization reflects the current allowlist')
  assert.equal(await readBrowserSession(sessionRequest, { ...env, QUICKSILVER_OIDC_USERS: '[]' }, deps), null, 'removing the mapping revokes access without waiting for session expiry')

  assert.equal(await revokeBrowserSession(sessionRequest, env, deps), true)
  assert.equal(await readBrowserSession(sessionRequest, env, deps), null)
  assert.equal(await revokeBrowserSession(sessionRequest, env, deps), false, 'a second revocation is not reported as successful')
})

test('wrong browser binding cannot consume a valid OIDC state transaction', async () => {
  const { deps, env, store } = await setup()
  const started = await startFlow(deps, env)
  const state = started.authorization.searchParams.get('state')!
  const wrong = await completeOidcLogin(new Request(`https://app.example.test/api/auth/oidc/callback?code=x&state=${state}`, { headers: { cookie: `${OIDC_LOGIN_COOKIE}=${'x'.repeat(40)}` } }), env, deps)
  assert.equal(wrong.headers.get('location'), 'https://app.example.test/?auth=failed')
  assert.equal(store.sessions.size, 0)

  const valid = await completeOidcLogin(new Request(`https://app.example.test/api/auth/oidc/callback?code=x&state=${state}`, { headers: { cookie: `${OIDC_LOGIN_COOKIE}=${started.bindingValue}` } }), env, deps)
  assert.equal(valid.status, 303, 'the valid browser can complete after an invalid cross-browser attempt')
  const replay = await completeOidcLogin(new Request(`https://app.example.test/api/auth/oidc/callback?code=x&state=${state}`, { headers: { cookie: `${OIDC_LOGIN_COOKIE}=${started.bindingValue}` } }), env, deps)
  assert.equal(replay.headers.get('location'), 'https://app.example.test/?auth=failed')
})

test('OIDC start refuses insecure configuration and never accepts an external return path', async () => {
  const { deps, env } = await setup()
  const refused = await startOidcLogin(new Request('https://app.example.test/api/auth/oidc/start'), { ...env, OIDC_ISSUER: 'http://idp.example.test' }, deps)
  assert.equal(refused.headers.get('location'), 'https://app.example.test/?auth=failed')

  const started = await startOidcLogin(new Request('https://app.example.test/api/auth/oidc/start?returnTo=https%3A%2F%2Fevil.example'), env, deps)
  const state = new URL(started.headers.get('location')!).searchParams.get('state')!
  const cookie = started.headers.get('set-cookie')!
  const bindingValue = new RegExp(`${OIDC_LOGIN_COOKIE}=([^;]+)`).exec(cookie)![1]!
  const completed = await completeOidcLogin(new Request(`https://app.example.test/api/auth/oidc/callback?code=x&state=${state}`, { headers: { cookie: `${OIDC_LOGIN_COOKIE}=${bindingValue}` } }), env, deps)
  assert.equal(new URL(completed.headers.get('location')!).origin, 'https://app.example.test')
  assert.equal(new URL(completed.headers.get('location')!).pathname, '/')
})

test('a verified login that is not on the allowlist is refused and logged with its issuer and subject, and nothing else', async () => {
  const warn = mock.method(console, 'warn', () => {})
  const error = mock.method(console, 'error', () => {})
  try {
    const login = async (users: string | undefined) => {
      const { deps, env, store } = await setup()
      const withUsers = { ...env, QUICKSILVER_OIDC_USERS: users } as OidcBrowserEnv
      const started = await startFlow(deps, withUsers)
      const state = started.authorization.searchParams.get('state')!
      const response = await completeOidcLogin(new Request(`https://app.example.test/api/auth/oidc/callback?code=the-auth-code&state=${state}`, { headers: { cookie: `${OIDC_LOGIN_COOKIE}=${started.bindingValue}` } }), withUsers, deps)
      return { response, store }
    }

    // Someone else is on the allowlist: this person is verified but unmapped.
    const other = JSON.stringify([{ issuer: ISSUER, subject: 'someone-else', tenantId: TENANT, principalId: 'person-other', roles: ['viewer'] }])
    const unmapped = await login(other)
    assert.equal(unmapped.response.headers.get('location'), 'https://app.example.test/?auth=failed')
    assert.equal(unmapped.store.sessions.size, 0, 'no session is created')
    assert.ok(!(unmapped.response.headers.get('set-cookie') ?? '').includes(OIDC_SESSION_COOKIE), 'no session cookie is set')
    const lines = warn.mock.calls.map((c) => c.arguments.map(String).join(' '))
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, /^\[oidc\] login refused: identity is not on the allowlist /)
    const logged = JSON.parse(lines[0]!.slice(lines[0]!.indexOf('{')))
    assert.deepEqual(logged, { reason: 'unmapped', issuer: ISSUER, subject: 'user-123' })
    for (const secret of ['the-auth-code', 'client-secret-long-enough', 'eyJ', 'Owner']) {
      assert.ok(!lines[0]!.includes(secret), `the log line never contains ${secret}`)
    }

    // An allowlist that fails to parse is reported as misconfigured, not as an unknown person.
    warn.mock.resetCalls()
    const broken = await login('not json')
    assert.equal(broken.response.headers.get('location'), 'https://app.example.test/?auth=failed')
    assert.equal(JSON.parse(warn.mock.calls[0]!.arguments.join(' ').slice(warn.mock.calls[0]!.arguments.join(' ').indexOf('{'))).reason, 'misconfigured')

    // A person who is on the allowlist logs nothing.
    warn.mock.resetCalls()
    const mapped = await login(binding(['viewer']))
    assert.equal(mapped.response.status, 303)
    assert.equal(mapped.store.sessions.size, 1)
    assert.equal(warn.mock.calls.length, 0)
  } finally {
    warn.mock.restore()
    error.mock.restore()
  }
})
