import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { authorize, type EvidenceRef, type PolicyRef, type RiskLevel } from '@quicksilver/kernel'
import type { AccessController, Permission, Principal } from '@quicksilver/kernel/identity'
import { judge, recommend, recordOutcome, shadowFacts, shadowReport, type Outcome, type ShadowLog, type Verdict } from '@quicksilver/kernel/playbooks/shadow'
import { learnFromVerdict, newVerdictLearner, predictAccept, predictionAgreement, type IntentGraph, type IntentGraphStore, type LearnerState } from '@quicksilver/aura'

/**
 * Shadow mode on the host (M4 pilot).
 *
 *   GET  /api/shadow/:intentId                                   decision:read
 *   POST /api/shadow/:intentId/recommendations   { proposal }    intent:provide or decision:propose
 *   POST /api/shadow/:intentId/generate          { departments?, max? }   intent:provide or decision:propose
 *   POST /api/shadow/:intentId/recommendations/:recId/verdict  { value, note? }   intent:provide, humans only
 *   POST /api/shadow/:intentId/recommendations/:recId/outcome  { value, note? }   intent:provide, humans only
 *
 * Nothing here executes. Every recommendation is evaluated by the kernel as
 * if the department had been handed over, so the log shows what Quicksilver
 * WOULD have done. Aura predicts the owner's verdict before it is given; the
 * verdict then trains Aura's learner, kept in its own record next to the log.
 * Hand-over stays the provider's own entry in the intent ledger.
 */

export interface ShadowProposal {
  department: string
  description: string
  reversible: boolean
  /** 0–5 */
  operationalImpact: number
  /** 0–5 */
  uncertainty: number
  financialExposure?: number
  customerFacing?: boolean
  evidence: Array<{ id: string; title: string; confidence: number }>
  features?: Record<string, number>
}

export interface ShadowGeneratorContext {
  intentId: string
  graph: IntentGraph
  departments: string[]
  max: number
  signal?: AbortSignal
}

/** The shadow-stage agent: reads the business's intent graph and proposes actions. It can only propose. */
export type ShadowGenerator = (ctx: ShadowGeneratorContext) => Promise<ShadowProposal[]>

export interface ShadowStore {
  load(intentId: string): Promise<{ log: ShadowLog; learner: LearnerState | null }>
  save(intentId: string, log: ShadowLog, learner: LearnerState | null): Promise<void>
}

export interface ShadowApiDeps {
  store: ShadowStore
  graphs: IntentGraphStore
  generator?: ShadowGenerator
  /** Policies the kernel applies to shadow recommendations (live policies in production). */
  policies?: PolicyRef[]
  /** Base risk of a handed-over department's capability (default 1). */
  baseRiskLevel?: RiskLevel
  now?: () => number
}

export interface ShadowApiContext {
  method: string
  parts: string[]
  principal: Principal
  tenantId: string
  access: AccessController
  readBody: () => Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }>
}

type Response = { status: number; body: unknown }

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const DEPT = /^[a-z][a-z0-9-]{0,39}$/
const VERDICTS: readonly Verdict[] = ['accepted', 'modified', 'rejected']
const OUTCOMES: readonly Outcome[] = ['good', 'neutral', 'bad']

// ── Stores ────────────────────────────────────────────────────────────────

/** Files at <dir>/<intentId>/shadow.json and learner.json: the same place `npm run onboard` uses. */
export class FileShadowStore implements ShadowStore {
  private readonly dir: string
  constructor(dir: string) { this.dir = dir }
  private path(intentId: string, file: string) {
    if (!ID.test(intentId)) throw new Error('Invalid intent id.')
    return join(this.dir, intentId, file)
  }
  async load(intentId: string) {
    const read = async <T>(file: string, fallback: T): Promise<T> => {
      try { return JSON.parse(await readFile(this.path(intentId, file), 'utf8')) as T } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback
        throw e
      }
    }
    return { log: await read<ShadowLog>('shadow.json', { recommendations: [] }), learner: await read<LearnerState | null>('learner.json', null) }
  }
  async save(intentId: string, log: ShadowLog, learner: LearnerState | null) {
    await mkdir(join(this.dir, intentId), { recursive: true })
    const write = async (file: string, value: unknown) => {
      const target = this.path(intentId, file)
      await writeFile(`${target}.tmp`, JSON.stringify(value, null, 1), { mode: 0o600 })
      await rename(`${target}.tmp`, target)
    }
    await write('shadow.json', log)
    if (learner) await write('learner.json', learner)
  }
}

