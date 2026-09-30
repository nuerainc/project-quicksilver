import { defineField, defineType } from 'sanity'

/** Immutable record of an approved internal department structure/budget update. */
export default defineType({
  name: 'departmentExecutionAudit',
  title: 'Department execution audit',
  type: 'document',
  readOnly: true,
  fields: [
    defineField({ name: 'proposalId', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'proposalDigest', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'actionId', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'actionDigest', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'approvalDigest', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'companyId', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'runId', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'departmentId', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'action', type: 'string', options: { list: ['spawn', 'fund', 'shrink', 'retire'] }, validation: (rule) => rule.required() }),
    defineField({ name: 'fromStatus', type: 'string', options: { list: ['active', 'retired'] } }),
    defineField({ name: 'toStatus', type: 'string', options: { list: ['active', 'retired'] }, validation: (rule) => rule.required() }),
    defineField({ name: 'fromBudgetUsd', type: 'number', validation: (rule) => rule.required() }),
    defineField({ name: 'toBudgetUsd', type: 'number', validation: (rule) => rule.required() }),
    defineField({ name: 'fromRevision', type: 'number', validation: (rule) => rule.required().integer() }),
    defineField({ name: 'toRevision', type: 'number', validation: (rule) => rule.required().integer() }),
    defineField({ name: 'approvedBy', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'executedAt', type: 'datetime', validation: (rule) => rule.required() }),
  ],
  orderings: [{ title: 'Execution time', name: 'executedAt', by: [{ field: 'executedAt', direction: 'desc' }] }],
  preview: { select: { action: 'action', department: 'departmentId', at: 'executedAt' }, prepare: ({ action, department, at }) => ({ title: `${action ?? 'change'} · ${department ?? '?'}`, subtitle: at }) },
})
