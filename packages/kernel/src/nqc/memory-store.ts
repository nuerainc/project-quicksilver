import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { governMemoryWrite, type GovernedMemoryEntry, type MemoryGovernanceDecision, type MemoryKind } from './memory.ts'

/**
 * Persistent store behind the memory governor (`governMemoryWrite`).
 *
 * The rule this store exists to keep: memory can make an agent better informed,
 * but it can never make it more permitted.
 *
 *  - Every write goes through `governMemoryWrite` first. Nothing reaches the store
 *    that the governor refused, and kinds that change behaviour (routing rules,
 *    safety constraints, agent and model profiles) need a verified supervisor
 *    approval record.
 *  - Recall returns advisory text. Nothing here is read by `authorize()` or any
 *    other authorization code; `memory-boundary.test.ts` fails if that changes.
 *  - Who wrote each entry, and from what source, is recorded and cannot be edited.
 *  - Every write attempt, refusals included, is an event in a hash-chained log, so
 *    a removed or altered entry shows up when the chain is verified.
 *  - Entries expire at their retention date and a person can ask for one to be
 *    forgotten; both leave a record that holds the entry's hash, not its text.
 */

export interface MemoryActor {
  id: string
  kind: 'agent' | 'human' | 'system'
}

export interface StoredMemory {
  id: string
  kind: MemoryKind
  domain: string
  content: string
  source: string
  confidence: number
  retentionDays: number
  contentHash: string
  proposedBy: MemoryActor
  /** The supervisor approval record that cleared a behaviour-changing kind. */
  approvalId?: string
  createdAt: string
  expiresAt: string
}

export type MemoryEventType = 'written' | 'refused' | 'unchanged' | 'forgotten' | 'expired'

export interface MemoryStoreEvent {
  seq: number
  at: string
  event: MemoryEventType
  memoryId: string
  actor: MemoryActor
  /** Hash of the content involved. The text is not kept for refusals, forgets or expiries. */
  contentHash: string
  reasons?: string[]
  prevHash: string
  hash: string
}

export interface RecalledMemory {
  id: string
  kind: MemoryKind
  domain: string
  content: string
  source: string
  confidence: number
  createdAt: string
  expiresAt: string
  /** Always true: recalled memory is context for a model or a person, never an instruction to the kernel. */
  advisory: true
}

export interface MemoryWriteContext {
  proposedBy: MemoryActor
  verifySupervisorApproval?: (approvalId: string, entry: GovernedMemoryEntry) => boolean
  now?: number
}

export interface MemoryWriteResult {
  stored: boolean
  /** Same id and same content was already stored; nothing changed. */
  unchanged: boolean
  decision: MemoryGovernanceDecision
}

interface Document { schemaVersion: 1; entries: StoredMemory[]; events: MemoryStoreEvent[] }

const GENESIS = '0'.repeat(64)
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
const contentHashOf = (content: string) => `sha256:${sha(content)}`

function eventHash(e: Omit<MemoryStoreEvent, 'hash'>): string {
  return sha(JSON.stringify([e.seq, e.at, e.event, e.memoryId, e.actor.id, e.actor.kind, e.contentHash, e.reasons ?? [], e.prevHash]))
}

/** In-process store; `FileMemoryStore` adds persistence. */
export class MemoryStore {
  protected doc: Document = { schemaVersion: 1, entries: [], events: [] }

