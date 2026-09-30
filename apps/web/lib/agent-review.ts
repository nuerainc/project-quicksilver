/** Keep the console's inline rationale validation aligned with the review API. */
export function agentReviewNoteProblem(note: string): string | null {
  const length = note.trim().length
  if (length < 10) return 'Enter at least 10 characters so the review has useful rationale.'
  if (length > 500) return 'Keep the review rationale to 500 characters or fewer.'
  return null
}
