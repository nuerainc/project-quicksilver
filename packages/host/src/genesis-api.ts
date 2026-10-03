import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import type { AccessController, Permission, Principal } from '@quicksilver/kernel/identity'
import {
  appendMoney,
  applyEvaluation,
  draftExperiment,
  evaluateExperiment,
  moneyTotals,
  MONEY_KINDS,
  MONEY_SOURCES,
  recordMeasurement,
  startExperiment,
  verifyMoneyLedger,
  type Experiment,
  type ExperimentDefinition,
  type MoneyEntryInput,
  type MoneyKind,
  type MoneyLedger,
} from '@quicksilver/kernel/playbooks/economics'
import { decideSpend, genesisBlockers, genesisFacts, validateGenesisConfig, type GenesisRunConfig } from '@quicksilver/kernel/playbooks/genesis'

import { checkReviewAppend, createManualReview, createWaesServiceReview, MANUAL_REVIEW_LABEL, parseContentReviewInput, parseWaesServiceInput, reviewSummary, sortReviews, type ContentReviewRecord, type WaesServiceAssessment, type WaesServiceInput } from './genesis-reviews.ts'
import { DEFAULT_GENESIS_TENANT, FileContentReviewStore, PENDING_PAYMENT_ID, PendingPaymentError, type PendingPaymentStore } from './genesis-store.ts'

/**
 * Genesis run on the host (M5): the same commands as `npm run genesis`, over HTTP.
 *
 *   GET  /api/genesis                                        decision:read
 *   POST /api/genesis/experiments            { definition }  intent:provide or decision:propose
 *   POST /api/genesis/experiments/:id/start                  intent:provide, humans only; refused while blockers exist
 *   POST /api/genesis/experiments/:id/measurements { value, source }   intent:provide or decision:propose
 *   POST /api/genesis/experiments/:id/evaluate               decision:read (the kernel applies kill/continue/close)
 *   POST /api/genesis/experiments/:id/decide  { note? }      intent:provide, humans only
 *   POST /api/genesis/money  { kind, amountUsd, category, description, source, experimentId?, confirm? }
 *                                                            intent:provide, humans only
 *   POST /api/genesis/reviews { text, channel, verdict, note?, experimentId? }
 *                                                            intent:provide, humans only: records a
 *                                                            MANUAL FOUNDER REVIEW of the exact text,
 *                                                            with the caller as reviewer (never a WAES run)
 *   GET  /api/genesis/pending-payments                       decision:read
 *   POST /api/genesis/pending-payments/:id/confirm { note? } intent:provide, humans only: records the
 *                                                            webhook-reported payment as revenue
 *   POST /api/genesis/pending-payments/:id/reject  { note? } intent:provide, humans only
 *
 * Nothing here moves money or executes an action. The money route RECORDS
 * money that has already moved, after the kernel's spend rules; every
 * response carries `executed: false`. A review sends and publishes nothing.
 * Data uses the same layout as the CLI (<dir>/<runId>/ledger.json,
 * experiments.json, run.json, reviews.json), so both see it.
 */

export interface GenesisRunState {
  startedAt: string | null
}

export interface GenesisState {
  ledger: MoneyLedger
  experiments: Experiment[]
  run: GenesisRunState
}

export interface GenesisStore {
  load(config: GenesisRunConfig): Promise<GenesisState>
  saveLedger(runId: string, ledger: MoneyLedger): Promise<void>
  saveExperiments(runId: string, experiments: Experiment[]): Promise<void>
  saveRun(runId: string, run: GenesisRunState): Promise<void>
  /** Content reviews (manual founder reviews of customer-facing text), oldest first. */
  loadReviews(runId: string): Promise<ContentReviewRecord[]>
  /** Append-only: a stored review is never rewritten. */
  appendReview(runId: string, review: ContentReviewRecord): Promise<void>
}

