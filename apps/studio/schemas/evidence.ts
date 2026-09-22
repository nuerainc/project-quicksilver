import { defineType, defineField } from 'sanity'

export default defineType({
  name: 'evidence',
  title: 'Evidence',
  type: 'document',
  fields: [
    defineField({ name: 'title', type: 'string', validation: (r) => r.required() }),
    defineField({
      name: 'type',
      type: 'string',
      options: {
        list: ['report', 'metric', 'incident', 'analysis', 'observation', 'external'],
        layout: 'dropdown',
      },
    }),
    defineField({
      name: 'source',
      type: 'string',
      description: 'Origin system, document, or person',
    }),
    defineField({
      name: 'claim',
      type: 'text',
      rows: 3,
      description: 'What this evidence asserts',
    }),
    defineField({
      name: 'confidence',
      type: 'number',
      description: '0-1; how reliable is the evidence',
      validation: (r) => r.min(0).max(1),
    }),
    defineField({ name: 'effectiveDate', type: 'date' }),
    defineField({
      name: 'relatedEntities',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'entity' }] }],
    }),
    defineField({
      name: 'supports',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'objective' }] }],
    }),
    defineField({
      name: 'contradicts',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'evidence' }] }],
    }),
  ],
})