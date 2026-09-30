import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AccessDecision } from '@quicksilver/kernel/identity'
import type { HostConfig } from './config.ts'

interface AuditEnvelope {
  sequence: number
  previousHash: string
  decision: AccessDecision
  hash: string
}

const GENESIS = '0'.repeat(64)

export function resolveAuthorizationAuditPath(config: HostConfig, env: Readonly<Record<string, string | undefined>> = process.env): string {
  const configured = env.QUICKSILVER_AUTHORIZATION_AUDIT_PATH?.trim()
  if (configured) return configured
  if (config.vault?.path) return `${config.vault.path}.authorization-audit.jsonl`
  if (config.store.kind === 'file') return `${config.store.path}.authorization-audit.jsonl`
  // Unit/integration test hosts often use in-memory run stores; give each
  // isolated host a real file without sharing state between test workers.
  if (process.env.NODE_TEST_CONTEXT) return join(tmpdir(), `quicksilver-auth-audit-${process.pid}-${randomUUID()}.jsonl`)
  throw new Error('Set QUICKSILVER_AUTHORIZATION_AUDIT_PATH or configure file-backed storage/vault so authorization decisions have durable storage.')
}

function digest(sequence: number, previousHash: string, decision: AccessDecision): string {
  return createHash('sha256').update(JSON.stringify({ sequence, previousHash, decision })).digest('hex')
}

/**
 * Process-independent append-only JSONL RBAC audit. Every record is fsynced
 * before AccessController returns; startup verifies sequence and hash linkage.
 * Intended for one host process per file on durable local storage.
 */
export class FileAuthorizationAuditStore {
  private sequence = 0
  private previousHash = GENESIS
  readonly path: string

  constructor(path: string) {
    this.path = path
    mkdirSync(dirname(path), { recursive: true })
    if (!existsSync(path)) return
    const raw = readFileSync(path, 'utf8')
    for (const [index, line] of raw.split('\n').entries()) {
      if (!line) continue
      let entry: AuditEnvelope
      try { entry = JSON.parse(line) as AuditEnvelope } catch { throw new Error(`Authorization audit is corrupt at line ${index + 1}.`) }
      if (entry.sequence !== this.sequence + 1 || entry.previousHash !== this.previousHash || entry.hash !== digest(entry.sequence, entry.previousHash, entry.decision)) {
        throw new Error(`Authorization audit integrity check failed at line ${index + 1}.`)
      }
      this.sequence = entry.sequence
      this.previousHash = entry.hash
    }
    const headPath = `${path}.head`
    if (!existsSync(headPath)) throw new Error('Authorization audit head checkpoint is missing.')
    let head: { sequence: number; hash: string }
    try { head = JSON.parse(readFileSync(headPath, 'utf8')) as { sequence: number; hash: string } }
    catch { throw new Error('Authorization audit head checkpoint is corrupt.') }
    if (head.sequence !== this.sequence || head.hash !== this.previousHash) throw new Error('Authorization audit tail does not match its head checkpoint.')
  }

  append(decision: AccessDecision): void {
    const sequence = this.sequence + 1
    const hash = digest(sequence, this.previousHash, decision)
    const envelope: AuditEnvelope = { sequence, previousHash: this.previousHash, decision, hash }
    const fd = openSync(this.path, 'a')
    try {
      writeSync(fd, `${JSON.stringify(envelope)}\n`, undefined, 'utf8')
      fsyncSync(fd)
    } finally { closeSync(fd) }
    const headPath = `${this.path}.head`
    const tempPath = `${headPath}.${randomUUID()}.tmp`
    const headFd = openSync(tempPath, 'wx')
    try {
      writeSync(headFd, JSON.stringify({ sequence, hash }), undefined, 'utf8')
      fsyncSync(headFd)
    } finally { closeSync(headFd) }
    renameSync(tempPath, headPath)
    this.sequence = sequence
    this.previousHash = hash
  }
}
