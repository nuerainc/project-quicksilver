import { defineField, defineType } from 'sanity'

/** Compare-and-swap pointer serializes active versions per tenant and agent. */
export default defineType({
  name: 'agentPublicationHead',
  title: 'Agent definition publication head',
  type: 'document',
  readOnly: true,
  fields: [
    defineField({ name: 'tenantId', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'agentId', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'activeVersion', type: 'number' }),
    defineField({ name: 'updatedAt', type: 'datetime', validation: (rule) => rule.required() }),
  ],
  preview: { select: { id: 'agentId', version: 'activeVersion' }, prepare: ({ id, version }) => ({ title: id ?? 'Agent', subtitle: version ? `active v${version}` : 'no active version' }) },
})