export interface GenesisApiDeps {
  config: GenesisRunConfig
  store: GenesisStore
  /** Names of active vault secrets (never values). The host supplies its own vault's names when this is absent. */
  vaultNames?: () => Promise<string[]>
  now?: () => number
  /** Optional model-backed WAES evaluator. Absence fails closed with 503. */
  runWaes?: (input: WaesServiceInput) => Promise<WaesServiceAssessment>
  /** P-027: payments a verified payment webhook reported, waiting for a human. The pending-payment routes return 404 when absent. */
  pending?: PendingPaymentStore
}

export interface GenesisApiContext {
  method: string
  parts: string[]
  principal: Principal
  tenantId: string
  access: AccessController
  readBody: () => Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }>
}

type Response = { status: number; body: unknown }

const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const EXP_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
const RECORDS_ONLY = 'Records money that already moved. Nothing was paid, charged or executed.'
const KERNEL = { id: 'kernel', kind: 'service' as const }

const emptyState = (c: GenesisRunConfig): GenesisState => ({ ledger: { runId: c.runId, budgetUsd: c.budgetUsd, entries: [] }, experiments: [], run: { startedAt: null } })

// ── Stores ────────────────────────────────────────────────────────────────

/**
 * Files at <dir>/<tenantId>/<runId>/{ledger,experiments,run,reviews}.json: the
 * layout `npm run genesis` uses, nested one level deeper under the bound
 * tenant so a multi-tenant host can never read or write another tenant's run.
 */
export class FileGenesisStore implements GenesisStore {
  private readonly dir: string
  private readonly tenantId: string
  private readonly reviews: FileContentReviewStore
  constructor(dir: string, tenantId: string = DEFAULT_GENESIS_TENANT) { this.dir = dir; this.tenantId = tenantId; this.reviews = new FileContentReviewStore(dir, tenantId) }
  private path(runId: string, file: string) {
    if (!RUN_ID.test(runId)) throw new Error('Invalid run id.')
    return join(this.dir, this.tenantId, runId, file)
  }
  private async read<T>(runId: string, file: string, fallback: T): Promise<T> {
    try { return JSON.parse(await readFile(this.path(runId, file), 'utf8')) as T } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback
      throw e
    }
  }
  private async write(runId: string, file: string, value: unknown) {
    const target = this.path(runId, file)
    await mkdir(join(this.dir, this.tenantId, runId), { recursive: true })
    await writeFile(`${target}.tmp`, JSON.stringify(value, null, 1), { mode: 0o600 })
    await rename(`${target}.tmp`, target)
  }
  async load(c: GenesisRunConfig): Promise<GenesisState> {
    const empty = emptyState(c)
    return {
      ledger: await this.read(c.runId, 'ledger.json', empty.ledger),
      experiments: await this.read(c.runId, 'experiments.json', empty.experiments),
      run: await this.read(c.runId, 'run.json', empty.run),
    }
  }
  saveLedger(runId: string, ledger: MoneyLedger) { return this.write(runId, 'ledger.json', ledger) }
  saveExperiments(runId: string, experiments: Experiment[]) { return this.write(runId, 'experiments.json', experiments) }
  saveRun(runId: string, run: GenesisRunState) { return this.write(runId, 'run.json', run) }
  loadReviews(runId: string) { return this.reviews.list(runId) }
  appendReview(runId: string, review: ContentReviewRecord) { return this.reviews.append(runId, review) }
}

/** The tenant is part of the Map key, so two tenant-bound instances sharing nothing in-process still cannot see each other's runs; a tenant-scoped instance also cannot see another tenant's runId even if it collides. */
export class MemoryGenesisStore implements GenesisStore {
  private readonly tenantId: string
  constructor(tenantId: string = DEFAULT_GENESIS_TENANT) { this.tenantId = tenantId }
  private readonly data = new Map<string, Partial<GenesisState>>()
  private key(runId: string) { return `${this.tenantId}\u0000${runId}` }
  async load(c: GenesisRunConfig) { return structuredClone({ ...emptyState(c), ...this.data.get(this.key(c.runId)) }) }
  private put(runId: string, patch: Partial<GenesisState>) { const k = this.key(runId); this.data.set(k, structuredClone({ ...this.data.get(k), ...patch })) }
  async saveLedger(runId: string, ledger: MoneyLedger) { this.put(runId, { ledger }) }
  async saveExperiments(runId: string, experiments: Experiment[]) { this.put(runId, { experiments }) }
  async saveRun(runId: string, run: GenesisRunState) { this.put(runId, { run }) }
  private readonly reviews = new Map<string, ContentReviewRecord[]>()
  async loadReviews(runId: string) { return sortReviews(structuredClone(this.reviews.get(this.key(runId)) ?? [])) }
  async appendReview(runId: string, review: ContentReviewRecord) {
    const k = this.key(runId)
    const current = this.reviews.get(k) ?? []
    if (checkReviewAppend(runId, current, review)) this.reviews.set(k, [...current, structuredClone(review)])
  }
}

