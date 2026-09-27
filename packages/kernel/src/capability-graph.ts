import type { CapabilityRef, EntityRef, RiskLevel } from './types.ts'
import { findCycles } from './graph-cycles.ts'
import { applySoleOperatorOverride } from './identity/separation.ts'

/**
 * Capability graph (M7). Deterministic and pure; no LLM.
 *
 * Four optional fields on a capability. With none set, a capability resolves
 * to exactly its own scopes and base risk, multiplier 1, and no dependencies
 * or conflicts, so existing behavior is unchanged.
 *
 * `inherits` — constraints flow down, rights never do.
 *   A child (e.g. `payments.refund-large`) inherits from its parents
 *   (`payments.refund`):
 *     - governing policy scopes: the union of its own and every ancestor's,
 *       so a policy on the parent also governs the child;
 *     - a base-risk floor: effective base risk = max(own, every ancestor's);
 *     - risk multipliers: the product of its own and every distinct
 *       ancestor's (each ancestor counted once, even through a diamond);
 *     - dependencies (`requires`) and conflicts (`conflictsWith`): a child is
 *       at least as constrained as its parents.
 *   Inheritance NEVER grants a permission. Holding the broader parent does not
 *   let an actor use the narrower child, and holding the child does not let
 *   an actor use the parent. The actor must hold the exact capability used
 *   (see capability.ts). Letting a broad grant imply narrower, riskier ones
 *   is how privilege creeps; the safe direction is that only restrictions
 *   are inherited.
 *
 * `requires` — to use X the actor must also hold every capability X requires,
 *   transitively (X requires Y requires Z → the actor must hold Y and Z).
 *   "Hold" means the same as for X itself: in the actor's profile AND granted
 *   to the actor by the capability.
 *
 * `conflictsWith` — the same actor may not hold both. Declared on either side
 *   (the relation is symmetric) and inherited (a conflict with a parent is a
 *   conflict with its children). For conflicts, "hold" is broader: in the
 *   actor's profile OR granted to the actor, so a half-recorded grant cannot
 *   hide a conflict. At authorize time an actor holding conflicting
 *   capabilities is refused for either one, unless the separation-of-duties
 *   sole-operator override applies (identity/separation.ts: the configured
 *   sole operator, acting as themselves, with a written justification). An
 *   override is stamped in the decision record and still sends the action to
 *   a human; it never runs autonomously. `validateCapabilityGraph(caps,
 *   entities)` reports conflicting holdings in the company model.
 *
 * `riskMultiplier` — finite and >= 1 (default 1). The action's computed risk
 *   (risk.ts, already clamped to 0-5) is multiplied by the effective
 *   multiplier, rounded UP to the next whole level, and clamped to 0-5, before
 *   any policy sees it. Rounding up is the conservative choice: any
 *   multiplier above 1 raises a nonzero risk by at least one level (1.1 × 2 →
 *   3). A tiny epsilon keeps float noise from rounding an exact product up
 *   (1.5 × 2 = 3, not 4).
 *
 * Fail closed. `validateCapabilityGraph` reports inheritance cycles, requires
 * cycles, unknown ids, a capability that requires one it conflicts with, a
 * conflict with itself, invalid multipliers and duplicate ids. authorize()
 * refuses an action whose capability, any ancestor, or any transitive
 * requirement is named in one of these problems.
 */

export type CapabilityGraphProblemCode =
  | 'duplicate-id'
  | 'unknown-reference'
  | 'inheritance-cycle'
  | 'requires-cycle'
  | 'requires-and-conflicts'
  | 'conflicts-with-self'
  | 'invalid-multiplier'
  | 'conflicting-holdings'

export interface CapabilityGraphProblem {
  severity: 'error'
  code: CapabilityGraphProblemCode
  /** Capabilities the problem is about. */
  capabilityIds: string[]
  /** For `conflicting-holdings`: the entity holding both. */
  entityId?: string
  message: string
}

export interface ResolvedCapability {
  id: string
  name: string
  /** Every transitive parent, nearest first (breadth-first, declaration order). */
  ancestors: string[]
  /** Own policy scopes plus every ancestor's, deduplicated, own first. */
  effectiveScopes: string[]
  ownBaseRiskLevel: RiskLevel
  /** max(own, every ancestor's) base risk. */
  effectiveBaseRiskLevel: RiskLevel
  /** Product of own and every distinct ancestor's multiplier (invalid ones count as 1; they block anyway). */
  riskMultiplier: number
  /** Required by this capability or an ancestor, directly. */
  directRequires: string[]
  /** Transitive closure of `directRequires` (excluding the capability itself). */
  transitiveRequires: string[]
  /** Symmetric, inherited conflicts. */
  conflictsWith: string[]
}

