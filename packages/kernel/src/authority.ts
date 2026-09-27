import type { PolicyCheck, PolicyEffect, PolicyRef, ProposedAction, RiskLevel } from './types.ts'
import { evaluateGuard, type Facts } from './process.ts'
import { findCycles } from './graph-cycles.ts'

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
 *
 * M7 — versioning, supersession and scope nesting (all fields optional; with
 * none of them set, behavior is unchanged):
 *
 *   Live. A policy is live when it is effective (no `effectiveDate`, or one on
 *   or before now) and not expired. Only live policies supersede others. (A
 *   policy that is not yet effective used to supersede its predecessor early,
 *   leaving a gap; it no longer does.)
 *
 *   Supersession by id. A candidate is superseded when another live candidate
 *   lists it in `supersedesIds`. Self-supersession is ignored here and
 *   reported by `validatePolicySet`.
 *
 *   Supersession cycles. If live candidates supersede each other in a cycle
 *   (A → B → A, any length), the kernel does not pick one: every member is
 *   recorded as `conflicts` / `supersession-cycle`, none of their effects is
 *   applied, and the cycle is a policy conflict, so a human must approve.
 *
 *   Versions. Policies sharing a `lineageId` are versions of one rule. Among
 *   the lineage's live policies (from the whole set passed in, not only this
 *   action's candidates) only the highest `version` applies; lower versions
 *   are recorded as `superseded-by-version`. If the newest version does not
 *   govern this action (another scope, not cited), the older candidate is
 *   still superseded, the newest version is recorded as `out-of-scope`, and a
 *   human must confirm the rule no longer applies here. A lineage whose
 *   current version cannot be determined (a live member without a valid
 *   version, or two live members tied at the top version) is not resolved:
 *   all its members apply and the ambiguity is a conflict (human review).
 *
 *   Scope nesting. Scopes are dot-separated (`finance.payments`). A policy
 *   with scope `finance` governs a capability whose governing scopes include
 *   `finance` or any `finance.*` descendant. When an ancestor-scope policy and
 *   a descendant-scope policy both apply and resolve to different effects, the
 *   more specific (descendant) scope wins only if it is at least as
 *   restrictive. If it is less restrictive, its effect is used but the kernel
 *   routes the action to a human: a more specific scope may never silently
 *   loosen an ancestor's restriction (the same principle as priority).
 *   Priority resolves disagreements within one scope; specificity resolves
 *   them between nested scopes. Free-text policies in nested scopes, like
 *   those sharing a scope, need a human to reconcile them.
 *
 *   Audit. Every row carries a `reasonCode`: applies, expired,
 *   not-yet-effective, conditions-not-met, superseded-by-id (with
 *   `supersededById`), superseded-by-version, supersession-cycle, out-of-scope.
 */

export interface AuthorityOptions {
  /** Facts for policy conditions (flat dotted names, as in process guards). */
  facts?: Facts
  /** The action's computed risk, for `maxRiskLevel` on permissive policies. */
  riskLevel?: RiskLevel
  /** Clock override for tests. */
  now?: Date
  /** Scopes that govern the action's capability (from the company model, not the planner). */
  governingScopes?: string[] | null
  /** The acting entity, for policies that name it in `appliesToEntityIds`. */
  actorId?: string
}

export interface AuthorityResult {
  checks: PolicyCheck[]
  conflicts: string[]
  applicablePolicyIds: string[]
  /** Hard blocks from `deny` policies that prevailed. */
  blockingReasons: string[]
  /** Reasons a human must approve (a prevailing `require-approval`, or a loosening resolution). */
  approvalReasons: string[]
  /** Disagreements resolved deterministically by priority or scope specificity. */
  resolutions: string[]
  /** Policies that govern the action but that the planner did not cite. */
  uncitedPolicyIds: string[]
}

const RESTRICTIVENESS: Record<PolicyEffect, number> = { allow: 0, 'require-approval': 1, deny: 2 }

/** True when `scope` is `ancestor` or a dot-separated descendant of it. */
export function scopeIncludes(ancestor: string | null | undefined, scope: string | null | undefined): boolean {
  if (!ancestor || !scope) return false
  return scope === ancestor || scope.startsWith(`${ancestor}.`)
}

/** A policy version is a positive integer. */
export function isValidPolicyVersion(version: unknown): version is number {
  return typeof version === 'number' && Number.isInteger(version) && version >= 1
}

function isOnOrBefore(dateText: string | null | undefined, now: Date): boolean {
  return Boolean(dateText) && new Date(dateText as string) <= now
}

