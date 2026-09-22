import { defineType, defineField } from 'sanity'

export default defineType({
  name: 'workflow',
  title: 'Workflow',
  type: 'document',
  fields: [
    defineField({ name: 'name', type: 'string', validation: (r) => r.required() }),
    defineField({
      name: 'trigger',
      type: 'string',
      description: 'What initiates this workflow (event, condition, request)',
    }),
    defineField({
      name: 'states',
      type: 'array',
      of: [
        {
          type: 'object',
          fields: [
            { name: 'id', type: 'string' },
            { name: 'label', type: 'string' },
          ],
        },
      ],
    }),
    defineField({
      name: 'transitions',
      type: 'array',
      of: [
        {
          type: 'object',
          fields: [
            { name: 'from', type: 'string' },
            { name: 'to', type: 'string' },
            { name: 'guard', type: 'string', description: 'Condition that must hold' },
          ],
        },
      ],
    }),
    defineField({
      name: 'requiredCapabilities',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'capability' }] }],
    }),
    defineField({
      name: 'approvalRequirements',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'entity' }] }],
    }),
    defineField({
      name: 'failureHandlers',
      type: 'array',
      of: [{ type: 'string' }],
    }),
    defineField({
      name: 'rollbackProcedure',
      type: 'text',
      rows: 4,
    }),
  ],
})