export interface CapabilityGraph {
  capabilities: Map<string, ResolvedCapability>
  problems: CapabilityGraphProblem[]
}

const list = (xs: string[] | null | undefined): string[] => [...new Set((xs ?? []).filter((x) => typeof x === 'string' && x.length > 0))]

function isValidMultiplier(m: unknown): boolean {
  return m === undefined || m === null || (typeof m === 'number' && Number.isFinite(m) && m >= 1)
}

/** Multiply a computed risk, round up (conservatively), and clamp to 0-5. */
export function applyRiskMultiplier(risk: RiskLevel, multiplier: number): RiskLevel {
  if (!Number.isFinite(multiplier) || multiplier <= 1) return risk
  const scaled = Math.ceil(risk * multiplier - 1e-9)
  return Math.max(0, Math.min(5, scaled)) as RiskLevel
}

/** Capability-level problems (no entities). */
function capabilityProblems(capabilities: CapabilityRef[], resolved: Map<string, ResolvedCapability>): CapabilityGraphProblem[] {
  const problems: CapabilityGraphProblem[] = []
  const byId = new Map<string, CapabilityRef>()
  for (const c of capabilities) {
    if (byId.has(c.id)) {
      problems.push({ severity: 'error', code: 'duplicate-id', capabilityIds: [c.id], message: `Capability id "${c.id}" appears more than once.` })
      continue
    }
    byId.set(c.id, c)
  }
  const ids = [...byId.keys()]
  const nameOf = (id: string) => byId.get(id)?.name ?? id

  for (const c of byId.values()) {
    for (const [field, refs] of [['inherits', c.inherits], ['requires', c.requires], ['conflictsWith', c.conflictsWith]] as const) {
      for (const ref of list(refs)) {
        if (!byId.has(ref)) {
          problems.push({
            severity: 'error',
            code: 'unknown-reference',
            capabilityIds: [c.id],
            message: `${c.name} lists "${ref}" in ${field}, but no such capability exists.`,
          })
        }
      }
    }
    if (!isValidMultiplier(c.riskMultiplier)) {
      problems.push({
        severity: 'error',
        code: 'invalid-multiplier',
        capabilityIds: [c.id],
        message: `${c.name} has risk multiplier ${String(c.riskMultiplier)}; it must be a finite number of at least 1.`,
      })
    }
    if (list(c.conflictsWith).includes(c.id)) {
      problems.push({ severity: 'error', code: 'conflicts-with-self', capabilityIds: [c.id], message: `${c.name} conflicts with itself, so no one could ever use it.` })
    }
  }

  for (const cycle of findCycles(ids, (id) => list(byId.get(id)!.inherits))) {
    problems.push({
      severity: 'error',
      code: 'inheritance-cycle',
      capabilityIds: cycle.members,
      message: `Inheritance cycle: ${cycle.path.map(nameOf).join(' → ')}.`,
    })
  }
  for (const cycle of findCycles(ids, (id) => resolved.get(id)?.directRequires ?? [])) {
    problems.push({
      severity: 'error',
      code: 'requires-cycle',
      capabilityIds: cycle.members,
      message: `Dependency cycle: ${cycle.path.map(nameOf).join(' → ')}.`,
    })
  }

  for (const r of resolved.values()) {
    const both = r.transitiveRequires.filter((id) => r.conflictsWith.includes(id))
    if (both.length > 0) {
      problems.push({
        severity: 'error',
        code: 'requires-and-conflicts',
        capabilityIds: [r.id, ...both],
        message: `${r.name} both requires and conflicts with ${both.map(nameOf).join(', ')}, so no one could ever use it.`,
      })
    }
  }
  return problems
}