function isExpired(policy: PolicyRef, now: Date): boolean {
  return policy.expirationDate ? new Date(policy.expirationDate) < now : false
}

function isNotYetEffective(policy: PolicyRef, now: Date): boolean {
  return policy.effectiveDate ? !isOnOrBefore(policy.effectiveDate, now) : false
}

/** Effective and not expired. */
export function isPolicyLive(policy: PolicyRef, now: Date): boolean {
  return !isExpired(policy, now) && !isNotYetEffective(policy, now)
}

/** True when every fact the guard mentions is present in `facts`. */
function guardFactsPresent(policy: PolicyRef, facts: Facts): boolean {
  const conditions = [...(policy.when?.all ?? []), ...(policy.when?.any ?? [])]
  return conditions.every((c) => facts[c.fact] !== undefined && facts[c.fact] !== null)
}

interface LineageResolution {
  /** Policy id → the newer live version that supersedes it. */
  supersededBy: Map<string, PolicyRef>
  /** Lineage id → why its current version cannot be determined. */
  ambiguous: Map<string, string>
}

/** Resolve each lineage among the live policies: only the highest version applies. */
function resolveLineages(policies: PolicyRef[], now: Date): LineageResolution {
  const supersededBy = new Map<string, PolicyRef>()
  const ambiguous = new Map<string, string>()
  const byLineage = new Map<string, PolicyRef[]>()
  for (const p of policies) {
    if (!p.lineageId || !isPolicyLive(p, now)) continue
    const group = byLineage.get(p.lineageId) ?? []
    if (!group.some((g) => g.id === p.id)) group.push(p)
    byLineage.set(p.lineageId, group)
  }
  for (const [lineage, members] of byLineage) {
    if (members.length < 2) continue
    const unversioned = members.filter((m) => !isValidPolicyVersion(m.version))
    if (unversioned.length > 0) {
      ambiguous.set(
        lineage,
        `Lineage "${lineage}" has live policies without a valid version (${unversioned.map((m) => m.name).join(', ')}); the kernel cannot tell which is current, so all of them apply and a human must confirm.`,
      )
      continue
    }
    const top = Math.max(...members.map((m) => m.version as number))
    const tops = members.filter((m) => m.version === top)
    if (tops.length > 1) {
      ambiguous.set(
        lineage,
        `Lineage "${lineage}" has ${tops.length} live policies at version ${top} (${tops.map((m) => m.name).join(', ')}); the kernel will not pick one, so they all apply and a human must confirm which is current.`,
      )
    }
    for (const m of members) if ((m.version as number) < top) supersededBy.set(m.id, tops[0]!)
  }
  return { supersededBy, ambiguous }
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

  // The planner's citations are advisory. The kernel also applies every policy
  // in the capability's governing scopes (or an ancestor scope of one) and every
  // policy that names the actor, so an omitted policy can't be avoided by not citing it.
  const scopes = options.governingScopes ?? []
  const cited = new Set(action.applicablePolicyIds)
  const governs = (p: PolicyRef) =>
    scopes.some((g) => scopeIncludes(p.scope, g)) ||
    (options.actorId !== undefined && (p.appliesToEntityIds ?? []).includes(options.actorId))
  const candidates = policies.filter((p) => cited.has(p.id) || governs(p))
  const candidateIds = new Set(candidates.map((p) => p.id))
  const uncitedPolicyIds = candidates.filter((p) => !cited.has(p.id)).map((p) => p.id)
  const uncited = new Set(uncitedPolicyIds)
  const nameOf = (id: string) => policies.find((p) => p.id === id)?.name ?? id

  // Supersession cycles among live candidates: never silently pick one.
  const liveCandidates = candidates.filter((p) => isPolicyLive(p, now))
  const liveIds = [...new Set(liveCandidates.map((p) => p.id))]
  const liveById = new Map(liveCandidates.map((p) => [p.id, p]))
  const cycles = findCycles(liveIds, (id) => (liveById.get(id)?.supersedesIds ?? []).filter((s) => s !== id))
  const inCycle = new Map<string, string[]>()
  for (const cycle of cycles) {
    for (const id of cycle.members) inCycle.set(id, cycle.path)
    conflicts.push(
      `Supersession cycle among live policies: ${cycle.path.map(nameOf).join(' → ')}. The kernel will not pick one; a human must decide which applies.`,
    )
  }

  // Versions: within a lineage only the highest live version applies.
  const lineages = resolveLineages(policies, now)
  for (const [lineage, message] of lineages.ambiguous) {
    if (liveCandidates.some((p) => p.lineageId === lineage)) conflicts.push(message)
  }
  const outOfScopeVersions = new Map<string, PolicyRef>()

  // Structured policies that survive their own conditions, with their effective effect.
  const effective = new Map<string, PolicyEffect>()

  for (const policy of candidates) {
    if (isExpired(policy, now)) {
      checks.push({ policyId: policy.id, policyName: policy.name, result: 'inapplicable', reasonCode: 'expired', reason: `Expired on ${policy.expirationDate}` })
      continue
    }
    if (isNotYetEffective(policy, now)) {
      checks.push({ policyId: policy.id, policyName: policy.name, result: 'inapplicable', reasonCode: 'not-yet-effective', reason: `Not effective until ${policy.effectiveDate}` })
      continue
    }
    const cycle = inCycle.get(policy.id)
    if (cycle) {
      checks.push({
        policyId: policy.id,
        policyName: policy.name,
        result: 'conflicts',
        reasonCode: 'supersession-cycle',
        reason: `In a supersession cycle (${cycle.map(nameOf).join(' → ')}); not applied until a human resolves it.`,
      })
      continue
    }
    // A policy is superseded when another live candidate (outside any cycle) lists it in `supersedes`.
    const superseder = liveCandidates.find(
      (other) => other.id !== policy.id && other.supersedesIds.includes(policy.id) && !inCycle.has(other.id),
    )
    if (superseder) {
      checks.push({
        policyId: policy.id,
        policyName: policy.name,
        result: 'superseded',
        reasonCode: 'superseded-by-id',
        supersededById: superseder.id,
        reason: `Superseded by ${superseder.name}.`,
      })
      continue
    }
    const newer = lineages.supersededBy.get(policy.id)
    if (newer) {
      const governsHere = candidateIds.has(newer.id)
      checks.push({
        policyId: policy.id,
        policyName: policy.name,
        result: 'superseded',
        reasonCode: 'superseded-by-version',
        supersededById: newer.id,
        reason: `Superseded by newer version ${newer.version} of lineage "${policy.lineageId}" (${newer.name}).${governsHere ? '' : ' That version does not govern this action.'}`,
      })
      if (!governsHere) {
        outOfScopeVersions.set(newer.id, newer)
        approvalReasons.push(
          `${policy.name} (version ${policy.version}) governs this action but its newer version ${newer.name} (version ${newer.version}) does not; a human must confirm the rule no longer applies here.`,
        )
      }
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
              reasonCode: 'conditions-not-met',
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
      reasonCode: 'applies',
      reason: policy.effect
        ? `Scope "${policy.scope}" applies; effect ${effective.get(policy.id)}.`
        : `Scope "${policy.scope}" applies to this action.`,
    })
    applicablePolicyIds.push(policy.id)
  }

  for (const newest of outOfScopeVersions.values()) {
    checks.push({
      policyId: newest.id,
      policyName: newest.name,
      result: 'inapplicable',
      reasonCode: 'out-of-scope',
      reason: `Newest version of lineage "${newest.lineageId}", but its scope "${newest.scope}" does not govern this action and the planner did not cite it.`,
    })
  }

  // Group applicable policies by scope.
  const byScope = new Map<string, PolicyRef[]>()
  for (const p of policies.filter((x) => applicablePolicyIds.includes(x.id))) {
    const group = byScope.get(p.scope) ?? []
    group.push(p)
    byScope.set(p.scope, group)
  }

  // Per scope: the prevailing structured effect and any priority-loosening reason.
  const prevailingByScope = new Map<string, PolicyEffect>()
  const priorityApprovals = new Map<string, string[]>()

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
          priorityApprovals.set(scope, [
            `${winner.name} would loosen a stricter policy in scope "${scope}" by priority alone; a human must confirm.`,
          ])
        }
      }
    }
    prevailingByScope.set(scope, prevailing)
  }

  // Scope nesting: a more specific scope decides over its ancestors, but may
  // never silently loosen them. An ancestor with an applicable descendant does
  // not emit its own reason; each descendant either restates it (at least as
  // restrictive) or triggers a loosening approval.
  const suppressed = new Set<string>()
  const nestingApprovals = new Map<string, string[]>()
  const scopeList = [...byScope.keys()]
  for (const ancestor of scopeList) {
    for (const descendant of scopeList) {
      if (ancestor === descendant || !scopeIncludes(ancestor, descendant)) continue
      const aGroup = byScope.get(ancestor)!
      const dGroup = byScope.get(descendant)!
      if (aGroup.some((p) => !effective.has(p.id)) || dGroup.some((p) => !effective.has(p.id))) {
        conflicts.push(
          `Policies in nested scopes "${ancestor}" and "${descendant}" include free-text rules; a human must reconcile them: ${[...aGroup, ...dGroup].map((p) => p.name).join(', ')}.`,
        )
      }
      const pa = prevailingByScope.get(ancestor)
      const pd = prevailingByScope.get(descendant)
      if (pa === undefined || pd === undefined) continue
      suppressed.add(ancestor)
      if (pa === pd) continue
      if (RESTRICTIVENESS[pd] > RESTRICTIVENESS[pa]) {
        resolutions.push(`More specific scope "${descendant}" (${pd}) prevails over ancestor scope "${ancestor}" (${pa}).`)
      } else {
        resolutions.push(`More specific scope "${descendant}" (${pd}) would loosen ancestor scope "${ancestor}" (${pa}).`)
        const list = nestingApprovals.get(descendant) ?? []
        list.push(
          `Policy in more specific scope "${descendant}" (${pd}) would loosen ancestor scope "${ancestor}" (${pa}); a human must confirm.`,
        )
        nestingApprovals.set(descendant, list)
      }
    }
  }

  for (const scope of scopeList) {
    approvalReasons.push(...(priorityApprovals.get(scope) ?? []))
    const prevailing = prevailingByScope.get(scope)
    if (prevailing !== undefined && !suppressed.has(scope)) {
      if (prevailing === 'deny') {
        blockingReasons.push(`Policy in scope "${scope}" denies this action.`)
      } else if (prevailing === 'require-approval') {
        approvalReasons.push(`Policy in scope "${scope}" requires human approval.`)
      }
    }
    // A suppressed ancestor's restriction is carried by its descendants: each
    // either restates it (at least as restrictive) or adds a loosening approval.
    approvalReasons.push(...(nestingApprovals.get(scope) ?? []))
  }

  // A governing policy the planner left out applies with its full effect; when it
  // is free-text (no structured effect) a human must confirm it was honored.
  for (const id of applicablePolicyIds) {
    if (uncited.has(id) && !effective.has(id)) {
      const p = policies.find((x) => x.id === id)!
      approvalReasons.push(`${p.name} governs this action but was not cited by the planner; a human must confirm it is satisfied.`)
    }
  }
  for (const c of checks) {
    if (uncited.has(c.policyId)) c.reason = `Added by the kernel (not cited by the planner). ${c.reason}`
  }

  return { checks, conflicts, applicablePolicyIds, blockingReasons, approvalReasons, resolutions, uncitedPolicyIds }
}

