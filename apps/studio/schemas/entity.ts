import { defineType, defineField } from 'sanity'

/**
 * The unified entity abstraction.
 * Humans, agents, robots, services, contractors, systems are all entities —
 * so the kernel can reason about them with the same primitives.
 */
export default defineType({
  name: 'entity',
  title: 'Entity',
  type: 'document',
  fields: [
    defineField({ name: 'name', type: 'string', validation: (r) => r.required() }),
    defineField({
      name: 'entityType',
      title: 'Entity type',
      type: 'string',
      options: {
        list: [
          { title: 'Human', value: 'human' },
          { title: 'Agent', value: 'agent' },
          { title: 'Robot', value: 'robot' },
          { title: 'Service', value: 'service' },
          { title: 'Contractor', value: 'contractor' },
          { title: 'System', value: 'system' },
        ],
        layout: 'dropdown',
      },
      validation: (r) => r.required(),
    }),
    defineField({
      name: 'capabilities',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'capability' }] }],
    }),
    defineField({
      name: 'permissions',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'policy' }] }],
    }),
    defineField({
      name: 'constraints',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'policy' }] }],
    }),
    defineField({
      name: 'reportsTo',
      type: 'reference',
      to: [{ type: 'entity' }],
    }),
    defineField({
      name: 'department',
      type: 'reference',
      to: [{ type: 'department' }],
    }),
    defineField({
      name: 'availability',
      type: 'string',
      description: 'e.g. "24/7", "business hours", "on-call"',
    }),
    defineField({
      name: 'riskProfile',
      type: 'number',
      description: '0-5; entities with higher profiles require stricter authorization',
      validation: (r) => r.min(0).max(5),
    }),
    defineField({
      name: 'costProfile',
      type: 'string',
      description: 'e.g. "low", "medium", "high", "premium"',
    }),
  ],
})