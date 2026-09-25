import type { PolicyCheck, PolicyEffect, PolicyRef, ProposedAction, RiskLevel } from './types.ts'
import { evaluateGuard, type Facts } from './process.ts'

/**
 * Authority check: which policies apply, which are superseded, and do the
 * applicable ones agree?
 *
 * The kernel never lets the LLM decide policy. The kernel:
 *   1. Filters out policies that are expired, not yet effective, or superseded.
 *   2. For policies that declare a structured `effect`, evaluates their
 *      conditions and resolves disagreements deterministically by priority.
 *   3. Falls back to same-scope conflict flagging for policies that only
 *      carry free-text rules (the original behavior).
 *   4. Records every check, conflict and resolution for the decision record.
 *
 * Fail-closed rules for structured policies:
 *   - A permissive policy (`allow`) applies only when its conditions hold.
 *     A missing fact means it does not apply.
 *   - A restrictive policy (`require-approval`, `deny`) applies unless its
 *     conditions are provably false. A missing fact means it still applies.
 *   - `allow` with `maxRiskLevel` becomes `require-approval` above that risk.
 *   - When priorities resolve a disagreement toward a LESS restrictive effect,
 *     the kernel still routes to a human: priority can never silently loosen
 *     a restriction.
 *   - Equal-priority disagreement is an unresolved conflict (human review).
 */

export interface AuthorityOptions {
  /** Facts for policy conditions (flat dotted names, as in process guards). */
  facts?: Facts
  /** The action's computed risk, for `maxRiskLevel` on permissive policies. */
  riskLevel?: RiskLevel
  /** Clock override for tests. */
  now?: Date
}

export interface AuthorityResult {
  checks: PolicyCheck[]
  conflicts: string[]
  applicablePolicyIds: string[]
  /** Hard blocks from `deny` policies that prevailed. */
  blockingReasons: string[]
  /** Reasons a human must approve (a prevailing `require-approval`, or a loosening resolution). */
  approvalReasons: string[]
  /** Disagreements resolved deterministically by priority. */
  resolutions: string[]
}

const RESTRICTIVENESS: Record<PolicyEffect, number> = { allow: 0, 'require-approval': 1, deny: 2 }

function isOnOrBefore(dateText: string | null | undefined, now: Date): boolean {
  return Boolean(dateText) && new Date(dateText as string) <= now
}

/** True when every fact the guard mentions is present in `facts`. */
function guardFactsPresent(policy: PolicyRef, facts: Facts): boolean {
  const conditions = [...(policy.when?.all ?? []), ...(policy.when?.any ?? [])]
  return conditions.every((c) => facts[c.fact] !== undefined && facts[c.fact] !== null)
}

