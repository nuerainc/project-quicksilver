import { createHash } from 'node:crypto'

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/
const EVIDENCE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/
const cents = (value: number) => Math.round(value * 100) / 100

/** Owner-authored thresholds are pinned as playbook data; there are no silent universal economics defaults. */
export interface DepartmentEconomicsPolicy {
  schemaVersion: 1
  playbookId: string
  version: number
  owner: string
  minimumPeriodsForSpawn: number
  minimumPeriodsForFund: number
  minimumPeriodsForRetirement: number
  spawnReturnMultiple: number
  fundReturnMultiple: number
  shrinkBelowReturnMultiple: number
  retireBelowReturnMultiple: number
}

export interface DepartmentEconomicsCandidate {
  departmentId: string
  status: 'candidate' | 'active'
  /** Number of consecutive, complete, independently sourced accounting periods. */
  qualifyingPeriods: number
  /** Net contribution after direct variable costs in the latest review period. */
  netContributionUsd: number
  /** Fully-loaded capital used in the same period, including compute. */
  capitalUsedUsd: number
  currentBudgetUsd: number
  /** Target budget proposed by the playbook. It is never moved by this module. */
  proposedBudgetUsd: number
  evidenceRefs: string[]
}

export type DepartmentChangeAction = 'spawn' | 'fund' | 'shrink' | 'retire' | 'maintain'

export interface DepartmentChangeProposal {
  proposalId: string
  departmentId: string
  action: DepartmentChangeAction
  returnMultiple: number | null
  currentBudgetUsd: number
  proposedBudgetUsd: number
  additionalCapitalUsd: number
  evidenceRefs: string[]
  rationale: string
  requiresFounderApproval: true
}

export interface DepartmentPortfolioProposal {
  schemaVersion: 1
  proposalId: string
  playbookId: string
  playbookVersion: number
  owner: string
  policy: DepartmentEconomicsPolicy
  policyDigest: string
  proposedBy: string
  proposedAt: string
  availableCapitalUsd: number
  allocatedCapitalUsd: number
  proposals: DepartmentChangeProposal[]
  digest: string
}

