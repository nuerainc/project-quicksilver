import type { PolicyCheck, PolicyRef, ProposedAction } from './types.ts'

/**
 * Authority check: which policies apply, which are superseded, and is there a conflict?
 *
 * The kernel never lets the LLM decide policy. The kernel:
 *   1. Filters out policies that are expired or superseded.
 *   2. Marks conflicts between two non-superseded policies in the same scope.
 *   3. Records every check in the decision artifact for audit.
 *
 * Day-3 work: implement actual conflict detection.
 */
export function checkAuthority(
  action: ProposedAction,
  policies: PolicyRef[],
): { checks: PolicyCheck[]; conflicts: string[]; applicablePolicyIds: string[] } {
  const now = new Date()
  const checks: PolicyCheck[] = []
  const conflicts: string[] = []
  const applicablePolicyIds: string[] = []

  const candidates = policies.filter((p) =>
    action.applicablePolicyIds.includes(p.id),
  )

  for (const policy of candidates) {
    const expired = policy.expirationDate && new Date(policy.expirationDate) < now
    const superseded = policy.supersedesIds.length === 0 && candidates.some(
      (other) => other.id !== policy.id && other.supersedesIds.includes(policy.id),
    )

    if (expired) {
      checks.push({
        policyId: policy.id,
        policyName: policy.name,
        result: 'inapplicable',
        reason: `Expired on ${policy.expirationDate}`,
      })
      continue
    }

    if (superseded) {
      checks.push({
        policyId: policy.id,
        policyName: policy.name,
        result: 'superseded',
        reason: 'A higher-priority policy supersedes this one.',
      })
      continue
    }

    checks.push({
      policyId: policy.id,
      policyName: policy.name,
      result: 'applies',
      reason: `Scope "${policy.scope}" applies to this action.`,
    })
    applicablePolicyIds.push(policy.id)
  }

  // Conflict detection (heuristic for the demo): two non-superseded policies
  // in the same scope with materially different rule text → flag for human review.
  // Day-3 refinement: parse rule text, embed, or use LLM-as-judge behind a tool.
  if (applicablePolicyIds.length >= 2) {
    const scoped = policies.filter((p) => applicablePolicyIds.includes(p.id))
    const byScope = new Map<string, PolicyRef[]>()
    for (const p of scoped) {
      const arr = byScope.get(p.scope) ?? []
      arr.push(p)
      byScope.set(p.scope, arr)
    }
    for (const [, group] of byScope) {
      if (group.length >= 2) {
        conflicts.push(
          `Multiple non-superseded policies share scope "${group[0]?.scope ?? ''}": ${group.map((g) => g.name).join(', ')}.`,
        )
      }
    }
  }

  return { checks, conflicts, applicablePolicyIds }
}