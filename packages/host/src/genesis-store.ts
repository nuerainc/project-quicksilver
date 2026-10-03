import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { experimentDigest, verifyMoneyLedger, type Experiment, type ExperimentStatus, type MoneyEntry, type MoneyEntryInput, type MoneyLedger } from '@quicksilver/kernel/playbooks/economics'

import { assertAllowedSanityProject, createSanityStoreClient, idSegment, isSanityConflict, type SanityStoreClient } from './sanity-client.ts'
import type { GenesisState, GenesisStore } from './genesis-api.ts'
import { checkReviewAppend, ContentReviewConflictError, sameReview, sortReviews, type ContentReviewRecord } from './genesis-reviews.ts'
import type { GenesisRunConfig } from '@quicksilver/kernel/playbooks/genesis'

/**
 * Persistence for Genesis (M5): the money ledger, the run's experiments and
 * its content reviews (manual founder reviews of customer-facing text).
 *
 *   File (default)  <dir>/<runId>/ledger.json, experiments.json and reviews.json,
 *                   the layout genesis-cli has always used; every write is
 *                   atomic (write a temp file, then rename).
 *   Sanity          moneyEntry     one per ledger entry, id "money-entry.<runId>.<seq>"
 *                   experimentRecord one per experiment, id "experiment-record.<runId>.<experimentId>"
 *                   contentReview  one per review, id "content-review.<runId>.<reviewId>"
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
 *   - Content reviews are append-only: a reviewId is written once, and a
 *     different record under a taken id throws ContentReviewConflictError.
 *     A new decision is a new record.
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

export interface ContentReviewStore {
  /** Reviews of the run, oldest first. */
  list(runId: string): Promise<ContentReviewRecord[]>
  /** Append one review; never rewrites a stored one. */
  append(runId: string, review: ContentReviewRecord): Promise<void>
}

/**
 * A single-tenant caller (a CLI, a test) that does not bind a tenantId gets
 * this partition, matching today's one-tenant-per-process deployment. A
 * multi-tenant host binds each store to its own tenant at construction, the
 * same way `tasks.ts`'s TaskService binds one. Money entries and experiments
 * keep their existing hash-chained shape untouched: the tenant is a storage
 * partition key (like `runId`'s directory), never a hashed field, so moving
 * this fix in or out never changes a ledger's digest.
 */
export const DEFAULT_GENESIS_TENANT = 'default'

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

