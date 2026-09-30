import { defineField, defineType } from 'sanity'

/** Append-only record of agent-definition review and publication actions. */
export default defineType({
  name: 'agentPublicationAudit',
  title: 'Agent definition publication audit',
  type: 'document',
  readOnly: true,
  fields: [
    defineField({ name: 'tenantId', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'event', type: 'string', options: { list: ['draft-created', 'rollback-draft-created', 'submitted-for-review', 'reviewed', 'published', 'deprecated'] }, validation: (rule) => rule.required() }),
    defineField({ name: 'agentId', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'version', type: 'number', validation: (rule) => rule.required().integer().min(1) }),
    defineField({ name: 'actorId', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'at', type: 'datetime', validation: (rule) => rule.required() }),
    defineField({ name: 'definitionDigest', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'detail', type: 'string' }),
  ],
  preview: { select: { event: 'event', id: 'agentId', version: 'version' }, prepare: ({ event, id, version }) => ({ title: `${event ?? 'agent event'} · ${id ?? '?'}`, subtitle: `v${version ?? '?'}` }) },
})
