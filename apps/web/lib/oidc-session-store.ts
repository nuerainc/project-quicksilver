import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Principal } from '@quicksilver/kernel/identity'
import type { SanityClient } from '@sanity/client'

export interface OidcLoginTransaction {
  stateDigest: string
  browserBindingDigest: string
  nonce: string
  codeVerifier: string
  returnTo: string
  createdAt: string
  expiresAt: string
}

export interface OidcWebSession {
  tokenDigest: string
  identity: { issuer: string; subject: string }
  principal: Principal
  createdAt: string
  expiresAt: string
  revokedAt?: string
}

/** The auth store contains only digests for browser secrets; PKCE material expires after ten minutes. */
export interface OidcSessionStore {
  createLoginTransaction(transaction: OidcLoginTransaction): Promise<void>
  consumeLoginTransaction(stateDigest: string, browserBindingDigest: string, now: Date): Promise<OidcLoginTransaction | null>
  createSession(session: OidcWebSession): Promise<void>
  getSession(tokenDigest: string, now: Date): Promise<OidcWebSession | null>
  revokeSession(tokenDigest: string, at: Date): Promise<boolean>
}

let configuredStore: OidcSessionStore | undefined

/** Dependency seam for isolated auth tests and deployment composition. */
export function setOidcSessionStore(store: OidcSessionStore | undefined): void {
  configuredStore = store
}

export function digestAuthSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export async function oidcSessionStore(): Promise<OidcSessionStore> {
  if (configuredStore) return configuredStore
  const client = (await import('./sanity-client.ts')).getSanityClient('write')
  return sanityOidcSessionStore(client)
}

export function sanityOidcSessionStore(client: SanityClient): OidcSessionStore {
  return {
    async createLoginTransaction(transaction) {
      await client.create({
        _id: `oidcLogin-${transaction.stateDigest}`,
        _type: 'oidcLoginTransaction',
        ...transaction,
      })
    },

    async consumeLoginTransaction(stateDigest, browserBindingDigest, now) {
      const id = `oidcLogin-${stateDigest}`
      const transaction = await client.getDocument<Record<string, unknown> & { _rev?: string; _type?: string; _id?: string }>(id)
      if (!transaction || transaction._type !== 'oidcLoginTransaction' || !transaction._rev
        || transaction.stateDigest !== stateDigest || typeof transaction.expiresAt !== 'string'
        || Date.parse(transaction.expiresAt) <= now.getTime() || transaction.consumedAt) return null
      if (typeof transaction.browserBindingDigest !== 'string') return null
      const expectedBinding = Buffer.from(transaction.browserBindingDigest, 'hex')
      const suppliedBinding = Buffer.from(browserBindingDigest, 'hex')
      if (expectedBinding.length !== 32 || suppliedBinding.length !== 32 || !timingSafeEqual(expectedBinding, suppliedBinding)) return null
      try {
        await client.patch(id).ifRevisionId(transaction._rev).set({ consumedAt: now.toISOString() }).commit({ visibility: 'sync' })
        await client.delete(id)
      } catch {
        // Revision conflicts mean another callback already consumed the state.
        // If erasure fails, refuse to issue a session while the PKCE verifier
        // may still be retained by the auth store.
        return null
      }
      if (typeof transaction.browserBindingDigest !== 'string'
        || typeof transaction.nonce !== 'string'
        || typeof transaction.codeVerifier !== 'string'
        || typeof transaction.returnTo !== 'string'
        || typeof transaction.createdAt !== 'string') return null
      return {
        stateDigest,
        browserBindingDigest: transaction.browserBindingDigest,
        nonce: transaction.nonce,
        codeVerifier: transaction.codeVerifier,
        returnTo: transaction.returnTo,
        createdAt: transaction.createdAt,
        expiresAt: transaction.expiresAt,
      }
    },

    async createSession(session) {
      await client.create({
        _id: `oidcWebSession-${randomUUID()}`,
        _type: 'oidcWebSession',
        ...session,
      })
    },

    async getSession(tokenDigest, now) {
      const rows = await client.fetch<Array<Record<string, unknown>>>(
        '*[_type == "oidcWebSession" && tokenDigest == $tokenDigest && !defined(revokedAt) && expiresAt > $now][0...1]',
        { tokenDigest, now: now.toISOString() },
      )
      const row = rows[0]
      if (!row || typeof row.createdAt !== 'string' || typeof row.expiresAt !== 'string'
        || !row.principal || typeof row.principal !== 'object') return null
      return {
        tokenDigest,
        identity: row.identity as OidcWebSession['identity'],
        principal: row.principal as Principal,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        ...(typeof row.revokedAt === 'string' ? { revokedAt: row.revokedAt } : {}),
      }
    },

    async revokeSession(tokenDigest, at) {
      const rows = await client.fetch<Array<{ _id: string; _rev: string }>>(
        '*[_type == "oidcWebSession" && tokenDigest == $tokenDigest && !defined(revokedAt)][0...1]{_id,_rev}',
        { tokenDigest },
      )
      const row = rows[0]
      if (!row) return false
      try {
        await client.patch(row._id).ifRevisionId(row._rev).set({ revokedAt: at.toISOString() }).commit({ visibility: 'sync' })
        return true
      } catch {
        return false
      }
    },
  }
}
