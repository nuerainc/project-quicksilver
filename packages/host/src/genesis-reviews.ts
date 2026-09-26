import { randomUUID } from 'node:crypto'

import { genesisWaesFacts, type GenesisRunConfig } from '@quicksilver/kernel/playbooks/genesis'
import {
  MANUAL_REVIEW_COMPONENT,
  WAES_BLOCK_REASONS,
  waesContentDigest,
  type WaesFacts,
  type WaesReview,
  type WaesReviewerKind,
  type WaesReviewKind,
  type WaesVerdict,
} from '@quicksilver/kernel/waes'

/**
 * Content reviews for a Genesis run (M5).
 *
 * Until the WAES suites run as a service, the founder approves customer-facing
 * text himself. Each decision is recorded here as a MANUAL FOUNDER REVIEW of
 * the exact text (bound by its content digest), never presented as a WAES run:
 * `kind: 'manual'`, `reviewerKind: 'human'`, `components: ['MANUAL-FOUNDER-REVIEW']`.
 *
 * Records are append-only. A new decision on the same text is a new record
 * (the latest one decides); changed text has a different digest, so it needs
 * its own review. Nothing here sends or publishes anything.
 */

export const MANUAL_REVIEW_LABEL = 'Manual founder review — not a WAES evaluation'
export const REVIEW_VERDICTS: readonly WaesVerdict[] = ['pass', 'revise', 'block']
export const REVIEW_TEXT_MAX = 20_000
const CHANNEL = /^[a-z][a-z0-9-]{0,39}$/
const EXP_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
const REVIEW_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/

export interface ContentReviewRecord {
  reviewId: string
  kind: WaesReviewKind
  /** sha256 of the reviewed text (`waesContentDigest`). */
  contentDigest: string
  /** The exact text reviewed. */
  text: string
  verdict: WaesVerdict
  /** `['MANUAL-FOUNDER-REVIEW']` for a manual review; the WAES components that ran otherwise. */
  components: string[]
  reviewer: string
  reviewerKind: WaesReviewerKind
  reviewedAt: string
  note?: string
  experimentId?: string
  /** Where the text will appear, for example landing-page, email, ad. */
  channel: string
}

export interface ContentReviewInput {
  text: string
  channel: string
  verdict: WaesVerdict
  note?: string
  experimentId?: string
}

export class ContentReviewRecordError extends Error {
  constructor(reviewId: string, reasons: string[]) {
    super(`Content review "${reviewId}" cannot be stored: ${reasons.join(' ')}`)
    this.name = 'ContentReviewRecordError'
  }
}

export class ContentReviewConflictError extends Error {
  constructor(runId: string, reviewId: string) {
    super(`Content review "${reviewId}" of run "${runId}" already exists with different content; reviews are never rewritten.`)
    this.name = 'ContentReviewConflictError'
  }
}

/** Shape-check a review request (from the API or the CLI). */
export function parseContentReviewInput(value: unknown): { ok: true; input: ContentReviewInput } | { ok: false; error: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'The review must be an object.' }
  const b = value as Record<string, unknown>
  if (typeof b.text !== 'string' || !b.text.trim()) return { ok: false, error: 'text is required: the exact customer-facing text being reviewed.' }
  if (b.text.length > REVIEW_TEXT_MAX) return { ok: false, error: `text must be at most ${REVIEW_TEXT_MAX.toLocaleString('en-US')} characters.` }
  if (typeof b.channel !== 'string' || !CHANNEL.test(b.channel)) return { ok: false, error: 'channel must be lowercase letters, digits and "-", up to 40 characters (for example landing-page, email, ad).' }
  if (!REVIEW_VERDICTS.includes(b.verdict as WaesVerdict)) return { ok: false, error: `verdict must be one of ${REVIEW_VERDICTS.join(', ')}.` }
  if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > 500)) return { ok: false, error: 'note must be at most 500 characters.' }
  if (b.experimentId !== undefined && (typeof b.experimentId !== 'string' || !EXP_ID.test(b.experimentId))) return { ok: false, error: 'experimentId is invalid.' }
  const note = typeof b.note === 'string' ? b.note.trim() : ''
  return {
    ok: true,
    input: {
      text: b.text,
      channel: b.channel,
      verdict: b.verdict as WaesVerdict,
      ...(note ? { note } : {}),
      ...(typeof b.experimentId === 'string' ? { experimentId: b.experimentId } : {}),
    },
  }
}

/** Why a record is not a valid stored review (empty when it is). */
export function contentReviewProblems(r: ContentReviewRecord): string[] {
  const problems: string[] = []
  if (!REVIEW_ID.test(r.reviewId ?? '')) problems.push('reviewId is invalid.')
  if (r.kind !== 'manual' && r.kind !== 'waes') problems.push('kind must be manual or waes.')
  if (typeof r.text !== 'string' || !r.text.trim()) problems.push('text is required.')
  else if (waesContentDigest(r.text) !== r.contentDigest) problems.push('contentDigest does not match the text.')
  if (!REVIEW_VERDICTS.includes(r.verdict)) problems.push('verdict is invalid.')
  if (!r.reviewer?.trim()) problems.push('reviewer is required.')
  if (!CHANNEL.test(r.channel ?? '')) problems.push('channel is invalid.')
  if (Number.isNaN(Date.parse(r.reviewedAt))) problems.push('reviewedAt is invalid.')
  const components = Array.isArray(r.components) ? r.components : []
  if (r.kind === 'manual') {
    if (r.reviewerKind !== 'human') problems.push('a manual review must be made by a human.')
    if (components.length !== 1 || components[0] !== MANUAL_REVIEW_COMPONENT) problems.push(`a manual review names only ${MANUAL_REVIEW_COMPONENT}.`)
  } else if (r.kind === 'waes') {
    if (!components.length) problems.push('a WAES review names the components that ran.')
    if (components.includes(MANUAL_REVIEW_COMPONENT)) problems.push(`only a manual review may name ${MANUAL_REVIEW_COMPONENT}.`)
  }
  return problems
}

