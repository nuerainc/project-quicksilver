/**
 * Task clients (M7 part 4): per-client bearer tokens for tools that hand tasks
 * to Quicksilver (Claude and other MCP clients, agent platforms, scripts).
 *
 * - The host's human and service principals come from QUICKSILVER_PRINCIPALS
 *   (set by hand, never changed at run time). Task clients are added and
 *   revoked from the founder's machine with `npm run tasks -- client ...`, so
 *   they live in their own small registry: data/tasks/clients.json, mode 0600.
 * - Only the SHA-256 digest of each token is stored (the same `digestToken`
 *   and constant-time comparison as the kernel's StaticTokenIdentityProvider).
 *   The token itself is printed once, when the client is added, and never
 *   again.
 * - A client authenticates as a *service* principal `client:<name>` holding
 *   only the `task-client` role (task:submit, task:read-own). A client can
 *   never be human, so it can never approve anything.
 * - Revocation is recorded, not deleted: the entry keeps who revoked it and
 *   when, and its token stops working at once (the host re-reads the file
 *   when it changes).
 */
import { timingSafeEqual } from 'node:crypto'
import { stat } from 'node:fs/promises'

import type { Principal } from '@quicksilver/kernel/identity'
import { digestToken, generateToken, MIN_TOKEN_LENGTH } from '@quicksilver/kernel/identity/tokens'

import { readJson, writeJsonAtomic } from './operate-store.ts'

export const TASK_CLIENT_ROLE = 'task-client'
const NAME = /^[a-z0-9][a-z0-9-]{1,39}$/

export interface TaskClientRecord {
  name: string
  principalId: string
  /** `sha256:<hex>` of the token. The token itself is never stored. */
  tokenDigest: string
  createdAt: string
  createdBy: string
  revokedAt?: string
  revokedBy?: string
}

/** A client as listed: no digest. */
export type TaskClientSummary = Omit<TaskClientRecord, 'tokenDigest'> & { active: boolean }

export interface TaskClientPersistence {
  load(): Promise<TaskClientRecord[]>
  save(records: TaskClientRecord[]): Promise<void>
  /** Changes when the stored records change (used to reload). */
  version(): Promise<string>
}

export class FileTaskClientPersistence implements TaskClientPersistence {
  readonly path: string
  constructor(path: string) { this.path = path }
  load() { return readJson<TaskClientRecord[]>(this.path, []) }
  save(records: TaskClientRecord[]) { return writeJsonAtomic(this.path, records) }
  async version() {
    try { const s = await stat(this.path); return `${s.mtimeMs}:${s.size}` } catch { return 'none' }
  }
}

export class MemoryTaskClientPersistence implements TaskClientPersistence {
  private records: TaskClientRecord[] = []
  private rev = 0
  async load() { return structuredClone(this.records) }
  async save(records: TaskClientRecord[]) { this.records = structuredClone(records); this.rev++ }
  async version() { return String(this.rev) }
}

export class TaskClientRegistry {
  private readonly persistence: TaskClientPersistence
  private readonly tenantId: string
  private readonly now: () => number
  private cache?: { version: string; records: TaskClientRecord[] }

  constructor(options: { persistence: TaskClientPersistence; tenantId: string; now?: () => number }) {
    this.persistence = options.persistence
    this.tenantId = options.tenantId
    this.now = options.now ?? Date.now
  }

  private async records(): Promise<TaskClientRecord[]> {
    const version = await this.persistence.version()
    if (!this.cache || this.cache.version !== version) this.cache = { version, records: await this.persistence.load() }
    return this.cache.records
  }

  /** Add a client. Returns the token ONCE; only its digest is stored. */
  async add(name: string, createdBy: string): Promise<{ client: TaskClientSummary; token: string }> {
    if (!NAME.test(name)) throw new Error('A client name is 2 to 40 lowercase letters, digits or "-".')
    const records = await this.persistence.load()
    if (records.some((r) => r.name === name)) throw new Error(`A client named "${name}" already exists (revoked clients keep their name). Choose another name.`)
    const { token, tokenDigest } = generateToken()
    const record: TaskClientRecord = { name, principalId: `client:${name}`, tokenDigest, createdAt: new Date(this.now()).toISOString(), createdBy }
    await this.persistence.save([...records, record])
    this.cache = undefined
    return { client: summarize(record), token }
  }

  async list(): Promise<TaskClientSummary[]> {
    return (await this.persistence.load()).map(summarize)
  }

  async revoke(name: string, revokedBy: string): Promise<TaskClientSummary> {
    const records = await this.persistence.load()
    const record = records.find((r) => r.name === name)
    if (!record) throw new Error(`No client named "${name}".`)
    if (record.revokedAt) return summarize(record)
    const next = records.map((r) => (r.name === name ? { ...r, revokedAt: new Date(this.now()).toISOString(), revokedBy } : r))
    await this.persistence.save(next)
    this.cache = undefined
    return summarize(next.find((r) => r.name === name)!)
  }

  /** Authenticate a bearer token. Compares against every active entry in constant time. */
  async authenticate(token: string | undefined): Promise<Principal | undefined> {
    if (typeof token !== 'string' || token.length < MIN_TOKEN_LENGTH || token.length > 512) return undefined
    const supplied = Buffer.from(digestToken(token).slice('sha256:'.length), 'hex')
    let found: TaskClientRecord | undefined
    for (const record of await this.records()) {
      const match = /^sha256:([0-9a-f]{64})$/.exec(record.tokenDigest)
      if (!match) continue
      if (timingSafeEqual(Buffer.from(match[1]!, 'hex'), supplied) && !record.revokedAt) found = record
    }
    return found ? { id: found.principalId, kind: 'service', tenantId: this.tenantId, roles: [TASK_CLIENT_ROLE], displayName: found.name } : undefined
  }

  async authenticateHeader(authorization: string | null | undefined): Promise<Principal | undefined> {
    const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')
    return match ? this.authenticate(match[1]) : undefined
  }
}

function summarize(r: TaskClientRecord): TaskClientSummary {
  const { tokenDigest: _omit, ...rest } = r
  return { ...rest, active: !r.revokedAt }
}
