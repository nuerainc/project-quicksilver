import type { CapabilityRef, EntityRef, EntityType, PolicyCheck, PolicyEffect, PolicyRef, RiskLevel } from './types.ts'
import { conditionFromSanity, type SanityGuardCondition } from './process-document.ts'
import { buildCapabilityGraph } from './capability-graph.ts'

/**
 * Company-model documents (Sanity) → kernel inputs, for callers that build
 * authorize() inputs from Sanity (the web plan route). Pure; the caller runs
 * the queries.
 *
 * Loading strategy (M7):
 *   1. ALL capabilities (CAPABILITIES_QUERY). Conflicts are symmetric and may
 *      be declared only on the other capability, and conflict holding counts
 *      every capability granted to the actor, so a closure walk from the
 *      action's capability would miss them. Company models are small (tens of
 *      capabilities), so one query is simpler and cannot under-fetch.
 *   2. The actor (ENTITY_QUERY): its capability ids, for requirements and conflicts.
 *   3. Policies (POLICIES_QUERY): cited ones, every policy whose scope is one
 *      of the capability's effective scopes (own plus inherited) OR an ancestor
 *      of one (`finance` reaches `finance.payments`), every policy naming the
 *      actor, and every lineage sibling of those, so version resolution sees
 *      the newest version even when it moved scope.
 *
 * Every query is parameterized; nothing is interpolated into GROQ.
 */

export const CAPABILITIES_QUERY = `*[_type == "capability"]{ _id, name, riskLevel, "authorizedEntityIds": authorizedEntities[]._ref, policyScopes, "inheritsIds": inherits[]._ref, "requiresIds": requires[]._ref, "conflictsWithIds": conflictsWith[]._ref, riskMultiplier }`

export const ENTITY_QUERY = `*[_type == "entity" && _id == $id][0]{ _id, name, entityType, "capabilityIds": capabilities[]._ref }`

const POLICY_GOVERNS = `(_id in $ids || scope in $scopes || $actorId in appliesTo[]._ref)`

export const POLICIES_QUERY = `*[_type == "policy" && (${POLICY_GOVERNS} || (defined(lineageId) && lineageId in *[_type == "policy" && ${POLICY_GOVERNS} && defined(lineageId)].lineageId))]{ _id, _rev, name, scope, priority, "appliesToEntityIds": appliesTo[]._ref, effectiveDate, expirationDate, "supersedesIds": supersedes[]._ref, "approvalRequirementIds": approvalRequirements[]._ref, effect, maxRiskLevel, whenAll, version, lineageId }`

export interface SanityCapabilityDocument {
  _id: string
  name: string
  riskLevel?: number | null
  authorizedEntityIds?: string[] | null
  policyScopes?: string[] | null
  inheritsIds?: string[] | null
  requiresIds?: string[] | null
  conflictsWithIds?: string[] | null
  riskMultiplier?: number | null
}

export interface SanityEntityDocument {
  _id: string
  name: string
  entityType: string
  capabilityIds?: string[] | null
}

export interface SanityPolicyDocument {
  _id: string
  _rev: string
  name: string
  scope: string
  priority: number
  effectiveDate?: string | null
  expirationDate?: string | null
  supersedesIds?: string[] | null
  approvalRequirementIds?: string[] | null
  appliesToEntityIds?: string[] | null
  effect?: PolicyEffect | null
  maxRiskLevel?: number | null
  whenAll?: SanityGuardCondition[] | null
  version?: number | null
  lineageId?: string | null
}

const ids = (xs: Array<string | null> | null | undefined): string[] => (xs ?? []).filter((x): x is string => typeof x === 'string' && x.length > 0)

export function entityFromSanity(doc: SanityEntityDocument): EntityRef {
  return { id: doc._id, name: doc.name, entityType: doc.entityType as EntityType, capabilityIds: doc.capabilityIds ?? [] }
}

/** Graph fields are included only when set, so a capability without them is unchanged. */
export function capabilityFromSanity(doc: SanityCapabilityDocument): CapabilityRef {
  const inherits = ids(doc.inheritsIds)
  const requires = ids(doc.requiresIds)
  const conflictsWith = ids(doc.conflictsWithIds)
  return {
    id: doc._id,
    name: doc.name,
    baseRiskLevel: (doc.riskLevel ?? 2) as RiskLevel,
    authorizedEntityIds: doc.authorizedEntityIds ?? [],
    policyScopes: doc.policyScopes ?? [],
    ...(inherits.length ? { inherits } : {}),
    ...(requires.length ? { requires } : {}),
    ...(conflictsWith.length ? { conflictsWith } : {}),
    // Passed through as stored (even if invalid) so the graph check can fail closed on it.
    ...(typeof doc.riskMultiplier === 'number' ? { riskMultiplier: doc.riskMultiplier } : {}),
  }
}

export function policyFromSanity(doc: SanityPolicyDocument): PolicyRef {
  return {
    id: doc._id,
    name: doc.name,
    scope: doc.scope,
    priority: doc.priority,
    effectiveDate: doc.effectiveDate ?? undefined,
    expirationDate: doc.expirationDate ?? undefined,
    supersedesIds: doc.supersedesIds ?? [],
    approvalRequirementIds: doc.approvalRequirementIds ?? [],
    appliesToEntityIds: doc.appliesToEntityIds ?? [],
    effect: doc.effect ?? null,
    maxRiskLevel: typeof doc.maxRiskLevel === 'number' ? (doc.maxRiskLevel as RiskLevel) : null,
    when: doc.whenAll?.length ? { all: doc.whenAll.map(conditionFromSanity) } : null,
    // Passed through as stored (even if invalid) so the kernel treats the lineage as ambiguous.
    ...(typeof doc.version === 'number' ? { version: doc.version } : {}),
    ...(typeof doc.lineageId === 'string' && doc.lineageId.trim() ? { lineageId: doc.lineageId.trim() } : {}),
  }
}

/** Each scope plus every dot-separated ancestor (`a.b.c` → `a`, `a.b`, `a.b.c`), sorted and unique. */
export function scopesWithAncestors(scopes: string[]): string[] {
  const out = new Set<string>()
  for (const scope of scopes) {
    if (!scope) continue
    out.add(scope) // exact match, as before M7, even for an oddly formed scope
    const parts = scope.split('.')
    for (let i = 1; i < parts.length; i += 1) {
      const head = parts.slice(0, i)
      if (head.every((p) => p !== '')) out.add(head.join('.'))
    }
  }
  return [...out].sort()
}

/**
 * The `$scopes` parameter for POLICIES_QUERY: the capability's effective
 * scopes (own plus inherited through the graph) and all their ancestors.
 */
export function policyScopesToFetch(capabilityId: string, capabilities: CapabilityRef[]): string[] {
  const resolved = buildCapabilityGraph(capabilities).capabilities.get(capabilityId)
  return scopesWithAncestors(resolved?.effectiveScopes ?? [])
}

/**
 * Policy ids a decision's policy snapshot covers: the policies its audit rows
 * reference. Lineage siblings fetched only for version resolution and never
 * named in a row stay out, so the snapshot matches what the execute and
 * approval routes recompute from the stored rows.
 */
export function snapshotPolicyIds(checks: PolicyCheck[]): string[] {
  return [...new Set(checks.map((c) => c.policyId))].sort()
}
