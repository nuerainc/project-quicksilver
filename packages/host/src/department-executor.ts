import { createHash } from 'node:crypto'

import {
  verifyDepartmentPortfolioApproval,
  verifyDepartmentPortfolioProposal,
  type DepartmentChangeProposal,
  type DepartmentPortfolioApproval,
  type DepartmentPortfolioProposal,
} from '@quicksilver/kernel/playbooks/department-economics'
import type { SanityMutation, SanityStoreClient } from './sanity-client.ts'

type DepartmentStatus = 'active' | 'retired'

interface DepartmentDocument extends Record<string, unknown> {
  _id: string
  _type: 'department'
  _rev?: string
  name: string
  companyId?: string
  economicsRunId?: string
  economicsDepartmentId?: string
  economicsStatus?: DepartmentStatus
  economicsBudgetUsd?: number
  economicsRevision?: number
  economicsProposalId?: string
  economicsApprovalDigest?: string
  economicsEvidenceRefs?: string[]
}

interface DepartmentExecutionAudit extends Record<string, unknown> {
  _id: string
  _type: 'departmentExecutionAudit'
  proposalId: string
  proposalDigest: string
  actionId: string
  actionDigest: string
  approvalDigest: string
  companyId: string
  runId: string
  departmentId: string
  action: DepartmentChangeProposal['action']
  fromStatus: DepartmentStatus | null
  toStatus: DepartmentStatus
  fromBudgetUsd: number
  toBudgetUsd: number
  fromRevision: number
  toRevision: number
  approvedBy: string
  executedAt: string
}

const cents = (amount: number) => Math.round(amount * 100) / 100
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function departmentDocumentId(companyId: string, runId: string, departmentId: string): string {
  const key = createHash('sha256').update(`${companyId}\0${runId}\0${departmentId}`).digest('hex').slice(0, 40)
  return `department.qs.${key}`
}

function executionAuditId(runId: string, proposalId: string, actionId: string): string {
  const key = createHash('sha256').update(`${runId}\0${proposalId}\0${actionId}`).digest('hex').slice(0, 40)
  return `department-execution.qs.${key}`
}

/**
 * Apply founder-approved department budget/status changes as one synchronous
 * Sanity transaction. This is a real internal effect, but it never moves
 * money or dispatches external tools. Every action is bound to the kernel
 * proposal and the founder's exact approval; stale records fail closed.
 */
export class SanityDepartmentExecutor {
  private readonly client: SanityStoreClient
  private readonly companyId: string
  private readonly runId: string