// ── Policy set validation (pure) ────────────────────────────────────────────

export type PolicySetProblemCode =
  | 'duplicate-policy-id'
  | 'supersession-cycle'
  | 'unknown-superseded-policy'
  | 'invalid-version'
  | 'version-without-lineage'
  | 'lineage-missing-version'
  | 'duplicate-lineage-version'
  | 'supersession-against-version-order'
  | 'partial-lineage-supersession'

export interface PolicySetProblem {
  severity: 'error' | 'warning'
  code: PolicySetProblemCode
  policyIds: string[]
  message: string
}

/**
 * Check a policy set for problems a human should fix. Pure and deterministic;
 * it does not consider dates (a problem in a future policy is still a problem).
 *
 * Errors:
 *   - duplicate-policy-id
 *   - supersession-cycle: A supersedes B supersedes A, any length (including
 *     a policy superseding itself). At authorize time a cycle among live
 *     candidates routes to a human.
 *   - invalid-version: `version` present but not a positive integer.
 *   - lineage-missing-version: a lineage with two or more policies where some
 *     lack a valid version, so the current one cannot be determined.
 *   - duplicate-lineage-version: two policies in one lineage with one version.
 *   - supersession-against-version-order: a policy explicitly supersedes a
 *     HIGHER version of its own lineage. Its `supersedesIds` and the version
 *     numbers disagree about which is current.
 * Warnings:
 *   - unknown-superseded-policy: `supersedesIds` names a policy not in the
 *     set (it may simply live elsewhere or have been deleted).
 *   - version-without-lineage: a version on a policy with no lineage has
 *     nothing to be ordered against.
 *   - partial-lineage-supersession: A supersedes B, B belongs to another
 *     lineage, and that lineage has a newer version A does not supersede. It
 *     is unclear whether A retires the whole rule or only the old version.
 *
 * Deliberately NOT flagged, because they are unambiguous:
 *   - superseding a policy in another scope (supersession is about rule
 *     identity, not scope; scope only decides what governs an action);
 *   - superseding the newest version of another lineage (one rule replaces
 *     another), or a lower version of one's own lineage (redundant with the
 *     version order, but consistent with it);
 *   - superseding an expired policy (harmless history).
 */
