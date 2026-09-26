import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { KeyObject } from 'node:crypto'

import type { Principal } from '@quicksilver/kernel/identity'

import { appendChange, verifyLedger, type AppendOptions, type IntentChange, type IntentLedger, type LedgerEntry } from './ledger.ts'
import type { GraphVariable, IntentGraph } from './types.ts'

/**
 * Persistence for the intent ledger and intent graphs.
 *
 * Every store is append-only: an entry, once written, is never replaced.
 * Loading verifies the hash chain (and signatures, when a public key is
 * configured), so a store that was edited behind Aura's back is refused
 * rather than trusted.
 *
 * Stores:
 *   - MemoryLedgerStore: tests and short-lived runs.
 *   - FileLedgerStore:   one JSON-lines file per company (the local host).
 *   - SanityLedgerStore: one document per entry in the company's Content
 *     Lake. Ids contain a dot ("intent-ledger.<company>.<seq>"), which keeps
 *     them out of unauthenticated reads, since intent is private to the
 *     company. Writes use createIfNotExists, so an existing entry is never
 *     overwritten.
 */

export interface LedgerStore {
  load(companyId: string): Promise<LedgerEntry[]>
  /** Must fail rather than overwrite if an entry with this seq already exists with different content. */
  append(companyId: string, entry: LedgerEntry): Promise<void>
}

export class LedgerIntegrityError extends Error {
  readonly companyId: string
  readonly brokenAt: number
  constructor(companyId: string, brokenAt: number, reason: string) {
    super(`Intent ledger for "${companyId}" failed verification at entry ${brokenAt}: ${reason}`)
    this.name = 'LedgerIntegrityError'
    this.companyId = companyId
    this.brokenAt = brokenAt
  }
}

export class LedgerConflictError extends Error {
  readonly seq: number
  constructor(companyId: string, seq: number) {
    super(`Entry ${seq} of the intent ledger for "${companyId}" was written by someone else first. Reload and try again.`)
    this.name = 'LedgerConflictError'
    this.seq = seq
  }
}

/** Load a company's ledger and refuse it if the chain (or a signature) does not verify. */
export async function loadLedger(store: LedgerStore, companyId: string, publicKey?: KeyObject): Promise<IntentLedger> {
  const entries = (await store.load(companyId)).sort((a, b) => a.seq - b.seq)
  const ledger = { entries }
  const check = verifyLedger(ledger, publicKey)
  if (!check.valid) throw new LedgerIntegrityError(companyId, check.brokenAt, check.reason)
  return ledger
}

export type RecordResult =
  | { ok: true; ledger: IntentLedger; entry: LedgerEntry }
  | { ok: false; reasons: string[] }

/**
 * Load, check the change against the provider rules, append, and persist.
 * The company id for a new company comes from the change itself.
 */
export async function recordChange(
  store: LedgerStore,
  companyId: string,
  actor: Principal,
  change: IntentChange,
  options: AppendOptions & { publicKey?: KeyObject } = {},
): Promise<RecordResult> {
  if (change.type === 'company.create' && change.companyId !== companyId) return { ok: false, reasons: ['The company id does not match the ledger being written.'] }
  const ledger = await loadLedger(store, companyId, options.publicKey)
  const result = appendChange(ledger, actor, change, options)
  if (!result.ok) return result
  await store.append(companyId, result.entry)
  return { ok: true, ledger: result.ledger, entry: result.entry }
}

export class MemoryLedgerStore implements LedgerStore {
  private readonly data = new Map<string, LedgerEntry[]>()
  async load(companyId: string): Promise<LedgerEntry[]> {
    return structuredClone(this.data.get(companyId) ?? [])
  }
  async append(companyId: string, entry: LedgerEntry): Promise<void> {
    const list = this.data.get(companyId) ?? []
    const existing = list.find((e) => e.seq === entry.seq)
    if (existing) {
      if (existing.hash !== entry.hash) throw new LedgerConflictError(companyId, entry.seq)
      return
    }
    this.data.set(companyId, [...list, structuredClone(entry)])
  }
}

const COMPANY_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/

function checkCompanyId(companyId: string): void {
  if (!COMPANY_ID.test(companyId)) throw new Error(`Invalid company id "${companyId}". Use letters, digits, "-" or "_".`)
}