/** <dir>/<tenantId>/<runId>/ledger.json holding the whole MoneyLedger, as genesis-cli has always written it (nested one level deeper, under the bound tenant). */
export class FileMoneyLedgerStore implements MoneyLedgerStore {
  private readonly dir: string
  private readonly budgetUsd: number
  private readonly tenantId: string
  /** `budgetUsd` is written into a new ledger file (existing files keep theirs). `tenantId` defaults to DEFAULT_GENESIS_TENANT. */
  constructor(dir: string, options: { budgetUsd?: number; tenantId?: string } = {}) {
    this.dir = dir
    this.budgetUsd = options.budgetUsd ?? 0
    this.tenantId = options.tenantId ?? DEFAULT_GENESIS_TENANT
  }
  private path(runId: string) {
    checkRunId(runId)
    return join(this.dir, this.tenantId, runId, 'ledger.json')
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

/** <dir>/<tenantId>/<runId>/experiments.json holding every experiment of the run, replaced atomically. */
export class FileExperimentStore implements ExperimentStore {
  private readonly dir: string
  private readonly tenantId: string
  constructor(dir: string, tenantId: string = DEFAULT_GENESIS_TENANT) {
    this.dir = dir
    this.tenantId = tenantId
  }
  private path(runId: string) {
    checkRunId(runId)
    return join(this.dir, this.tenantId, runId, 'experiments.json')
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

/** <dir>/<tenantId>/<runId>/reviews.json holding every content review of the run, append-only. */
export class FileContentReviewStore implements ContentReviewStore {
  private readonly dir: string
  private readonly tenantId: string
  constructor(dir: string, tenantId: string = DEFAULT_GENESIS_TENANT) {
    this.dir = dir
    this.tenantId = tenantId
  }
  private path(runId: string) {
    checkRunId(runId)
    return join(this.dir, this.tenantId, runId, 'reviews.json')
  }
  async list(runId: string): Promise<ContentReviewRecord[]> {
    return sortReviews(await readJson<ContentReviewRecord[]>(this.path(runId), []))
  }
  async append(runId: string, review: ContentReviewRecord): Promise<void> {
    const all = await readJson<ContentReviewRecord[]>(this.path(runId), [])
    if (!checkReviewAppend(runId, all, review)) return
    await writeJsonAtomic(this.path(runId), [...all, review])
  }
}

// ── Pending payments (P-027) ──────────────────────────────────────────────

/**
 * Payments a verified payment-processor webhook reported, waiting for a human
 * to confirm them into the money ledger (`autoRecordPaymentWebhooks: false`,
 * the default). One row per payment: `id` is the processor's payment
 * reference (a Stripe PaymentIntent id), so the several events Stripe sends
 * for one payment, and its retries, never make two rows. A row is decided
 * once (confirmed or rejected) and never reopened.
 *
 * File-backed only for v1 (<dir>/<tenantId>/<runId>/pending-payments.json).
 * There is no Sanity-backed pending store yet; in Sanity mode the host keeps
 * this queue in files next to its other local state.
 */
export type PendingPaymentStatus = 'pending' | 'confirmed' | 'rejected'

export interface PendingPaymentEntry {
  /** The processor's payment reference; also the ledger entry's `source.ref`. */
  id: string
  status: PendingPaymentStatus
  provider: 'stripe'
  /** The first event that reported this payment. */
  eventId: string
  eventType: string
  livemode: boolean
  receivedAt: string
  /** What confirming records (always `revenue` from `payment-processor`). */
  input: MoneyEntryInput
  decidedBy?: string
  decidedAt?: string
  note?: string
  /** The ledger entry a confirmation wrote. */
  ledgerSeq?: number
}

export interface PendingPaymentDecision {
  status: 'confirmed' | 'rejected'
  by: string
  at: string
  note?: string
  ledgerSeq?: number
}

export interface PendingPaymentStore {
  /** Rows of the run, oldest first. */
  list(runId: string): Promise<PendingPaymentEntry[]>
  get(runId: string, id: string): Promise<PendingPaymentEntry | undefined>
  /** Add a row unless one with the same id exists (then returns that one, `created: false`). */
  putPending(runId: string, entry: PendingPaymentEntry): Promise<{ created: boolean; entry: PendingPaymentEntry }>
  /** Decide a pending row once. Throws PendingPaymentError (`not-found`, `already-decided`). */
  decide(runId: string, id: string, decision: PendingPaymentDecision): Promise<PendingPaymentEntry>
}

export class PendingPaymentError extends Error {
  readonly code: 'not-found' | 'already-decided'
  constructor(code: 'not-found' | 'already-decided', message: string) {
    super(message)
    this.name = 'PendingPaymentError'
    this.code = code
  }
}

export const PENDING_PAYMENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/

function applyPendingPut(all: PendingPaymentEntry[], entry: PendingPaymentEntry): { created: boolean; entry: PendingPaymentEntry; all: PendingPaymentEntry[] } {
  if (!PENDING_PAYMENT_ID.test(entry.id) || entry.status !== 'pending') throw new Error('A pending payment needs a valid id and status "pending".')
  const existing = all.find((e) => e.id === entry.id)
  if (existing) return { created: false, entry: existing, all }
  return { created: true, entry, all: [...all, entry] }
}

function applyPendingDecision(runId: string, all: PendingPaymentEntry[], id: string, d: PendingPaymentDecision): { entry: PendingPaymentEntry; all: PendingPaymentEntry[] } {
  const i = all.findIndex((e) => e.id === id)
  if (i < 0) throw new PendingPaymentError('not-found', `No pending payment "${id}" in run "${runId}".`)
  const current = all[i]!
  if (current.status !== 'pending') throw new PendingPaymentError('already-decided', `Payment "${id}" was already ${current.status}.`)
  const entry: PendingPaymentEntry = { ...current, status: d.status, decidedBy: d.by, decidedAt: d.at, ...(d.note ? { note: d.note } : {}), ...(d.ledgerSeq !== undefined ? { ledgerSeq: d.ledgerSeq } : {}) }
  return { entry, all: all.map((e, j) => (j === i ? entry : e)) }
}

/** <dir>/<tenantId>/<runId>/pending-payments.json. Callers serialize writes per run (the host's withLock). */
export class FilePendingPaymentStore implements PendingPaymentStore {
  private readonly dir: string
  private readonly tenantId: string
  constructor(dir: string, tenantId: string = DEFAULT_GENESIS_TENANT) {
    this.dir = dir
    this.tenantId = tenantId
  }
  private path(runId: string) {
    checkRunId(runId)
    return join(this.dir, this.tenantId, runId, 'pending-payments.json')
  }
  async list(runId: string): Promise<PendingPaymentEntry[]> { return readJson<PendingPaymentEntry[]>(this.path(runId), []) }
  async get(runId: string, id: string) { return (await this.list(runId)).find((e) => e.id === id) }
  async putPending(runId: string, entry: PendingPaymentEntry) {
    const r = applyPendingPut(await this.list(runId), entry)
    if (r.created) await writeJsonAtomic(this.path(runId), r.all)
    return { created: r.created, entry: r.entry }
  }
  async decide(runId: string, id: string, decision: PendingPaymentDecision) {
    const r = applyPendingDecision(runId, await this.list(runId), id, decision)
    await writeJsonAtomic(this.path(runId), r.all)
    return r.entry
  }
}

/** In-memory twin for tests and file-less hosts; partitioned by tenant like MemoryGenesisStore. */
export class MemoryPendingPaymentStore implements PendingPaymentStore {
  private readonly tenantId: string
  private readonly data = new Map<string, PendingPaymentEntry[]>()
  constructor(tenantId: string = DEFAULT_GENESIS_TENANT) { this.tenantId = tenantId }
  private key(runId: string) { checkRunId(runId); return `${this.tenantId}\u0000${runId}` }
  async list(runId: string) { return structuredClone(this.data.get(this.key(runId)) ?? []) }
  async get(runId: string, id: string) { return (await this.list(runId)).find((e) => e.id === id) }
  async putPending(runId: string, entry: PendingPaymentEntry) {
    const r = applyPendingPut(await this.list(runId), structuredClone(entry))
    if (r.created) this.data.set(this.key(runId), r.all)
    return { created: r.created, entry: structuredClone(r.entry) }
  }
  async decide(runId: string, id: string, decision: PendingPaymentDecision) {
    const r = applyPendingDecision(runId, await this.list(runId), id, decision)
    this.data.set(this.key(runId), r.all)
    return structuredClone(r.entry)
  }
}

// ── Sanity ────────────────────────────────────────────────────────────────

export interface SanityMoneyEntryDocument {
  _id: string
  _type: 'moneyEntry'
  tenantId: string
  runId: string
  seq: number
  kind: MoneyEntry['kind']
  amountUsd: number
  category: string
  description: string
  experimentId?: string
  sourceType: MoneyEntry['source']['type']
  sourceRef: string
  spendDecisionId?: string
  spendRecommendation?: 'execute-autonomously' | 'request-approval'
  spendRiskLevel?: number
  spendReasons?: string[]
  spendConfirmedBy?: string
  spendConfirmedAt?: string
  occurredAt?: string
  recordedAt: string
  recordedBy: string
  prevHash: string
  hash: string
}

/** Namespaced by tenant so two tenants' entries can never collide on id. */
export function moneyEntryDocumentId(tenantId: string, runId: string, seq: number): string {
  checkRunId(runId)
  if (!Number.isInteger(seq) || seq < 1) throw new Error(`Invalid sequence number ${seq}.`)
  return `money-entry.${idSegment(tenantId)}.${idSegment(runId)}.${String(seq).padStart(8, '0')}`
}

export function toMoneyEntryDocument(tenantId: string, runId: string, e: MoneyEntry): SanityMoneyEntryDocument {
  return {
    _id: moneyEntryDocumentId(tenantId, runId, e.seq),
    _type: 'moneyEntry',
    tenantId,
    runId,
    seq: e.seq,
    kind: e.kind,
    amountUsd: e.amountUsd,
    category: e.category,
    description: e.description,
    ...(e.experimentId !== undefined ? { experimentId: e.experimentId } : {}),
    sourceType: e.source.type,
    sourceRef: e.source.ref,
    ...(e.spendAuthorization ? {
      spendDecisionId: e.spendAuthorization.decisionId,
      spendRecommendation: e.spendAuthorization.recommendation,
      spendRiskLevel: e.spendAuthorization.riskLevel,
      spendReasons: e.spendAuthorization.reasons,
      spendConfirmedBy: e.spendAuthorization.confirmedBy,
      spendConfirmedAt: e.spendAuthorization.confirmedAt,
    } : {}),
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
    ...(d.spendDecisionId && d.spendRecommendation && d.spendRiskLevel !== undefined && d.spendConfirmedBy && d.spendConfirmedAt ? {
      spendAuthorization: {
        decisionId: d.spendDecisionId,
        recommendation: d.spendRecommendation,
        riskLevel: d.spendRiskLevel as NonNullable<MoneyEntry['spendAuthorization']>['riskLevel'],
        reasons: d.spendReasons ?? [],
        confirmedBy: d.spendConfirmedBy,
        confirmedAt: d.spendConfirmedAt,
      },
    } : {}),
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
  private readonly tenantId: string
  constructor(client: SanityStoreClient, tenantId: string = DEFAULT_GENESIS_TENANT) {
    assertAllowedSanityProject(client.projectId)
    this.client = client
    this.tenantId = tenantId
  }
  async load(runId: string): Promise<MoneyEntry[]> {
    checkRunId(runId)
    const docs = await this.client.fetch<SanityMoneyEntryDocument[]>(
      '*[_type == $type && tenantId == $tenantId && runId == $runId && !(_id in path("drafts.**"))] | order(seq asc)',
      { type: 'moneyEntry', tenantId: this.tenantId, runId },
    )
    return verified(runId, docs.map(fromMoneyEntryDocument))
  }
  async append(runId: string, entry: MoneyEntry): Promise<void> {
    const doc = toMoneyEntryDocument(this.tenantId, runId, entry)
    if (entry.seq > 1) {
      const prev = await this.client.getDocument<SanityMoneyEntryDocument>(moneyEntryDocumentId(this.tenantId, runId, entry.seq - 1))
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
  tenantId: string
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

/** Namespaced by tenant so two tenants' experiments can never collide on id. */
export function experimentRecordId(tenantId: string, runId: string, experimentId: string): string {
  checkRunId(runId)
  return `experiment-record.${idSegment(tenantId)}.${idSegment(runId)}.${idSegment(experimentId)}`
}

export function toExperimentRecordDocument(tenantId: string, runId: string, exp: Experiment, position: number): SanityExperimentRecordDocument {
  const d = exp.definition
  return {
    _id: experimentRecordId(tenantId, runId, d.id),
    _type: 'experimentRecord',
    tenantId,
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
  private readonly tenantId: string
  constructor(client: SanityStoreClient, tenantId: string = DEFAULT_GENESIS_TENANT) {
    assertAllowedSanityProject(client.projectId)
    this.client = client
    this.tenantId = tenantId
  }
  private async docs(runId: string): Promise<SanityExperimentRecordDocument[]> {
    checkRunId(runId)
    const docs = await this.client.fetch<SanityExperimentRecordDocument[]>(
      '*[_type == $type && tenantId == $tenantId && runId == $runId && !(_id in path("drafts.**"))] | order(position asc)',
      { type: 'experimentRecord', tenantId: this.tenantId, runId },
    )
    return [...docs].sort((a, b) => a.position - b.position || a._id.localeCompare(b._id))
  }
  async list(runId: string): Promise<Experiment[]> {
    return (await this.docs(runId)).map(fromExperimentRecordDocument)
  }
  async put(runId: string, experiment: Experiment): Promise<void> {
    const id = experimentRecordId(this.tenantId, runId, experiment.definition.id)
    const current = await this.client.getDocument<SanityExperimentRecordDocument>(id)
    const prev = current ? fromExperimentRecordDocument(current) : undefined
    checkExperiment(prev, experiment)
    try {
      if (!current) {
        const position = (await this.docs(runId)).reduce((m, d) => Math.max(m, d.position), 0) + 1
        await this.client.mutate([{ create: { ...toExperimentRecordDocument(this.tenantId, runId, experiment, position) } }])
        return
      }
      const next = toExperimentRecordDocument(this.tenantId, runId, experiment, current.position)
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

export interface SanityContentReviewDocument {
  _id: string
  _type: 'contentReview'
  tenantId: string
  runId: string
  reviewId: string
  kind: ContentReviewRecord['kind']
  contentDigest: string
  text: string
  verdict: ContentReviewRecord['verdict']
  components: string[]
  reviewer: string
  reviewerKind: ContentReviewRecord['reviewerKind']
  reviewedAt: string
  note?: string
  experimentId?: string
  channel: string
}

/** Namespaced by tenant so two tenants' reviews can never collide on id. */
export function contentReviewDocumentId(tenantId: string, runId: string, reviewId: string): string {
  checkRunId(runId)
  return `content-review.${idSegment(tenantId)}.${idSegment(runId)}.${idSegment(reviewId)}`
}

export function toContentReviewDocument(tenantId: string, runId: string, r: ContentReviewRecord): SanityContentReviewDocument {
  return {
    _id: contentReviewDocumentId(tenantId, runId, r.reviewId),
    _type: 'contentReview',
    tenantId,
    runId,
    reviewId: r.reviewId,
    kind: r.kind,
    contentDigest: r.contentDigest,
    text: r.text,
    verdict: r.verdict,
    components: [...r.components],
    reviewer: r.reviewer,
    reviewerKind: r.reviewerKind,
    reviewedAt: r.reviewedAt,
    ...(r.note !== undefined ? { note: r.note } : {}),
    ...(r.experimentId !== undefined ? { experimentId: r.experimentId } : {}),
    channel: r.channel,
  }
}

export function fromContentReviewDocument(d: SanityContentReviewDocument): ContentReviewRecord {
  return {
    reviewId: d.reviewId,
    kind: d.kind,
    contentDigest: d.contentDigest,
    text: d.text,
    verdict: d.verdict,
    components: [...(d.components ?? [])],
    reviewer: d.reviewer,
    reviewerKind: d.reviewerKind,
    reviewedAt: d.reviewedAt,
    ...(d.note !== undefined ? { note: d.note } : {}),
    ...(d.experimentId !== undefined ? { experimentId: d.experimentId } : {}),
    channel: d.channel,
  }
}

export class SanityContentReviewStore implements ContentReviewStore {
  private readonly client: SanityStoreClient
  private readonly tenantId: string
  constructor(client: SanityStoreClient, tenantId: string = DEFAULT_GENESIS_TENANT) {
    assertAllowedSanityProject(client.projectId)
    this.client = client
    this.tenantId = tenantId
  }
  async list(runId: string): Promise<ContentReviewRecord[]> {
    checkRunId(runId)
    const docs = await this.client.fetch<SanityContentReviewDocument[]>(
      '*[_type == $type && tenantId == $tenantId && runId == $runId && !(_id in path("drafts.**"))] | order(reviewedAt asc)',
      { type: 'contentReview', tenantId: this.tenantId, runId },
    )
    return sortReviews([...docs].sort((a, b) => a._id.localeCompare(b._id)).map(fromContentReviewDocument))
  }
  async append(runId: string, review: ContentReviewRecord): Promise<void> {
    checkReviewAppend(runId, [], review)
    // createIfNotExists never overwrites: if the id is taken, Sanity returns the stored review.
    const stored = await this.client.createIfNotExists(toContentReviewDocument(this.tenantId, runId, review))
    if (!sameReview(fromContentReviewDocument(stored), review)) throw new ContentReviewConflictError(runId, review.reviewId)
  }
}

// ── Choosing a store ──────────────────────────────────────────────────────

export interface GenesisStores {
  kind: 'file' | 'sanity'
  ledger: MoneyLedgerStore
  experiments: ExperimentStore
  reviews: ContentReviewStore
}

/**
 * QUICKSILVER_GENESIS_STORE=sanity keeps Genesis records in Sanity (needs
 * NEXT_PUBLIC_SANITY_PROJECT_ID and SANITY_WRITE_TOKEN (legacy: SANITY_AUTH_TOKEN); the legacy challenge
 * project is refused). Anything else keeps the files under `dir`.
 */
export async function genesisStoresFromEnv(options: { dir: string; budgetUsd: number; tenantId?: string; env?: NodeJS.ProcessEnv; client?: SanityStoreClient }): Promise<GenesisStores> {
  const env = options.env ?? process.env
  const tenantId = options.tenantId ?? DEFAULT_GENESIS_TENANT
  if ((env.QUICKSILVER_GENESIS_STORE ?? 'file').trim() === 'sanity') {
    const client = options.client ?? (await createSanityStoreClient(env))
    if (!client) throw new Error('QUICKSILVER_GENESIS_STORE=sanity needs NEXT_PUBLIC_SANITY_PROJECT_ID and SANITY_WRITE_TOKEN (or the legacy SANITY_AUTH_TOKEN).')
    return { kind: 'sanity', ledger: new SanityMoneyLedgerStore(client, tenantId), experiments: new SanityExperimentStore(client, tenantId), reviews: new SanityContentReviewStore(client, tenantId) }
  }
  return { kind: 'file', ledger: new FileMoneyLedgerStore(options.dir, { budgetUsd: options.budgetUsd, tenantId }), experiments: new FileExperimentStore(options.dir, tenantId), reviews: new FileContentReviewStore(options.dir, tenantId) }
}

// ── Host API adapter ──────────────────────────────────────────────────────

/**
 * Serves the host's Genesis routes from these stores, so the host and
 * `npm run genesis` share one ledger in Sanity mode too. Saves only append new
 * ledger entries and put experiments; the run's start is the first
 * experiment's start.
 */
export class StoresGenesisAdapter implements GenesisStore {
  private readonly stores: GenesisStores
  constructor(stores: GenesisStores) { this.stores = stores }
  async load(config: GenesisRunConfig): Promise<GenesisState> {
    const [entries, experiments] = await Promise.all([this.stores.ledger.load(config.runId), this.stores.experiments.list(config.runId)])
    return { ledger: { runId: config.runId, budgetUsd: config.budgetUsd, entries }, experiments, run: { startedAt: runStartedAt(experiments) } }
  }
  async saveLedger(runId: string, ledger: MoneyLedger): Promise<void> {
    const stored = await this.stores.ledger.load(runId)
    for (const entry of ledger.entries.slice(stored.length)) await this.stores.ledger.append(runId, entry)
  }
  async saveExperiments(runId: string, experiments: Experiment[]): Promise<void> {
    const stored = new Map((await this.stores.experiments.list(runId)).map((e) => [e.definition.id, JSON.stringify(e)]))
    for (const e of experiments) if (stored.get(e.definition.id) !== JSON.stringify(e)) await this.stores.experiments.put(runId, e)
  }
  async saveRun(): Promise<void> {}
  loadReviews(runId: string): Promise<ContentReviewRecord[]> { return this.stores.reviews.list(runId) }
  appendReview(runId: string, review: ContentReviewRecord): Promise<void> { return this.stores.reviews.append(runId, review) }
}
