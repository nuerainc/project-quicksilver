import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { experimentDigest, verifyMoneyLedger, type Experiment, type ExperimentStatus, type MoneyEntry, type MoneyLedger } from '@quicksilver/kernel/playbooks/economics'

import { assertAllowedSanityProject, createSanityStoreClient, idSegment, isSanityConflict, type SanityStoreClient } from './sanity-client.ts'

/**
 * Persistence for Genesis (M5): the money ledger and the run's experiments.
 *
 *   File (default)  <dir>/<runId>/ledger.json and experiments.json, the layout
 *                   genesis-cli has always used; every write is atomic
 *                   (write a temp file, then rename).
 *   Sanity          moneyEntry     one per ledger entry, id "money-entry.<runId>.<seq>"
 *                   experimentRecord one per experiment, id "experiment-record.<runId>.<experimentId>"
 *                   Ids contain a dot, which keeps them out of unauthenticated reads.
 *
 * Rules every store enforces:
 *   - Money entries are append-only. An entry whose seq is already taken by a
 *     different entry, or that does not follow the last entry, is refused
 *     with MoneyLedgerConflictError. Loading verifies the hash chain and throws
 *     MoneyLedgerIntegrityError when it does not verify.
 *   - An experiment's definition and digest are fixed once it leaves draft.
 *     Its start stamp is set once, and its measurements and decisions only
 *     grow. Violations throw ExperimentRecordError. A write that loses a race
 *     to another writer throws ExperimentConflictError.
 */

export interface MoneyLedgerStore {
  /** Entries in order, chain verified. Throws MoneyLedgerIntegrityError when it does not verify. */
  load(runId: string): Promise<MoneyEntry[]>
  /** Refuses (MoneyLedgerConflictError) an entry whose seq is taken or that does not follow the last one. */
  append(runId: string, entry: MoneyEntry): Promise<void>
}

export interface ExperimentStore {
  /** Experiments in the order they were drafted. */
  list(runId: string): Promise<Experiment[]>
  /** Create or update one experiment (keyed by definition.id). */
  put(runId: string, experiment: Experiment): Promise<void>
}

export class MoneyLedgerIntegrityError extends Error {
  readonly runId: string
  constructor(runId: string, errors: string[]) {
    super(`The money ledger for run "${runId}" does not verify: ${errors.join(' ')}`)
    this.name = 'MoneyLedgerIntegrityError'
    this.runId = runId
  }
}

export class MoneyLedgerConflictError extends Error {
  readonly seq: number
  constructor(runId: string, seq: number, why: string) {
    super(`Money entry ${seq} of run "${runId}" was refused: ${why} Reload and try again.`)
    this.name = 'MoneyLedgerConflictError'
    this.seq = seq
  }
}

export class ExperimentRecordError extends Error {
  constructor(experimentId: string, reasons: string[]) {
    super(`Experiment "${experimentId}" cannot be stored: ${reasons.join(' ')}`)
    this.name = 'ExperimentRecordError'
  }
}

export class ExperimentConflictError extends Error {
  constructor(experimentId: string) {
    super(`Experiment "${experimentId}" was changed by another writer first. Reload and try again.`)
    this.name = 'ExperimentConflictError'
  }
}

const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
function checkRunId(runId: string): void {
  if (!RUN_ID.test(runId)) throw new Error(`Invalid run id "${runId}".`)
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const o = value as Record<string, unknown>
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
}

function verified(runId: string, entries: MoneyEntry[]): MoneyEntry[] {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq)
  const v = verifyMoneyLedger({ runId, budgetUsd: 0, entries: sorted })
  if (!v.valid) throw new MoneyLedgerIntegrityError(runId, v.errors)
  return sorted
}

/** Where a new entry must go, given the verified entries so far (throws when it doesn't fit; returns false when it is already there). */
function checkAppend(runId: string, current: MoneyEntry[], entry: MoneyEntry): boolean {
  const existing = current.find((e) => e.seq === entry.seq)
  if (existing) {
    if (existing.hash !== entry.hash) throw new MoneyLedgerConflictError(runId, entry.seq, 'that sequence number is already taken by a different entry.')
    return false
  }
  if (entry.seq !== current.length + 1) throw new MoneyLedgerConflictError(runId, entry.seq, `the next entry is ${current.length + 1}.`)
  const last = current.at(-1)
  if (last && entry.prevHash !== last.hash) throw new MoneyLedgerConflictError(runId, entry.seq, 'it does not follow the last entry.')
  return true
}

