import { createHash } from 'node:crypto'

import type { RiskLevel } from '../types.ts'
import { judgeMetric, type MetricVerdict, type PlaybookMetric } from './playbook.ts'

/**
 * Economic primitives for Genesis (M5): experiments, the money ledger and the
 * small-budget spend risk scale.
 *
 * Rules enforced here:
 *   - An experiment's hypothesis, metric thresholds, budget and duration are
 *     fixed when a human starts it. Its digest is pinned; a changed
 *     definition is a new experiment, never a silent edit.
 *   - The kill verdict applies on its own (stopping never needs permission).
 *     Scale needs a human, because it spends more.
 *   - Every dollar is in a hash-chained ledger with a source. Compute (model
 *     and hosting usage) is costed as capital, the same as any other spend.
 *   - Spend risk is measured against what is left of the budget, so the same
 *     $20 is low risk early in a $500 run and high risk near its end.
 */

type Actor = { id: string; kind: 'human' | 'agent' | 'service' }

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const o = value as Record<string, unknown>
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
}
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
const cents = (n: number) => Math.round(n * 100) / 100

// ── Experiments ───────────────────────────────────────────────────────────

export interface ExperimentDefinition {
  id: string
  /** What we believe and how we'd know: "If X, then metric Y reaches Z within N days." */
  hypothesis: string
  playbookId: string
  metric: PlaybookMetric
  budgetUsd: number
  durationDays: number
  customerFacing: boolean
  proposedBy: string
}

export type ExperimentStatus = 'draft' | 'running' | 'killed' | 'held' | 'scaled' | 'completed'

export interface Experiment {
  definition: ExperimentDefinition
  digest: string
  status: ExperimentStatus
  startedAt?: string
  startedBy?: string
  endsAt?: string
  measurements: Array<{ at: string; value: number; by: string; source: string }>
  decisions: Array<{ at: string; verdict: MetricVerdict | 'expired' | 'over-budget'; applied: ExperimentStatus; by: string; note?: string }>
}

export function validateExperiment(def: ExperimentDefinition): string[] {
  const errors: string[] = []
  if (!ID.test(def.id ?? '')) errors.push('id is invalid.')
  if (!def.hypothesis?.trim() || def.hypothesis.length > 1_000) errors.push('hypothesis must be 1 to 1,000 characters.')
  if (!ID.test(def.playbookId ?? '')) errors.push('playbookId is invalid.')
  if (!(def.budgetUsd > 0)) errors.push('budgetUsd must be more than zero.')
  if (!Number.isInteger(def.durationDays) || def.durationDays < 1 || def.durationDays > 90) errors.push('durationDays must be a whole number from 1 to 90.')
  if (typeof def.customerFacing !== 'boolean') errors.push('customerFacing must be true or false.')
  const m = def.metric
  if (!m || !ID.test(m.id ?? '')) errors.push('metric.id is invalid.')
  else if (![m.kill, m.hold, m.scale].every(Number.isFinite)) errors.push('metric thresholds must be numbers.')
  else if (m.direction === 'higher-is-better' ? !(m.kill < m.hold && m.hold <= m.scale) : !(m.kill > m.hold && m.hold >= m.scale)) errors.push(`metric thresholds are out of order for ${m.direction}.`)
  return errors
}

export function experimentDigest(def: ExperimentDefinition): string {
  return sha256(canonical(def))
}

export function draftExperiment(def: ExperimentDefinition): { ok: true; experiment: Experiment } | { ok: false; reasons: string[] } {
  const errors = validateExperiment(def)
  if (errors.length) return { ok: false, reasons: errors }
  return { ok: true, experiment: { definition: def, digest: experimentDigest(def), status: 'draft', measurements: [], decisions: [] } }
}

type ExpResult = { ok: true; experiment: Experiment } | { ok: false; reasons: string[] }

/** A human starts the experiment; from here its thresholds, budget and duration are fixed. */
export function startExperiment(exp: Experiment, actor: Actor, now: Date, options: { remainingBudgetUsd: number }): ExpResult {
  const reasons: string[] = []
  if (actor.kind !== 'human') reasons.push('Only a human starts an experiment (it commits money).')
  if (exp.status !== 'draft') reasons.push(`Only a draft experiment can start (this one is ${exp.status}).`)
  if (experimentDigest(exp.definition) !== exp.digest) reasons.push('The experiment changed after it was drafted; draft it again.')
  if (exp.definition.budgetUsd > options.remainingBudgetUsd) reasons.push(`Its budget ($${exp.definition.budgetUsd}) is more than what is left ($${cents(options.remainingBudgetUsd)}).`)
  if (reasons.length) return { ok: false, reasons }
  const endsAt = new Date(now.getTime() + exp.definition.durationDays * 86_400_000)
  return { ok: true, experiment: { ...exp, status: 'running', startedAt: now.toISOString(), startedBy: actor.id, endsAt: endsAt.toISOString() } }
}

