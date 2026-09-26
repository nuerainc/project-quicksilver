import { createHash } from 'node:crypto'

/**
 * WAES review gate (M5): customer-facing actions need a passing review.
 *
 * WAES (the Wellbeing Alignment Evaluation Suite) reviews an offer, claim or
 * outbound message before any customer sees it. The kernel does not run
 * WAES; it checks the evidence:
 *
 *   - the review must cover exactly the content being sent (content digest),
 *   - its verdict must be `pass`,
 *   - the reviewer must not be the actor proposing the action.
 *
 * Two kinds of review exist:
 *
 *   - `waes` (the default, and what a review without `kind` is): WAES suites
 *     ran; `components` names them.
 *   - `manual`: until the WAES suites run as a service, the founder approves
 *     customer-facing text himself. A manual review must come from a human
 *     reviewer and names exactly `components: ['MANUAL-FOUNDER-REVIEW']`, so
 *     every place that lists components shows it was not a WAES run. Only a
 *     manual review may carry that marker. Manual reviews count only when the
 *     policy allows them (`waesFacts(..., { allowManual: true })`); otherwise
 *     the fact is `manual-not-allowed` and the action stays blocked.
 *
 * `authorize()` hard-blocks a customer-facing action unless the fact
 * `waes.review` is `pass`, which only `waesFacts()` sets from a matching
 * review. `waes.reviewKind` records which kind of review it was, so every
 * downstream record can show that a pass was manual.
 */

export type WaesVerdict = 'pass' | 'revise' | 'block'
export type WaesReviewKind = 'waes' | 'manual'
export type WaesReviewerKind = 'human' | 'service'

/** The only component a manual review names, and a marker no WAES review may carry. */
export const MANUAL_REVIEW_COMPONENT = 'MANUAL-FOUNDER-REVIEW'

export interface WaesReview {
  reviewId: string
  /** Absent means `waes` (reviews recorded before manual review existed). */
  kind?: WaesReviewKind
  /** sha256 of the exact content reviewed (see `waesContentDigest`). */
  contentDigest: string
  verdict: WaesVerdict
  /** WAES components that ran, for example SENTINEL, COMPASS, LANTERN; `[MANUAL_REVIEW_COMPONENT]` for a manual review. */
  components: string[]
  reviewer: string
  /** Required to be `human` for a manual review. */
  reviewerKind?: WaesReviewerKind
  reviewedAt: string
  notes?: string
}

export type WaesReviewFact = WaesVerdict | 'missing' | 'stale' | 'self-reviewed' | 'manual-not-allowed' | 'manual-invalid'

export interface WaesFactOptions {
  /** Count manual founder reviews (default false). Turn off once WAES runs as a service. */
  allowManual?: boolean
}

export type WaesFacts = {
  'waes.review': WaesReviewFact
  'waes.reviewId'?: string
  'waes.reviewKind'?: WaesReviewKind
}

/** Normalize line endings and outer whitespace so the digest is stable across platforms. */
export function waesContentDigest(content: string): string {
  return createHash('sha256').update(content.replace(/\r\n/g, '\n').trim()).digest('hex')
}

export function waesReviewKind(review: Pick<WaesReview, 'kind'>): WaesReviewKind | undefined {
  const kind = review.kind ?? 'waes'
  return kind === 'waes' || kind === 'manual' ? kind : undefined
}

/** Facts for `authorize()`: `waes.review` and, when a review is present, `waes.reviewId` and `waes.reviewKind`. */
export function waesFacts(review: WaesReview | undefined, content: string, actorId: string, options: WaesFactOptions = {}): WaesFacts {
  if (!review) return { 'waes.review': 'missing' }
  const kind = waesReviewKind(review)
  if (!kind) return { 'waes.review': 'missing', 'waes.reviewId': review.reviewId }
  const facts = (value: WaesReviewFact): WaesFacts => ({ 'waes.review': value, 'waes.reviewId': review.reviewId, 'waes.reviewKind': kind })
  if (review.contentDigest !== waesContentDigest(content)) return facts('stale')
  if (review.reviewer === actorId) return facts('self-reviewed')
  const components = review.components ?? []
  if (kind === 'manual') {
    if (review.reviewerKind !== 'human') return facts('manual-invalid')
    if (components.length !== 1 || components[0] !== MANUAL_REVIEW_COMPONENT) return facts('manual-invalid')
    if (options.allowManual !== true) return facts('manual-not-allowed')
    return facts(review.verdict)
  }
  if (components.includes(MANUAL_REVIEW_COMPONENT)) return facts('manual-invalid')
  if (!components.length) return facts('missing')
  return facts(review.verdict)
}

export const WAES_BLOCK_REASONS: Record<Exclude<WaesReviewFact, 'pass'>, string> = {
  missing: 'Customer-facing actions need a passing WAES review; none was supplied.',
  stale: 'The review covers different content than the action would send.',
  'self-reviewed': 'The review was made by the proposing actor; it must come from a separate reviewer.',
  revise: 'The reviewer asked for revisions; revise the content and review it again.',
  block: 'The reviewer blocked this content.',
  'manual-not-allowed': 'The content has only a manual founder review, and this policy does not accept manual reviews in place of WAES.',
  'manual-invalid': `A manual review must be made by a human reviewer and name only ${MANUAL_REVIEW_COMPONENT}, and only a manual review may carry that marker.`,
}