export function validatePolicySet(policies: PolicyRef[]): PolicySetProblem[] {
  const problems: PolicySetProblem[] = []
  const byId = new Map<string, PolicyRef>()
  for (const p of policies) {
    if (byId.has(p.id)) {
      problems.push({ severity: 'error', code: 'duplicate-policy-id', policyIds: [p.id], message: `Policy id "${p.id}" appears more than once.` })
      continue
    }
    byId.set(p.id, p)
  }
  const ids = [...byId.keys()]
  const nameOf = (id: string) => byId.get(id)?.name ?? id

  for (const cycle of findCycles(ids, (id) => byId.get(id)!.supersedesIds ?? [])) {
    problems.push({
      severity: 'error',
      code: 'supersession-cycle',
      policyIds: cycle.members,
      message: `Supersession cycle: ${cycle.path.map(nameOf).join(' → ')}.`,
    })
  }

  for (const p of byId.values()) {
    for (const target of p.supersedesIds ?? []) {
      if (!byId.has(target)) {
        problems.push({
          severity: 'warning',
          code: 'unknown-superseded-policy',
          policyIds: [p.id],
          message: `${p.name} supersedes "${target}", which is not in the policy set.`,
        })
      }
    }
    if (p.version !== undefined && p.version !== null && !isValidPolicyVersion(p.version)) {
      problems.push({
        severity: 'error',
        code: 'invalid-version',
        policyIds: [p.id],
        message: `${p.name} has version ${String(p.version)}; a version must be a positive integer.`,
      })
    }
    if (!p.lineageId && isValidPolicyVersion(p.version)) {
      problems.push({
        severity: 'warning',
        code: 'version-without-lineage',
        policyIds: [p.id],
        message: `${p.name} has version ${p.version} but no lineage, so there is nothing to order it against.`,
      })
    }
  }

  const byLineage = new Map<string, PolicyRef[]>()
  for (const p of byId.values()) {
    if (!p.lineageId) continue
    byLineage.set(p.lineageId, [...(byLineage.get(p.lineageId) ?? []), p])
  }
  for (const [lineage, members] of byLineage) {
    if (members.length < 2) continue
    const unversioned = members.filter((m) => !isValidPolicyVersion(m.version))
    if (unversioned.length > 0) {
      problems.push({
        severity: 'error',
        code: 'lineage-missing-version',
        policyIds: unversioned.map((m) => m.id),
        message: `Lineage "${lineage}" has policies without a valid version: ${unversioned.map((m) => m.name).join(', ')}.`,
      })
    }
    const byVersion = new Map<number, PolicyRef[]>()
    for (const m of members) {
      if (!isValidPolicyVersion(m.version)) continue
      byVersion.set(m.version, [...(byVersion.get(m.version) ?? []), m])
    }
    for (const [version, same] of byVersion) {
      if (same.length > 1) {
        problems.push({
          severity: 'error',
          code: 'duplicate-lineage-version',
          policyIds: same.map((m) => m.id),
          message: `Lineage "${lineage}" has ${same.length} policies at version ${version}: ${same.map((m) => m.name).join(', ')}.`,
        })
      }
    }
  }

  for (const p of byId.values()) {
    for (const targetId of p.supersedesIds ?? []) {
      const target = byId.get(targetId)
      if (!target || target.id === p.id || !target.lineageId) continue
      if (target.lineageId === p.lineageId) {
        if (isValidPolicyVersion(p.version) && isValidPolicyVersion(target.version) && p.version < target.version) {
          problems.push({
            severity: 'error',
            code: 'supersession-against-version-order',
            policyIds: [p.id, target.id],
            message: `${p.name} (version ${p.version}) supersedes ${target.name} (version ${target.version}) in the same lineage "${p.lineageId}"; supersession and version order disagree.`,
          })
        }
        continue
      }
      if (!isValidPolicyVersion(target.version)) continue
      const newer = (byLineage.get(target.lineageId) ?? []).filter(
        (m) => isValidPolicyVersion(m.version) && m.version > (target.version as number) && !(p.supersedesIds ?? []).includes(m.id),
      )
      if (newer.length > 0) {
        problems.push({
          severity: 'warning',
          code: 'partial-lineage-supersession',
          policyIds: [p.id, target.id, ...newer.map((m) => m.id)],
          message: `${p.name} supersedes ${target.name} (version ${target.version} of lineage "${target.lineageId}") but not its newer version(s) ${newer.map((m) => `${m.name} (version ${m.version})`).join(', ')}; it is unclear whether the whole rule is retired.`,
        })
      }
    }
  }

  return problems
}
