import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { AccessController, Principal } from '@quicksilver/kernel/identity'

/**
 * Single-tenant secrets vault.
 *
 * - Values are encrypted at rest with AES-256-GCM under a 32-byte master key
 *   that lives only in the environment (`QUICKSILVER_VAULT_KEY`), never on disk
 *   next to the vault file. Each version has its own random nonce. The secret
 *   name and version are bound in as associated data, so a ciphertext can't be
 *   moved to another name.
 * - Every operation is authorized by the kernel's RBAC:
 *     `secret:use`   resolve a value for the runtime (services, workers);
 *     `secret:read`  reveal a value to a human (tenant admins);
 *     `secret:write` create, rotate, or disable.
 * - Rotation keeps earlier versions for a grace period, so webhook senders and
 *   other consumers can move to the new value without downtime.
 * - Every access, allowed or denied, goes to the audit sink. Values never do.
 *
 * Writes are atomic (temp file + rename). The file holds metadata in the clear
 * (names, versions, timestamps, who changed what) and values only as ciphertext.
 */

export interface SecretVersionMeta {
  version: number
  createdAt: string
  createdBy: string
  /** After this time the version is no longer returned. Unset for the active version. */
  expiresAt?: string
}

export interface SecretMeta {
  name: string
  tenantId: string
  description?: string
  disabled: boolean
  activeVersion: number
  versions: SecretVersionMeta[]
}

interface StoredVersion extends SecretVersionMeta {
  iv: string
  tag: string
  data: string
}

interface StoredSecret extends Omit<SecretMeta, 'versions'> {
  versions: StoredVersion[]
}

interface VaultFile {
  format: 'quicksilver-vault/1'
  tenantId: string
  /** SHA-256 of the key, truncated; detects a wrong key before any decrypt. */
  keyCheck: string
  secrets: Record<string, StoredSecret>
}

export interface VaultAuditEvent {
  at: string
  operation: 'put' | 'rotate' | 'use' | 'reveal' | 'disable' | 'list'
  name?: string
  version?: number
  principalId: string
  allowed: boolean
  reasons: string[]
}

export interface SecretsVaultOptions {
  path: string
  /** 32 bytes, as base64 or 64 hex characters. */
  masterKey: string
  tenantId: string
  access: AccessController
  audit?: (event: VaultAuditEvent) => void
  now?: () => number
}

export type VaultErrorCode = 'forbidden' | 'not-found' | 'disabled' | 'invalid' | 'corrupt' | 'wrong-key'

export class VaultError extends Error {
  readonly code: VaultErrorCode
  constructor(message: string, code: VaultErrorCode) {
    super(message)
    this.code = code
    this.name = 'VaultError'
  }
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/
const MAX_VALUE_BYTES = 64 * 1024
const MAX_VERSIONS = 10

export function parseMasterKey(text: string | undefined): Buffer {
  const value = (text ?? '').trim()
  let key: Buffer | undefined
  if (/^[0-9a-f]{64}$/i.test(value)) key = Buffer.from(value, 'hex')
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) key = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  if (!key || key.length !== 32) throw new VaultError('The vault master key must be 32 bytes (base64 or 64 hex characters).', 'invalid')
  return key
}

/** A new random master key, base64. Store it in the deployment's environment, never in the repo. */
export function generateMasterKey(): string {
  return randomBytes(32).toString('base64')
}

function keyCheck(key: Buffer): string {
  return createHash('sha256').update('quicksilver-vault-keycheck').update(key).digest('hex').slice(0, 16)
}

export class SecretsVault {
  private readonly key: Buffer
  private readonly options: SecretsVaultOptions
  private readonly now: () => number
  private state?: VaultFile
  private chain: Promise<unknown> = Promise.resolve()

  constructor(options: SecretsVaultOptions) {
    this.options = options
    this.key = parseMasterKey(options.masterKey)
    this.now = options.now ?? Date.now
  }

