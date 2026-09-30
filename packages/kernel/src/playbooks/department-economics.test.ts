import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decideDepartmentPortfolio,
  proposeDepartmentPortfolio,
  validateDepartmentEconomicsPolicy,
  verifyDepartmentPortfolioApproval,
  type DepartmentEconomicsCandidate,
  type DepartmentEconomicsPolicy,
} from './department-economics.ts'

const now = new Date('2026-09-30T12:00:00.000Z')
const policy: DepartmentEconomicsPolicy = {
  schemaVersion: 1,
  playbookId: 'operate',
  version: 3,
  owner: 'founder-1',
  minimumPeriodsForSpawn: 2,
  minimumPeriodsForFund: 2,
  minimumPeriodsForRetirement: 3,
  spawnReturnMultiple: 1.5,
  fundReturnMultiple: 1.25,
  shrinkBelowReturnMultiple: 0.8,
  retireBelowReturnMultiple: 0.2,
}

function candidate(overrides: Partial<DepartmentEconomicsCandidate> = {}): DepartmentEconomicsCandidate {
  return {
    departmentId: 'growth',
    status: 'candidate',
    qualifyingPeriods: 3,
    netContributionUsd: 180,
    capitalUsedUsd: 100,
    currentBudgetUsd: 0,
    proposedBudgetUsd: 40,
    evidenceRefs: ['ledger-period-1', 'ledger-period-2', 'experiment-3'],
    ...overrides,
  }
}

function propose(candidates: DepartmentEconomicsCandidate[], availableCapitalUsd = 100) {
  const result = proposeDepartmentPortfolio({ policy, candidates, availableCapitalUsd, proposedBy: 'kernel:operate', now })
  assert.equal(result.ok, true, result.ok ? '' : result.reasons.join(' '))
  return result.ok ? result.portfolio : assert.fail('proposal expected')
}

test('policy: founder-configured return bands are ordered and sample sizes bounded', () => {
  assert.deepEqual(validateDepartmentEconomicsPolicy(policy), [])
  assert.ok(validateDepartmentEconomicsPolicy({ ...policy, retireBelowReturnMultiple: 0.8 }).some((problem) => /retireBelowReturnMultiple/.test(problem)))
  assert.ok(validateDepartmentEconomicsPolicy({ ...policy, fundReturnMultiple: 0.7 }).some((problem) => /shrinkBelowReturnMultiple/.test(problem)))
  assert.ok(validateDepartmentEconomicsPolicy({ ...policy, minimumPeriodsForSpawn: 0 }).some((problem) => /minimumPeriodsForSpawn/.test(problem)))
})

test('proposal: spawn, fund, shrink, retire and maintain all use pinned unit economics and require the founder', () => {
  const portfolio = propose([
    candidate({ departmentId: 'candidate-new', proposedBudgetUsd: 20 }),
    candidate({ departmentId: 'funding', status: 'active', currentBudgetUsd: 50, proposedBudgetUsd: 75, netContributionUsd: 160 }),
    candidate({ departmentId: 'shrinking', status: 'active', currentBudgetUsd: 80, proposedBudgetUsd: 45, netContributionUsd: 50 }),
    candidate({ departmentId: 'retiring', status: 'active', currentBudgetUsd: 30, proposedBudgetUsd: 0, netContributionUsd: 10, qualifyingPeriods: 4, evidenceRefs: ['ledger-period-1', 'ledger-period-2', 'ledger-period-3', 'ledger-period-4'] }),
    candidate({ departmentId: 'stable', status: 'active', currentBudgetUsd: 25, proposedBudgetUsd: 25, netContributionUsd: 100 }),
  ])
  const actions = Object.fromEntries(portfolio.proposals.map((proposal) => [proposal.departmentId, proposal]))
  assert.equal(actions['candidate-new']?.action, 'spawn')
  assert.equal(actions.funding?.action, 'fund')
  assert.equal(actions.shrinking?.action, 'shrink')
  assert.equal(actions.retiring?.action, 'retire')
  assert.equal(actions.retiring?.proposedBudgetUsd, 0)
  assert.equal(actions.stable?.action, 'maintain')
  assert.ok(portfolio.proposals.every((proposal) => proposal.requiresFounderApproval))
  assert.equal(portfolio.allocatedCapitalUsd, 45)
  assert.equal(portfolio.digest.length, 64)
})

