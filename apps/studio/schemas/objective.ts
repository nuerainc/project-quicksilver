import { defineType, defineField } from 'sanity'

export default defineType({
  name: 'objective',
  title: 'Objective',
  type: 'document',
  fields: [
    defineField({ name: 'name', type: 'string', validation: (r) => r.required() }),
    defineField({ name: 'description', type: 'text', rows: 3 }),
    defineField({
      name: 'owner',
      type: 'reference',
      to: [{ type: 'entity' }],
    }),
    defineField({
      name: 'priority',
      type: 'number',
      validation: (r) => r.min(0).max(10),
    }),
    defineField({ name: 'deadline', type: 'date' }),
    defineField({
      name: 'constraints',
      type: 'array',
      of: [{ type: 'string' }],
    }),
    defineField({
      name: 'successMetrics',
      type: 'array',
      of: [{ type: 'string' }],
    }),
    defineField({
      name: 'budget',
      type: 'object',
      fields: [
        { name: 'amount', type: 'number' },
        { name: 'currency', type: 'string' },
      ],
    }),
    defineField({
      name: 'status',
      type: 'string',
      options: {
        list: ['draft', 'active', 'blocked', 'achieved', 'abandoned'],
        layout: 'dropdown',
      },
    }),
  ],
})