export class MemoryShadowStore implements ShadowStore {
  private readonly data = new Map<string, { log: ShadowLog; learner: LearnerState | null }>()
  async load(intentId: string) {
    const d = this.data.get(intentId)
    return d ? structuredClone(d) : { log: { recommendations: [] }, learner: null }
  }
  async save(intentId: string, log: ShadowLog, learner: LearnerState | null) {
    this.data.set(intentId, structuredClone({ log, learner }))
  }
}

// One write at a time per intent, so concurrent verdicts cannot lose each other.
const locks = new Map<string, Promise<unknown>>()
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  locks.set(key, next.catch(() => undefined))
  return next
}

// ── Kernel verdict ────────────────────────────────────────────────────────

const clampRisk = (n: number): RiskLevel => Math.max(0, Math.min(5, Math.round(Number.isFinite(n) ? n : 5))) as RiskLevel

/** What the kernel would have done if this department had been handed over. */
export function kernelVerdict(proposal: ShadowProposal, deps: Pick<ShadowApiDeps, 'policies' | 'baseRiskLevel'>) {
  const actorId = `shadow:${proposal.department}`
  const capabilityId = `dept.${proposal.department}`
  const evidence: EvidenceRef[] = proposal.evidence.map((e) => ({ id: e.id, title: e.title, confidence: Math.max(0, Math.min(1, e.confidence)) }))
  const result = authorize({
    action: {
      description: proposal.description,
      actorId,
      capabilityId,
      applicablePolicyIds: [],
      evidenceIds: evidence.map((e) => e.id),
      ...(typeof proposal.financialExposure === 'number' ? { financialExposure: proposal.financialExposure } : {}),
      reversible: proposal.reversible,
      operationalImpact: clampRisk(proposal.operationalImpact),
      uncertainty: clampRisk(proposal.uncertainty),
      ...(proposal.customerFacing ? { customerFacing: true } : {}),
    },
    actor: { id: actorId, name: `${proposal.department} (shadow)`, entityType: 'agent', capabilityIds: [capabilityId] },
    capabilities: [{ id: capabilityId, name: `Run ${proposal.department}`, baseRiskLevel: deps.baseRiskLevel ?? 1, authorizedEntityIds: [actorId], policyScopes: ['operations', proposal.department] }],
    policies: deps.policies ?? [],
    evidence,
    // No WAES review exists at the shadow stage, so a customer-facing proposal shows what the gate would do: block.
    facts: { 'action.customerFacing': proposal.customerFacing === true },
  })
  return { recommendation: result.recommendation, riskLevel: result.riskLevel, reasons: [...result.blockingReasons, ...result.concerns] }
}

