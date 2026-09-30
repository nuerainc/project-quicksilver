import { defineField, defineType } from 'sanity'

/** Append-only record of workflow draft, review, release, and rollback actions. */
export default defineType({
  name: 'workflowPublicationAudit',
  title: 'Workflow publication audit',
  type: 'document',
  readOnly: true,
  fields: [
    defineField({ name: 'tenantId', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'event', type: 'string', options: { list: ['draft-created', 'submitted-for-review', 'reviewed', 'published', 'deprecated', 'rolled-back'] }, validation: (rule) => rule.required() }),
    defineField({ name: 'graphId', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'version', type: 'number', validation: (rule) => rule.required().integer().min(1) }),
    defineField({ name: 'actorId', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'at', type: 'datetime', validation: (rule) => rule.required() }),
    defineField({ name: 'graphDigest', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'detail', type: 'string' }),
  ],
  preview: {
    select: { event: 'event', graphId: 'graphId', version: 'version', actorId: 'actorId' },
    prepare: ({ event, graphId, version, actorId }) => ({ title: `${event ?? 'workflow event'} · ${graphId ?? '?'}`, subtitle: `v${version ?? '?'} · ${actorId ?? '?'}` }),
  },
})