/** A manual founder review of `input.text` by `reviewer` (who must be a human). */
export function createManualReview(input: ContentReviewInput, reviewer: { id: string; kind: string }, now: Date): { ok: true; review: ContentReviewRecord } | { ok: false; reasons: string[] } {
  if (reviewer.kind !== 'human') return { ok: false, reasons: ['Only a human records a manual founder review.'] }
  const contentDigest = waesContentDigest(input.text)
  const reviewedAt = now.toISOString()
  const review: ContentReviewRecord = {
    reviewId: `review-${reviewedAt.replace(/[^0-9]/g, '').slice(0, 14)}-${contentDigest.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
    kind: 'manual',
    contentDigest,
    text: input.text,
    verdict: input.verdict,
    components: [MANUAL_REVIEW_COMPONENT],
    reviewer: reviewer.id,
    reviewerKind: 'human',
    reviewedAt,
    ...(input.note ? { note: input.note } : {}),
    ...(input.experimentId ? { experimentId: input.experimentId } : {}),
    channel: input.channel,
  }
  const problems = contentReviewProblems(review)
  return problems.length ? { ok: false, reasons: problems } : { ok: true, review }
}

/** The kernel's view of a stored review. */
export function toWaesReview(r: ContentReviewRecord): WaesReview {
  return {
    reviewId: r.reviewId,
    kind: r.kind,
    contentDigest: r.contentDigest,
    verdict: r.verdict,
    components: r.components,
    reviewer: r.reviewer,
    reviewerKind: r.reviewerKind,
    reviewedAt: r.reviewedAt,
    ...(r.note ? { notes: r.note } : {}),
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const o = value as Record<string, unknown>
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`
}

export const sameReview = (a: ContentReviewRecord, b: ContentReviewRecord) => canonical(a) === canonical(b)

/**
 * Where `record` goes in `current`: true to append, false when the identical
 * record is already stored. Throws on an invalid record or a reviewId taken by
 * a different record.
 */
export function checkReviewAppend(runId: string, current: ContentReviewRecord[], record: ContentReviewRecord): boolean {
  const problems = contentReviewProblems(record)
  if (problems.length) throw new ContentReviewRecordError(record.reviewId, problems)
  const existing = current.find((r) => r.reviewId === record.reviewId)
  if (!existing) return true
  if (!sameReview(existing, record)) throw new ContentReviewConflictError(runId, record.reviewId)
  return false
}

/** Oldest first; ties keep stored order. */
export function sortReviews(records: ContentReviewRecord[]): ContentReviewRecord[] {
  return records.map((r, i) => [r, i] as const).sort((a, b) => a[0].reviewedAt.localeCompare(b[0].reviewedAt) || a[1] - b[1]).map(([r]) => r)
}

export interface ContentStatus {
  contentDigest: string
  /** The latest review of exactly this text, which is the one that decides. */
  review: ContentReviewRecord | null
  /** How many reviews of exactly this text exist. */
  reviewsOfThisText: number
  facts: WaesFacts
  passes: boolean
  manual: boolean
  /** Why the gate would block, when it would. */
  reason?: string
}

/**
 * Would the WAES gate pass `text` right now, for an action proposed by
 * `proposerId`, under the run's policy? The latest review of the exact text
 * decides; manual reviews count only when the run config allows them.
 */
export function contentStatus(config: GenesisRunConfig, records: ContentReviewRecord[], text: string, proposerId: string): ContentStatus {
  const contentDigest = waesContentDigest(text)
  const matching = sortReviews(records).filter((r) => r.contentDigest === contentDigest)
  const review = matching.at(-1) ?? null
  const facts = genesisWaesFacts(config, review ? toWaesReview(review) : undefined, text, proposerId)
  const value = facts['waes.review']
  return {
    contentDigest,
    review,
    reviewsOfThisText: matching.length,
    facts,
    passes: value === 'pass',
    manual: review?.kind === 'manual',
    ...(value !== 'pass' ? { reason: WAES_BLOCK_REASONS[value] } : {}),
  }
}

/** Counts for the run report: manual reviews are always listed apart from WAES reviews. */
export function reviewSummary(records: ContentReviewRecord[]): Record<WaesReviewKind, Record<WaesVerdict | 'total', number>> {
  const empty = () => ({ total: 0, pass: 0, revise: 0, block: 0 })
  const out = { waes: empty(), manual: empty() }
  for (const r of records) {
    const bucket = out[r.kind]
    if (!bucket) continue
    bucket.total++
    bucket[r.verdict]++
  }
  return out
}

/**
 * The CLI's `<file-or-"text">` argument: the contents of the file when `arg`
 * names an existing file (relative to `root`), otherwise `arg` itself.
 */
export async function readContentArg(arg: string, root: string): Promise<{ text: string; from: 'file' | 'argument'; path?: string }> {
  const { readFile, stat } = await import('node:fs/promises')
  const { resolve } = await import('node:path')
  if (arg.length <= 4096 && !arg.includes('\n')) {
    const path = resolve(root, arg)
    try {
      if ((await stat(path)).isFile()) return { text: await readFile(path, 'utf8'), from: 'file', path }
    } catch {
      // Not a readable file: the argument is the text.
    }
  }
  return { text: arg, from: 'argument' }
}