/** Why storing `next` over `prev` would break an experiment's fixed record (empty when it is fine). */
export function experimentChangeProblems(prev: Experiment | undefined, next: Experiment): string[] {
  const problems: string[] = []
  if (experimentDigest(next.definition) !== next.digest) problems.push('its digest does not match its definition.')
  if (!prev || prev.status === 'draft') return problems
  if (canonical(prev.definition) !== canonical(next.definition) || prev.digest !== next.digest) problems.push(`its definition and digest are fixed since it left draft (it is ${prev.status}); a changed experiment needs a new id.`)
  if (next.status === 'draft') problems.push('it cannot go back to draft.')
  for (const k of ['startedAt', 'startedBy', 'endsAt'] as const) if (prev[k] !== undefined && prev[k] !== next[k]) problems.push(`${k} is set once.`)
  const extends_ = <T>(a: T[], b: T[]) => b.length >= a.length && a.every((x, i) => canonical(x) === canonical(b[i]))
  if (!extends_(prev.measurements, next.measurements)) problems.push('measurements are only added, never changed.')
  if (!extends_(prev.decisions, next.decisions)) problems.push('decisions are only added, never changed.')
  return problems
}

function checkExperiment(prev: Experiment | undefined, next: Experiment): void {
  const problems = experimentChangeProblems(prev, next)
  if (problems.length) throw new ExperimentRecordError(next.definition.id, problems)
}

/** When the run started: the first experiment start (for stores that keep no run file). */
export function runStartedAt(experiments: Experiment[]): string | null {
  const starts = experiments.map((e) => e.startedAt).filter((s): s is string => !!s).sort()
  return starts[0] ?? null
}

// ── Files ─────────────────────────────────────────────────────────────────

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    throw e
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 1), { mode: 0o600 })
  await rename(tmp, path)
}

/** <dir>/<runId>/ledger.json holding the whole MoneyLedger, as genesis-cli has always written it. */
export class FileMoneyLedgerStore implements MoneyLedgerStore {
  private readonly dir: string
  private readonly budgetUsd: number
  /** `budgetUsd` is written into a new ledger file (existing files keep theirs). */
  constructor(dir: string, options: { budgetUsd?: number } = {}) {
    this.dir = dir
    this.budgetUsd = options.budgetUsd ?? 0
  }
  private path(runId: string) {
    checkRunId(runId)
    return join(this.dir, runId, 'ledger.json')
  }
  private async read(runId: string): Promise<MoneyLedger> {
    return readJson<MoneyLedger>(this.path(runId), { runId, budgetUsd: this.budgetUsd, entries: [] })
  }
  async load(runId: string): Promise<MoneyEntry[]> {
    return verified(runId, (await this.read(runId)).entries)
  }
  async append(runId: string, entry: MoneyEntry): Promise<void> {
    const ledger = await this.read(runId)
    const current = verified(runId, ledger.entries)
    if (!checkAppend(runId, current, entry)) return
    await writeJsonAtomic(this.path(runId), { ...ledger, entries: [...current, entry] })
  }
}

/** <dir>/<runId>/experiments.json holding every experiment of the run, replaced atomically. */
export class FileExperimentStore implements ExperimentStore {
  private readonly dir: string
  constructor(dir: string) {
    this.dir = dir
  }
  private path(runId: string) {
    checkRunId(runId)
    return join(this.dir, runId, 'experiments.json')
  }
  async list(runId: string): Promise<Experiment[]> {
    return readJson<Experiment[]>(this.path(runId), [])
  }
  async put(runId: string, experiment: Experiment): Promise<void> {
    const all = await this.list(runId)
    const i = all.findIndex((e) => e.definition.id === experiment.definition.id)
    checkExperiment(i >= 0 ? all[i] : undefined, experiment)
    if (i >= 0) all[i] = experiment
    else all.push(experiment)
    await writeJsonAtomic(this.path(runId), all)
  }
}

// ── Sanity ────────────────────────────────────────────────────────────────

export interface SanityMoneyEntryDocument {
  _id: string
  _type: 'moneyEntry'
  runId: string
  seq: number
  kind: MoneyEntry['kind']
  amountUsd: number
  category: string
  description: string
  experimentId?: string
  sourceType: MoneyEntry['source']['type']
  sourceRef: string
  occurredAt?: string
  recordedAt: string
  recordedBy: string
  prevHash: string
  hash: string
}

export function moneyEntryDocumentId(runId: string, seq: number): string {
  checkRunId(runId)
  if (!Number.isInteger(seq) || seq < 1) throw new Error(`Invalid sequence number ${seq}.`)
  return `money-entry.${idSegment(runId)}.${String(seq).padStart(8, '0')}`
}