  /** Load or create the vault file. Fails closed on a wrong key or a tenant mismatch. */
  async open(): Promise<void> {
    let raw: string | undefined
    try {
      raw = await readFile(this.options.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (raw === undefined) {
      this.state = { format: 'quicksilver-vault/1', tenantId: this.options.tenantId, keyCheck: keyCheck(this.key), secrets: {} }
      await this.persist()
      return
    }
    let parsed: VaultFile
    try {
      parsed = JSON.parse(raw) as VaultFile
    } catch {
      throw new VaultError('The vault file is not valid JSON.', 'corrupt')
    }
    if (parsed?.format !== 'quicksilver-vault/1' || typeof parsed.secrets !== 'object') throw new VaultError('Unrecognized vault file format.', 'corrupt')
    if (parsed.tenantId !== this.options.tenantId) throw new VaultError('The vault belongs to a different tenant.', 'invalid')
    const expected = Buffer.from(keyCheck(this.key))
    const actual = Buffer.from(String(parsed.keyCheck ?? ''))
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new VaultError('The vault master key does not match this vault.', 'wrong-key')
    this.state = parsed
  }

  /** Metadata only. Requires `secret:read` or `secret:use`. */
  async list(principal: Principal | undefined): Promise<SecretMeta[]> {
    const state = this.requireOpen()
    const use = this.options.access.authorize(principal, 'secret:use', { tenantId: this.options.tenantId, kind: 'secret' })
    const read = use.allowed ? use : this.options.access.authorize(principal, 'secret:read', { tenantId: this.options.tenantId, kind: 'secret' })
    this.audit('list', principal, read.allowed, read.reasons)
    if (!read.allowed) throw new VaultError(read.reasons.join(' '), 'forbidden')
    return Object.values(state.secrets).map(toMeta)
  }

  /** Create a secret, or add a new active version (rotation). Earlier versions stay valid for `graceMs`. */
  put(principal: Principal | undefined, name: string, value: string, options: { description?: string; graceMs?: number } = {}): Promise<SecretMeta> {
    return this.serial(async () => {
      const state = this.requireOpen()
      this.checkName(name)
      if (typeof value !== 'string' || value.length === 0) throw new VaultError('Secret value must be a non-empty string.', 'invalid')
      if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) throw new VaultError('Secret value exceeds 64 KiB.', 'invalid')
      const existing = state.secrets[name]
      const operation = existing ? 'rotate' : 'put'
      this.authorize(operation, 'secret:write', principal, name)

      const now = this.now()
      const at = new Date(now).toISOString()
      const graceMs = options.graceMs ?? 24 * 3_600_000
      if (!Number.isInteger(graceMs) || graceMs < 0) throw new VaultError('graceMs must be a non-negative integer.', 'invalid')
      const version = existing ? Math.max(...existing.versions.map((v) => v.version)) + 1 : 1
      const encrypted = this.encrypt(name, version, value)
      const versions = (existing?.versions ?? []).map((v) =>
        v.version === existing?.activeVersion && !v.expiresAt ? { ...v, expiresAt: new Date(now + graceMs).toISOString() } : v,
      )
      versions.push({ version, createdAt: at, createdBy: principal!.id, ...encrypted })
      const secret: StoredSecret = {
        name,
        tenantId: this.options.tenantId,
        description: options.description ?? existing?.description,
        disabled: false,
        activeVersion: version,
        // Drop expired versions and keep the list bounded.
        versions: versions.filter((v) => v.version === version || !v.expiresAt || Date.parse(v.expiresAt) > now).slice(-MAX_VERSIONS),
      }
      state.secrets[name] = secret
      await this.persist()
      this.audit(operation, principal, true, [], name, version)
      return toMeta(secret)
    })
  }

  /** Resolve the active value for the runtime. Requires `secret:use`. */
  async use(principal: Principal | undefined, name: string): Promise<string> {
    return (await this.resolve('use', 'secret:use', principal, name))[0]!
  }

  /** The active value plus earlier versions still inside their grace period, newest first. */
  async useAll(principal: Principal | undefined, name: string): Promise<string[]> {
    return this.resolve('use', 'secret:use', principal, name, true)
  }

  /** Reveal the active value to a human. Requires `secret:read`. */
  async reveal(principal: Principal | undefined, name: string): Promise<string> {
    return (await this.resolve('reveal', 'secret:read', principal, name))[0]!
  }

  disable(principal: Principal | undefined, name: string): Promise<SecretMeta> {
    return this.serial(async () => {
      const state = this.requireOpen()
      this.authorize('disable', 'secret:write', principal, name)
      const secret = state.secrets[name]
      if (!secret) throw new VaultError(`Secret "${name}" does not exist.`, 'not-found')
      secret.disabled = true
      await this.persist()
      this.audit('disable', principal, true, [], name)
      return toMeta(secret)
    })
  }

  private async resolve(operation: 'use' | 'reveal', permission: 'secret:use' | 'secret:read', principal: Principal | undefined, name: string, all = false): Promise<string[]> {
    const state = this.requireOpen()
    this.authorize(operation, permission, principal, name)
    const secret = state.secrets[name]
    if (!secret) {
      this.audit(operation, principal, false, ['not found'], name)
      throw new VaultError(`Secret "${name}" does not exist.`, 'not-found')
    }
    if (secret.disabled) {
      this.audit(operation, principal, false, ['disabled'], name)
      throw new VaultError(`Secret "${name}" is disabled.`, 'disabled')
    }
    const now = this.now()
    const live = secret.versions
      .filter((v) => v.version === secret.activeVersion || (all && v.expiresAt && Date.parse(v.expiresAt) > now))
      .sort((a, b) => b.version - a.version)
    const values = live.map((v) => this.decrypt(name, v))
    this.audit(operation, principal, true, [], name, secret.activeVersion)
    return values
  }

  private authorize(operation: VaultAuditEvent['operation'], permission: 'secret:use' | 'secret:read' | 'secret:write', principal: Principal | undefined, name: string): void {
    const decision = this.options.access.authorize(principal, permission, { tenantId: this.options.tenantId, kind: 'secret', id: name })
    if (!decision.allowed) {
      this.audit(operation, principal, false, decision.reasons, name)
      throw new VaultError(decision.reasons.join(' '), 'forbidden')
    }
  }

  private encrypt(name: string, version: number, value: string): { iv: string; tag: string; data: string } {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    cipher.setAAD(Buffer.from(`${this.options.tenantId}/${name}/${version}`))
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }
  }