/** One JSON-lines file per company, appended to and never rewritten. */
export class FileLedgerStore implements LedgerStore {
  private readonly dir: string
  constructor(dir: string) {
    this.dir = dir
  }
  private path(companyId: string): string {
    checkCompanyId(companyId)
    return join(this.dir, `${companyId}.intent-ledger.jsonl`)
  }
  async load(companyId: string): Promise<LedgerEntry[]> {
    let text: string
    try {
      text = await readFile(this.path(companyId), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as LedgerEntry)
  }
  async append(companyId: string, entry: LedgerEntry): Promise<void> {
    const current = await this.load(companyId)
    const existing = current.find((e) => e.seq === entry.seq)
    if (existing) {
      if (existing.hash !== entry.hash) throw new LedgerConflictError(companyId, entry.seq)
      return
    }
    if (entry.seq !== current.length + 1) throw new LedgerConflictError(companyId, entry.seq)
    const path = this.path(companyId)
    await mkdir(dirname(path), { recursive: true })
    await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 })
  }
}

// ---------------------------------------------------------------------------
// Sanity

/** The small part of @sanity/client the store needs, so Aura carries no Sanity dependency. */
export interface SanityLikeClient {
  fetch<T>(query: string, params: Record<string, unknown>): Promise<T>
  createIfNotExists<T extends { _id: string; _type: string }>(doc: T): Promise<T>
}

export interface SanityLedgerDocument {
  _id: string
  _type: 'intentLedgerEntry'
  companyId: string
  seq: number
  at: string
  actorId: string
  actorRole: LedgerEntry['actor']['role']
  changeType: IntentChange['type']
  /** The change, exactly as hashed, as JSON. */
  changeJson: string
  previousJson?: string
  reason?: string
  prevHash: string
  hash: string
  signature?: string
}

export function ledgerDocumentId(companyId: string, seq: number): string {
  checkCompanyId(companyId)
  return `intent-ledger.${companyId}.${String(seq).padStart(8, '0')}`
}

export function toSanityLedgerDocument(companyId: string, entry: LedgerEntry): SanityLedgerDocument {
  return {
    _id: ledgerDocumentId(companyId, entry.seq),
    _type: 'intentLedgerEntry',
    companyId,
    seq: entry.seq,
    at: entry.at,
    actorId: entry.actor.id,
    actorRole: entry.actor.role,
    changeType: entry.change.type,
    changeJson: JSON.stringify(entry.change),
    ...(entry.previous !== undefined ? { previousJson: JSON.stringify(entry.previous) } : {}),
    ...(entry.reason ? { reason: entry.reason } : {}),
    prevHash: entry.prevHash,
    hash: entry.hash,
    ...(entry.signature ? { signature: entry.signature } : {}),
  }
}

export function fromSanityLedgerDocument(doc: SanityLedgerDocument): LedgerEntry {
  return {
    seq: doc.seq,
    at: doc.at,
    actor: { id: doc.actorId, role: doc.actorRole },
    change: JSON.parse(doc.changeJson) as IntentChange,
    ...(doc.previousJson !== undefined ? { previous: JSON.parse(doc.previousJson) as unknown } : {}),
    ...(doc.reason ? { reason: doc.reason } : {}),
    prevHash: doc.prevHash,
    hash: doc.hash,
    ...(doc.signature ? { signature: doc.signature } : {}),
  }
}

export class SanityLedgerStore implements LedgerStore {
  private readonly client: SanityLikeClient
  constructor(client: SanityLikeClient) {
    this.client = client
  }
  async load(companyId: string): Promise<LedgerEntry[]> {
    checkCompanyId(companyId)
    const docs = await this.client.fetch<SanityLedgerDocument[]>(
      '*[_type == "intentLedgerEntry" && companyId == $companyId && !(_id in path("drafts.**"))] | order(seq asc)',
      { companyId },
    )
    return docs.map(fromSanityLedgerDocument)
  }
  async append(companyId: string, entry: LedgerEntry): Promise<void> {
    const doc = toSanityLedgerDocument(companyId, entry)
    const stored = await this.client.createIfNotExists(doc)
    if (stored.hash !== entry.hash) throw new LedgerConflictError(companyId, entry.seq)
  }
}

// ---------------------------------------------------------------------------
// Intent graphs (Sanity)