export function toMoneyEntryDocument(runId: string, e: MoneyEntry): SanityMoneyEntryDocument {
  return {
    _id: moneyEntryDocumentId(runId, e.seq),
    _type: 'moneyEntry',
    runId,
    seq: e.seq,
    kind: e.kind,
    amountUsd: e.amountUsd,
    category: e.category,
    description: e.description,
    ...(e.experimentId !== undefined ? { experimentId: e.experimentId } : {}),
    sourceType: e.source.type,
    sourceRef: e.source.ref,
    ...(e.occurredAt !== undefined ? { occurredAt: e.occurredAt } : {}),
    recordedAt: e.recordedAt,
    recordedBy: e.recordedBy,
    prevHash: e.prevHash,
    hash: e.hash,
  }
}

export function fromMoneyEntryDocument(d: SanityMoneyEntryDocument): MoneyEntry {
  return {
    kind: d.kind,
    amountUsd: d.amountUsd,
    category: d.category,
    description: d.description,
    ...(d.experimentId !== undefined ? { experimentId: d.experimentId } : {}),
    source: { type: d.sourceType, ref: d.sourceRef },
    ...(d.occurredAt !== undefined ? { occurredAt: d.occurredAt } : {}),
    seq: d.seq,
    recordedAt: d.recordedAt,
    recordedBy: d.recordedBy,
    prevHash: d.prevHash,
    hash: d.hash,
  }
}

export class SanityMoneyLedgerStore implements MoneyLedgerStore {
  private readonly client: SanityStoreClient
  constructor(client: SanityStoreClient) {
    assertAllowedSanityProject(client.projectId)
    this.client = client
  }
  async load(runId: string): Promise<MoneyEntry[]> {
    checkRunId(runId)
    const docs = await this.client.fetch<SanityMoneyEntryDocument[]>(
      '*[_type == $type && runId == $runId && !(_id in path("drafts.**"))] | order(seq asc)',
      { type: 'moneyEntry', runId },
    )
    return verified(runId, docs.map(fromMoneyEntryDocument))
  }
  async append(runId: string, entry: MoneyEntry): Promise<void> {
    const doc = toMoneyEntryDocument(runId, entry)
    if (entry.seq > 1) {
      const prev = await this.client.getDocument<SanityMoneyEntryDocument>(moneyEntryDocumentId(runId, entry.seq - 1))
      if (!prev) throw new MoneyLedgerConflictError(runId, entry.seq, `entry ${entry.seq - 1} is not stored.`)
      if (prev.hash !== entry.prevHash) throw new MoneyLedgerConflictError(runId, entry.seq, 'it does not follow the last entry.')
    }
    // createIfNotExists never overwrites: if the id is taken, Sanity returns the stored entry.
    const stored = await this.client.createIfNotExists(doc)
    if (stored.hash !== entry.hash) throw new MoneyLedgerConflictError(runId, entry.seq, 'that sequence number is already taken by a different entry.')
  }
}

export interface SanityExperimentRecordDocument {
  _id: string
  _type: 'experimentRecord'
  _rev?: string
  runId: string
  experimentId: string
  /** Drafting order within the run. */
  position: number
  status: ExperimentStatus
  digest: string
  hypothesis: string
  playbookId: string
  budgetUsd: number
  durationDays: number
  customerFacing: boolean
  proposedBy: string
  /** The definition exactly as digested. */
  definitionJson: string
  startedAt?: string
  startedBy?: string
  endsAt?: string
  measurementsJson: string
  decisionsJson: string
}

export function experimentRecordId(runId: string, experimentId: string): string {
  checkRunId(runId)
  return `experiment-record.${idSegment(runId)}.${idSegment(experimentId)}`
}

export function toExperimentRecordDocument(runId: string, exp: Experiment, position: number): SanityExperimentRecordDocument {
  const d = exp.definition
  return {
    _id: experimentRecordId(runId, d.id),
    _type: 'experimentRecord',
    runId,
    experimentId: d.id,
    position,
    status: exp.status,
    digest: exp.digest,
    hypothesis: d.hypothesis,
    playbookId: d.playbookId,
    budgetUsd: d.budgetUsd,
    durationDays: d.durationDays,
    customerFacing: d.customerFacing,
    proposedBy: d.proposedBy,
    definitionJson: JSON.stringify(d),
    ...(exp.startedAt !== undefined ? { startedAt: exp.startedAt } : {}),
    ...(exp.startedBy !== undefined ? { startedBy: exp.startedBy } : {}),
    ...(exp.endsAt !== undefined ? { endsAt: exp.endsAt } : {}),
    measurementsJson: JSON.stringify(exp.measurements),
    decisionsJson: JSON.stringify(exp.decisions),
  }
}

