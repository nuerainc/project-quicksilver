import { defineType, defineField } from 'sanity'

/**
 * The fictional company — the root document.
 * Quicksilver reads exactly one organization document per session.
 */
export default defineType({
  name: 'organization',
  title: 'Organization',
  type: 'document',
  fields: [
    defineField({ name: 'name', type: 'string', validation: (r) => r.required() }),
    defineField({ name: 'mission', type: 'text', rows: 3 }),
    defineField({
      name: 'objectives',
      title: 'Active objectives',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'objective' }] }],
    }),
    defineField({
      name: 'departments',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'department' }] }],
    }),
    defineField({
      name: 'policies',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'policy' }] }],
    }),
    defineField({
      name: 'resources',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'entity' }] }],
    }),
  ],
})