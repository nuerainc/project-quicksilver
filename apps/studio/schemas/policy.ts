import { defineType, defineField } from 'sanity'
import { guardCondition } from './workflow'

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
    defineField({
      name: 'effect',
      type: 'string',
      description:
        'Optional structured effect. Leave empty to keep free-text behavior (same-scope policies go to a human).',
      options: { list: ['allow', 'require-approval', 'deny'], layout: 'radio' },
    }),
    defineField({
      name: 'maxRiskLevel',
      type: 'number',
      description: 'For "allow": the highest kernel risk (0-5) it permits. Above this, it requires approval.',
      validation: (r) => r.min(0).max(5).integer(),
    }),
    defineField({
      name: 'whenAll',
      title: 'Applies when (all conditions)',
      type: 'array',
      of: [guardCondition],
      description:
        'Conditions over facts. Permissive policies need every fact present; restrictive ones still apply when a fact is missing.',
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