/** Resolve every capability's effective view and collect graph problems. */
export function buildCapabilityGraph(capabilities: CapabilityRef[]): CapabilityGraph {
  const byId = new Map<string, CapabilityRef>()
  for (const c of capabilities) if (!byId.has(c.id)) byId.set(c.id, c)

  const ancestorsOf = (id: string): string[] => {
    const seen = new Set<string>([id])
    const out: string[] = []
    const queue = [...list(byId.get(id)?.inherits)]
    while (queue.length > 0) {
      const next = queue.shift()!
      if (seen.has(next) || !byId.has(next)) continue
      seen.add(next)
      out.push(next)
      queue.push(...list(byId.get(next)!.inherits))
    }
    return out
  }

  // Direct conflicts made symmetric.
  const symmetric = new Map<string, Set<string>>()
  const addConflict = (a: string, b: string) => {
    if (!symmetric.has(a)) symmetric.set(a, new Set())
    symmetric.get(a)!.add(b)
  }
  for (const c of byId.values()) {
    for (const other of list(c.conflictsWith)) {
      if (!byId.has(other)) continue
      addConflict(c.id, other)
      addConflict(other, c.id)
    }
  }

  const partial = new Map<string, Omit<ResolvedCapability, 'transitiveRequires'>>()
  for (const c of byId.values()) {
    const ancestors = ancestorsOf(c.id)
    const chain = [c, ...ancestors.map((a) => byId.get(a)!)]
    const effectiveScopes = [...new Set(chain.flatMap((x) => list(x.policyScopes)))]
    // Same default as risk.ts for a capability without a base risk.
    const baseOf = (x: CapabilityRef) => (typeof x.baseRiskLevel === 'number' && Number.isFinite(x.baseRiskLevel) ? x.baseRiskLevel : 2)
    const effectiveBase = Math.max(...chain.map(baseOf))
    const riskMultiplier = chain.reduce(
      (product, x) => product * (isValidMultiplier(x.riskMultiplier) && typeof x.riskMultiplier === 'number' ? x.riskMultiplier : 1),
      1,
    )
    const directRequires = [...new Set(chain.flatMap((x) => list(x.requires)))].filter((r) => r !== c.id && byId.has(r))
    const conflictsWith = [...new Set(chain.flatMap((x) => [...(symmetric.get(x.id) ?? [])]))]
    partial.set(c.id, {
      id: c.id,
      name: c.name,
      ancestors,
      effectiveScopes,
      ownBaseRiskLevel: baseOf(c) as RiskLevel,
      effectiveBaseRiskLevel: Math.max(0, Math.min(5, effectiveBase)) as RiskLevel,
      riskMultiplier,
      directRequires,
      conflictsWith,
    })
  }

  // Inherited conflicts made symmetric again (a conflict with a parent is a conflict with its children).
  for (const r of partial.values()) {
    for (const other of r.conflictsWith) {
      const o = partial.get(other)
      if (o && !o.conflictsWith.includes(r.id)) o.conflictsWith.push(r.id)
    }
  }

  const resolved = new Map<string, ResolvedCapability>()
  for (const r of partial.values()) {
    const seen = new Set<string>([r.id])
    const transitive: string[] = []
    const queue = [...r.directRequires]
    while (queue.length > 0) {
      const next = queue.shift()!
      if (seen.has(next)) continue
      seen.add(next)
      transitive.push(next)
      queue.push(...(partial.get(next)?.directRequires ?? []))
    }
    resolved.set(r.id, { ...r, conflictsWith: r.conflictsWith.filter((x) => x !== r.id), transitiveRequires: transitive })
  }

  return { capabilities: resolved, problems: capabilityProblems(capabilities, resolved) }
}

/**
 * Validate the capability graph; with `entities`, also report any entity
 * holding two conflicting capabilities (the company-model check).
 */
export function validateCapabilityGraph(capabilities: CapabilityRef[], entities: EntityRef[] = []): CapabilityGraphProblem[] {
  const graph = buildCapabilityGraph(capabilities)
  const problems = [...graph.problems]
  for (const entity of entities) {
    const held = heldForConflicts(entity, capabilities)
    const reported = new Set<string>()
    for (const id of held) {
      for (const other of graph.capabilities.get(id)?.conflictsWith ?? []) {
        if (!held.includes(other)) continue
        const key = [id, other].sort().join('|')
        if (reported.has(key)) continue
        reported.add(key)
        problems.push({
          severity: 'error',
          code: 'conflicting-holdings',
          capabilityIds: [id, other].sort(),
          entityId: entity.id,
          message: `${entity.name} holds conflicting capabilities ${[id, other].sort().join(' and ')}.`,
        })
      }
    }
  }
  return problems
}

/** Problems that make `capabilityId` unusable: about it, an ancestor, or a transitive requirement. */
export function graphProblemsFor(graph: CapabilityGraph, capabilityId: string): CapabilityGraphProblem[] {
  const r = graph.capabilities.get(capabilityId)
  const relevant = new Set([capabilityId, ...(r?.ancestors ?? []), ...(r?.transitiveRequires ?? [])])
  return graph.problems.filter((p) => p.code !== 'conflicting-holdings' && p.capabilityIds.some((id) => relevant.has(id)))
}

/** Capabilities the entity holds for conflict purposes: in its profile OR granted to it. */
function heldForConflicts(entity: EntityRef, capabilities: CapabilityRef[]): string[] {
  const ids = new Set(entity.capabilityIds)
  for (const c of capabilities) if ((c.authorizedEntityIds ?? []).includes(entity.id)) ids.add(c.id)
  return [...ids].sort()
}

