/**
 * Explicit OIDC identity-to-principal mapping.
 *
 * This is deliberately not a role-claim mapper: an IdP token cannot grant a
 * role by naming it. An owner-managed allowlist binds an exact issuer/subject
 * pair to the Quicksilver principal, tenant, and roles. Callers must verify
 * the OIDC token (signature, issuer, audience, expiry, nonce) before invoking
 * this module. Until P-108's session integration is complete, bearer-token
 * authentication remains the only API authentication path.
 */
import { validatePrincipal, type Principal } from '@quicksilver/kernel/identity'
import { createRemoteJWKSet, jwtVerify, customFetch } from 'jose'
import { timingSafeEqual } from 'node:crypto'

const ID = /^[a-zA-Z0-9][a-zA-Z0-9:._@/-]{0,127}$/
const TENANT = /^[a-z0-9][a-z0-9-]{0,62}$/
const ROLE = /^[a-z][a-z0-9-]{0,62}$/

export interface OidcIdentityBinding {
  issuer: string
  subject: string
  tenantId: string
  principalId: string
  roles: string[]
  displayName?: string
}

export interface VerifiedOidcClaims {
  iss: string
  sub: string
  name?: string
}

export type OidcIdentityMappingResult =
  | { ok: true; principal: Principal }
  | { ok: false; reason: 'unmapped' | 'tenant-mismatch' | 'misconfigured' }

export interface OidcTokenVerificationConfig {
  issuer: string
  audience: string
  jwksUri: string
  nonce: string
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

/** Verify an OIDC ID token's signature and protocol claims using the issuer's JWKS. */
export async function verifyOidcIdToken(
  token: string,
  config: OidcTokenVerificationConfig,
  options: { fetcher?: typeof fetch; now?: Date } = {},
): Promise<VerifiedOidcClaims> {
  if (typeof token !== 'string' || token.length < 32 || token.length > 32_768
    || !config || !validIssuer(config.issuer) || !validHttpsUrl(config.jwksUri)
    || typeof config.audience !== 'string' || !config.audience.trim()
    || typeof config.nonce !== 'string' || config.nonce.length < 16 || config.nonce.length > 256) {
    throw new Error('OIDC token verification is not configured correctly.')
  }

  const cacheKey = `${config.issuer}\u0000${config.jwksUri}`
  let jwks = jwksCache.get(cacheKey)
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(config.jwksUri), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 10 * 60_000,
      [customFetch]: async (url, init) => {
        const response = await (options.fetcher ?? fetch)(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(5_000) })
        if (!response.ok) throw new Error('OIDC signing keys are unavailable.')
        return response
      },
    })
    if (jwksCache.size >= 32) jwksCache.delete(jwksCache.keys().next().value!)
    jwksCache.set(cacheKey, jwks)
  }

  const { payload } = await jwtVerify(token, jwks, {
    issuer: config.issuer,
    audience: config.audience,
    algorithms: ['RS256', 'PS256', 'ES256'],
    maxTokenAge: '10 minutes',
    clockTolerance: 5,
    ...(options.now ? { currentDate: options.now } : {}),
  })
  if (typeof payload.sub !== 'string' || !payload.sub || typeof payload.iss !== 'string') {
    throw new Error('OIDC ID token is missing its issuer or subject.')
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if ((payload.azp !== undefined && payload.azp !== config.audience)
    || (audiences.length > 1 && payload.azp !== config.audience)) {
    throw new Error('OIDC ID token authorized party did not match the client.')
  }
  if (typeof payload.nonce !== 'string' || payload.nonce.length !== config.nonce.length
    || !timingSafeEqual(Buffer.from(payload.nonce), Buffer.from(config.nonce))) {
    throw new Error('OIDC ID token nonce did not match the login transaction.')
  }
  return {
    iss: payload.iss,
    sub: payload.sub,
    ...(typeof payload.name === 'string' ? { name: payload.name.slice(0, 200) } : {}),
  }
}

/** Parse the owner-managed OIDC allowlist. Invalid/ambiguous config fails closed. */
export function parseOidcIdentityBindings(json: string | undefined): OidcIdentityBinding[] | null {
  if (!json?.trim()) return null
  let parsed: unknown
  try { parsed = JSON.parse(json) } catch { return null }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 1000) return null

  const bindings: OidcIdentityBinding[] = []
  const subjects = new Set<string>()
  for (const value of parsed) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const row = value as Record<string, unknown>
    if (Object.keys(row).some((key) => !['issuer', 'subject', 'tenantId', 'principalId', 'roles', 'displayName'].includes(key))) return null
    if (typeof row.issuer !== 'string' || !validIssuer(row.issuer)) return null
    if (typeof row.subject !== 'string' || row.subject.length < 1 || row.subject.length > 512) return null
    if (typeof row.tenantId !== 'string' || !TENANT.test(row.tenantId)) return null
    if (typeof row.principalId !== 'string' || !ID.test(row.principalId)) return null
    if (!Array.isArray(row.roles) || row.roles.length < 1 || row.roles.length > 32 || row.roles.some((role) => typeof role !== 'string' || !ROLE.test(role))) return null
    if (new Set(row.roles).size !== row.roles.length) return null
    if (row.displayName !== undefined && (typeof row.displayName !== 'string' || row.displayName.trim().length === 0 || row.displayName.length > 100)) return null
    const key = `${row.issuer}\u0000${row.subject}`
    if (subjects.has(key)) return null
    subjects.add(key)
    const principal: Principal = {
      id: row.principalId,
      kind: 'human',
      tenantId: row.tenantId,
      roles: [...row.roles] as string[],
      ...(typeof row.displayName === 'string' ? { displayName: row.displayName.trim() } : {}),
    }
    if (validatePrincipal(principal).length) return null
    bindings.push({
      issuer: row.issuer,
      subject: row.subject,
      tenantId: row.tenantId,
      principalId: row.principalId,
      roles: [...row.roles] as string[],
      ...(typeof row.displayName === 'string' ? { displayName: row.displayName.trim() } : {}),
    })
  }
  return bindings
}

/** Map claims only after cryptographic OIDC verification; never trust tenant/roles from claims. */
export function mapVerifiedOidcIdentity(
  claims: VerifiedOidcClaims,
  bindings: readonly OidcIdentityBinding[] | null,
  expectedTenantId: string,
): OidcIdentityMappingResult {
  if (!bindings || !TENANT.test(expectedTenantId)) return { ok: false, reason: 'misconfigured' }
  if (typeof claims?.iss !== 'string' || typeof claims.sub !== 'string' || !claims.sub) return { ok: false, reason: 'unmapped' }
  const matches = bindings.filter((binding) => binding.issuer === claims.iss && binding.subject === claims.sub)
  if (matches.length !== 1) return { ok: false, reason: 'unmapped' }
  const binding = matches[0]!
  if (binding.tenantId !== expectedTenantId) return { ok: false, reason: 'tenant-mismatch' }
  const principal: Principal = {
    id: binding.principalId,
    kind: 'human',
    tenantId: binding.tenantId,
    roles: [...binding.roles],
    ...(binding.displayName ? { displayName: binding.displayName } : {}),
  }
  if (validatePrincipal(principal).length) return { ok: false, reason: 'misconfigured' }
  return { ok: true, principal }
}

function validIssuer(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && url.username === '' && url.password === '' && url.search === '' && url.hash === ''
      && url.href.replace(/\/$/, '') === value.replace(/\/$/, '')
  } catch { return false }
}

function validHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}