export function recordMeasurement(exp: Experiment, value: number, actor: Actor, source: string, now: Date): ExpResult {
  if (exp.status !== 'running' && exp.status !== 'held') return { ok: false, reasons: ['Only a running or held experiment takes measurements.'] }
  if (!Number.isFinite(value)) return { ok: false, reasons: ['The value must be a number.'] }
  if (!source?.trim()) return { ok: false, reasons: ['Every measurement names its source.'] }
  if (experimentDigest(exp.definition) !== exp.digest) return { ok: false, reasons: ['The experiment definition differs from the one that started.'] }
  return { ok: true, experiment: { ...exp, measurements: [...exp.measurements, { at: now.toISOString(), value, by: actor.id, source: source.trim() }] } }
}

export interface ExperimentEvaluation {
  verdict: MetricVerdict | 'expired' | 'over-budget' | 'no-data'
  latest: number | null
  spentUsd: number
  explanation: string
}

/** Compare the latest measurement with the thresholds fixed at start, and check spend and time. */
export function evaluateExperiment(exp: Experiment, spentUsd: number, now: Date): ExperimentEvaluation {
  const latest = exp.measurements.at(-1)?.value ?? null
  if (spentUsd > exp.definition.budgetUsd) return { verdict: 'over-budget', latest, spentUsd, explanation: `Spent $${cents(spentUsd)} of a $${exp.definition.budgetUsd} budget.` }
  const expired = exp.endsAt !== undefined && now.getTime() >= new Date(exp.endsAt).getTime()
  if (latest === null) return expired ? { verdict: 'expired', latest, spentUsd, explanation: 'The experiment ended without a measurement.' } : { verdict: 'no-data', latest, spentUsd, explanation: 'No measurement yet.' }
  const verdict = judgeMetric(exp.definition.metric, latest)
  const m = exp.definition.metric
  const explanation = `${m.label}: ${latest}${m.unit ? ` ${m.unit}` : ''} against kill ${m.kill}, hold ${m.hold}, scale ${m.scale} (${m.direction}).`
  if (expired && verdict !== 'scale') return { verdict: 'expired', latest, spentUsd, explanation: `${explanation} Time is up.` }
  return { verdict, latest, spentUsd, explanation }
}

/**
 * Apply an evaluation. Kill, expiry and over-budget stop the experiment for
 * any actor (including the kernel). Scale needs a human. Hold pauses spend.
 */
export function applyEvaluation(exp: Experiment, evaluation: ExperimentEvaluation, actor: Actor, now: Date, note?: string): ExpResult {
  if (exp.status !== 'running' && exp.status !== 'held') return { ok: false, reasons: [`The experiment is already ${exp.status}.`] }
  const v = evaluation.verdict
  if (v === 'no-data') return { ok: false, reasons: ['Nothing to decide yet.'] }
  let applied: ExperimentStatus
  if (v === 'kill' || v === 'over-budget') applied = 'killed'
  else if (v === 'expired') applied = 'completed'
  else if (v === 'hold') applied = 'held'
  else if (v === 'continue') applied = 'running'
  else {
    if (actor.kind !== 'human') return { ok: false, reasons: ['Scaling spends more: a human decides it.'] }
    applied = 'scaled'
  }
  return { ok: true, experiment: { ...exp, status: applied, decisions: [...exp.decisions, { at: now.toISOString(), verdict: v, applied, by: actor.id, ...(note ? { note } : {}) }] } }
}

// ── Money ledger ──────────────────────────────────────────────────────────

export const MONEY_KINDS = ['spend', 'compute', 'revenue', 'refund'] as const
export type MoneyKind = (typeof MONEY_KINDS)[number]
export const MONEY_SOURCES = ['receipt', 'invoice', 'provider-usage', 'payment-processor', 'bank', 'manual'] as const

export interface MoneyEntryInput {
  kind: MoneyKind
  /** Positive USD. A refund reduces capital used; revenue is money in. */
  amountUsd: number
  category: string
  description: string
  experimentId?: string
  source: { type: (typeof MONEY_SOURCES)[number]; ref: string }
  /** When the money moved (defaults to the recording time). */
  occurredAt?: string
}

export interface MoneyEntry extends MoneyEntryInput {
  seq: number
  recordedAt: string
  recordedBy: string
  prevHash: string
  hash: string
}

export interface MoneyLedger {
  runId: string
  budgetUsd: number
  entries: MoneyEntry[]
}

const GENESIS_HASH = '0'.repeat(64)

function entryHash(e: Omit<MoneyEntry, 'hash'>): string {
  return sha256(canonical(e))
}

