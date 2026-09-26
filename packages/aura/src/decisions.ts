import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { ShadowLog, Verdict } from '@quicksilver/kernel/playbooks/shadow'

import { learn, newLearner, probabilities, type ChoiceOption, type Features } from './learn.ts'

/**
 * Decision journal: real decisions the provider made, in Quicksilver or
 * outside it, kept so Aura can learn from them.
 *
 * Aura learns best from many real decisions in their real context. Every
 * logged decision is reusable in two ways:
 *   - as a worked example for in-context learning (`decisionsAsExamples`,
 *     the same text style as the choice-eval `--examples` arm);
 *   - as test data, scored predict-then-learn (`prequentialOnDecisions`),
 *     so the pilot has an honest running accuracy number.
 *
 * Judged shadow recommendations are decisions too (`verdictsAsDecisions`):
 * accept, modify or reject the recommendation.
 *
 * Governance: only a human logs a decision (the host also requires
 * intent:provide). The journal is append-only: an entry is never edited or
 * removed. A decision is what the provider did, not intent: it never writes
 * to the intent ledger and grants nothing.
 */

export type DecisionSource = 'journal' | 'shadow' | 'scenario'
export const DECISION_SOURCES: readonly DecisionSource[] = ['journal', 'shadow', 'scenario']

export interface DecisionOption {
  id: string
  text: string
}

export interface Decision {
  id: string
  at: string
  /** Who made (and logged) the decision. */
  by: string
  situation: string
  options: DecisionOption[]
  /** The id of the option chosen. */
  chosen: string
  note?: string
  /** A free tag, e.g. "pricing" or "hiring". */
  category?: string
  source: DecisionSource
}

export interface DecisionInput {
  situation: unknown
  /** Option texts, or {id?, text} objects; ids default to a, b, c, … */
  options: unknown
  /** An option id, or a 1-based option number. */
  chosen: unknown
  note?: unknown
  category?: unknown
  source?: unknown
}

export const DECISION_LIMITS = { situation: 1_000, option: 300, note: 1_000, category: 40, minOptions: 2, maxOptions: 5 } as const
const LETTERS = ['a', 'b', 'c', 'd', 'e']
const OPTION_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/
const CATEGORY = /^[a-z0-9][a-z0-9 _-]{0,39}$/

type Actor = { id: string; kind: 'human' | 'agent' | 'service' }

/** Validate and normalize a decision to log. Pure. */
export function validateDecision(input: DecisionInput): { ok: true; value: Omit<Decision, 'id' | 'at' | 'by'> } | { ok: false; error: string } {
  const L = DECISION_LIMITS
  if (typeof input.situation !== 'string' || !input.situation.trim() || input.situation.length > L.situation) return { ok: false, error: `situation must be 1 to ${L.situation} characters.` }
  if (!Array.isArray(input.options) || input.options.length < L.minOptions || input.options.length > L.maxOptions) return { ok: false, error: `options must list ${L.minOptions} to ${L.maxOptions} options.` }
  const options: DecisionOption[] = []
  for (const [i, raw] of input.options.entries()) {
    const o = typeof raw === 'string' ? { text: raw } : (raw ?? {}) as { id?: unknown; text?: unknown }
    if (typeof o.text !== 'string' || !o.text.trim() || o.text.length > L.option) return { ok: false, error: `Each option needs 1 to ${L.option} characters of text.` }
    const id = o.id === undefined ? LETTERS[i]! : o.id
    if (typeof id !== 'string' || !OPTION_ID.test(id)) return { ok: false, error: 'Option ids use lowercase letters, digits, "-" and "_".' }
    if (options.some((x) => x.id === id)) return { ok: false, error: `Option id "${id}" is used twice.` }
    options.push({ id, text: o.text.trim() })
  }
  let chosen: string | undefined
  if (typeof input.chosen === 'number' && Number.isInteger(input.chosen)) chosen = options[input.chosen - 1]?.id
  else if (typeof input.chosen === 'string') chosen = options.find((o) => o.id === input.chosen)?.id ?? (/^\d$/.test(input.chosen) ? options[Number(input.chosen) - 1]?.id : undefined)
  if (!chosen) return { ok: false, error: 'chosen must name one of the options (its id or its number, from 1).' }
  if (input.note !== undefined && input.note !== null && input.note !== '' && (typeof input.note !== 'string' || input.note.length > L.note)) return { ok: false, error: `note must be at most ${L.note} characters.` }
  let category: string | undefined
  if (input.category !== undefined && input.category !== null && input.category !== '') {
    if (typeof input.category !== 'string' || !CATEGORY.test(input.category.trim().toLowerCase())) return { ok: false, error: 'category is a short tag: up to 40 lowercase letters, digits, spaces, "-" or "_".' }
    category = input.category.trim().toLowerCase()
  }
  const source = input.source ?? 'journal'
  if (!DECISION_SOURCES.includes(source as DecisionSource)) return { ok: false, error: `source must be one of ${DECISION_SOURCES.join(', ')}.` }
  const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim() : undefined
  return { ok: true, value: { situation: input.situation.trim(), options, chosen, ...(note ? { note } : {}), ...(category ? { category } : {}), source: source as DecisionSource } }
}

