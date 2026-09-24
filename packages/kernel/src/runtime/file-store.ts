import { open, readFile, rename, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { InMemoryWorkflowRunStore, type WorkflowRunEvent, type WorkflowRunRecord } from './store.ts'

type JournalEntry =
  | { v: 1; op: 'insert'; record: WorkflowRunRecord }
  | { v: 1; op: 'update'; record: WorkflowRunRecord; expectedRevision: number }
  | { v: 1; op: 'event'; event: WorkflowRunEvent }

export interface FileWorkflowRunStoreOptions {
  /** fsync every journal write (default true). Disable only for tests or throwaway environments. */
  fsync?: boolean
}

/**
 * Append-only JSONL journal store for a single writer process.
 *
 * Every mutation is written (and by default fsync'd) before it is applied in
 * memory, so a crash can lose at most the in-flight write. On open the journal
 * is replayed; a torn final line from a crash is ignored, while corruption in
 * the middle of the file stops the open rather than guessing.
 *
 * This is the durable local backend. Multi-process or multi-host deployments
 * need a transactional database adapter behind the same `WorkflowRunStore` port.
 */
export class FileWorkflowRunStore extends InMemoryWorkflowRunStore {
  private queue: Promise<unknown> = Promise.resolve()
  private discardedTail = false

  private readonly path: string
  private readonly fsync: boolean

  private constructor(path: string, fsync: boolean) {
    super()
    this.path = path
    this.fsync = fsync
  }

  static async open(path: string, options: FileWorkflowRunStoreOptions = {}): Promise<FileWorkflowRunStore> {
    const store = new FileWorkflowRunStore(path, options.fsync ?? true)
    await mkdir(dirname(path), { recursive: true })
    let text = ''
    try {
      text = await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!
      if (!line.trim()) continue
      let entry: JournalEntry
      try {
        entry = JSON.parse(line) as JournalEntry
      } catch {
        const isTail = lines.slice(index + 1).every((rest) => !rest.trim())
        if (isTail) {
          store.discardedTail = true
          break
        }
        throw new Error(`Workflow run journal is corrupt at line ${index + 1}; refusing to open.`)
      }
      store.replay(entry, index + 1)
    }
    if (store.discardedTail) await store.rewrite()
    return store
  }

  /** True when the last open dropped a partially written final journal line. */
  get recoveredFromTornWrite(): boolean {
    return this.discardedTail
  }

  override async insert(record: WorkflowRunRecord): Promise<void> {
    await this.serial(async () => {
      this.assertInsertable(record)
      await this.append({ v: 1, op: 'insert', record })
      this.applyInsert(record)
    })
  }

  override async compareAndSet(next: WorkflowRunRecord, expectedRevision: number): Promise<boolean> {
    return this.serial(async () => {
      const current = this.runs.get(next.runId)
      if (!current || current.revision !== expectedRevision || next.revision !== expectedRevision + 1) return false
      if (next.tenantId !== current.tenantId || next.idempotencyKey !== current.idempotencyKey || next.graphDigest !== current.graphDigest) {
        throw new Error('Run identity fields (tenant, idempotency key, graph digest) are immutable.')
      }
      await this.append({ v: 1, op: 'update', record: next, expectedRevision })
      return this.applyCompareAndSet(next, expectedRevision)
    })
  }

  override async appendEvent(event: Omit<WorkflowRunEvent, 'seq'>): Promise<WorkflowRunEvent> {
    return this.serial(async () => {
      if (!this.runs.has(event.runId)) throw new Error(`Cannot record an event for unknown run "${event.runId}".`)
      const seq = (this.eventLog.get(event.runId)?.length ?? 0) + 1
      const stored: WorkflowRunEvent = { ...event, seq }
      await this.append({ v: 1, op: 'event', event: stored })
      return this.applyEvent(stored)
    })
  }

  /** Rewrite the journal as one insert per run plus its events (atomic rename). */
  async compact(): Promise<void> {
    await this.serial(() => this.rewrite())
  }

  private replay(entry: JournalEntry, line: number): void {
    if (entry?.v !== 1) throw new Error(`Unsupported journal entry version at line ${line}.`)
    if (entry.op === 'insert') this.applyInsert(entry.record)
    else if (entry.op === 'update') {
      if (!this.applyCompareAndSet(entry.record, entry.expectedRevision)) throw new Error(`Journal revision conflict at line ${line}.`)
    } else if (entry.op === 'event') this.applyEvent(entry.event)
    else throw new Error(`Unknown journal operation at line ${line}.`)
  }

  private assertInsertable(record: WorkflowRunRecord): void {
    if (this.runs.has(record.runId)) throw new Error(`Workflow run "${record.runId}" already exists.`)
    if (record.idempotencyKey && this.idempotency.has(`${record.tenantId}\u0000${record.idempotencyKey}`)) {
      throw new Error('A run with this idempotency key already exists for the tenant.')
    }
  }

  private async rewrite(): Promise<void> {
    const temp = `${this.path}.${process.pid}.tmp`
    const handle = await open(temp, 'w')
    try {
      for (const record of this.runs.values()) {
        await handle.write(`${JSON.stringify({ v: 1, op: 'insert', record } satisfies JournalEntry)}\n`)
        for (const event of this.eventLog.get(record.runId) ?? []) {
          await handle.write(`${JSON.stringify({ v: 1, op: 'event', event } satisfies JournalEntry)}\n`)
        }
      }
      if (this.fsync) await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, this.path)
  }

  private async append(entry: JournalEntry): Promise<void> {
    const handle = await open(this.path, 'a')
    try {
      await handle.write(`${JSON.stringify(entry)}\n`)
      if (this.fsync) await handle.datasync()
    } finally {
      await handle.close()
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation)
    this.queue = next.catch(() => undefined)
    return next
  }
}
