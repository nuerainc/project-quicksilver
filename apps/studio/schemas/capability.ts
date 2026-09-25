import { defineType, defineField } from 'sanity'

export default defineType({
  name: 'capability',
  title: 'Capability',
  type: 'document',
  fields: [
    defineField({ name: 'name', type: 'string', validation: (r) => r.required() }),
    defineField({ name: 'description', type: 'text', rows: 3 }),
    defineField({
      name: 'requiredSkills',
      type: 'array',
      of: [{ type: 'string' }],
    }),
    defineField({
      name: 'riskLevel',
      title: 'Base risk level',
      type: 'number',
      description: '0-5; the kernel uses this as a baseline for authorization',
      validation: (r) => r.required().min(0).max(5),
    }),
    defineField({
      name: 'authorizedEntities',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'entity' }] }],
    }),
    defineField({
      name: 'policyScopes',
      title: 'Governing policy scopes',
      type: 'array',
      of: [{ type: 'string' }],
      description:
        'Policy scopes that govern this capability, e.g. "production.parameter_changes". The kernel applies every live policy in these scopes, even ones the planner did not cite.',
    }),
    defineField({
      name: 'requiredTools',
      type: 'array',
      of: [{ type: 'string' }],
    }),
  ],
})