export interface SanityIntentGraphDocument {
  _id: string
  _type: 'intentGraph'
  graphId: string
  objective: string
  mode: IntentGraph['mode']
  autonomyDepth: IntentGraph['autonomyDepth']
  requestedBy: string
  createdAt: string
  variables: Array<Omit<GraphVariable, 'value' | 'sources'> & { _key: string; valueJson?: string; sourcesJson: string }>
  edges: Array<IntentGraph['edges'][number] & { _key: string }>
  historyJson: string
  questionFeedbackJson?: string
}

export function toSanityIntentGraph(graph: IntentGraph): SanityIntentGraphDocument {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(graph.id)) throw new Error(`Invalid graph id "${graph.id}".`)
  return {
    _id: `intent-graph.${graph.id}`,
    _type: 'intentGraph',
    graphId: graph.id,
    objective: graph.objective,
    mode: graph.mode,
    autonomyDepth: graph.autonomyDepth,
    requestedBy: graph.requestedBy,
    createdAt: graph.createdAt,
    variables: graph.variables.map(({ value, sources, ...rest }, i) => ({
      _key: `v${i}`,
      ...rest,
      ...(value !== undefined ? { valueJson: JSON.stringify(value) } : {}),
      sourcesJson: JSON.stringify(sources),
    })),
    edges: graph.edges.map((e, i) => ({ _key: `e${i}`, ...e })),
    historyJson: JSON.stringify(graph.history),
    ...(graph.questionFeedback?.length ? { questionFeedbackJson: JSON.stringify(graph.questionFeedback) } : {}),
  }
}

export function fromSanityIntentGraph(doc: SanityIntentGraphDocument): IntentGraph {
  return {
    id: doc.graphId,
    objective: doc.objective,
    mode: doc.mode,
    autonomyDepth: doc.autonomyDepth,
    requestedBy: doc.requestedBy,
    createdAt: doc.createdAt,
    variables: doc.variables.map(({ _key, valueJson, sourcesJson, ...rest }) => {
      void _key
      return { ...rest, ...(valueJson !== undefined ? { value: JSON.parse(valueJson) as GraphVariable['value'] } : {}), sources: JSON.parse(sourcesJson) as GraphVariable['sources'] }
    }),
    edges: doc.edges.map(({ _key, ...e }) => {
      void _key
      return e
    }),
    history: JSON.parse(doc.historyJson) as IntentGraph['history'],
    ...(doc.questionFeedbackJson ? { questionFeedback: JSON.parse(doc.questionFeedbackJson) as IntentGraph['questionFeedback'] } : {}),
  }
}

// ---------------------------------------------------------------------------
// Intent graph stores (latest version of each graph; its history travels inside it)

export interface IntentGraphStore {
  get(id: string): Promise<IntentGraph | undefined>
  put(graph: IntentGraph): Promise<void>
  list(): Promise<IntentGraph[]>
}

const GRAPH_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/

export class MemoryIntentGraphStore implements IntentGraphStore {
  private readonly graphs = new Map<string, IntentGraph>()
  async get(id: string) { const g = this.graphs.get(id); return g ? structuredClone(g) : undefined }
  async put(graph: IntentGraph) { if (!GRAPH_ID.test(graph.id)) throw new Error(`Invalid graph id "${graph.id}".`); this.graphs.set(graph.id, structuredClone(graph)) }
  async list() { return [...this.graphs.values()].map((g) => structuredClone(g)) }
}

/** One JSON file per graph, replaced atomically (write then rename). */
export class FileIntentGraphStore implements IntentGraphStore {
  private readonly dir: string
  constructor(dir: string) {
    this.dir = dir
  }
  private path(id: string): string {
    if (!GRAPH_ID.test(id)) throw new Error(`Invalid graph id "${id}".`)
    return join(this.dir, `${id}.intent-graph.json`)
  }
  async get(id: string): Promise<IntentGraph | undefined> {
    try {
      return JSON.parse(await readFile(this.path(id), 'utf8')) as IntentGraph
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  async put(graph: IntentGraph): Promise<void> {
    const path = this.path(graph.id)
    await mkdir(this.dir, { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(graph), { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, path)
  }
  async list(): Promise<IntentGraph[]> {
    let names: string[]
    try {
      names = await readdir(this.dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const out: IntentGraph[] = []
    for (const n of names.filter((f) => f.endsWith('.intent-graph.json'))) out.push(JSON.parse(await readFile(join(this.dir, n), 'utf8')) as IntentGraph)
    return out
  }
}