export interface DepartmentProposalInput {
  policy: DepartmentEconomicsPolicy
  candidates: DepartmentEconomicsCandidate[]
  availableCapitalUsd: number
  proposedBy: string
  now: Date
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

export function validateDepartmentEconomicsPolicy(policy: DepartmentEconomicsPolicy): string[] {
  const errors: string[] = []
  const allowedKeys = new Set(['schemaVersion', 'playbookId', 'version', 'owner', 'minimumPeriodsForSpawn', 'minimumPeriodsForFund', 'minimumPeriodsForRetirement', 'spawnReturnMultiple', 'fundReturnMultiple', 'shrinkBelowReturnMultiple', 'retireBelowReturnMultiple'])
  if (policy && Object.keys(policy).some((key) => !allowedKeys.has(key))) errors.push('policy contains unsupported fields.')
  if (policy?.schemaVersion !== 1) errors.push('schemaVersion must be 1.')
  if (!ID.test(policy?.playbookId ?? '')) errors.push('playbookId is invalid.')
  if (!Number.isInteger(policy?.version) || policy.version < 1) errors.push('version must be a positive integer.')
  if (!policy?.owner?.trim()) errors.push('owner is required.')
  for (const key of ['minimumPeriodsForSpawn', 'minimumPeriodsForFund', 'minimumPeriodsForRetirement'] as const) {
    if (!Number.isInteger(policy?.[key]) || policy[key] < 1 || policy[key] > 100) errors.push(`${key} must be an integer from 1 to 100.`)
  }
  const thresholds = ['spawnReturnMultiple', 'fundReturnMultiple', 'shrinkBelowReturnMultiple', 'retireBelowReturnMultiple'] as const
  for (const key of thresholds) if (typeof policy?.[key] !== 'number' || !Number.isFinite(policy[key])) errors.push(`${key} must be finite.`)
  if (!(policy?.spawnReturnMultiple >= 0) || !(policy?.fundReturnMultiple >= 0)) errors.push('spawnReturnMultiple and fundReturnMultiple must be zero or more.')
  if (policy?.spawnReturnMultiple < policy?.fundReturnMultiple) errors.push('spawnReturnMultiple must be at least fundReturnMultiple.')
  if (policy?.retireBelowReturnMultiple >= policy?.shrinkBelowReturnMultiple) errors.push('retireBelowReturnMultiple must be lower than shrinkBelowReturnMultiple.')
  if (policy?.shrinkBelowReturnMultiple >= policy?.fundReturnMultiple) errors.push('shrinkBelowReturnMultiple must be lower than fundReturnMultiple.')
  return errors
}

function validateCandidate(candidate: DepartmentEconomicsCandidate): string[] {
  const errors: string[] = []
  const allowedKeys = new Set(['departmentId', 'status', 'qualifyingPeriods', 'netContributionUsd', 'capitalUsedUsd', 'currentBudgetUsd', 'proposedBudgetUsd', 'evidenceRefs'])
  if (candidate && Object.keys(candidate).some((key) => !allowedKeys.has(key))) errors.push('candidate contains unsupported fields.')
  if (!ID.test(candidate?.departmentId ?? '')) errors.push('departmentId is invalid.')
  if (candidate?.status !== 'candidate' && candidate?.status !== 'active') errors.push('status must be candidate or active.')
  if (!Number.isInteger(candidate?.qualifyingPeriods) || candidate.qualifyingPeriods < 0 || candidate.qualifyingPeriods > 100) errors.push('qualifyingPeriods must be an integer from 0 to 100.')
  if (typeof candidate?.netContributionUsd !== 'number' || !Number.isFinite(candidate.netContributionUsd)) errors.push('netContributionUsd must be finite.')
  for (const key of ['capitalUsedUsd', 'currentBudgetUsd', 'proposedBudgetUsd'] as const) {
    if (typeof candidate?.[key] !== 'number' || !Number.isFinite(candidate[key]) || candidate[key] < 0) errors.push(`${key} must be zero or more.`)
  }
  if (!Array.isArray(candidate?.evidenceRefs) || !candidate.evidenceRefs.length || candidate.evidenceRefs.length > 100 || candidate.evidenceRefs.some((ref) => typeof ref !== 'string' || !EVIDENCE_ID.test(ref))) errors.push('evidenceRefs must contain 1 to 100 valid source ids.')
  else {
    if (new Set(candidate.evidenceRefs).size !== candidate.evidenceRefs.length) errors.push('evidenceRefs cannot contain duplicate source ids.')
    if (candidate.evidenceRefs.length < candidate.qualifyingPeriods) errors.push('Each qualifying period must have at least one distinct evidence reference.')
  }
  if (candidate?.status === 'candidate' && candidate.currentBudgetUsd !== 0) errors.push('a candidate department must have a current budget of zero.')
  return errors
}

/**
 * Create deterministic, evidence-linked organization recommendations from a
 * pinned Operate playbook. This function proposes only: founder approval and a
 * separate execution adapter are required before any organization or money is
 * changed.
 */
export function proposeDepartmentPortfolio(input: DepartmentProposalInput): { ok: true; portfolio: DepartmentPortfolioProposal } | { ok: false; reasons: string[] } {
  const reasons = validateDepartmentEconomicsPolicy(input?.policy)
  if (!Number.isFinite(input?.availableCapitalUsd) || input.availableCapitalUsd < 0) reasons.push('availableCapitalUsd must be zero or more.')
  if (!ID.test(input?.proposedBy ?? '')) reasons.push('proposedBy is invalid.')
  if (!(input?.now instanceof Date) || Number.isNaN(input.now.getTime())) reasons.push('now must be a valid date.')
  if (!Array.isArray(input?.candidates) || input.candidates.length > 100) reasons.push('candidates must be a list of at most 100 departments.')
  const ids = new Set<string>()
  for (const candidate of input?.candidates ?? []) {
    reasons.push(...validateCandidate(candidate))
    if (ids.has(candidate.departmentId)) reasons.push(`Duplicate departmentId "${candidate.departmentId}".`)
    ids.add(candidate.departmentId)
  }
  if (reasons.length) return { ok: false, reasons }

  let remaining = cents(input.availableCapitalUsd)
  const proposals = [...input.candidates].sort((a, b) => a.departmentId.localeCompare(b.departmentId)).map((candidate) => {
    const returnMultiple = candidate.capitalUsedUsd > 0 ? cents(candidate.netContributionUsd / candidate.capitalUsedUsd) : null
    const base = {
      departmentId: candidate.departmentId,
      returnMultiple,
      currentBudgetUsd: cents(candidate.currentBudgetUsd),
      proposedBudgetUsd: cents(candidate.proposedBudgetUsd),
      evidenceRefs: [...candidate.evidenceRefs],
      requiresFounderApproval: true as const,
    }
    let action: DepartmentChangeAction = 'maintain'
    let rationale = 'No structural change is supported by the configured economics thresholds and current evidence.'
    if (candidate.status === 'candidate') {
      if (candidate.qualifyingPeriods < input.policy.minimumPeriodsForSpawn) rationale = `Spawn deferred: requires ${input.policy.minimumPeriodsForSpawn} qualifying periods; only ${candidate.qualifyingPeriods} are recorded.`
      else if (returnMultiple === null) rationale = 'Spawn deferred: no fully-loaded capital-use evidence is available to calculate return.'
      else if (returnMultiple < input.policy.spawnReturnMultiple) rationale = `Spawn deferred: return multiple ${returnMultiple} is below the pinned ${input.policy.spawnReturnMultiple} threshold.`
      else if (candidate.proposedBudgetUsd <= 0) rationale = 'Spawn deferred: a positive proposed budget is required.'
      else if (candidate.proposedBudgetUsd > remaining) rationale = `Spawn deferred: requested capital ${candidate.proposedBudgetUsd} exceeds the remaining approved pool ${remaining}.`
      else {
        action = 'spawn'
        rationale = `Spawn proposed: ${candidate.qualifyingPeriods} qualifying periods and return multiple ${returnMultiple} meet the pinned threshold ${input.policy.spawnReturnMultiple}.`
        remaining = cents(remaining - candidate.proposedBudgetUsd)
      }
    } else if (returnMultiple === null) {
      rationale = 'Change deferred: no fully-loaded capital-use evidence is available to calculate return.'
    } else if (returnMultiple <= input.policy.retireBelowReturnMultiple && candidate.qualifyingPeriods >= input.policy.minimumPeriodsForRetirement) {
      action = 'retire'
      base.proposedBudgetUsd = 0
      rationale = `Retirement proposed: return multiple ${returnMultiple} is at or below ${input.policy.retireBelowReturnMultiple} for ${candidate.qualifyingPeriods} qualifying periods.`
    } else if (returnMultiple < input.policy.shrinkBelowReturnMultiple) {
      if (candidate.proposedBudgetUsd >= candidate.currentBudgetUsd) rationale = `Shrink deferred: return multiple ${returnMultiple} is below ${input.policy.shrinkBelowReturnMultiple}, but the proposed budget is not lower.`
      else {
        action = 'shrink'
        rationale = `Shrink proposed: return multiple ${returnMultiple} is below the pinned ${input.policy.shrinkBelowReturnMultiple} threshold.`
      }
    } else if (returnMultiple >= input.policy.fundReturnMultiple && candidate.qualifyingPeriods >= input.policy.minimumPeriodsForFund) {
      const additional = cents(candidate.proposedBudgetUsd - candidate.currentBudgetUsd)
      if (additional <= 0) rationale = `Funding deferred: return multiple ${returnMultiple} meets the threshold, but no budget increase was proposed.`
      else if (additional > remaining) rationale = `Funding deferred: requested capital ${additional} exceeds the remaining approved pool ${remaining}.`
      else {
        action = 'fund'
        rationale = `Funding proposed: ${candidate.qualifyingPeriods} qualifying periods and return multiple ${returnMultiple} meet the pinned threshold ${input.policy.fundReturnMultiple}.`
        remaining = cents(remaining - additional)
      }
    } else if (returnMultiple >= input.policy.fundReturnMultiple) {
      rationale = `Funding deferred: requires ${input.policy.minimumPeriodsForFund} qualifying periods; only ${candidate.qualifyingPeriods} are recorded.`
    }
    const additionalCapitalUsd = action === 'spawn' ? candidate.proposedBudgetUsd : action === 'fund' ? cents(candidate.proposedBudgetUsd - candidate.currentBudgetUsd) : 0
    const proposalCore = { ...base, action, additionalCapitalUsd, rationale }
    return { ...proposalCore, proposalId: digest(proposalCore).slice(0, 24) }
  })
  const proposalCore = {
    schemaVersion: 1 as const,
    playbookId: input.policy.playbookId,
    playbookVersion: input.policy.version,
    owner: input.policy.owner,
    policy: structuredClone(input.policy),
    policyDigest: digest(input.policy),
    proposedBy: input.proposedBy,
    proposedAt: input.now.toISOString(),
    availableCapitalUsd: cents(input.availableCapitalUsd),
    allocatedCapitalUsd: cents(input.availableCapitalUsd - remaining),
    proposals,
  }
  return { ok: true, portfolio: { ...proposalCore, proposalId: digest(proposalCore).slice(0, 24), digest: digest(proposalCore) } }
}

export function verifyDepartmentPortfolioProposal(portfolio: DepartmentPortfolioProposal): boolean {
  if (!portfolio || portfolio.schemaVersion !== 1 || !Array.isArray(portfolio.proposals)) return false
  if (portfolio.policyDigest !== digest(portfolio.policy) || validateDepartmentEconomicsPolicy(portfolio.policy).length > 0
    || portfolio.policy.playbookId !== portfolio.playbookId || portfolio.policy.version !== portfolio.playbookVersion || portfolio.policy.owner !== portfolio.owner) return false
  const { digest: storedDigest, proposalId: storedId, ...core } = portfolio
  const computed = digest(core)
  if (storedDigest !== computed || storedId !== computed.slice(0, 24)) return false
  const ids = new Set<string>()
  let allocated = 0
  for (const proposal of portfolio.proposals) {
    const { proposalId, ...proposalCore } = proposal
    if (proposalId !== digest(proposalCore).slice(0, 24) || ids.has(proposalId)) return false
    ids.add(proposalId)
    allocated += proposal.additionalCapitalUsd
  }
  return cents(allocated) === portfolio.allocatedCapitalUsd && portfolio.allocatedCapitalUsd <= portfolio.availableCapitalUsd
}

export interface DepartmentPortfolioApproval {
  proposalId: string
  digest: string
  approvedActionIds: string[]
  rejectedActionIds: string[]
  approvedBy: string
  approvedAt: string
  note: string
}

export function verifyDepartmentPortfolioApproval(portfolio: DepartmentPortfolioProposal, decision: DepartmentPortfolioApproval): boolean {
  if (!verifyDepartmentPortfolioProposal(portfolio) || !decision || decision.proposalId !== portfolio.proposalId || decision.digest !== portfolio.digest
    || decision.approvedBy !== portfolio.owner || decision.approvedBy === portfolio.proposedBy || !decision.note?.trim()
    || Number.isNaN(Date.parse(decision.approvedAt)) || Date.parse(decision.approvedAt) < Date.parse(portfolio.proposedAt)) return false
  const actionable = new Set(portfolio.proposals.filter((proposal) => proposal.action !== 'maintain').map((proposal) => proposal.proposalId))
  const approved = new Set(decision.approvedActionIds)
  const rejected = new Set(decision.rejectedActionIds)
  if ([...approved].some((id) => !actionable.has(id)) || [...rejected].some((id) => !actionable.has(id))
    || [...approved].some((id) => rejected.has(id))
    || [...actionable].some((id) => !approved.has(id) && !rejected.has(id))) return false
  const approvedCapital = portfolio.proposals.filter((proposal) => approved.has(proposal.proposalId)).reduce((sum, proposal) => sum + proposal.additionalCapitalUsd, 0)
  return approvedCapital <= portfolio.availableCapitalUsd
}

/** Record the founder's choice against the immutable proposal; never executes it. */
export function decideDepartmentPortfolio(
  portfolio: DepartmentPortfolioProposal,
  actor: { id: string; kind: string },
  choices: { approve: string[]; reject: string[]; note: string },
  now: Date,
): { ok: true; decision: DepartmentPortfolioApproval } | { ok: false; reasons: string[] } {
  const reasons: string[] = []
  const { digest: suppliedDigest, proposalId: suppliedId } = portfolio ?? {} as DepartmentPortfolioProposal
  if (!verifyDepartmentPortfolioProposal(portfolio)) reasons.push('The department proposal changed after review; create a new proposal.')
  if (actor?.kind !== 'human' || actor.id !== portfolio?.owner) reasons.push(`Only the playbook owner (${portfolio?.owner ?? 'unknown'}) may decide this department proposal.`)
  if (actor?.id === portfolio?.proposedBy) reasons.push('The department proposal must be decided by someone other than its proposer.')
  if (!choices?.note?.trim() || choices.note.trim().length > 500) reasons.push('A written decision note of 1 to 500 characters is required.')
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) reasons.push('now must be a valid date.')
  if (!Array.isArray(choices?.approve) || !Array.isArray(choices?.reject)) reasons.push('approve and reject must be lists of proposal ids.')
  const validIds = new Set((portfolio?.proposals ?? []).filter((p) => p.action !== 'maintain').map((p) => p.proposalId))
  const approved = new Set(choices?.approve ?? [])
  const rejected = new Set(choices?.reject ?? [])
  if ([...approved].some((id) => !validIds.has(id))) reasons.push('approve contains an unknown or non-actionable proposal id.')
  if ([...rejected].some((id) => !validIds.has(id))) reasons.push('reject contains an unknown or non-actionable proposal id.')
  if ([...approved].some((id) => rejected.has(id))) reasons.push('A proposal cannot be approved and rejected at the same time.')
  if ([...validIds].some((id) => !approved.has(id) && !rejected.has(id))) reasons.push('Every actionable proposal must be explicitly approved or rejected.')
  const approvedCapital = (portfolio?.proposals ?? []).filter((proposal) => approved.has(proposal.proposalId)).reduce((sum, proposal) => sum + proposal.additionalCapitalUsd, 0)
  if (approvedCapital > (portfolio?.availableCapitalUsd ?? 0)) reasons.push('Approved proposals exceed the portfolio capital ceiling.')
  if (reasons.length) return { ok: false, reasons }
  return { ok: true, decision: {
    proposalId: suppliedId,
    digest: suppliedDigest,
    approvedActionIds: [...approved].sort(),
    rejectedActionIds: [...rejected].sort(),
    approvedBy: actor.id,
    approvedAt: now.toISOString(),
    note: choices.note.trim(),
  } }
}
