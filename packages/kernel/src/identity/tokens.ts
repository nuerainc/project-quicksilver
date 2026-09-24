import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

import { validatePrincipal, type Principal } from './rbac.ts'

/**
 * Server-only bearer-token identity provider.
 *
 * Only SHA-256 digests of tokens are held, so a leaked configuration does not
 * leak usable credentials. Comparison is constant-time over the digests.
 * Intended as the interim credential layer until an SSO/OIDC provider is
 * attached behind the same `IdentityProvider` port.
 */

export interface IdentityProvider {
  authenticate(credential: string | undefined): Principal | undefined
}

export interface TokenPrincipalConfig extends Principal {
  /** `sha256:<hex>` digest of the bearer token. */
  tokenDigest: string
}

export const MIN_TOKEN_LENGTH = 32

export function digestToken(token: string): string {
  return `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`
}

/** Generate a new random bearer token and its digest. Show the token once; store only the digest. */
export function generateToken(): { token: string; tokenDigest: string } {
  const token = `qs_${randomBytes(32).toString('base64url')}`
  return { token, tokenDigest: digestToken(token) }
}

export class StaticTokenIdentityProvider implements IdentityProvider {
  private readonly entries: Array<{ digest: Buffer; principal: Readonly<Principal> }> = []

  constructor(configs: readonly TokenPrincipalConfig[] = []) {
    for (const config of configs) this.add(config)
  }

  add(config: TokenPrincipalConfig): void {
    const errors = validatePrincipal(config)
    const match = /^sha256:([0-9a-f]{64})$/.exec(config?.tokenDigest ?? '')
    if (!match) errors.push('tokenDigest must be sha256:<64 hex>.')
    if (errors.length) throw new Error(`Invalid principal "${config?.id ?? 'unknown'}": ${errors.join(' ')}`)
    if (this.entries.some((entry) => entry.principal.id === config.id && entry.principal.tenantId === config.tenantId)) {
      throw new Error(`Principal "${config.id}" is already registered for tenant "${config.tenantId}".`)
    }
    const digest = Buffer.from(match![1]!, 'hex')
    if (this.entries.some((entry) => timingSafeEqual(entry.digest, digest))) throw new Error('Two principals cannot share a token.')
    const { tokenDigest: _omit, ...principal } = config
    this.entries.push({ digest, principal: Object.freeze({ ...principal, roles: Object.freeze([...principal.roles]) }) })
  }

  authenticate(credential: string | undefined): Principal | undefined {
    if (typeof credential !== 'string' || credential.length < MIN_TOKEN_LENGTH || credential.length > 512) return undefined
    const supplied = Buffer.from(digestToken(credential).slice('sha256:'.length), 'hex')
    let found: Readonly<Principal> | undefined
    // Compare against every entry so timing does not reveal which one matched.
    for (const entry of this.entries) if (timingSafeEqual(entry.digest, supplied)) found = entry.principal
    if (!found || found.disabled) return undefined
    return { ...found, roles: [...found.roles] }
  }

  /** Authenticate an `Authorization: Bearer <token>` header value. */
  authenticateHeader(authorization: string | null | undefined): Principal | undefined {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')
    return match ? this.authenticate(match[1]) : undefined
  }
}

/**
 * Parse principals from JSON (e.g. an environment variable). Invalid input
 * throws instead of silently granting or dropping access.
 */
export function principalsFromJson(json: string | undefined): TokenPrincipalConfig[] {
  if (!json?.trim()) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error('Principal configuration is not valid JSON.')
  }
  if (!Array.isArray(parsed)) throw new Error('Principal configuration must be a JSON array.')
  return parsed as TokenPrincipalConfig[]
}
