import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
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
 *
 * Nothing here moves money or executes an action. The money route RECORDS
 * money that has already moved, after the kernel's spend rules; every
 * response carries `executed: false`. Data uses the same layout as the CLI
 * (<dir>/<runId>/ledger.json, experiments.json, run.json), so both see it.
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
}

export interface GenesisApiDeps {
  config: GenesisRunConfig
  store: GenesisStore
  /** Names of active vault secrets (never values). The host supplies its own vault's names when this is absent. */
  vaultNames?: () => Promise<string[]>
  now?: () => number
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

/** Files at <dir>/<runId>/{ledger,experiments,run}.json: the layout `npm run genesis` uses. */
export class FileGenesisStore implements GenesisStore {
  private readonly dir: string
  constructor(dir: string) { this.dir = dir }
  private path(runId: string, file: string) {
    if (!RUN_ID.test(runId)) throw new Error('Invalid run id.')
    return join(this.dir, runId, file)
  }
  private async read<T>(runId: string, file: string, fallback: T): Promise<T> {
    try { return JSON.parse(await readFile(this.path(runId, file), 'utf8')) as T } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback
      throw e
    }
  }
  private async write(runId: string, file: string, value: unknown) {
    const target = this.path(runId, file)
    await mkdir(join(this.dir, runId), { recursive: true })
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
}

export class MemoryGenesisStore implements GenesisStore {
  private readonly data = new Map<string, Partial<GenesisState>>()
  async load(c: GenesisRunConfig) { return structuredClone({ ...emptyState(c), ...this.data.get(c.runId) }) }
  private put(runId: string, patch: Partial<GenesisState>) { this.data.set(runId, structuredClone({ ...this.data.get(runId), ...patch })) }
  async saveLedger(runId: string, ledger: MoneyLedger) { this.put(runId, { ledger }) }
  async saveExperiments(runId: string, experiments: Experiment[]) { this.put(runId, { experiments }) }
  async saveRun(runId: string, run: GenesisRunState) { this.put(runId, { run }) }
}

// One write at a time per run, so concurrent requests cannot lose each other's entries.
const locks = new Map<string, Promise<unknown>>()
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
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
        executes: false,
      },
    }
  }

  if (configErrors.length) return { status: 409, body: { error: 'The run config is invalid; fix it before recording anything.', reasons: configErrors } }

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
      const r = appendMoney(s.ledger, input, actor, at)
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