/** Held for use: in the profile AND granted (the same test as the capability itself). */
function heldForUse(entity: EntityRef, capability: CapabilityRef | undefined): boolean {
  return Boolean(capability) && entity.capabilityIds.includes(capability!.id) && (capability!.authorizedEntityIds ?? []).includes(entity.id)
}

export interface SeparationSettings {
  /** Configured sole operator for single-human organizations (off when unset). */
  soleOperatorId?: string | null
  /** Written justification; required for a sole-operator override. */
  justification?: string | null
}

/** What the capability graph found for one action, for the decision record. */
export interface CapabilityGraphFinding {
  capabilityId: string
  /** Scopes whose policies govern the action (own plus inherited). */
  effectiveScopes: string[]
  /** Ancestors whose constraints were inherited. */
  inheritedFrom: string[]
  /** Effective base risk (the inheritance floor applied). */
  baseRiskLevel: RiskLevel
  /** Risk multiplier applied to the computed risk (1 = none). */
  riskMultiplier: number
  /** Computed risk before and after the multiplier (filled in by authorize()). */
  riskBeforeMultiplier?: RiskLevel
  riskAfterMultiplier?: RiskLevel
  /** Every capability the action transitively requires, and those the actor lacks. */
  requires: string[]
  missingRequires: string[]
  /** Conflicting capabilities the actor holds. */
  conflictsHeld: string[]
  /** True when the sole operator waived a conflict with a written justification. */
  soleOperatorOverride: boolean
  /** Graph problems that make this capability unusable. */
  problems: string[]
}

export interface CapabilityGraphCheck {
  /** Reasons the action is refused (graph problems, missing requirements, conflicts). */
  blockingReasons: string[]
  /** Reasons a human must review (a sole-operator conflict override). */
  concerns: string[]
  finding: CapabilityGraphFinding | null
}

/**
 * The graph part of the capability check for one action. Returns no finding
 * when the capability is not in the model (checkCapability reports that).
 */
export function checkCapabilityGraph(
  actor: EntityRef,
  capabilityId: string,
  capabilities: CapabilityRef[],
  graph: CapabilityGraph = buildCapabilityGraph(capabilities),
  separation: SeparationSettings = {},
): CapabilityGraphCheck {
  const resolved = graph.capabilities.get(capabilityId)
  if (!resolved) return { blockingReasons: [], concerns: [], finding: null }
  const byId = new Map<string, CapabilityRef>()
  for (const c of capabilities) if (!byId.has(c.id)) byId.set(c.id, c)
  const nameOf = (id: string) => byId.get(id)?.name ?? id

  const blockingReasons: string[] = []
  const concerns: string[] = []

  const problems = graphProblemsFor(graph, capabilityId).map((p) => p.message)
  if (problems.length > 0) {
    blockingReasons.push(`Capability "${resolved.name}" cannot be used while the capability graph is invalid: ${problems.join(' ')}`)
  }

  const missingRequires = resolved.transitiveRequires.filter((id) => !heldForUse(actor, byId.get(id)))
  if (missingRequires.length > 0) {
    blockingReasons.push(
      `Capability "${resolved.name}" requires ${missingRequires.map((id) => `"${nameOf(id)}"`).join(', ')}, which ${actor.name} does not hold.`,
    )
  }

  const held = heldForConflicts(actor, capabilities)
  const conflictsHeld = resolved.conflictsWith.filter((id) => held.includes(id))
  let soleOperatorOverride = false
  if (conflictsHeld.length > 0) {
    const conflict = `${actor.name} holds "${resolved.name}" and conflicting ${conflictsHeld.map((id) => `"${nameOf(id)}"`).join(', ')}.`
    const sod = applySoleOperatorOverride({
      personId: actor.id,
      conflicts: [conflict],
      soleOperatorId: separation.soleOperatorId,
      justification: separation.justification,
      strictReason: 'Separation of duties: the same actor may not hold conflicting capabilities; either one is refused.',
    })
    if (sod.allowed) {
      soleOperatorOverride = true
      concerns.push(`Separation of duties waived by the sole operator: ${conflict} A human must confirm.`)
    } else {
      blockingReasons.push(sod.reasons.join(' '))
    }
  }

  return {
    blockingReasons,
    concerns,
    finding: {
      capabilityId,
      effectiveScopes: resolved.effectiveScopes,
      inheritedFrom: resolved.ancestors,
      baseRiskLevel: resolved.effectiveBaseRiskLevel,
      riskMultiplier: resolved.riskMultiplier,
      requires: resolved.transitiveRequires,
      missingRequires,
      conflictsHeld,
      soleOperatorOverride,
      problems,
    },
  }
}