export function appendMoney(ledger: MoneyLedger, input: MoneyEntryInput, actor: Actor, now: Date): { ok: true; ledger: MoneyLedger; entry: MoneyEntry } | { ok: false; reasons: string[] } {
  const reasons: string[] = []
  if (!MONEY_KINDS.includes(input.kind)) reasons.push(`kind must be one of ${MONEY_KINDS.join(', ')}.`)
  if (!(input.amountUsd > 0) || input.amountUsd > 1_000_000) reasons.push('amountUsd must be a positive number.')
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(input.category ?? '')) reasons.push('category must be lowercase letters, digits and "-".')
  if (!input.description?.trim() || input.description.length > 500) reasons.push('description must be 1 to 500 characters.')
  if (!MONEY_SOURCES.includes(input.source?.type as never) || !input.source?.ref?.trim()) reasons.push('Every entry names its source (type and reference).')
  if (input.experimentId !== undefined && !ID.test(input.experimentId)) reasons.push('experimentId is invalid.')
  if (input.kind === 'revenue' && input.source?.type === 'manual' && actor.kind !== 'human') reasons.push('Only a human records revenue by hand.')
  const v = verifyMoneyLedger(ledger)
  if (!v.valid) reasons.push(`The ledger does not verify: ${v.errors.join(' ')}`)
  if (reasons.length) return { ok: false, reasons }
  const prev = ledger.entries.at(-1)
  const base: Omit<MoneyEntry, 'hash'> = {
    ...input,
    amountUsd: cents(input.amountUsd),
    description: input.description.trim(),
    occurredAt: input.occurredAt ?? now.toISOString(),
    seq: (prev?.seq ?? 0) + 1,
    recordedAt: now.toISOString(),
    recordedBy: actor.id,
    prevHash: prev?.hash ?? GENESIS_HASH,
  }
  const entry: MoneyEntry = { ...base, hash: entryHash(base) }
  return { ok: true, ledger: { ...ledger, entries: [...ledger.entries, entry] }, entry }
}

export function verifyMoneyLedger(ledger: MoneyLedger): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  let prevHash = GENESIS_HASH
  ledger.entries.forEach((e, i) => {
    const { hash, ...rest } = e
    if (e.seq !== i + 1) errors.push(`Entry ${i + 1} has sequence ${e.seq}.`)
    if (e.prevHash !== prevHash) errors.push(`Entry ${e.seq} does not follow the previous entry.`)
    if (entryHash(rest) !== hash) errors.push(`Entry ${e.seq} was altered.`)
    prevHash = hash
  })
  return { valid: errors.length === 0, errors }
}

export interface MoneyTotals {
  budgetUsd: number
  spendUsd: number
  computeUsd: number
  refundsUsd: number
  revenueUsd: number
  /** spend + compute − refunds: compute is capital, like any other spend. */
  capitalUsedUsd: number
  remainingUsd: number
  netUsd: number
  /** revenue ÷ capital used (null before any capital is used). */
  returnOnCapital: number | null
  byExperiment: Record<string, { capitalUsedUsd: number; revenueUsd: number }>
}

export function moneyTotals(ledger: MoneyLedger): MoneyTotals {
  const sum = (k: MoneyKind, list = ledger.entries) => list.filter((e) => e.kind === k).reduce((s, e) => s + e.amountUsd, 0)
  const capital = (list: MoneyEntry[]) => sum('spend', list) + sum('compute', list) - sum('refund', list)
  const byExperiment: MoneyTotals['byExperiment'] = {}
  for (const id of new Set(ledger.entries.map((e) => e.experimentId).filter((x): x is string => !!x))) {
    const list = ledger.entries.filter((e) => e.experimentId === id)
    byExperiment[id] = { capitalUsedUsd: cents(capital(list)), revenueUsd: cents(sum('revenue', list)) }
  }
  const capitalUsed = capital(ledger.entries)
  const revenue = sum('revenue')
  return {
    budgetUsd: ledger.budgetUsd,
    spendUsd: cents(sum('spend')),
    computeUsd: cents(sum('compute')),
    refundsUsd: cents(sum('refund')),
    revenueUsd: cents(revenue),
    capitalUsedUsd: cents(capitalUsed),
    remainingUsd: cents(ledger.budgetUsd - capitalUsed),
    netUsd: cents(revenue - capitalUsed),
    returnOnCapital: capitalUsed > 0 ? Math.round((revenue / capitalUsed) * 1000) / 1000 : null,
    byExperiment,
  }
}

// ── Spend risk (small budgets) ────────────────────────────────────────────

/**
 * Risk of one spend, from its share of the REMAINING budget:
 *   0 → 0 · ≤ 2% → 1 · ≤ 5% → 2 · ≤ 10% → 3 · ≤ 25% → 4 · more, or beyond what is left → 5
 */
export function spendRiskLevel(amountUsd: number, remainingUsd: number): RiskLevel {
  if (!(amountUsd > 0)) return 0
  if (!(remainingUsd > 0) || amountUsd > remainingUsd) return 5
  const share = amountUsd / remainingUsd
  if (share <= 0.02) return 1
  if (share <= 0.05) return 2
  if (share <= 0.1) return 3
  if (share <= 0.25) return 4
  return 5
}

/** Facts for `authorize()` about a proposed spend. */
export function spendFacts(amountUsd: number, totals: MoneyTotals): Record<string, number | boolean> {
  return {
    'spend.amountUsd': cents(amountUsd),
    'spend.riskLevel': spendRiskLevel(amountUsd, totals.remainingUsd),
    'spend.withinBudget': amountUsd <= totals.remainingUsd,
    'budget.remainingUsd': totals.remainingUsd,
    'budget.capitalUsedUsd': totals.capitalUsedUsd,
  }
}
