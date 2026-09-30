import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import {
  decideDepartmentPortfolio,
  proposeDepartmentPortfolio,
  type DepartmentEconomicsCandidate,
  type DepartmentEconomicsPolicy,
} from '@quicksilver/kernel/playbooks/department-economics'
import type { SanityDoc, SanityMutation, SanityStoreClient } from './sanity-client.ts'
import { SanityDepartmentExecutor } from './department-executor.ts'

const now = new Date('2026-09-30T12:00:00.000Z')
const policy: DepartmentEconomicsPolicy = {
  schemaVersion: 1, playbookId: 'operate', version: 3, owner: 'founder-1',
  minimumPeriodsForSpawn: 2, minimumPeriodsForFund: 2, minimumPeriodsForRetirement: 3,
  spawnReturnMultiple: 1.5, fundReturnMultiple: 1.25, shrinkBelowReturnMultiple: 0.8, retireBelowReturnMultiple: 0.2,
}
function candidate(departmentId: string, overrides: Partial<DepartmentEconomicsCandidate> = {}): DepartmentEconomicsCandidate {
  return { departmentId, status: 'candidate', qualifyingPeriods: 3, netContributionUsd: 180, capitalUsedUsd: 100, currentBudgetUsd: 0, proposedBudgetUsd: 20, evidenceRefs: ['ledger:1', 'ledger:2', 'experiment:3'], ...overrides }
}
const departmentId = (company: string, run: string, id: string) => `department.qs.${createHash('sha256').update(`${company}\0${run}\0${id}`).digest('hex').slice(0, 40)}`

class FakeSanity implements SanityStoreClient {
  readonly projectId: string
  readonly docs = new Map<string, SanityDoc>()
  private revision = 1
  failTransaction = false

  constructor(projectId = 'f87t11g1') { this.projectId = projectId }

  async fetch<T>(_: string, params: Record<string, unknown>): Promise<T> {
    const matches = [...this.docs.values()].filter((doc) => doc._type === params.type && doc.companyId === params.companyId && doc.economicsRunId === params.runId && doc.economicsDepartmentId === params.departmentId)
    return structuredClone(matches) as T
  }
  async getDocument<T extends { _id: string; _type: string; _rev?: string }>(id: string): Promise<T | undefined> {
    const value = this.docs.get(id)
    return value ? structuredClone(value) as T : undefined
  }
  async createIfNotExists<T extends { _id: string; _type: string }>(doc: T): Promise<T> { return structuredClone(doc) }
  async mutate(mutations: SanityMutation[]): Promise<void> {
    if (this.failTransaction) throw new Error('simulated Sanity transaction failure')
    const next = new Map(this.docs)
    for (const mutation of mutations) {
      if ('create' in mutation) {
        if (next.has(mutation.create._id)) throw Object.assign(new Error('already exists'), { statusCode: 409 })
        next.set(mutation.create._id, { ...structuredClone(mutation.create), _rev: `rev-${this.revision++}` })
      } else if ('patch' in mutation) {
        const current = next.get(mutation.patch.id)
        if (!current || current._rev !== mutation.patch.ifRevisionID) throw Object.assign(new Error('revision conflict'), { statusCode: 409 })
        next.set(current._id, { ...current, ...structuredClone(mutation.patch.set ?? {}), _rev: `rev-${this.revision++}` })
      } else throw new Error('unexpected mutation type')
    }
    this.docs.clear()
    for (const [id, doc] of next) this.docs.set(id, doc)
  }
  seedDepartment(id: string, budget: number) {
    const _id = departmentId('company-1', 'operate-1', id)
    this.docs.set(_id, { _id, _type: 'department', _rev: 'seed-rev', name: id, companyId: 'company-1', economicsRunId: 'operate-1', economicsDepartmentId: id, economicsStatus: 'active', economicsBudgetUsd: budget, economicsRevision: 4 })
  }
}

function approvedFixture() {
  const candidates = [
    candidate('new-team', { proposedBudgetUsd: 20 }),
    candidate('fund-team', { status: 'active', currentBudgetUsd: 50, proposedBudgetUsd: 75, netContributionUsd: 160 }),
    candidate('shrink-team', { status: 'active', currentBudgetUsd: 80, proposedBudgetUsd: 45, netContributionUsd: 50 }),
    candidate('retire-team', { status: 'active', currentBudgetUsd: 30, proposedBudgetUsd: 0, netContributionUsd: 10, qualifyingPeriods: 4, evidenceRefs: ['ledger:a', 'ledger:b', 'ledger:c', 'ledger:d'] }),
  ]
  const proposed = proposeDepartmentPortfolio({ policy, candidates, availableCapitalUsd: 100, proposedBy: 'kernel:operate', now })
  if (!proposed.ok) throw new Error(proposed.reasons.join(' '))
  const decided = decideDepartmentPortfolio(proposed.portfolio, { id: 'founder-1', kind: 'human' }, { approve: proposed.portfolio.proposals.map((item) => item.proposalId), reject: [], note: 'Approved against verified evidence.' }, now)
  if (!decided.ok) throw new Error(decided.reasons.join(' '))
  return { portfolio: proposed.portfolio, approval: decided.decision }
}

