import { test } from 'node:test'
import assert from 'node:assert/strict'
import { guardWebRoute, resetWebRateLimits } from './route-guard.ts'
import { digestAuthSecret, setOidcSessionStore, type OidcSessionStore, type OidcWebSession } from './oidc-session-store.ts'
import { setAuthorizationAuditAppender, type AuthorizationAuditRecord } from './authorization-audit-store.ts'

const issuedAt = new Date('2026-09-30T18:00:00.000Z')
const secret = 'browser-session-secret-that-is-never-stored'

class SessionStore implements OidcSessionStore {
  readonly session: OidcWebSession
  constructor(session: OidcWebSession) { this.session = session }
  async createLoginTransaction(): Promise<void> {}
  async consumeLoginTransaction(): Promise<null> { return null }
  async createSession(): Promise<void> {}
  async getSession(digest: string, now: Date): Promise<OidcWebSession | null> {
    return digest === this.session.tokenDigest && Date.parse(this.session.expiresAt) > now.getTime() && !this.session.revokedAt ? this.session : null
  }
  async revokeSession(): Promise<boolean> { return true }
}

test('OIDC browser sessions pass through the same permission checks and authorization audit as bearer principals', async () => {
  const names = ['QUICKSILVER_TENANT_ID', 'QUICKSILVER_OIDC_USERS', 'QUICKSILVER_PRINCIPALS', 'NQC_SUPERVISOR_TOKEN', 'NQC_SUPERVISOR_ID']
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]))
  const audits: AuthorizationAuditRecord[] = []
  try {
    process.env.QUICKSILVER_TENANT_ID = 'acme'
    process.env.QUICKSILVER_OIDC_USERS = JSON.stringify([{ issuer: 'https://idp.example.test', subject: 'user-1', tenantId: 'acme', principalId: 'entity-ana', roles: ['supervisor'], displayName: 'Ana' }])
    delete process.env.QUICKSILVER_PRINCIPALS
    delete process.env.NQC_SUPERVISOR_TOKEN
    delete process.env.NQC_SUPERVISOR_ID
    setAuthorizationAuditAppender(async (record) => { audits.push(record); return 'audit-test' })
    setOidcSessionStore(new SessionStore({
      tokenDigest: digestAuthSecret(secret),
      identity: { issuer: 'https://idp.example.test', subject: 'user-1' },
      principal: { id: 'entity-ana', kind: 'human', tenantId: 'acme', roles: ['supervisor'], displayName: 'Ana' },
      createdAt: issuedAt.toISOString(),
      expiresAt: '2099-01-01T00:00:00.000Z',
    }))
    resetWebRateLimits()
    const request = new Request('https://app.example.test/api/workflows/publish', { headers: { cookie: `__Host-quicksilver-session=${secret}` } })
    const allowed = await guardWebRoute(request, 'workflows/publish')
    assert.deepEqual(allowed, { ok: true, principalId: 'entity-ana', principalKind: 'human' })
    assert.equal(audits.at(-1)?.outcome, 'allow')
    assert.equal(audits.at(-1)?.actorId, 'entity-ana')

    process.env.QUICKSILVER_OIDC_USERS = JSON.stringify([{ issuer: 'https://idp.example.test', subject: 'user-1', tenantId: 'acme', principalId: 'entity-ana', roles: ['viewer'] }])
    const denied = await guardWebRoute(request, 'workflows/publish')
    assert.equal(denied.ok, false)
    if (!denied.ok) assert.equal(denied.status, 403)
    assert.equal(audits.at(-1)?.outcome, 'deny')
    assert.equal(audits.at(-1)?.actorId, undefined)
  } finally {
    setOidcSessionStore(undefined)
    setAuthorizationAuditAppender(undefined)
    for (const name of names) {
      const value = prior[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