export function validateProposal(value: unknown): { ok: true; proposal: ShadowProposal } | { ok: false; error: string } {
  const p = (value ?? {}) as Record<string, unknown>
  if (typeof p.department !== 'string' || !DEPT.test(p.department)) return { ok: false, error: 'department must be lowercase letters, digits and "-", up to 40 characters.' }
  if (typeof p.description !== 'string' || !p.description.trim() || p.description.length > 1_000) return { ok: false, error: 'description must be 1 to 1,000 characters.' }
  if (typeof p.reversible !== 'boolean') return { ok: false, error: 'reversible must be true or false.' }
  for (const k of ['operationalImpact', 'uncertainty'] as const) if (typeof p[k] !== 'number' || p[k] < 0 || p[k] > 5) return { ok: false, error: `${k} must be a number from 0 to 5.` }
  if (p.financialExposure !== undefined && (typeof p.financialExposure !== 'number' || p.financialExposure < 0)) return { ok: false, error: 'financialExposure must be a non-negative number.' }
  if (p.customerFacing !== undefined && typeof p.customerFacing !== 'boolean') return { ok: false, error: 'customerFacing must be true or false.' }
  if (!Array.isArray(p.evidence) || p.evidence.length > 20) return { ok: false, error: 'evidence must be a list of up to 20 items.' }
  for (const e of p.evidence as Array<Record<string, unknown>>) {
    if (typeof e?.id !== 'string' || typeof e.title !== 'string' || typeof e.confidence !== 'number') return { ok: false, error: 'Each evidence item needs id, title and confidence (0–1).' }
  }
  if (p.features !== undefined) {
    if (typeof p.features !== 'object' || p.features === null) return { ok: false, error: 'features must be an object of numbers.' }
    const entries = Object.entries(p.features as Record<string, unknown>)
    if (entries.length > 20 || entries.some(([k, v]) => !/^[a-z][a-zA-Z0-9._-]{0,63}$/.test(k) || typeof v !== 'number' || !Number.isFinite(v))) return { ok: false, error: 'features must be up to 20 named finite numbers.' }
  }
  return { ok: true, proposal: { ...(p as unknown as ShadowProposal), description: (p.description as string).trim() } }
}

// ── Routes ────────────────────────────────────────────────────────────────