export function fromExperimentRecordDocument(doc: SanityExperimentRecordDocument): Experiment {
  return {
    definition: JSON.parse(doc.definitionJson) as Experiment['definition'],
    digest: doc.digest,
    status: doc.status,
    ...(doc.startedAt !== undefined ? { startedAt: doc.startedAt } : {}),
    ...(doc.startedBy !== undefined ? { startedBy: doc.startedBy } : {}),
    ...(doc.endsAt !== undefined ? { endsAt: doc.endsAt } : {}),
    measurements: JSON.parse(doc.measurementsJson) as Experiment['measurements'],
    decisions: JSON.parse(doc.decisionsJson) as Experiment['decisions'],
  }
}

export class SanityExperimentStore implements ExperimentStore {
  private readonly client: SanityStoreClient
  constructor(client: SanityStoreClient) {
    assertAllowedSanityProject(client.projectId)
    this.client = client
  }
  private async docs(runId: string): Promise<SanityExperimentRecordDocument[]> {
    checkRunId(runId)
    const docs = await this.client.fetch<SanityExperimentRecordDocument[]>(
      '*[_type == $type && runId == $runId && !(_id in path("drafts.**"))] | order(position asc)',
      { type: 'experimentRecord', runId },
    )
    return [...docs].sort((a, b) => a.position - b.position || a._id.localeCompare(b._id))
  }
  async list(runId: string): Promise<Experiment[]> {
    return (await this.docs(runId)).map(fromExperimentRecordDocument)
  }
  async put(runId: string, experiment: Experiment): Promise<void> {
    const id = experimentRecordId(runId, experiment.definition.id)
    const current = await this.client.getDocument<SanityExperimentRecordDocument>(id)
    const prev = current ? fromExperimentRecordDocument(current) : undefined
    checkExperiment(prev, experiment)
    try {
      if (!current) {
        const position = (await this.docs(runId)).reduce((m, d) => Math.max(m, d.position), 0) + 1
        await this.client.mutate([{ create: { ...toExperimentRecordDocument(runId, experiment, position) } }])
        return
      }
      const next = toExperimentRecordDocument(runId, experiment, current.position)
      const set: Record<string, unknown> = {
        status: next.status,
        measurementsJson: next.measurementsJson,
        decisionsJson: next.decisionsJson,
        ...(next.startedAt !== undefined ? { startedAt: next.startedAt } : {}),
        ...(next.startedBy !== undefined ? { startedBy: next.startedBy } : {}),
        ...(next.endsAt !== undefined ? { endsAt: next.endsAt } : {}),
      }
      // The definition is only ever written while the stored record is still a draft.
      if (current.status === 'draft') {
        for (const k of ['digest', 'hypothesis', 'playbookId', 'budgetUsd', 'durationDays', 'customerFacing', 'proposedBy', 'definitionJson'] as const) set[k] = next[k]
      }
      await this.client.mutate([{ patch: { id, ...(current._rev ? { ifRevisionID: current._rev } : {}), set } }])
    } catch (error) {
      if (isSanityConflict(error)) throw new ExperimentConflictError(experiment.definition.id)
      throw error
    }
  }
}

// ── Choosing a store ──────────────────────────────────────────────────────

export interface GenesisStores {
  kind: 'file' | 'sanity'
  ledger: MoneyLedgerStore
  experiments: ExperimentStore
}

/**
 * QUICKSILVER_GENESIS_STORE=sanity keeps Genesis records in Sanity (needs
 * NEXT_PUBLIC_SANITY_PROJECT_ID and SANITY_AUTH_TOKEN; the legacy challenge
 * project is refused). Anything else keeps the files under `dir`.
 */
export async function genesisStoresFromEnv(options: { dir: string; budgetUsd: number; env?: NodeJS.ProcessEnv; client?: SanityStoreClient }): Promise<GenesisStores> {
  const env = options.env ?? process.env
  if ((env.QUICKSILVER_GENESIS_STORE ?? 'file').trim() === 'sanity') {
    const client = options.client ?? (await createSanityStoreClient(env))
    if (!client) throw new Error('QUICKSILVER_GENESIS_STORE=sanity needs NEXT_PUBLIC_SANITY_PROJECT_ID and SANITY_AUTH_TOKEN.')
    return { kind: 'sanity', ledger: new SanityMoneyLedgerStore(client), experiments: new SanityExperimentStore(client) }
  }
  return { kind: 'file', ledger: new FileMoneyLedgerStore(options.dir, { budgetUsd: options.budgetUsd }), experiments: new FileExperimentStore(options.dir) }
}
