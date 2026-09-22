import { defineType, defineField } from 'sanity'

export default defineType({
  name: 'department',
  title: 'Department',
  type: 'document',
  fields: [
    defineField({ name: 'name', type: 'string', validation: (r) => r.required() }),
    defineField({ name: 'purpose', type: 'text', rows: 2 }),
    defineField({
      name: 'parentDepartment',
      type: 'reference',
      to: [{ type: 'department' }],
    }),
    defineField({
      name: 'leader',
      type: 'reference',
      to: [{ type: 'entity' }],
    }),
    defineField({
      name: 'members',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'entity' }] }],
    }),
    defineField({
      name: 'capabilities',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'capability' }] }],
    }),
    defineField({
      name: 'objectives',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'objective' }] }],
    }),
  ],
})