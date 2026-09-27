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
      name: 'inherits',
      title: 'Inherits from',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'capability' }] }],
      description:
        'Optional parents. This capability inherits their governing scopes, base-risk floor, dependencies, conflicts and risk multipliers. Inheritance never grants a right: holding a parent does not allow this capability.',
    }),
    defineField({
      name: 'requires',
      title: 'Requires',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'capability' }] }],
      description: 'Optional. To use this capability an actor must also hold each of these (transitively).',
    }),
    defineField({
      name: 'conflictsWith',
      title: 'Conflicts with',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'capability' }] }],
      description:
        'Optional. The same actor may not hold this capability and any of these (separation of duties); either is refused unless the sole-operator override applies.',
    }),
    defineField({
      name: 'riskMultiplier',
      type: 'number',
      description:
        'Optional, at least 1. Multiplies the action\'s computed risk (rounded up, capped at 5) before policies see it. Multipliers along the inheritance chain multiply.',
      validation: (r) => r.min(1),
    }),
    defineField({
      name: 'requiredTools',
      type: 'array',
      of: [{ type: 'string' }],
    }),
  ],
})