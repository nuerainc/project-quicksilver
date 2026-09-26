import { createHash } from 'node:crypto'

/**
 * WAES review gate (M5): customer-facing actions need a passing WAES review.
 *
 * WAES (the Wellbeing Alignment Evaluation Suite) reviews an offer, claim or
 * outbound message before any customer sees it. The kernel does not run
 * WAES; it checks the evidence:
 *
 *   - the review must cover exactly the content being sent (content digest),
 *   - its verdict must be `pass`,
 *   - the reviewer must not be the actor proposing the action.
 *
 * `authorize()` hard-blocks a customer-facing action unless the fact
 * `waes.review` is `pass`, which only `waesFacts()` sets from a matching review.
 */

export type WaesVerdict = 'pass' | 'revise' | 'block'

export interface WaesReview {
  reviewId: string
  /** sha256 of the exact content reviewed (see `waesContentDigest`). */
  contentDigest: string
  verdict: WaesVerdict
  /** WAES components that ran, for example SENTINEL, COMPASS, LANTERN. */
  components: string[]
  reviewer: string
  reviewedAt: string
  notes?: string
}

export type WaesReviewFact = WaesVerdict | 'missing' | 'stale' | 'self-reviewed'

/** Normalize line endings and outer whitespace so the digest is stable across platforms. */
export function waesContentDigest(content: string): string {
  return createHash('sha256').update(content.replace(/\r\n/g, '\n').trim()).digest('hex')
}

/** Facts for `authorize()`: `waes.review` and, when present, `waes.reviewId`. */
export function waesFacts(review: WaesReview | undefined, content: string, actorId: string): { 'waes.review': WaesReviewFact; 'waes.reviewId'?: string } {
  if (!review) return { 'waes.review': 'missing' }
  if (review.contentDigest !== waesContentDigest(content)) return { 'waes.review': 'stale', 'waes.reviewId': review.reviewId }
  if (review.reviewer === actorId) return { 'waes.review': 'self-reviewed', 'waes.reviewId': review.reviewId }
  if (!review.components.length) return { 'waes.review': 'missing', 'waes.reviewId': review.reviewId }
  return { 'waes.review': review.verdict, 'waes.reviewId': review.reviewId }
}

export const WAES_BLOCK_REASONS: Record<Exclude<WaesReviewFact, 'pass'>, string> = {
  missing: 'Customer-facing actions need a passing WAES review; none was supplied.',
  stale: 'The WAES review covers different content than the action would send.',
  'self-reviewed': 'The WAES review was made by the proposing actor; it must come from a separate reviewer.',
  revise: 'WAES asked for revisions; revise the content and review it again.',
  block: 'WAES blocked this content.',
}