// One write at a time per run, so concurrent requests (and payment webhooks) cannot lose each other's entries.
const locks = new Map<string, Promise<unknown>>()
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  locks.set(key, next.catch(() => undefined))
  return next
}

// ── Input validation ──────────────────────────────────────────────────────

const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Shape-check a definition before the kernel's own validation; `proposedBy` is always the caller. */
export function parseDefinition(value: unknown, proposedBy: string): { ok: true; definition: ExperimentDefinition } | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'definition must be an object.' }
  const d = value as Record<string, unknown>
  if (!isStr(d.id, 128) || !EXP_ID.test(d.id)) return { ok: false, error: 'definition.id must be letters, digits and . _ : -, up to 128 characters.' }
  if (!isStr(d.hypothesis, 1_000)) return { ok: false, error: 'definition.hypothesis must be 1 to 1,000 characters.' }
  if (!isStr(d.playbookId, 128)) return { ok: false, error: 'definition.playbookId is required.' }
  if (!isNum(d.budgetUsd)) return { ok: false, error: 'definition.budgetUsd must be a number.' }
  if (!isNum(d.durationDays)) return { ok: false, error: 'definition.durationDays must be a number.' }
  if (typeof d.customerFacing !== 'boolean') return { ok: false, error: 'definition.customerFacing must be true or false.' }
  const m = d.metric as Record<string, unknown> | undefined
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, error: 'definition.metric must be an object.' }
  if (!isStr(m.id, 128) || !isStr(m.label, 120)) return { ok: false, error: 'definition.metric needs an id and a label (up to 120 characters).' }
  if (m.unit !== undefined && (typeof m.unit !== 'string' || m.unit.length > 24)) return { ok: false, error: 'definition.metric.unit must be at most 24 characters.' }
  if (m.direction !== 'higher-is-better' && m.direction !== 'lower-is-better') return { ok: false, error: 'definition.metric.direction must be higher-is-better or lower-is-better.' }
  if (!isNum(m.kill) || !isNum(m.hold) || !isNum(m.scale)) return { ok: false, error: 'definition.metric kill, hold and scale must be numbers.' }
  return {
    ok: true,
    definition: {
      id: d.id,
      hypothesis: d.hypothesis.trim(),
      playbookId: d.playbookId,
      metric: { id: m.id, label: m.label.trim(), ...(typeof m.unit === 'string' && m.unit ? { unit: m.unit } : {}), direction: m.direction, kill: m.kill, hold: m.hold, scale: m.scale },
      budgetUsd: d.budgetUsd,
      durationDays: d.durationDays,
      customerFacing: d.customerFacing,
      proposedBy,
    },
  }
}