/** Build a decision to log. Only a human provider logs decisions. Pure: the caller appends it. */
export function recordDecision(actor: Actor, input: DecisionInput, opts: { id: string; now?: Date }): { ok: true; decision: Decision } | { ok: false; reason: string; status: 403 | 422 } {
  if (actor.kind !== 'human') return { ok: false, status: 403, reason: 'Only a human provider logs decisions.' }
  const v = validateDecision(input)
  if (!v.ok) return { ok: false, status: 422, reason: v.error }
  return { ok: true, decision: { id: opts.id, at: (opts.now ?? new Date()).toISOString(), by: actor.id, ...v.value } }
}

// ── Stores (append-only) ──────────────────────────────────────────────────

export interface DecisionStore {
  list(): Promise<Decision[]>
  /** Adds one decision; fails if its id already exists. There is no update or delete. */
  append(decision: Decision): Promise<void>
}

export class DecisionConflictError extends Error {
  constructor(id: string) {
    super(`Decision "${id}" already exists; the journal is append-only.`)
    this.name = 'DecisionConflictError'
  }
}

export class MemoryDecisionStore implements DecisionStore {
  private readonly items: Decision[] = []
  async list() { return structuredClone(this.items) }
  async append(decision: Decision) {
    if (this.items.some((d) => d.id === decision.id)) throw new DecisionConflictError(decision.id)
    this.items.push(structuredClone(decision))
  }
}

/**
 * One JSON-lines file (data/intent/decisions.jsonl on the founder's computer).
 * Each append rewrites the file through a temporary file and a rename, so a
 * crash never leaves half a line; appends in this process are serialized.
 */
export class FileDecisionStore implements DecisionStore {
  private readonly path: string
  private queue: Promise<unknown> = Promise.resolve()
  constructor(path: string) { this.path = path }
  async list(): Promise<Decision[]> {
    let text: string
    try { text = await readFile(this.path, 'utf8') } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
    return text.split('\n').filter((l) => l.trim()).map((l, i) => {
      try { return JSON.parse(l) as Decision } catch { throw new Error(`${this.path}: line ${i + 1} is not valid JSON.`) }
    })
  }
  append(decision: Decision): Promise<void> {
    const run = async () => {
      let existing = ''
      try { existing = await readFile(this.path, 'utf8') } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      const ids = new Set(existing.split('\n').filter((l) => l.trim()).map((l) => (JSON.parse(l) as Decision).id))
      if (ids.has(decision.id)) throw new DecisionConflictError(decision.id)
      await mkdir(dirname(this.path), { recursive: true })
      const next = (existing && !existing.endsWith('\n') ? existing + '\n' : existing) + JSON.stringify(decision) + '\n'
      await writeFile(`${this.path}.tmp`, next, { mode: 0o600 })
      await rename(`${this.path}.tmp`, this.path)
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => undefined)
    return p
  }
}

