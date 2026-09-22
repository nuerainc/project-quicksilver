import { defineType, defineField } from 'sanity'

/**
 * Metric — measurable company state. Used by the closed-loop recovery loop.
 * Format: name | value | unit | baseline | direction (lower-better | higher-better)
 */
export default defineType({
  name: 'metric',
  title: 'Metric',
  type: 'document',
  fields: [
    defineField({ name: 'name', type: 'string', validation: (r) => r.required() }),
    defineField({
      name: 'unit',
      type: 'string',
      description: 'e.g. "hours/week", "%", "USD"',
    }),
    defineField({ name: 'value', type: 'number', validation: (r) => r.required() }),
    defineField({ name: 'baseline', type: 'number', description: 'Pre-objective value.' }),
    defineField({
      name: 'direction',
      type: 'string',
      options: {
        list: [
          { title: 'Lower is better', value: 'lower-better' },
          { title: 'Higher is better', value: 'higher-better' },
        ],
        layout: 'radio',
      },
      initialValue: 'lower-better',
    }),
    defineField({
      name: 'objective',
      type: 'reference',
      to: [{ type: 'objective' }],
      description: 'Objective this metric tracks.',
    }),
    defineField({
      name: 'relatedDecision',
      type: 'reference',
      to: [{ type: 'decision' }],
      description: 'The last decision that moved this metric.',
    }),
    defineField({ name: 'updatedAt', type: 'datetime' }),
  ],
})