  /** Govern and store one entry. A refusal is recorded and nothing is stored. */
  write(entry: GovernedMemoryEntry, ctx: MemoryWriteContext): MemoryWriteResult {
    const now = ctx.now ?? Date.now()
    const decision = governMemoryWrite(entry, ctx.verifySupervisorApproval)
    const hash = contentHashOf(entry.content ?? '')
    if (!decision.allowed || !decision.safeEntry) {
      this.append('refused', entry.id ?? '', ctx.proposedBy, hash, now, decision.reasons)
      this.save()
      return { stored: false, unchanged: false, decision }
    }
    const existing = this.doc.entries.find((e) => e.id === entry.id)
    if (existing) {
      if (existing.contentHash === hash) {
        this.append('unchanged', entry.id, ctx.proposedBy, hash, now)
        this.save()
        return { stored: false, unchanged: true, decision }
      }
      // An id names one fact. A different text under the same id is a new entry, not an edit.
      const reasons = [`Memory "${entry.id}" already exists with different content; use a new id. Stored memory is not edited.`]
      this.append('refused', entry.id, ctx.proposedBy, hash, now, reasons)
      this.save()
      return { stored: false, unchanged: false, decision: { ...decision, allowed: false, reasons, safeEntry: undefined } }
    }
    const safe = decision.safeEntry
    this.doc.entries.push({
      ...safe,
      contentHash: hash,
      proposedBy: ctx.proposedBy,
      ...(entry.approvalId ? { approvalId: entry.approvalId } : {}),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + safe.retentionDays * 86_400_000).toISOString(),
    })
    this.append('written', entry.id, ctx.proposedBy, hash, now)
    this.save()
    return { stored: true, unchanged: false, decision }
  }

  /** Unexpired entries, most confident and newest first. Advisory text only. */
  recall(query: { domain?: string; kind?: MemoryKind; limit?: number; now?: number } = {}): RecalledMemory[] {
    const now = query.now ?? Date.now()
    return this.doc.entries
      .filter((e) => Date.parse(e.expiresAt) > now)
      .filter((e) => (query.domain === undefined || e.domain === query.domain) && (query.kind === undefined || e.kind === query.kind))
      .sort((a, b) => b.confidence - a.confidence || (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, Math.max(0, Math.min(query.limit ?? 10, 100)))
      .map((e) => ({
        id: e.id, kind: e.kind, domain: e.domain, content: e.content, source: e.source,
        confidence: e.confidence, createdAt: e.createdAt, expiresAt: e.expiresAt, advisory: true as const,
      }))
  }

  /** Every stored entry, including who proposed it and which approval cleared it. For audit, not for prompts. */
  entries(): readonly StoredMemory[] { return [...this.doc.entries] }
  events(): readonly MemoryStoreEvent[] { return [...this.doc.events] }

  /** A person asks for an entry to be forgotten. Agents cannot. */
  forget(id: string, actor: MemoryActor, now = Date.now()): boolean {
    if (actor.kind !== 'human') return false
    const i = this.doc.entries.findIndex((e) => e.id === id)
    if (i < 0) return false
    const [gone] = this.doc.entries.splice(i, 1)
    this.append('forgotten', id, actor, gone!.contentHash, now)
    this.save()
    return true
  }

  /** Remove entries past their retention date. Returns the ids removed. */
  sweepExpired(now = Date.now()): string[] {
    const expired = this.doc.entries.filter((e) => Date.parse(e.expiresAt) <= now)
    for (const e of expired) {
      this.doc.entries = this.doc.entries.filter((x) => x.id !== e.id)
      this.append('expired', e.id, { id: 'retention', kind: 'system' }, e.contentHash, now)
    }
    if (expired.length > 0) this.save()
    return expired.map((e) => e.id)
  }

  /** Check the event chain and that every stored entry still matches the hash it was written with. */
  verify(): { valid: boolean; errors: string[] } {
    const errors: string[] = []
    let prev = GENESIS
    this.doc.events.forEach((e, i) => {
      if (e.seq !== i + 1) errors.push(`Event ${i + 1}: sequence is ${e.seq}.`)
      if (e.prevHash !== prev) errors.push(`Event ${e.seq}: previous hash does not match.`)
      const { hash, ...rest } = e
      if (hash !== eventHash(rest)) errors.push(`Event ${e.seq}: hash does not match its contents.`)
      prev = e.hash
    })
    const written = new Map(this.doc.events.filter((e) => e.event === 'written').map((e) => [e.memoryId, e.contentHash]))
    const gone = new Set(this.doc.events.filter((e) => e.event === 'forgotten' || e.event === 'expired').map((e) => e.memoryId))
    for (const entry of this.doc.entries) {
      if (contentHashOf(entry.content) !== entry.contentHash) errors.push(`Memory "${entry.id}": content does not match its hash.`)
      if (written.get(entry.id) !== entry.contentHash) errors.push(`Memory "${entry.id}": no matching write event.`)
    }
    for (const [id] of written) {
      if (!gone.has(id) && !this.doc.entries.some((e) => e.id === id)) errors.push(`Memory "${id}": written, but removed without a record.`)
    }
    return { valid: errors.length === 0, errors }
  }

  private append(event: MemoryEventType, memoryId: string, actor: MemoryActor, contentHash: string, now: number, reasons?: string[]): void {
    const prev = this.doc.events[this.doc.events.length - 1]
    const base = {
      seq: (prev?.seq ?? 0) + 1, at: new Date(now).toISOString(), event, memoryId, actor, contentHash,
      ...(reasons && reasons.length > 0 ? { reasons: reasons.slice(0, 16).map((r) => r.slice(0, 300)) } : {}),
      prevHash: prev?.hash ?? GENESIS,
    }
    this.doc.events.push({ ...base, hash: eventHash(base) })
  }

  protected save(): void {}
}

/** A single file, written whole and renamed into place. One writer process per file. */
export class FileMemoryStore extends MemoryStore {
  private readonly path: string

  constructor(path: string) {
    super()
    this.path = path
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Document
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries) || !Array.isArray(parsed.events)) throw new Error(`Memory file ${path} is not a version 1 memory store.`)
      this.doc = parsed
      const check = this.verify()
      if (!check.valid) throw new Error(`Memory file ${path} failed verification, so it was not loaded: ${check.errors[0]}`)
    }
  }

  protected override save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.doc), { mode: 0o600 })
    renameSync(tmp, this.path)
  }
}
