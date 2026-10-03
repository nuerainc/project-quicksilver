import { authorize, resolveThresholds, type AuthorizeArgs, type AuthorizeResult } from './approval.ts'
import type { PolicyCheck, RiskLevel } from './types.ts'
import { WAES_BLOCK_REASONS } from './waes.ts'

/**
 * The "why" of a decision: everything the kernel already knew when it decided,
 * laid out so a person can follow it, plus the near-miss: what, if changed,
 * would have changed the answer.
 *
 * Nothing here is estimated. The risk lines are the kernel's own components. Each
 * "what would change it" entry is found by changing ONE input and running the same
 * `authorize()` again, so the outcome it reports is the outcome the kernel gives.
 * A requirement the kernel cannot try on its own (new evidence, a new review) is
 * listed as a requirement and marked `simulated: false`.
 */

const RANK: Record<AuthorizeResult['recommendation'], number> = { reject: 0, 'request-approval': 1, 'execute-autonomously': 2 }

export interface WhyRiskLine { label: string; value: number; note?: string }

export interface WhyGuard {
  policyId: string
  policyName: string
  result: PolicyCheck['result']
  reasonCode?: PolicyCheck['reasonCode']
  reason: string
  /** True when the planner named this policy; false means the kernel applied it unprompted. */
  citedByPlanner: boolean
}

export interface WhyChange {
  /** What would have to be different, in one sentence. */
  change: string
  kind: 'action' | 'capability' | 'policy' | 'review' | 'evidence'
  /** True when the kernel ran the changed input; false when it is a stated requirement. */
  simulated: boolean
  /** The kernel's answer to the changed input. Absent when not simulated. */
  outcome?: { recommendation: AuthorizeResult['recommendation']; riskLevel: RiskLevel; blockingReasons: number; concerns: number }
  /** True when the outcome is better than the actual decision. */
  improves: boolean
}

export interface DecisionWhy {
  recommendation: AuthorizeResult['recommendation']
  headline: string
  risk: {
    lines: WhyRiskLine[]
    preMultiplierRisk: RiskLevel
    multiplier: number
    finalRisk: RiskLevel
    autoMax: RiskLevel
    review: RiskLevel
    /** Where the final risk falls against the ceilings. */
    band: 'within-autonomous-ceiling' | 'needs-approval' | 'above-review-ceiling'
  }
  /** Digest of the exact policy revisions that governed this decision. */
  policySnapshot: string
  guards: WhyGuard[]
  uncitedPolicyIds: string[]
  capability: null | {
    effectiveScopes: string[]
    inheritedFrom: string[]
    baseRiskLevel: RiskLevel
    missingRequires: string[]
    conflictsHeld: string[]
    problems: string[]
  }
  /** Why a human is needed (empty when none is). */
  approvalDrivers: string[]
  blockingReasons: string[]
  whatWouldChangeIt: WhyChange[]
}

export function explainWhy(args: AuthorizeArgs, precomputed?: AuthorizeResult): DecisionWhy {
  const result = precomputed ?? authorize(args)
  const { autoMax, review } = resolveThresholds(args.thresholds)
  const rc = result.explanation.riskComponents
  const lines: WhyRiskLine[] = [
    { label: 'Capability base risk', value: rc.baseRisk },
    { label: 'Impact', value: rc.impact, note: `financial tier ${rc.financialImpact}, operational tier ${rc.operationalImpact}; the larger counts` },
    { label: 'Not reversible', value: rc.reversibility },
    { label: 'High uncertainty', value: rc.uncertainty, note: 'uncertainty 4 or 5' },
  ]

  const band: DecisionWhy['risk']['band'] = result.riskLevel > review ? 'above-review-ceiling' : result.riskLevel > autoMax ? 'needs-approval' : 'within-autonomous-ceiling'

  const cited = new Set(args.action.applicablePolicyIds)
  const guards: WhyGuard[] = result.policyChecks.map((c) => ({
    policyId: c.policyId, policyName: c.policyName, result: c.result,
    ...(c.reasonCode ? { reasonCode: c.reasonCode } : {}), reason: c.reason, citedByPlanner: cited.has(c.policyId),
  }))

  const g = result.capabilityGraph
  const capability = g ? {
    effectiveScopes: g.effectiveScopes, inheritedFrom: g.inheritedFrom, baseRiskLevel: g.baseRiskLevel,
    missingRequires: g.missingRequires, conflictsHeld: g.conflictsHeld, problems: g.problems,
  } : null

  const approvalDrivers: string[] = []
  if (result.recommendation === 'request-approval') {
    if (result.riskLevel > autoMax) approvalDrivers.push(`Risk ${result.riskLevel} is above the autonomous ceiling of ${autoMax}.`)
    approvalDrivers.push(...result.concerns)
  }

  const headline = result.recommendation === 'reject'
    ? `Refused: ${result.blockingReasons[0] ?? 'blocked'}${result.blockingReasons.length > 1 ? ` (and ${result.blockingReasons.length - 1} more)` : ''}`
    : result.recommendation === 'request-approval'
      ? `A human must approve this. ${approvalDrivers[0] ?? ''}`.trim()
      : `Allowed to run on its own: risk ${result.riskLevel} is within the autonomous ceiling of ${autoMax}, with no concerns.`

  return {
    recommendation: result.recommendation,
    headline,
    risk: { lines, preMultiplierRisk: rc.preMultiplierRisk, multiplier: rc.multiplier, finalRisk: rc.finalRisk, autoMax, review, band },
    policySnapshot: result.policySnapshot,
    guards,
    uncitedPolicyIds: result.uncitedPolicyIds,
    capability,
    approvalDrivers,
    blockingReasons: result.blockingReasons,
    whatWouldChangeIt: counterfactuals(args, result),
  }
}

