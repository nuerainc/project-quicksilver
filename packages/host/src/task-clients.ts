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
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { Principal } from '@quicksilver/kernel/identity'
import { digestToken, generateToken, MIN_TOKEN_LENGTH } from '@quicksilver/kernel/identity/tokens'

import { readJson, writeJsonAtomic } from './operate-store.ts'

export const TASK_CLIENT_ROLE = 'task-client'
const NAME = /^[a-z0-9][a-z0-9-]{1,39}$/

export interface TaskClientRecord {
  tenantId: string
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
  /** Atomic read/modify/write; required when several tenant hosts share a persistence file. */
  mutate<T>(update: (records: TaskClientRecord[]) => { records: TaskClientRecord[]; result: T }): Promise<T>
  /** Changes when the stored records change (used to reload). */
  version(): Promise<string>
}

export class FileTaskClientPersistence implements TaskClientPersistence {
  readonly path: string
  constructor(path: string) { this.path = path }
  load() { return readJson<TaskClientRecord[]>(this.path, []) }
  async save(records: TaskClientRecord[]) {
    await withClientFileLock(this.path, () => this.saveUnlocked(records))
  }
  async mutate<T>(update: (records: TaskClientRecord[]) => { records: TaskClientRecord[]; result: T }): Promise<T> {
    return withClientFileLock(this.path, async () => {
      const { records, result } = update(await this.load())
      await this.saveUnlocked(records)
      return result
    })
  }
  private saveUnlocked(records: TaskClientRecord[]) { return writeJsonAtomic(this.path, records) }
  async version() {
    try { return createHash('sha256').update(await readFile(this.path)).digest('hex') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'none'; throw error }
  }
}

export class MemoryTaskClientPersistence implements TaskClientPersistence {
  private records: TaskClientRecord[] = []
  private rev = 0
  private writes: Promise<void> = Promise.resolve()
  async load() { return structuredClone(this.records) }
  async save(records: TaskClientRecord[]) { this.records = structuredClone(records); this.rev++ }
  async mutate<T>(update: (records: TaskClientRecord[]) => { records: TaskClientRecord[]; result: T }): Promise<T> {
    const operation = async () => {
      const { records, result } = update(structuredClone(this.records))
      await this.save(records)
      return result
    }
    const pending = this.writes.then(operation, operation)
    this.writes = pending.then(() => undefined, () => undefined)
    return pending
  }
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
    if (!this.cache || this.cache.version !== version) this.cache = { version, records: (await this.persistence.load()).filter((r) => r.tenantId === this.tenantId) }
    return this.cache.records
  }

  /** Add a client. Returns the token ONCE; only its digest is stored. */
  async add(name: string, createdBy: string): Promise<{ client: TaskClientSummary; token: string }> {
    if (!NAME.test(name)) throw new Error('A client name is 2 to 40 lowercase letters, digits or "-".')
    const { token, tokenDigest } = generateToken()
    const record: TaskClientRecord = { tenantId: this.tenantId, name, principalId: `client:${name}`, tokenDigest, createdAt: new Date(this.now()).toISOString(), createdBy }
    await this.persistence.mutate((records) => {
      if (records.some((r) => r.tenantId === this.tenantId && r.name === name)) throw new Error(`A client named "${name}" already exists (revoked clients keep their name). Choose another name.`)
      return { records: [...records, record], result: undefined }
    })
    this.cache = undefined
    return { client: summarize(record), token }
  }

  async list(): Promise<TaskClientSummary[]> {
    return (await this.persistence.load()).filter((r) => r.tenantId === this.tenantId).map(summarize)
  }

  async revoke(name: string, revokedBy: string): Promise<TaskClientSummary> {
    const summary = await this.persistence.mutate((records) => {
      const record = records.find((r) => r.tenantId === this.tenantId && r.name === name)
      if (!record) throw new Error(`No client named "${name}".`)
      if (record.revokedAt) return { records, result: summarize(record) }
      const next = records.map((r) => (r.tenantId === this.tenantId && r.name === name ? { ...r, revokedAt: new Date(this.now()).toISOString(), revokedBy } : r))
      return { records: next, result: summarize(next.find((r) => r.tenantId === this.tenantId && r.name === name)!) }
    })
    this.cache = undefined
    return summary
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

const CLIENT_LOCK_STALE_MS = 10 * 60_000
const CLIENT_LOCK_WAIT_MS = 30_000

async function withClientFileLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const lockDir = `${path}.lock`
  const started = Date.now()
  while (true) {
    try {
      await mkdir(lockDir, { mode: 0o700 })
      try {
        await writeFile(join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, token: randomBytes(16).toString('hex'), createdAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' })
      } catch (error) {
        await rm(lockDir, { recursive: true, force: true })
        throw error
      }
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'EISDIR') throw error
      try {
        if (Date.now() - (await stat(lockDir)).mtimeMs > CLIENT_LOCK_STALE_MS) {
          await rm(lockDir, { recursive: true, force: true })
          continue
        }
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw lockError
      }
      if (Date.now() - started >= CLIENT_LOCK_WAIT_MS) throw new Error('Timed out waiting for the task-client registry write lock.')
      await new Promise((resolve) => setTimeout(resolve, 15 + Math.floor(Math.random() * 35)))
    }
  }
  try { return await operation() } finally { await rm(lockDir, { recursive: true, force: true }) }
}