  constructor(
    client: SanityStoreClient,
    companyId: string,
    runId: string,
  ) {
    this.client = client
    this.companyId = companyId
    this.runId = runId
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(companyId) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(runId)) throw new Error('Invalid companyId or Operate runId for department execution.')
    if (client.projectId === 'd280bqjc') throw new Error('Department execution is prohibited in the public Quicksilver challenge project.')
  }

  async apply(
    portfolio: DepartmentPortfolioProposal,
    approval: DepartmentPortfolioApproval,
    actor: { id: string; kind: string },
    now: Date,
  ): Promise<{ status: 'applied' | 'already-applied' | 'no-approved-actions'; changed: number; auditIds: string[] }> {
    if (!verifyDepartmentPortfolioProposal(portfolio)) throw new Error('Department proposal digest or policy is invalid; refusing to execute.')
    if (!verifyDepartmentPortfolioApproval(portfolio, approval)) throw new Error('Founder approval does not match the exact department proposal; refusing to execute.')
    if (actor.kind !== 'human' || actor.id !== portfolio.owner || actor.id !== approval.approvedBy) throw new Error('Only the approving human owner may execute this department proposal.')
    if (this.client.projectId === 'd280bqjc') throw new Error('Department execution is prohibited in the public Quicksilver challenge project.')
    if (!(now instanceof Date) || Number.isNaN(now.getTime()) || now.getTime() < Date.parse(approval.approvedAt)) throw new Error('Execution time is invalid or precedes founder approval.')

    const approvedIds = new Set(approval.approvedActionIds)
    const actions = portfolio.proposals.filter((proposal) => approvedIds.has(proposal.proposalId) && proposal.action !== 'maintain')
    if (!actions.length) return { status: 'no-approved-actions', changed: 0, auditIds: [] }
    const approvalDigest = digest(approval)
    const auditIds = actions.map((action) => executionAuditId(this.runId, portfolio.proposalId, action.proposalId))
    const existingAudits = await Promise.all(auditIds.map((id) => this.client.getDocument<DepartmentExecutionAudit>(id)))
    const present = existingAudits.filter((record): record is DepartmentExecutionAudit => record !== undefined)
    if (present.length) {
      if (present.length !== actions.length || present.some((record, index) => record.proposalDigest !== portfolio.digest || record.approvalDigest !== approvalDigest || record.actionDigest !== digest(actions[index]))) {
        throw new Error('Department execution history is partial or conflicts with this approval; refusing to retry.')
      }
      return { status: 'already-applied', changed: 0, auditIds }
    }

    const mutations: SanityMutation[] = []
    for (const action of actions) {
      const id = departmentDocumentId(this.companyId, this.runId, action.departmentId)
      const matches = await this.client.fetch<DepartmentDocument[]>(
        '*[_type == $type && companyId == $companyId && economicsRunId == $runId && economicsDepartmentId == $departmentId]',
        { type: 'department', companyId: this.companyId, runId: this.runId, departmentId: action.departmentId },
      )
      if (matches.length > 1) throw new Error(`Department ${action.departmentId} has duplicate economic records; refusing to execute.`)
      const current = matches[0]
      const beforeStatus = current?.economicsStatus ?? null
      const beforeBudget = current?.economicsBudgetUsd ?? 0
      const beforeRevision = current?.economicsRevision ?? 0
      if (action.action === 'spawn') {
        if (current) throw new Error(`Department ${action.departmentId} already exists; spawn requires a new record.`)
        if (action.currentBudgetUsd !== 0 || action.proposedBudgetUsd <= 0) throw new Error('Spawn proposal has invalid current or proposed budget.')
        mutations.push({ create: {
          _id: id,
          _type: 'department',
          name: action.departmentId,
          companyId: this.companyId,
          economicsRunId: this.runId,
          economicsDepartmentId: action.departmentId,
          economicsStatus: 'active',
          economicsBudgetUsd: cents(action.proposedBudgetUsd),
          economicsRevision: 1,
          economicsProposalId: portfolio.proposalId,
          economicsApprovalDigest: approvalDigest,
          economicsEvidenceRefs: action.evidenceRefs,
        } as DepartmentDocument })
      } else {
        if (!current || current._id !== id || !current._rev || beforeStatus !== 'active' || !Number.isFinite(beforeBudget) || beforeRevision < 1) throw new Error(`Department ${action.departmentId} is missing a versioned active record; refusing to apply ${action.action}.`)
        if (cents(beforeBudget) !== cents(action.currentBudgetUsd)) throw new Error(`Department ${action.departmentId} has a stale budget (stored ${beforeBudget}, proposal ${action.currentBudgetUsd}).`)
        if (action.action === 'fund' && action.proposedBudgetUsd <= action.currentBudgetUsd) throw new Error('Funding must increase the department budget.')
        if (action.action === 'shrink' && (action.proposedBudgetUsd < 0 || action.proposedBudgetUsd >= action.currentBudgetUsd)) throw new Error('Shrinking must reduce the department budget without going below zero.')
        if (action.action === 'retire' && action.proposedBudgetUsd !== 0) throw new Error('Retirement must set the department budget to zero.')
        const toStatus: DepartmentStatus = action.action === 'retire' ? 'retired' : 'active'
        mutations.push({ patch: {
          id,
          ifRevisionID: current._rev,
          set: {
            economicsStatus: toStatus,
            economicsBudgetUsd: cents(action.proposedBudgetUsd),
            economicsRevision: beforeRevision + 1,
            economicsProposalId: portfolio.proposalId,
            economicsApprovalDigest: approvalDigest,
            economicsEvidenceRefs: action.evidenceRefs,
          },
        } })
      }
      const afterStatus: DepartmentStatus = action.action === 'retire' ? 'retired' : 'active'
      const auditId = executionAuditId(this.runId, portfolio.proposalId, action.proposalId)
      const audit: DepartmentExecutionAudit = {
        _id: auditId,
        _type: 'departmentExecutionAudit',
        proposalId: portfolio.proposalId,
        proposalDigest: portfolio.digest,
        actionId: action.proposalId,
        actionDigest: digest(action),
        approvalDigest,
        companyId: this.companyId,
        runId: this.runId,
        departmentId: action.departmentId,
        action: action.action,
        fromStatus: beforeStatus,
        toStatus: afterStatus,
        fromBudgetUsd: cents(beforeBudget),
        toBudgetUsd: cents(action.proposedBudgetUsd),
        fromRevision: beforeRevision,
        toRevision: beforeRevision + 1,
        approvedBy: approval.approvedBy,
        executedAt: now.toISOString(),
      }
      mutations.push({ create: audit })
    }
    await this.client.mutate(mutations)
    return { status: 'applied', changed: actions.length, auditIds }
  }
}