export function checkAuthority(
  action: ProposedAction,
  policies: PolicyRef[],
  options: AuthorityOptions = {},
): AuthorityResult {
  const now = options.now ?? new Date()
  const facts = options.facts ?? {}
  const checks: PolicyCheck[] = []
  const conflicts: string[] = []
  const applicablePolicyIds: string[] = []
  const blockingReasons: string[] = []
  const approvalReasons: string[] = []
  const resolutions: string[] = []

  const candidates = policies.filter((p) => action.applicablePolicyIds.includes(p.id))

  // Structured policies that survive their own conditions, with their effective effect.
  const effective = new Map<string, PolicyEffect>()

  for (const policy of candidates) {
    const expired = policy.expirationDate ? new Date(policy.expirationDate) < now : false
    const notYetEffective = policy.effectiveDate ? !isOnOrBefore(policy.effectiveDate, now) : false
    // A policy is superseded when another live candidate lists it in `supersedes`.
    // (Previously a policy that itself superseded something could never be superseded.)
    const superseder = candidates.find(
      (other) =>
        other.id !== policy.id &&
        other.supersedesIds.includes(policy.id) &&
        !(other.expirationDate && new Date(other.expirationDate) < now),
    )

    if (expired) {
      checks.push({ policyId: policy.id, policyName: policy.name, result: 'inapplicable', reason: `Expired on ${policy.expirationDate}` })
      continue
    }
    if (notYetEffective) {
      checks.push({ policyId: policy.id, policyName: policy.name, result: 'inapplicable', reason: `Not effective until ${policy.effectiveDate}` })
      continue
    }
    if (superseder) {
      checks.push({ policyId: policy.id, policyName: policy.name, result: 'superseded', reason: `Superseded by ${superseder.name}.` })
      continue
    }

    if (policy.effect) {
      const restrictive = policy.effect !== 'allow'
      if (policy.when) {
        const guard = evaluateGuard(policy.when, facts)
        if (!guard.passed) {
          const missing = !guardFactsPresent(policy, facts)
          if (!restrictive || !missing) {
            // Permissive: conditions must hold. Restrictive: conditions provably false.
            checks.push({
              policyId: policy.id,
              policyName: policy.name,
              result: 'inapplicable',
              reason: `Conditions not met: ${guard.failures.join('; ')}`,
            })
            continue
          }
          // Restrictive with missing facts: fail closed, keep applying.
        }
      }
      let effect: PolicyEffect = policy.effect
      if (
        effect === 'allow' &&
        policy.maxRiskLevel !== undefined &&
        policy.maxRiskLevel !== null &&
        (options.riskLevel === undefined || options.riskLevel > policy.maxRiskLevel)
      ) {
        effect = 'require-approval'
      }
      effective.set(policy.id, effect)
    }

    checks.push({
      policyId: policy.id,
      policyName: policy.name,
      result: 'applies',
      reason: policy.effect
        ? `Scope "${policy.scope}" applies; effect ${effective.get(policy.id)}.`
        : `Scope "${policy.scope}" applies to this action.`,
    })
    applicablePolicyIds.push(policy.id)
  }

  // Group applicable policies by scope.
  const byScope = new Map<string, PolicyRef[]>()
  for (const p of policies.filter((x) => applicablePolicyIds.includes(x.id))) {
    const group = byScope.get(p.scope) ?? []
    group.push(p)
    byScope.set(p.scope, group)
  }

  for (const [scope, group] of byScope) {
    const unstructured = group.filter((p) => !effective.has(p.id))
    const structured = group.filter((p) => effective.has(p.id))

    // Legacy behavior: free-text policies sharing a scope need a human to reconcile.
    if (group.length >= 2 && unstructured.length > 0) {
      conflicts.push(`Multiple non-superseded policies share scope "${scope}": ${group.map((g) => g.name).join(', ')}.`)
    }
    if (structured.length === 0) continue

    const effects = new Set(structured.map((p) => effective.get(p.id)!))
    const mostRestrictive = [...effects].sort((a, b) => RESTRICTIVENESS[b] - RESTRICTIVENESS[a])[0]!

    let prevailing: PolicyEffect
    if (effects.size === 1) {
      prevailing = mostRestrictive
    } else {
      const topPriority = Math.max(...structured.map((p) => p.priority))
      const top = structured.filter((p) => p.priority === topPriority)
      const topEffects = new Set(top.map((p) => effective.get(p.id)!))
      if (topEffects.size > 1) {
        conflicts.push(
          `Equal-priority policies in scope "${scope}" disagree: ${top.map((p) => `${p.name} (${effective.get(p.id)})`).join(', ')}.`,
        )
        prevailing = mostRestrictive
      } else {
        const winner = top[0]!
        prevailing = effective.get(winner.id)!
        const overridden = structured.filter((p) => p.id !== winner.id && effective.get(p.id) !== prevailing)
        resolutions.push(
          `In scope "${scope}", ${winner.name} (priority ${winner.priority}, ${prevailing}) prevails over ${overridden
            .map((p) => `${p.name} (priority ${p.priority}, ${effective.get(p.id)})`)
            .join(', ')}.`,
        )
        if (RESTRICTIVENESS[prevailing] < RESTRICTIVENESS[mostRestrictive]) {
          approvalReasons.push(
            `${winner.name} would loosen a stricter policy in scope "${scope}" by priority alone; a human must confirm.`,
          )
        }
      }
    }

    if (prevailing === 'deny') {
      blockingReasons.push(`Policy in scope "${scope}" denies this action.`)
    } else if (prevailing === 'require-approval') {
      approvalReasons.push(`Policy in scope "${scope}" requires human approval.`)
    }
  }

  return { checks, conflicts, applicablePolicyIds, blockingReasons, approvalReasons, resolutions }
}