test('proposal: a candidate needs enough periods, evidence and capital, and never spends beyond the pool', () => {
  const portfolio = propose([
    candidate({ departmentId: 'a', proposedBudgetUsd: 60 }),
    candidate({ departmentId: 'b', proposedBudgetUsd: 60 }),
    candidate({ departmentId: 'too-early', qualifyingPeriods: 1 }),
    candidate({ departmentId: 'no-data', capitalUsedUsd: 0 }),
  ])
  const actions = Object.fromEntries(portfolio.proposals.map((proposal) => [proposal.departmentId, proposal]))
  assert.equal(actions.a?.action, 'spawn', 'capital is allocated deterministically by department id')
  assert.equal(actions.b?.action, 'maintain')
  assert.match(actions.b?.rationale ?? '', /exceeds the remaining approved pool/)
  assert.equal(actions['too-early']?.action, 'maintain')
  assert.match(actions['too-early']?.rationale ?? '', /qualifying periods/)
  assert.match(actions['no-data']?.rationale ?? '', /no fully-loaded capital-use evidence/)
  assert.ok(portfolio.allocatedCapitalUsd <= portfolio.availableCapitalUsd)
})

test('proposal: malformed or duplicate financial evidence is rejected before recommendation', () => {
  const duplicate = [candidate(), candidate()]
  assert.equal(proposeDepartmentPortfolio({ policy, candidates: duplicate, availableCapitalUsd: 100, proposedBy: 'kernel:operate', now }).ok, false)
  assert.equal(proposeDepartmentPortfolio({ policy, candidates: [candidate({ evidenceRefs: [] })], availableCapitalUsd: 100, proposedBy: 'kernel:operate', now }).ok, false)
  assert.equal(proposeDepartmentPortfolio({ policy, candidates: [candidate()], availableCapitalUsd: -1, proposedBy: 'kernel:operate', now }).ok, false)
})

test('proposal: claimed qualifying periods cannot outnumber distinct evidence references', () => {
  const result = proposeDepartmentPortfolio({
    policy,
    candidates: [candidate({ qualifyingPeriods: 3, evidenceRefs: ['ledger-period-1', 'ledger-period-2'] })],
    availableCapitalUsd: 100,
    proposedBy: 'kernel-1',
    now,
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.match(result.reasons.join(' '), /Each qualifying period must have at least one distinct evidence reference/)
  const repeated = proposeDepartmentPortfolio({
    policy,
    candidates: [candidate({ qualifyingPeriods: 2, evidenceRefs: ['ledger-period-1', 'ledger-period-1'] })],
    availableCapitalUsd: 100,
    proposedBy: 'kernel-1',
    now,
  })
  assert.equal(repeated.ok, false)
  if (!repeated.ok) assert.match(repeated.reasons.join(' '), /cannot contain duplicate source ids/)
})

test('decision: only the owner may decide an unmodified proposal as a different human', () => {
  const portfolio = propose([candidate()])
  const proposalId = portfolio.proposals[0]!.proposalId
  const choice = { approve: [proposalId], reject: [], note: 'Approved against the ledger evidence and pinned return policy.' }
  assert.equal(decideDepartmentPortfolio(portfolio, { id: 'kernel:operate', kind: 'service' }, choice, now).ok, false)
  assert.equal(decideDepartmentPortfolio(portfolio, { id: 'other-human', kind: 'human' }, choice, now).ok, false)
  assert.equal(decideDepartmentPortfolio(portfolio, { id: 'founder-1', kind: 'human' }, { ...choice, note: '' }, now).ok, false)
  const approved = decideDepartmentPortfolio(portfolio, { id: 'founder-1', kind: 'human' }, choice, now)
  assert.equal(approved.ok, true)
  if (approved.ok) {
    assert.deepEqual(approved.decision.approvedActionIds, [proposalId])
    assert.equal(approved.decision.digest, portfolio.digest)
    assert.equal(approved.decision.approvedBy, 'founder-1')
    assert.equal(verifyDepartmentPortfolioApproval(portfolio, approved.decision), true)
    assert.equal(verifyDepartmentPortfolioApproval(portfolio, { ...approved.decision, approvedBy: 'forged-agent' }), false)
  }
  const changed = { ...portfolio, allocatedCapitalUsd: 99 }
  assert.equal(decideDepartmentPortfolio(changed, { id: 'founder-1', kind: 'human' }, choice, now).ok, false)
})
