import { defineType, defineField } from 'sanity'

export default defineType({
  name: 'policy',
  title: 'Policy',
  type: 'document',
  fields: [
    defineField({ name: 'name', type: 'string', validation: (r) => r.required() }),
    defineField({
      name: 'scope',
      type: 'string',
      description: 'e.g. "production.parameter_changes", "finance.transfers"',
    }),
    defineField({
      name: 'priority',
      type: 'number',
      description: 'Higher wins on conflict; the kernel uses this to resolve',
      validation: (r) => r.required(),
    }),
    defineField({
      name: 'rules',
      type: 'array',
      of: [{ type: 'text' }],
    }),
    defineField({ name: 'effectiveDate', type: 'date' }),
    defineField({ name: 'expirationDate', type: 'date' }),
    defineField({
      name: 'supersedes',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'policy' }] }],
    }),
    defineField({
      name: 'appliesTo',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'entity' }] }],
    }),
    defineField({
      name: 'approvalRequirements',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'entity' }] }],
      description: 'Entities whose approval is required for actions under this policy',
    }),
  ],
})