export function parseMoney(value: unknown): { ok: true; input: MoneyEntryInput; confirm: boolean } | { ok: false; error: string } {
  const b = (value ?? {}) as Record<string, unknown>
  if (!MONEY_KINDS.includes(b.kind as MoneyKind)) return { ok: false, error: `kind must be one of ${MONEY_KINDS.join(', ')}.` }
  const kind = b.kind as MoneyKind
  if (!isNum(b.amountUsd) || b.amountUsd <= 0 || b.amountUsd > 1_000_000) return { ok: false, error: 'amountUsd must be a positive number (at most 1,000,000).' }
  const category = b.category === undefined ? (kind === 'compute' ? 'compute' : kind === 'revenue' ? 'sales' : undefined) : b.category
  if (typeof category !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(category)) return { ok: false, error: 'category must be lowercase letters, digits and "-", up to 40 characters.' }
  if (!isStr(b.description, 500)) return { ok: false, error: 'description must be 1 to 500 characters.' }
  const s = b.source as Record<string, unknown> | undefined
  if (!s || typeof s !== 'object' || !MONEY_SOURCES.includes(s.type as never) || !isStr(s.ref, 200)) return { ok: false, error: `source must be { type, ref }: type one of ${MONEY_SOURCES.join(', ')}, ref 1 to 200 characters.` }
  if (b.experimentId !== undefined && (typeof b.experimentId !== 'string' || !EXP_ID.test(b.experimentId))) return { ok: false, error: 'experimentId is invalid.' }
  if (b.confirm !== undefined && typeof b.confirm !== 'boolean') return { ok: false, error: 'confirm must be true or false.' }
  return {
    ok: true,
    confirm: b.confirm === true,
    input: {
      kind,
      amountUsd: b.amountUsd,
      category,
      description: b.description.trim(),
      source: { type: s.type as MoneyEntryInput['source']['type'], ref: (s.ref as string).trim() },
      ...(typeof b.experimentId === 'string' ? { experimentId: b.experimentId } : {}),
    },
  }
}

// ── Views ─────────────────────────────────────────────────────────────────

function experimentView(e: Experiment, spentUsd: number, now: Date) {
  const active = e.status === 'running' || e.status === 'held'
  const evaluation = active ? evaluateExperiment(e, spentUsd, now) : null
  const v = evaluation?.verdict
  // Scale always waits for a human; hold waits unless the experiment is already held.
  const awaitingDecision = active && (v === 'scale' || (v === 'hold' && e.status !== 'held'))
  return { ...e, spentUsd, evaluation, awaitingDecision }
}

async function readVaultNames(deps: GenesisApiDeps): Promise<{ names: string[]; note?: string }> {
  if (!deps.vaultNames) return { names: [], note: 'No vault is configured on this host, so payment accounts cannot be checked.' }
  try { return { names: await deps.vaultNames() } } catch (error) {
    return { names: [], note: `The vault could not be read: ${(error as Error).message}` }
  }
}

// ── Routes ────────────────────────────────────────────────────────────────

