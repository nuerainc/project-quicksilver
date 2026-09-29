/**
 * The operator's audit log: one JSON line per event (a gate decision, an
 * approval, a tool result, a completion check), each carrying the hash of the
 * one before, so a removed or edited line is detected. Hashes use the
 * kernel's canonical JSON (the same as run digests).
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'

import { canonicalJson } from '@quicksilver/kernel/runtime'

export const AUDIT_GENESIS = 'sha256:0'

export interface AuditEvent {
  runId: string
  kind: 'run-start' | 'gate' | 'approval' | 'tool-result' | 'completion' | 'run-end' | 'rollback'
  at: string
  data: Record<string, unknown>
}

export interface AuditLine extends AuditEvent {
  seq: number
  prevHash: string
  hash: string
}

function hashOf(line: Omit<AuditLine, 'hash'>): string {
  return `sha256:${createHash('sha256').update(canonicalJson(line)).digest('hex')}`
}

export interface AuditSink {
  append(event: AuditEvent): Promise<AuditLine>
  read(): Promise<AuditLine[]>
}

/** In memory (tests, one-off runs). */
export class MemoryAuditSink implements AuditSink {
  private lines: AuditLine[] = []
  async append(event: AuditEvent): Promise<AuditLine> {
    const prev = this.lines.at(-1)
    const base = { ...event, seq: (prev?.seq ?? 0) + 1, prevHash: prev?.hash ?? AUDIT_GENESIS }
    const line = { ...base, hash: hashOf(base) }
    this.lines.push(line)
    return line
  }
  async read(): Promise<AuditLine[]> { return [...this.lines] }
}

/** Append-only JSON lines file (mode 0600), writes serialized in-process. */
export class FileAuditSink implements AuditSink {
  private readonly path: string
  private queue: Promise<unknown> = Promise.resolve()
  private last: { seq: number; hash: string } | undefined

  constructor(path: string) { this.path = path }

  async read(): Promise<AuditLine[]> {
    try {
      return (await readFile(this.path, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as AuditLine)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
  }

  append(event: AuditEvent): Promise<AuditLine> {
    const run = async () => {
      if (!this.last) {
        const tail = (await this.read()).at(-1)
        this.last = tail ? { seq: tail.seq, hash: tail.hash } : { seq: 0, hash: AUDIT_GENESIS }
      }
      const base = { ...event, seq: this.last.seq + 1, prevHash: this.last.hash }
      const line = { ...base, hash: hashOf(base) }
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      await appendFile(this.path, `${JSON.stringify(line)}\n`, { mode: 0o600 })
      this.last = { seq: line.seq, hash: line.hash }
      return line
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => undefined)
    return p
  }
}

/** Check the chain: every line follows the one before and hashes to itself. Pure. */
export function verifyAudit(lines: readonly AuditLine[]): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  let prev = AUDIT_GENESIS
  lines.forEach((l, i) => {
    const { hash, ...rest } = l
    if (l.seq !== i + 1) errors.push(`Line ${i + 1} has sequence ${l.seq}.`)
    if (l.prevHash !== prev) errors.push(`Line ${l.seq} does not follow the line before.`)
    if (hashOf(rest) !== hash) errors.push(`Line ${l.seq} was changed.`)
    prev = hash
  })
  return { valid: errors.length === 0, errors }
}
