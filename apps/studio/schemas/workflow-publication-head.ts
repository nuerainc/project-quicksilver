import { defineField, defineType } from 'sanity'

/** One compare-and-swap pointer serializes publication changes per workflow. */
export default defineType({
  name: 'workflowPublicationHead',
  title: 'Workflow publication head',
  type: 'document',
  readOnly: true,
  fields: [
    defineField({ name: 'tenantId', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'graphId', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'activeVersion', type: 'number' }),
    defineField({ name: 'updatedAt', type: 'datetime', validation: (rule) => rule.required() }),
  ],
  preview: {
    select: { graphId: 'graphId', version: 'activeVersion' },
    prepare: ({ graphId, version }) => ({ title: graphId ?? 'Workflow', subtitle: version ? `active v${version}` : 'no active version' }),
  },
})
