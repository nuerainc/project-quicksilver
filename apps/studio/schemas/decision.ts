import { defineType, defineField } from 'sanity'

/**
 * The auditable decision artifact.
 * Stored after the kernel authorizes or rejects a proposed action.
 * NOT a chain-of-thought log — a structured record suitable for review.
 */
export default defineType({
  name: 'decision',
  title: 'Decision',
  type: 'document',
  fields: [
    defineField({ name: 'question', type: 'text', rows: 2 }),
    defineField({
      name: 'context',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'entity', }, { type: 'capability' }, { type: 'policy' }] }],
    }),
    defineField({
      name: 'candidateActions',
      type: 'array',
      of: [
        {
          type: 'object',
          fields: [
            { name: 'description', type: 'string' },
            { name: 'actor', type: 'reference', to: [{ type: 'entity' }] },
            { name: 'capability', type: 'reference', to: [{ type: 'capability' }] },
          ],
        },
      ],
    }),
    defineField({ name: 'selectedAction', type: 'string' }),
    defineField({
      name: 'reasoningSummary',
      type: 'text',
      rows: 4,
      description: 'One-paragraph human-readable explanation of why this action was chosen',
    }),
    defineField({
      name: 'evidence',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'evidence' }] }],
    }),
    defineField({
      name: 'constraints',
      type: 'array',
      of: [{ type: 'string' }],
    }),
    defineField({
      name: 'policyChecks',
      type: 'array',
      of: [
        {
          type: 'object',
          fields: [
            { name: 'policy', type: 'reference', to: [{ type: 'policy' }] },
            {
              name: 'result',
              type: 'string',
              options: { list: ['applies', 'superseded', 'conflicts', 'inapplicable'] },
            },
            { name: 'reason', type: 'string' },
          ],
        },
      ],
    }),
    defineField({
      name: 'riskLevel',
      type: 'number',
      validation: (r) => r.min(0).max(5),
    }),
    defineField({ name: 'requiredApproval', type: 'boolean' }),
    defineField({
      name: 'reviewerNotes',
      type: 'object',
      description:
        'Independent second opinion from the reviewer model (packages/agent/src/reviewer.ts). ' +
        'Advisory only -- the kernel above is what actually authorizes or blocks.',
      fields: [
        { name: 'valid', type: 'boolean' },
        { name: 'policyConflicts', type: 'array', of: [{ type: 'string' }] },
        { name: 'missingEvidence', type: 'array', of: [{ type: 'string' }] },
        { name: 'riskConcerns', type: 'array', of: [{ type: 'string' }] },
        { name: 'suggestions', type: 'array', of: [{ type: 'string' }] },
      ],
    }),
    defineField({
      name: 'status',
      type: 'string',
      options: {
        list: ['proposed', 'awaiting-approval', 'approved', 'rejected', 'executed', 'failed', 'rolled-back'],
        layout: 'dropdown',
      },
    }),
    defineField({ name: 'createdAt', type: 'datetime' }),
    defineField({
      name: 'approvedBy',
      type: 'reference',
      to: [{ type: 'entity' }],
    }),
    defineField({ name: 'executedAt', type: 'datetime' }),
  ],
})