  private decrypt(name: string, stored: StoredVersion): string {
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(stored.iv, 'base64'))
      decipher.setAAD(Buffer.from(`${this.options.tenantId}/${name}/${stored.version}`))
      decipher.setAuthTag(Buffer.from(stored.tag, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(stored.data, 'base64')), decipher.final()]).toString('utf8')
    } catch {
      throw new VaultError(`Secret "${name}" version ${stored.version} failed integrity checks.`, 'corrupt')
    }
  }

  private checkName(name: string): void {
    if (typeof name !== 'string' || !NAME.test(name)) throw new VaultError('Secret names use lowercase letters, digits, ".", "_" and "-" (max 128).', 'invalid')
  }

  private requireOpen(): VaultFile {
    if (!this.state) throw new VaultError('The vault is not open. Call open() first.', 'invalid')
    return this.state
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.options.path), { recursive: true })
    const tmp = `${this.options.path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
    await rename(tmp, this.options.path)
  }

  private audit(operation: VaultAuditEvent['operation'], principal: Principal | undefined, allowed: boolean, reasons: string[], name?: string, version?: number): void {
    try {
      this.options.audit?.({
        at: new Date(this.now()).toISOString(),
        operation,
        ...(name ? { name } : {}),
        ...(version ? { version } : {}),
        principalId: principal?.id ?? 'anonymous',
        allowed,
        reasons,
      })
    } catch {
      // Audit sinks must not change vault outcomes.
    }
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => undefined)
    return next
  }
}

function toMeta(secret: StoredSecret): SecretMeta {
  return {
    name: secret.name,
    tenantId: secret.tenantId,
    ...(secret.description ? { description: secret.description } : {}),
    disabled: secret.disabled,
    activeVersion: secret.activeVersion,
    versions: secret.versions.map(({ version, createdAt, createdBy, expiresAt }) => ({ version, createdAt, createdBy, ...(expiresAt ? { expiresAt } : {}) })),
  }
}
