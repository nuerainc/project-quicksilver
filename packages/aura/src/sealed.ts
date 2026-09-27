import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { validateDecision, type Decision, type DecisionOption } from './decisions.ts'

/**
 * Sealed predictions on the provider's own real decisions.
 *
 * The provider describes a decision they face (situation and options). Aura
 * predicts their choice BEFORE they make it, and seals that prediction: it is
 * stored but not shown. The provider then decides and gives a one-line
 * reason; only then is the prediction revealed and scored. This is the
 * charter's predict-then-learn rule on the provider's own intent, in their
 * own situations, which the scenario sets could not test.
 *
 * Ask when unsure: each prediction takes several votes. When they disagree,
 * or fall below the provider's threshold, Aura would ask instead of acting.
 * The scoreboard shows agreement where Aura would have acted, and how often
 * it would have asked, so the threshold can be set from real data.
 *
 * A sealed prediction is Aura's inference, never provider intent.
 */

export interface SealedPrediction {
  /** The majority pick (ties go to the earliest vote). */
  pick: string
  votes: string[]
  /** Share of votes for the pick, 0..1. */
  confidence: number
  /** True when confidence meets the threshold: Aura would act; false: Aura would ask the provider. */
  wouldAct: boolean
  threshold: number
  reason?: string
  /** Which predictor made it, e.g. the model deployment and method. */
  method: string
  at: string
}

export interface PendingDecision {
  id: string
  at: string
  by: string
  situation: string
  options: DecisionOption[]
  category?: string
  prediction: SealedPrediction
}

/** Majority of votes and its confidence; ties go to the earliest vote. Pure. */
export function tallyVotes(votes: Array<string | null>, threshold: number): { pick: string; votes: string[]; confidence: number; wouldAct: boolean } | null {
  const ok = votes.filter((v): v is string => typeof v === 'string')
  if (!ok.length) return null
  const counts = new Map<string, number>()
  for (const v of ok) counts.set(v, (counts.get(v) ?? 0) + 1)
  const [pick, n] = [...counts.entries()].sort((a, b) => b[1] - a[1] || ok.indexOf(a[0]) - ok.indexOf(b[0]))[0]!
  const confidence = n / votes.length
  return { pick, votes: ok, confidence, wouldAct: confidence >= threshold }
}

/** Validate what the provider describes before Aura predicts (situation, 2–5 options, optional category). Pure. */
export function validatePending(input: { situation: unknown; options: unknown; category?: unknown }): { ok: true; value: Pick<PendingDecision, 'situation' | 'options' | 'category'> } | { ok: false; error: string } {
  // Reuse the journal's rules; the choice is filled with the first option only to pass validation.
  const v = validateDecision({ situation: input.situation, options: input.options, chosen: 1, category: input.category })
  if (!v.ok) return v
  return { ok: true, value: { situation: v.value.situation, options: v.value.options, ...(v.value.category ? { category: v.value.category } : {}) } }
}

/** Resolve a pending decision with the provider's choice: a journal decision carrying the sealed prediction. Pure. */
export function resolvePending(p: PendingDecision, input: { chosen: unknown; note?: unknown }, opts: { id: string; now?: Date; by: string }): { ok: true; decision: Decision & { prediction: SealedPrediction; predictedId: string } } | { ok: false; error: string } {
  const v = validateDecision({ situation: p.situation, options: p.options, chosen: input.chosen, note: input.note, category: p.category, source: 'journal' })
  if (!v.ok) return v
  if (!(input.note && String(input.note).trim())) return { ok: false, error: 'Add a one-line reason (--note): your reasons are what Aura learns most from.' }
  return { ok: true, decision: { id: opts.id, at: (opts.now ?? new Date()).toISOString(), by: opts.by, ...v.value, prediction: p.prediction, predictedId: p.id } }
}

export interface PredictionScoreboard {
  predicted: number
  agreed: number
  /** Aura would have acted on these (confident). */
  acted: number
  actedAgreed: number
  /** Aura would have asked on these (unsure). */
  asked: number
  /** Of the asked ones, how many it would have got wrong anyway (asking was right to do). */
  askedWouldMiss: number
}

/** Score sealed predictions on resolved decisions. Pure. */
export function predictionScoreboard(decisions: Array<Decision & { prediction?: SealedPrediction }>): PredictionScoreboard {
  const s: PredictionScoreboard = { predicted: 0, agreed: 0, acted: 0, actedAgreed: 0, asked: 0, askedWouldMiss: 0 }
  for (const d of decisions) {
    const p = d.prediction
    if (!p) continue
    const right = p.pick === d.chosen
    s.predicted++
    if (right) s.agreed++
    if (p.wouldAct) { s.acted++; if (right) s.actedAgreed++ } else { s.asked++; if (!right) s.askedWouldMiss++ }
  }
  return s
}

/** Open (sealed, undecided) decisions: one JSON file, rewritten atomically. */
export class FilePendingStore {
  private readonly path: string
  private queue: Promise<unknown> = Promise.resolve()
  constructor(path: string) { this.path = path }
  async list(): Promise<PendingDecision[]> {
    try { return (JSON.parse(await readFile(this.path, 'utf8')) as { pending: PendingDecision[] }).pending } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
  }
  async get(id: string): Promise<PendingDecision | undefined> { return (await this.list()).find((p) => p.id === id) }
  private write(fn: (items: PendingDecision[]) => PendingDecision[]): Promise<void> {
    const run = async () => {
      const next = fn(await this.list())
      await mkdir(dirname(this.path), { recursive: true })
      await writeFile(`${this.path}.tmp`, JSON.stringify({ pending: next }, null, 1), { mode: 0o600 })
      await rename(`${this.path}.tmp`, this.path)
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => undefined)
    return p
  }
  add(p: PendingDecision): Promise<void> {
    return this.write((items) => { if (items.some((x) => x.id === p.id)) throw new Error(`Pending decision "${p.id}" already exists.`); return [...items, p] })
  }
  /** Removes a pending decision once it is resolved into the journal. */
  close(id: string): Promise<void> { return this.write((items) => items.filter((x) => x.id !== id)) }
}
