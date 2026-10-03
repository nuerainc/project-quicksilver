import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OIDC_SESSION_COOKIE, readBrowserSession, revokeBrowserSession, type OidcBrowserEnv } from './oidc-browser-auth.ts'
import { digestAuthSecret, type OidcLoginTransaction, type OidcSessionStore, type OidcWebSession } from './oidc-session-store.ts'

// P-107: one auth store (the same Sanity dataset) can serve more than one tenant's console.

const ALPHA = 'a'.repeat(43)
const BETA = 'b'.repeat(43)
const NOW = new Date('2026-10-03T12:00:00.000Z')
const ISSUER = 'https://accounts.example.test'

class SharedStore implements OidcSessionStore {
  readonly sessions = new Map<string, OidcWebSession>()
  async createLoginTransaction(_t: OidcLoginTransaction) {}
  async consumeLoginTransaction() { return null }
  async createSession(s: OidcWebSession) { this.sessions.set(s.tokenDigest, s) }
  async getSession(digest: string) { return this.sessions.get(digest) ?? null }
  async revokeSession(digest: string, at: Date) {
    const s = this.sessions.get(digest)
    if (!s || s.revokedAt) return false
    this.sessions.set(digest, { ...s, revokedAt: at.toISOString() })
    return true
  }
}

const users = (tenantId: string, subject = 'sub-1', principalId = 'person-owner') =>
  JSON.stringify([{ issuer: ISSUER, subject, tenantId, principalId, roles: ['viewer'], displayName: 'Owner' }])
const env = (tenantId: string, usersJson = users(tenantId)): OidcBrowserEnv => ({ QUICKSILVER_TENANT_ID: tenantId, QUICKSILVER_OIDC_USERS: usersJson } as OidcBrowserEnv)
const cookie = (token: string) => new Request('https://app.example.test/api/auth/session', { headers: { cookie: `${OIDC_SESSION_COOKIE}=${token}` } })

async function mint(store: SharedStore, token: string, tenantId: string, subject = 'sub-1') {
  await store.createSession({
    tokenDigest: digestAuthSecret(token),
    identity: { issuer: ISSUER, subject },
    principal: { id: 'person-owner', kind: 'human', tenantId, roles: ['viewer'] },
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
  })
}

test('a session minted for one tenant is refused by another tenant sharing the store, even for the same person and principal id', async () => {
  const store = new SharedStore()
  await mint(store, ALPHA, 'alpha')
  const deps = { store, now: () => NOW }
  assert.equal((await readBrowserSession(cookie(ALPHA), env('alpha'), deps))?.tenantId, 'alpha')
  // Beta maps the same issuer, subject and principal id; the alpha session still must not work there.
  assert.equal(await readBrowserSession(cookie(ALPHA), env('beta'), deps), null)
})

test('a tenant never takes its access from the stored principal: roles and tenant come from its own allowlist', async () => {
  const store = new SharedStore()
  await mint(store, ALPHA, 'alpha')
  const widened = JSON.stringify([{ issuer: ISSUER, subject: 'sub-1', tenantId: 'alpha', principalId: 'person-owner', roles: ['viewer', 'tenant-admin'] }])
  const read = await readBrowserSession(cookie(ALPHA), env('alpha', widened), { store, now: () => NOW })
  assert.deepEqual(read?.roles, ['viewer', 'tenant-admin'], 'roles follow the live allowlist, not what was stored at sign-in')
  assert.equal(await readBrowserSession(cookie(ALPHA), env('alpha', users('beta')), { store, now: () => NOW }), null, 'an allowlist that moved the person to another tenant ends the session')
})

test('signing out in one tenant does not touch another tenant\'s sessions', async () => {
  const store = new SharedStore()
  await mint(store, ALPHA, 'alpha')
  await mint(store, BETA, 'beta', 'sub-2')
  const deps = { store, now: () => NOW }
  assert.equal(await revokeBrowserSession(cookie(ALPHA), env('alpha'), deps), true)
  assert.equal(await readBrowserSession(cookie(ALPHA), env('alpha'), deps), null)
  assert.equal((await readBrowserSession(cookie(BETA), env('beta', users('beta', 'sub-2')), deps))?.tenantId, 'beta')
})

test('an unknown or missing session cookie reads as signed out in every tenant', async () => {
  const store = new SharedStore()
  const deps = { store, now: () => NOW }
  assert.equal(await readBrowserSession(cookie('n'.repeat(40)), env('alpha'), deps), null)
  assert.equal(await readBrowserSession(new Request('https://app.example.test/'), env('beta'), deps), null)
})