/** A short, unique-enough id for a new journal entry. */
export function newDecisionId(now: Date = new Date()): string {
  return `dec-${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

// ── Shadow verdicts as decisions ──────────────────────────────────────────

const VERDICT_OPTION: Record<Verdict, 'accept' | 'modify' | 'reject'> = { accepted: 'accept', modified: 'modify', rejected: 'reject' }

/**
 * Judged shadow recommendations as decisions: accept, modify or reject what
 * Quicksilver recommended. Derived on read, never stored twice. Unjudged
 * recommendations are left out.
 */
export function verdictsAsDecisions(log: ShadowLog, opts: { intentId?: string } = {}): Decision[] {
  const prefix = opts.intentId ? `shadow:${opts.intentId}:` : 'shadow:'
  return log.recommendations.filter((r) => r.verdict).map((r) => ({
    id: prefix + r.id,
    at: r.verdict!.at,
    by: r.verdict!.by,
    situation: `Quicksilver recommended, for the ${r.department} department: ${r.description} (The kernel would have: ${r.kernel.recommendation}, risk ${r.kernel.riskLevel} of 5.)`,
    options: [
      { id: 'accept', text: 'Accept it as proposed' },
      { id: 'modify', text: 'Do it, but changed' },
      { id: 'reject', text: 'Reject it' },
    ],
    chosen: VERDICT_OPTION[r.verdict!.value],
    ...(r.verdict!.note ? { note: r.verdict!.note } : {}),
    category: r.department,
    source: 'shadow' as const,
  }))
}

// ── Worked examples (in-context learning) ─────────────────────────────────

/** The same preamble the choice-eval `--examples` arm uses. */
export const EXAMPLES_PREAMBLE = 'Here are earlier decisions this same provider made, with the option they chose and, when they gave one, their own note. Learn how they decide: what they protect, when they take a middle path, when they want to be asked, and when they would rather you just act.'

/** Decisions as worked-examples text, oldest first, in the choice-eval `--examples` style. Pure. */
export function decisionsAsExamples(decisions: Decision[]): string {
  const lines = [EXAMPLES_PREAMBLE, '']
  for (const d of [...decisions].sort((a, b) => a.at.localeCompare(b.at))) {
    lines.push(`- ${d.category ? `Area: ${d.category}. ` : ''}Situation: ${d.situation}`)
    lines.push(`  Options: ${d.options.map((o) => `${o.id}) ${o.text}`).join(' | ')}`)
    lines.push(`  They chose: ${d.chosen}${d.note?.trim() ? `. Their note: "${d.note.trim().slice(0, 300)}"` : ''}`)
  }
  return lines.join('\n')
}

// ── Baseline: predict-then-learn on logged decisions ──────────────────────

export const DECISION_BASELINE_MODEL = 'aura-decision-baseline-v0'

const WORDS: Record<string, RegExp> = {
  decline: /\b(reject|decline|refuse|say no|turn (it|them) down|pass on|skip|don'?t|do not|cancel|drop|walk away|no)\b/i,
  delay: /\b(wait|hold off|later|postpone|delay|next (week|month|quarter|year)|revisit)\b/i,
  compromise: /\b(partial|partly|half|some of|split|middle|meet (them|in the middle)|compromise|pilot|trial|test|small(er)?|both|instead|but)\b/i,
  ask: /\b(ask|check with|consult|talk to|discuss|get (advice|input))\b/i,
  modify: /\b(modify|change|changed|adjust|tweak|revise|negotiate)\b/i,
  spend: /\b(buy|spend|pay|hire|invest|\$\s?\d)/i,
}

/**
 * Generic features for an option's text: keyword flags only. Option position
 * is deliberately excluded, so the baseline cannot win by learning "they pick b".
 */
export function decisionOptionFeatures(text: string): Features {
  const f: Features = {}
  for (const [k, re] of Object.entries(WORDS)) if (re.test(text)) f[k] = 1
  return f
}

export interface DecisionBaseline {
  /** Always says what this is: a keyword-feature baseline, not Aura's model. */
  label: string
  model: string
  decisions: number
  /** Expected correct predictions (ties split evenly among the tied options). */
  correct: number
  accuracy: number | null
  /** Accuracy of picking uniformly at random: the mean of 1/options. */
  chance: number | null
  laterAccuracy: number | null
  meanProbabilityOfActual: number | null
  /** Predictions where several options were tied for the top. */
  ties: number
  bySource: Partial<Record<DecisionSource, { decisions: number; correct: number }>>
  weights: Record<string, number>
}

/**
 * Predict each decision BEFORE learning from it, oldest first, with the
 * existing learner (learn.ts) on keyword features. Ties are credited as
 * 1/k (a random tie-break), never resolved by option order.
 */
export function prequentialOnDecisions(decisions: Decision[], opts: { learningRate?: number; priorStrength?: number } = {}): DecisionBaseline {
  let state = newLearner({}, { learningRate: opts.learningRate ?? 0.5, priorStrength: opts.priorStrength ?? 0.1 })
  const ordered = [...decisions].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
  const credits: number[] = []
  let pActual = 0, chance = 0, ties = 0
  const bySource: DecisionBaseline['bySource'] = {}
  for (const d of ordered) {
    const options: ChoiceOption[] = d.options.map((o) => ({ id: o.id, features: decisionOptionFeatures(o.text) }))
    if (!options.some((o) => o.id === d.chosen)) continue
    const p = probabilities(state, options)
    const top = Math.max(...Object.values(p))
    const best = options.filter((o) => p[o.id]! >= top - 1e-12).map((o) => o.id)
    if (best.length > 1) ties++
    const credit = best.includes(d.chosen) ? 1 / best.length : 0
    credits.push(credit)
    pActual += p[d.chosen]!
    chance += 1 / options.length
    const s = (bySource[d.source] ??= { decisions: 0, correct: 0 })
    s.decisions++
    s.correct = Math.round((s.correct + credit) * 1000) / 1000
    state = learn(state, options, d.chosen)
  }
  const n = credits.length
  const round = (x: number) => Math.round(x * 1000) / 1000
  const later = credits.slice(Math.floor(n / 2))
  const correct = credits.reduce((a, b) => a + b, 0)
  return {
    label: 'Baseline only: keyword features (decline, delay, compromise, ask, modify, spend; no option position) and the learn.ts logit, scored predict-then-learn.',
    model: DECISION_BASELINE_MODEL,
    decisions: n,
    correct: round(correct),
    accuracy: n ? round(correct / n) : null,
    chance: n ? round(chance / n) : null,
    laterAccuracy: later.length ? round(later.reduce((a, b) => a + b, 0) / later.length) : null,
    meanProbabilityOfActual: n ? round(pActual / n) : null,
    ties,
    bySource,
    weights: Object.fromEntries(Object.entries(state.weights).map(([k, v]) => [k, round(v)])),
  }
}