test('applies all approved department changes atomically and records immutable audit evidence', async () => {
  const client = new FakeSanity()
  client.seedDepartment('fund-team', 50)
  client.seedDepartment('shrink-team', 80)
  client.seedDepartment('retire-team', 30)
  const { portfolio, approval } = approvedFixture()
  const executor = new SanityDepartmentExecutor(client, 'company-1', 'operate-1')
  const result = await executor.apply(portfolio, approval, { id: 'founder-1', kind: 'human' }, now)
  assert.deepEqual(result, { status: 'applied', changed: 4, auditIds: result.auditIds })
  assert.equal(client.docs.size, 8, 'three existing departments plus one spawned department and four audits')
  for (const [id, budget, status] of [['new-team', 20, 'active'], ['fund-team', 75, 'active'], ['shrink-team', 45, 'active'], ['retire-team', 0, 'retired']] as const) {
    const record = client.docs.get(departmentId('company-1', 'operate-1', id))
    assert.equal(record?.economicsBudgetUsd, budget)
    assert.equal(record?.economicsStatus, status)
    assert.equal(record?.economicsRevision, id === 'new-team' ? 1 : 5)
    assert.equal(record?.economicsApprovalDigest, createHash('sha256').update(JSON.stringify(approval)).digest('hex'))
  }
  const audits = [...client.docs.values()].filter((doc) => doc._type === 'departmentExecutionAudit')
  assert.equal(audits.length, 4)
  assert.ok(audits.every((audit) => audit.proposalDigest === portfolio.digest && audit.approvedBy === 'founder-1'))
  assert.equal((await executor.apply(portfolio, approval, { id: 'founder-1', kind: 'human' }, now)).status, 'already-applied')
})

test('fails closed for an unapproved actor, changed proposal, changed approval, or public challenge project', async () => {
  const client = new FakeSanity()
  const { portfolio, approval } = approvedFixture()
  const executor = new SanityDepartmentExecutor(client, 'company-1', 'operate-1')
  await assert.rejects(executor.apply(portfolio, approval, { id: 'agent-1', kind: 'agent' }, now), /Only the approving human owner/)
  await assert.rejects(executor.apply({ ...portfolio, owner: 'attacker' }, approval, { id: 'founder-1', kind: 'human' }, now), /proposal digest or policy/)
  await assert.rejects(executor.apply(portfolio, { ...approval, approvedBy: 'attacker' }, { id: 'founder-1', kind: 'human' }, now), /does not match/)
  assert.throws(() => new SanityDepartmentExecutor(new FakeSanity('d280bqjc'), 'company-1', 'operate-1'), /public Quicksilver challenge project/)
})

test('rejects stale department state and leaves all records untouched when the transaction fails', async () => {
  const { portfolio, approval } = approvedFixture()
  const staleClient = new FakeSanity()
  staleClient.seedDepartment('fund-team', 51)
  staleClient.seedDepartment('shrink-team', 80)
  staleClient.seedDepartment('retire-team', 30)
  await assert.rejects(new SanityDepartmentExecutor(staleClient, 'company-1', 'operate-1').apply(portfolio, approval, { id: 'founder-1', kind: 'human' }, now), /stale budget/)
  assert.equal([...staleClient.docs.values()].some((doc) => doc._type === 'departmentExecutionAudit'), false)

  const failingClient = new FakeSanity()
  failingClient.seedDepartment('fund-team', 50)
  failingClient.seedDepartment('shrink-team', 80)
  failingClient.seedDepartment('retire-team', 30)
  failingClient.failTransaction = true
  const before = structuredClone([...failingClient.docs])
  await assert.rejects(new SanityDepartmentExecutor(failingClient, 'company-1', 'operate-1').apply(portfolio, approval, { id: 'founder-1', kind: 'human' }, now), /simulated Sanity transaction failure/)
  assert.deepEqual([...failingClient.docs], before)
})