export async function handleGenesisRoute(ctx: GenesisApiContext, deps: GenesisApiDeps): Promise<Response | undefined> {
  const { method, parts, principal, access, tenantId } = ctx
  if (parts[1] !== 'genesis') return undefined
  const { config, store } = deps
  const can = (p: Permission) => access.authorize(principal, p, { tenantId, kind: 'genesis', id: config.runId })
  const needAny = (...ps: Permission[]): Response | undefined => {
    const ds = ps.map(can)
    return ds.some((d) => d.allowed) ? undefined : { status: 403, body: { error: ds[0]!.reasons.join(' ') } }
  }
  const humanOnly = (what: string): Response | undefined => {
    const denied = needAny('intent:provide')
    if (denied) return denied
    return principal.kind === 'human' ? undefined : { status: 403, body: { error: `Only a human ${what}.` } }
  }
  const now = () => new Date(deps.now?.() ?? Date.now())
  const actor = { id: principal.id, kind: principal.kind }
  const configErrors = validateGenesisConfig(config)
  const bodyOf = async (): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; res: Response }> => {
    const body = await ctx.readBody()
    return body.ok ? { ok: true, value: (body.value ?? {}) as Record<string, unknown> } : { ok: false, res: { status: body.status, body: { error: body.error } } }
  }
  const brokenLedger = (s: GenesisState): Response | undefined => {
    const v = verifyMoneyLedger(s.ledger)
    return v.valid ? undefined : { status: 409, body: { error: 'The money ledger does not verify; nothing more is recorded until it is reviewed.', reasons: v.errors } }
  }

  // GET /api/genesis
  if (parts.length === 2 && method === 'GET') {
    const denied = needAny('decision:read')
    if (denied) return denied
    const s = await store.load(config)
    const reviews = await store.loadReviews(config.runId)
    const vault = await readVaultNames(deps)
    const totals = moneyTotals(s.ledger)
    const at = now()
    const facts = genesisFacts(config, s.ledger, s.experiments, s.run.startedAt ? new Date(s.run.startedAt) : null, at)
    return {
      status: 200,
      body: {
        runId: config.runId,
        config: {
          playbookId: config.playbookId,
          budgetUsd: config.budgetUsd,
          durationDays: config.durationDays,
          digitalOnly: config.digitalOnly,
          waesRequired: config.waesRequired,
          waesManualReviewAllowed: config.waesManualReviewAllowed === true,
          allowedCategories: config.allowedCategories,
          prohibitedCategories: config.prohibitedCategories,
          spend: config.spend,
          prerequisites: config.prerequisites,
          owner: config.owner,
        },
        run: { startedAt: s.run.startedAt, daysLeft: facts['run.daysLeft'] },
        blockers: genesisBlockers(config, vault.names),
        ...(vault.note ? { vaultNote: vault.note } : {}),
        totals,
        experiments: s.experiments.map((e) => experimentView(e, totals.byExperiment[e.definition.id]?.capitalUsedUsd ?? 0, at)),
        facts,
        ledger: { entries: s.ledger.entries.length, verified: verifyMoneyLedger(s.ledger), recent: s.ledger.entries.slice(-10).reverse() },
        // Manual founder reviews are counted apart from WAES reviews; newest first.
        reviewSummary: reviewSummary(reviews),
        reviews: reviews.slice(-20).reverse(),
        executes: false,
      },
    }
  }

  // GET /api/genesis/pending-payments
  if (parts[2] === 'pending-payments' && !deps.pending) return { status: 404, body: { error: 'No payment webhook queue is configured on this host.' } }
  if (parts.length === 3 && parts[2] === 'pending-payments' && method === 'GET') {
    const denied = needAny('decision:read')
    if (denied) return denied
    const rows = await deps.pending!.list(config.runId)
    return { status: 200, body: { pending: rows.filter((r) => r.status === 'pending'), decided: rows.filter((r) => r.status !== 'pending').slice(-50).reverse(), autoRecord: config.autoRecordPaymentWebhooks === true, executes: false } }
  }

  if (configErrors.length) return { status: 409, body: { error: 'The run config is invalid; fix it before recording anything.', reasons: configErrors } }

  // POST /api/genesis/pending-payments/:id/(confirm|reject)
  if (parts.length === 5 && parts[2] === 'pending-payments' && (parts[4] === 'confirm' || parts[4] === 'reject') && method === 'POST') {
    const confirming = parts[4] === 'confirm'
    const denied = humanOnly(confirming ? 'confirms a payment into the ledger' : 'rejects a reported payment')
    if (denied) return denied
    const id = parts[3]!
    if (!PENDING_PAYMENT_ID.test(id)) return { status: 404, body: { error: 'Unknown pending payment.' } }
    const body = await bodyOf()
    if (!body.ok) return body.res
    const note = body.value.note
    if (note !== undefined && !isStr(note, 500)) return { status: 422, body: { error: 'note must be 1 to 500 characters.' } }
    const pending = deps.pending!
    return withLock(config.runId, async () => {
      const row = await pending.get(config.runId, id)
      if (!row) return { status: 404, body: { error: `No pending payment "${id}".` } }
      if (row.status !== 'pending') return { status: 409, body: { error: `Payment "${id}" was already ${row.status}.`, payment: row, executed: false } }
      const at = now()
      const decision = { by: principal.id, at: at.toISOString(), ...(typeof note === 'string' ? { note: note.trim() } : {}) }
      try {
        if (!confirming) return { status: 200, body: { payment: await pending.decide(config.runId, id, { status: 'rejected', ...decision }), executed: false } }
        const s = await store.load(config)
        const broken = brokenLedger(s)
        if (broken) return broken
        const already = s.ledger.entries.find((e) => e.source.type === row.input.source.type && e.source.ref === row.input.source.ref)
        if (already) return { status: 409, body: { error: `This payment is already in the ledger (entry ${already.seq}); reject this row instead.`, executed: false } }
        const r = appendMoney(s.ledger, row.input, actor, at)
        if (!r.ok) return { status: 422, body: { error: 'Not recorded.', reasons: r.reasons, executed: false } }
        await store.saveLedger(config.runId, r.ledger)
        const payment = await pending.decide(config.runId, id, { status: 'confirmed', ...decision, ledgerSeq: r.entry.seq })
        return { status: 201, body: { payment, entry: r.entry, totals: moneyTotals(r.ledger), executed: false, note: RECORDS_ONLY } }
      } catch (error) {
        if (error instanceof PendingPaymentError) return { status: error.code === 'not-found' ? 404 : 409, body: { error: error.message, executed: false } }
        throw error
      }
    })
  }

  // POST /api/genesis/experiments
  if (parts.length === 3 && parts[2] === 'experiments' && method === 'POST') {
    const denied = needAny('intent:provide', 'decision:propose')
    if (denied) return denied
    const body = await bodyOf()
    if (!body.ok) return body.res
    const parsed = parseDefinition(body.value.definition, principal.id)
    if (!parsed.ok) return { status: 422, body: { error: parsed.error } }
    const def = parsed.definition
    if (def.playbookId !== config.playbookId) return { status: 422, body: { error: `The experiment belongs to playbook "${def.playbookId}", not "${config.playbookId}".` } }
    const d = draftExperiment(def)
    if (!d.ok) return { status: 422, body: { error: 'The experiment is not valid.', reasons: d.reasons } }
    return withLock(config.runId, async () => {
      const s = await store.load(config)
      if (s.experiments.some((e) => e.definition.id === def.id)) return { status: 409, body: { error: `Experiment "${def.id}" already exists; a changed experiment needs a new id.` } }
      await store.saveExperiments(config.runId, [...s.experiments, d.experiment])
      return { status: 201, body: { experiment: d.experiment, executed: false } }
    })
  }

  // POST /api/genesis/money
  if (parts.length === 3 && parts[2] === 'money' && method === 'POST') {
    const denied = humanOnly('records money')
    if (denied) return denied
    const body = await bodyOf()
    if (!body.ok) return body.res
    const parsed = parseMoney(body.value)
    if (!parsed.ok) return { status: 422, body: { error: parsed.error } }
    const { input, confirm } = parsed
    return withLock(config.runId, async () => {
      const s = await store.load(config)
      const broken = brokenLedger(s)
      if (broken) return broken
      const experiment = input.experimentId ? s.experiments.find((e) => e.definition.id === input.experimentId) : undefined
      if (input.experimentId && !experiment) return { status: 404, body: { error: `No experiment "${input.experimentId}".` } }
      const at = now()
      let decision: ReturnType<typeof decideSpend> | undefined
      if (input.kind === 'spend' || input.kind === 'compute') {
        decision = decideSpend(config, s.ledger, { amountUsd: input.amountUsd, category: input.category, description: input.description, ...(input.experimentId ? { experimentId: input.experimentId } : {}) }, at, experiment)
        if (decision.recommendation === 'reject') return { status: 422, body: { error: 'Not recorded: the rules refuse this spend. If the money already moved outside the rules, stop the run and review it.', reasons: decision.reasons, decision, executed: false } }
        if (decision.recommendation === 'request-approval' && !confirm) return { status: 409, body: { error: 'Not recorded: this needs your decision. Send it again with confirm: true to approve it as yourself.', reasons: decision.reasons, decision, executed: false } }
      }
      const r = appendMoney(s.ledger, {
        ...input,
        ...((input.kind === 'spend' || input.kind === 'compute') && decision
          ? { spendAuthorization: {
              decisionId: `spend-${randomUUID()}`,
              recommendation: decision.recommendation as 'execute-autonomously' | 'request-approval',
              riskLevel: decision.riskLevel,
              reasons: decision.reasons,
              confirmedBy: principal.id,
              confirmedAt: at.toISOString(),
            } }
          : {}),
      }, actor, at)
      if (!r.ok) return { status: 422, body: { error: 'Not recorded.', reasons: r.reasons, executed: false } }
      await store.saveLedger(config.runId, r.ledger)
      return {
        status: 201,
        body: {
          entry: r.entry,
          totals: moneyTotals(r.ledger),
          ...(decision ? { decision, ...(decision.recommendation === 'request-approval' ? { approvedBy: principal.id } : {}) } : {}),
          executed: false,
          note: RECORDS_ONLY,
        },
      }
    })
  }

  // POST /api/genesis/reviews
  if (parts.length === 4 && parts[2] === 'reviews' && parts[3] === 'waes' && method === 'POST') {
    const denied = needAny('intent:provide')
    if (denied) return denied
    if (principal.kind !== 'human') return { status: 403, body: { error: 'Only a human may request a WAES evaluation.' } }
    if (!deps.runWaes) return { status: 503, body: { error: 'WAES evaluation is unavailable; no review was recorded.' } }
    const body = await bodyOf()
    if (!body.ok) return body.res
    const parsed = parseWaesServiceInput(body.value)
    if (!parsed.ok) return { status: 422, body: { error: parsed.error } }
    const input = parsed.input
    return withLock(config.runId, async () => {
      if (input.experimentId) {
        const s = await store.load(config)
        if (!s.experiments.some((e) => e.definition.id === input.experimentId)) return { status: 404, body: { error: `No experiment "${input.experimentId}".` } }
      }
      let assessment: WaesServiceAssessment
      try {
        assessment = await deps.runWaes!(input)
      } catch {
        return { status: 503, body: { error: 'WAES evaluation failed; no review was recorded.' } }
      }
      const created = createWaesServiceReview(input, assessment, now())
      if (!created.ok) return { status: 502, body: { error: 'WAES returned an incomplete or invalid assessment; no review was recorded.', reasons: created.reasons } }
      await store.appendReview(config.runId, created.review)
      return { status: 201, body: { review: created.review, label: 'WAES service evaluation', executed: false, note: 'Review recorded only. Nothing was sent or published. NQC Kernel authorization remains required.' } }
    })
  }

  if (parts.length === 3 && parts[2] === 'reviews' && method === 'POST') {
    const denied = humanOnly('records a manual founder review')
    if (denied) return denied
    const body = await bodyOf()
    if (!body.ok) return body.res
    const parsed = parseContentReviewInput(body.value)
    if (!parsed.ok) return { status: 422, body: { error: parsed.error } }
    const input = parsed.input
    return withLock(config.runId, async () => {
      if (input.experimentId) {
        const s = await store.load(config)
        if (!s.experiments.some((e) => e.definition.id === input.experimentId)) return { status: 404, body: { error: `No experiment "${input.experimentId}".` } }
      }
      const r = createManualReview(input, actor, now())
      if (!r.ok) return { status: 422, body: { error: 'Not recorded.', reasons: r.reasons } }
      await store.appendReview(config.runId, r.review)
      return {
        status: 201,
        body: {
          review: r.review,
          label: MANUAL_REVIEW_LABEL,
          counts: config.waesManualReviewAllowed === true
            ? 'This run accepts manual founder reviews at the WAES gate; the gate records the pass as manual.'
            : 'This run does not accept manual founder reviews at the WAES gate; this record alone will not unlock the text.',
          executed: false,
          note: 'Recorded only. Nothing was sent or published.',
        },
      }
    })
  }

  // /api/genesis/experiments/:id/<action>
  if (parts.length === 5 && parts[2] === 'experiments' && method === 'POST') {
    const id = parts[3]!
    if (!EXP_ID.test(id)) return { status: 422, body: { error: 'Invalid experiment id.' } }
    const action = parts[4]
    if (!['start', 'measurements', 'evaluate', 'decide'].includes(action!)) return { status: 404, body: { error: 'Not found.' } }

    const denied = action === 'start' ? humanOnly('starts an experiment (it commits money)')
      : action === 'decide' ? humanOnly('decides a scale or hold verdict')
      : action === 'measurements' ? needAny('intent:provide', 'decision:propose')
      : needAny('decision:read')
    if (denied) return denied
    const body = await bodyOf()
    if (!body.ok) return body.res
    let value: number | undefined, source: string | undefined, note: string | undefined
    if (action === 'measurements') {
      if (!isNum(body.value.value)) return { status: 422, body: { error: 'value must be a finite number.' } }
      if (!isStr(body.value.source, 300)) return { status: 422, body: { error: 'source must be 1 to 300 characters (where the number came from).' } }
      value = body.value.value
      source = body.value.source
    }
    if (action === 'decide' && body.value.note !== undefined) {
      if (typeof body.value.note !== 'string' || body.value.note.length > 500) return { status: 422, body: { error: 'note must be at most 500 characters.' } }
      note = body.value.note.trim() || undefined
    }

    return withLock(config.runId, async () => {
      const s = await store.load(config)
      const i = s.experiments.findIndex((e) => e.definition.id === id)
      if (i < 0) return { status: 404, body: { error: `No experiment "${id}".` } }
      const exp = s.experiments[i]!
      const at = now()
      const save = async (next: Experiment) => {
        const list = s.experiments.slice()
        list[i] = next
        await store.saveExperiments(config.runId, list)
      }

      if (action === 'start') {
        const vault = await readVaultNames(deps)
        const blockers = genesisBlockers(config, vault.names)
        if (blockers.length) return { status: 409, body: { error: 'The run cannot start experiments yet.', blockers, reasons: blockers } }
        const broken = brokenLedger(s)
        if (broken) return broken
        if (s.run.startedAt && (genesisFacts(config, s.ledger, s.experiments, new Date(s.run.startedAt), at)['run.daysLeft'] as number) <= 0) return { status: 409, body: { error: 'The run has ended.' } }
        const r = startExperiment(exp, actor, at, { remainingBudgetUsd: moneyTotals(s.ledger).remainingUsd })
        if (!r.ok) return { status: 409, body: { error: 'The experiment was not started.', reasons: r.reasons } }
        await save(r.experiment)
        if (!s.run.startedAt) await store.saveRun(config.runId, { startedAt: at.toISOString() })
        return { status: 200, body: { experiment: r.experiment, executed: false } }
      }

      if (action === 'measurements') {
        const r = recordMeasurement(exp, value!, actor, source!, at)
        if (!r.ok) return { status: 409, body: { error: 'The measurement was not recorded.', reasons: r.reasons } }
        await save(r.experiment)
        return { status: 201, body: { experiment: r.experiment, executed: false } }
      }

      // evaluate / decide
      if (exp.status !== 'running' && exp.status !== 'held') return { status: 409, body: { error: `The experiment is ${exp.status}; there is nothing to evaluate.` } }
      const spent = moneyTotals(s.ledger).byExperiment[id]?.capitalUsedUsd ?? 0
      const evaluation = evaluateExperiment(exp, spent, at)
      if (evaluation.verdict === 'no-data') return { status: action === 'decide' ? 409 : 200, body: { evaluation, applied: null, awaitingDecision: false, ...(action === 'decide' ? { error: 'Nothing to decide yet.' } : {}), executed: false } }
      if (action === 'evaluate' && (evaluation.verdict === 'scale' || evaluation.verdict === 'hold')) {
        return { status: 200, body: { evaluation, applied: null, awaitingDecision: !(evaluation.verdict === 'hold' && exp.status === 'held'), experiment: exp, executed: false } }
      }
      const r = action === 'decide'
        ? applyEvaluation(exp, evaluation, actor, at, note)
        : applyEvaluation(exp, evaluation, KERNEL, at, `Evaluated at the request of ${principal.id}.`)
      if (!r.ok) return { status: 409, body: { error: 'The verdict was not applied.', reasons: r.reasons } }
      await save(r.experiment)
      return { status: 200, body: { evaluation, applied: r.experiment.status, appliedBy: action === 'decide' ? principal.id : KERNEL.id, awaitingDecision: false, experiment: r.experiment, executed: false } }
    })
  }

  return { status: 404, body: { error: 'Not found.' } }
}