type Variant = { change: string; kind: WhyChange['kind']; apply: (a: AuthorizeArgs) => AuthorizeArgs }

function counterfactuals(args: AuthorizeArgs, result: AuthorizeResult): WhyChange[] {
  const { action, actor } = args
  const capability = args.capabilities.find((c) => c.id === action.capabilityId)
  const variants: Variant[] = []
  const withAction = (patch: Partial<AuthorizeArgs['action']>) => (a: AuthorizeArgs): AuthorizeArgs => ({ ...a, action: { ...a.action, ...patch } })

  const requirements: WhyChange[] = []
  if (result.blockingReasons.includes('No evidence supports this action.')) {
    requirements.push({ change: 'Cite at least one piece of evidence that supports the action.', kind: 'evidence', simulated: false, improves: true })
  }
  const waesReasons = new Set(Object.values(WAES_BLOCK_REASONS))
  for (const reason of result.blockingReasons) {
    if (waesReasons.has(reason)) {
      variants.push({ change: `Supply a passing WAES review of this content, made by a different reviewer. (${reason})`, kind: 'review', apply: (a) => ({ ...a, facts: { ...(a.facts ?? {}), 'waes.review': 'pass' } }) })
      break
    }
  }

  if (capability) {
    const holds = actor.capabilityIds.includes(capability.id) && capability.authorizedEntityIds.includes(actor.id)
    if (!holds) {
      variants.push({
        change: `Grant ${actor.name} the capability "${capability.name}".`, kind: 'capability',
        apply: (a) => ({
          ...a,
          actor: { ...a.actor, capabilityIds: [...new Set([...a.actor.capabilityIds, capability.id])] },
          capabilities: a.capabilities.map((c) => (c.id === capability.id ? { ...c, authorizedEntityIds: [...new Set([...c.authorizedEntityIds, a.actor.id])] } : c)),
        }),
      })
    }
  }
  const g = result.capabilityGraph
  for (const missing of g?.missingRequires ?? []) {
    const required = args.capabilities.find((c) => c.id === missing)
    variants.push({
      change: `Grant ${actor.name} the required capability "${required?.name ?? missing}".`, kind: 'capability',
      apply: (a) => ({
        ...a,
        actor: { ...a.actor, capabilityIds: [...new Set([...a.actor.capabilityIds, missing])] },
        capabilities: a.capabilities.map((c) => (c.id === missing ? { ...c, authorizedEntityIds: [...new Set([...c.authorizedEntityIds, a.actor.id])] } : c)),
      }),
    })
  }
  for (const held of g?.conflictsHeld ?? []) {
    const conflicting = args.capabilities.find((c) => c.id === held)
    variants.push({
      change: `Separate duties: ${actor.name} must not also hold "${conflicting?.name ?? held}".`, kind: 'capability',
      apply: (a) => ({ ...a, actor: { ...a.actor, capabilityIds: a.actor.capabilityIds.filter((id) => id !== held) } }),
    })
  }

  if (result.uncitedPolicyIds.length > 0) {
    variants.push({ change: `The planner cites the governing ${result.uncitedPolicyIds.length === 1 ? 'policy' : 'policies'} it left out (${result.uncitedPolicyIds.join(', ')}).`, kind: 'policy', apply: withAction({ applicablePolicyIds: [...new Set([...action.applicablePolicyIds, ...result.uncitedPolicyIds])] }) })
  }

  const rc = result.explanation.riskComponents
  if (!action.reversible) variants.push({ change: 'The action can be undone cleanly (reversible).', kind: 'action', apply: withAction({ reversible: true }) })
  if (action.uncertainty >= 4) variants.push({ change: 'The planner is less uncertain (uncertainty 3 or lower).', kind: 'action', apply: withAction({ uncertainty: 3 }) })
  if (rc.financialImpact > 0 && typeof action.financialExposure === 'number') variants.push({ change: 'The financial exposure stays under 1,000.', kind: 'action', apply: withAction({ financialExposure: 999 }) })
  if (rc.operationalImpact > 0) variants.push({ change: 'The operational impact is 1 or lower.', kind: 'action', apply: withAction({ operationalImpact: 1 }) })

  const tried = variants.map((v) => ({ v, outcome: authorize(v.apply(args)) }))
  const better = (o: AuthorizeResult) => RANK[o.recommendation] > RANK[result.recommendation] || (RANK[o.recommendation] === RANK[result.recommendation] && o.riskLevel < result.riskLevel)
  const toChange = (change: string, kind: WhyChange['kind'], o: AuthorizeResult): WhyChange => ({
    change, kind, simulated: true, improves: better(o),
    outcome: { recommendation: o.recommendation, riskLevel: o.riskLevel, blockingReasons: o.blockingReasons.length, concerns: o.concerns.length },
  })
  const singles = tried.map(({ v, outcome }) => toChange(v.change, v.kind, outcome)).filter((c) => c.improves)

  // All the improving changes at once: the shortest list of work that earns the answer.
  const improving = tried.filter(({ outcome }) => better(outcome))
  const out: WhyChange[] = [...requirements, ...singles]
  if (improving.length > 1) {
    const all = improving.reduce((a, { v }) => v.apply(a), args)
    const o = authorize(all)
    if (better(o)) out.push(toChange(`All of the above together (${improving.length} changes).`, 'action', o))
  }
  return out
}