export async function handleShadowRoute(ctx: ShadowApiContext, deps: ShadowApiDeps): Promise<Response | undefined> {
  const { method, parts, principal, access, tenantId } = ctx
  if (parts[1] !== 'shadow' || parts.length < 3) return undefined
  const intentId = parts[2]!
  if (!ID.test(intentId)) return { status: 422, body: { error: 'Invalid intent id.' } }
  const can = (p: Permission) => access.authorize(principal, p, { tenantId, kind: 'shadow' })
  const needAny = (...ps: Permission[]): Response | undefined => {
    const ds = ps.map(can)
    return ds.some((d) => d.allowed) ? undefined : { status: 403, body: { error: ds[0]!.reasons.join(' ') } }
  }
  const now = () => new Date(deps.now?.() ?? Date.now())
  const graph = await deps.graphs.get(intentId).catch(() => undefined)
  if (!graph) return { status: 404, body: { error: 'No such intent.' } }

  if (parts.length === 3 && method === 'GET') {
    const denied = needAny('decision:read')
    if (denied) return denied
    const { log, learner } = await deps.store.load(intentId)
    return {
      status: 200,
      body: {
        intentId,
        recommendations: log.recommendations,
        departments: shadowReport(log),
        facts: shadowFacts(log),
        aura: {
          predictions: predictionAgreement(log),
          learner: learner ? { observations: learner.observations, weights: learner.weights, provenance: 'AGENT_INFERRED' } : null,
        },
      },
    }
  }

  const add = async (proposals: ShadowProposal[], source: 'human' | 'agent') => withLock(intentId, async () => {
    const { log: start, learner } = await deps.store.load(intentId)
    const state = learner ?? newVerdictLearner()
    let log = start
    const added: string[] = []
    for (const proposal of proposals) {
      const kernel = kernelVerdict(proposal, deps)
      const draft = { department: proposal.department, kernel: { recommendation: kernel.recommendation, riskLevel: kernel.riskLevel }, ...(proposal.features ? { features: proposal.features } : {}) }
      const id = `rec-${log.recommendations.length + 1}`
      const r = recommend(log, {
        id,
        department: proposal.department,
        description: proposal.description,
        proposedAt: now().toISOString(),
        kernel: draft.kernel,
        source,
        ...(proposal.features ? { features: proposal.features } : {}),
        prediction: predictAccept(state, draft),
      })
      if (!r.ok) return { status: 422, body: { error: r.reason } }
      log = r.log
      added.push(id)
    }
    await deps.store.save(intentId, log, learner)
    return { status: 201, body: { added, recommendations: log.recommendations.filter((r) => added.includes(r.id)), executed: false } }
  })

  if (parts.length === 4 && parts[3] === 'recommendations' && method === 'POST') {
    const denied = needAny('intent:provide', 'decision:propose')
    if (denied) return denied
    const body = await ctx.readBody()
    if (!body.ok) return { status: body.status, body: { error: body.error } }
    const v = validateProposal((body.value as { proposal?: unknown } | null)?.proposal)
    if (!v.ok) return { status: 422, body: { error: v.error } }
    return add([v.proposal], principal.kind === 'human' ? 'human' : 'agent')
  }

  if (parts.length === 4 && parts[3] === 'generate' && method === 'POST') {
    const denied = needAny('intent:provide', 'decision:propose')
    if (denied) return denied
    if (!deps.generator) return { status: 501, body: { error: 'No shadow-stage agent is configured on this host (it needs a model provider).' } }
    const body = await ctx.readBody()
    if (!body.ok) return { status: body.status, body: { error: body.error } }
    const { departments, max } = (body.value ?? {}) as { departments?: unknown; max?: unknown }
    const depts = Array.isArray(departments) ? departments.filter((d): d is string => typeof d === 'string' && DEPT.test(d)).slice(0, 10) : ['finance', 'operations', 'sales']
    if (!depts.length) return { status: 422, body: { error: 'departments must name at least one department.' } }
    const limit = typeof max === 'number' && max >= 1 ? Math.min(10, Math.floor(max)) : 5
    let proposals: ShadowProposal[]
    try {
      proposals = await deps.generator({ intentId, graph, departments: depts, max: limit })
    } catch (error) {
      return { status: 502, body: { error: `The shadow-stage agent failed: ${(error as Error).message}` } }
    }
    const valid: ShadowProposal[] = []
    const refused: string[] = []
    for (const p of proposals.slice(0, limit)) {
      const v = validateProposal(p)
      if (v.ok && depts.includes(v.proposal.department)) valid.push(v.proposal)
      else refused.push(v.ok ? `Department "${v.proposal.department}" was not requested.` : v.error)
    }
    if (!valid.length) return { status: 200, body: { added: [], refused, executed: false } }
    const res = await add(valid, 'agent')
    return refused.length ? { ...res, body: { ...(res.body as object), refused } } : res
  }

  if (parts.length === 6 && parts[3] === 'recommendations' && (parts[5] === 'verdict' || parts[5] === 'outcome') && method === 'POST') {
    const denied = needAny('intent:provide')
    if (denied) return denied
    const body = await ctx.readBody()
    if (!body.ok) return { status: body.status, body: { error: body.error } }
    const { value, note } = (body.value ?? {}) as { value?: unknown; note?: unknown }
    if (note !== undefined && (typeof note !== 'string' || note.length > 500)) return { status: 422, body: { error: 'note must be at most 500 characters.' } }
    const recId = parts[4]!
    const actor = { id: principal.id, kind: principal.kind === 'human' ? 'human' as const : principal.kind === 'agent' ? 'agent' as const : 'service' as const }
    return withLock(intentId, async () => {
      const { log, learner } = await deps.store.load(intentId)
      if (parts[5] === 'verdict') {
        if (!VERDICTS.includes(value as Verdict)) return { status: 422, body: { error: `value must be one of ${VERDICTS.join(', ')}.` } }
        const r = judge(log, recId, actor, value as Verdict, now(), note as string | undefined)
        if (!r.ok) return { status: actor.kind === 'human' ? 422 : 403, body: { error: r.reason } }
        const rec = r.log.recommendations.find((x) => x.id === recId)!
        const nextLearner = learnFromVerdict(learner ?? newVerdictLearner(), rec, value as Verdict)
        await deps.store.save(intentId, r.log, nextLearner)
        return { status: 200, body: { recommendation: rec, predicted: rec.prediction ?? null, aura: { observations: nextLearner.observations } } }
      }
      if (!OUTCOMES.includes(value as Outcome)) return { status: 422, body: { error: `value must be one of ${OUTCOMES.join(', ')}.` } }
      const r = recordOutcome(log, recId, actor, value as Outcome, now(), note as string | undefined)
      if (!r.ok) return { status: actor.kind === 'human' ? 422 : 403, body: { error: r.reason } }
      await deps.store.save(intentId, r.log, learner)
      return { status: 200, body: { recommendation: r.log.recommendations.find((x) => x.id === recId) } }
    })
  }

  return { status: 404, body: { error: 'Not found.' } }
}
