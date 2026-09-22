import { defineType, defineField, defineArrayMember } from 'sanity'

/**
 * Process definition -- an executable workflow.
 *
 * The document type keeps its original name, `workflow`, so existing
 * references and GROQ queries keep working. In Studio it is labelled
 * "Process definition" to keep it distinct from the Sanity Workflows
 * plugin (the Studio review board configured in sanity.config.ts).
 *
 * The Quicksilver kernel (packages/kernel/src/process.ts) runs these:
 * it validates the definition, then authorizes every state change against
 * its transitions and guards. Guards are structured conditions, never
 * code -- the kernel does not evaluate strings.
 */

const GUARD_OPS = [
  { title: 'equals', value: 'eq' },
  { title: 'does not equal', value: 'neq' },
  { title: 'greater than', value: 'gt' },
  { title: 'greater than or equal', value: 'gte' },
  { title: 'less than', value: 'lt' },
  { title: 'less than or equal', value: 'lte' },
  { title: 'is one of', value: 'in' },
  { title: 'is not one of', value: 'notIn' },
  { title: 'exists', value: 'exists' },
]

const guardCondition = defineArrayMember({
  type: 'object',
  name: 'guardCondition',
  title: 'Condition',
  fields: [
    defineField({
      name: 'fact',
      type: 'string',
      description: 'Dotted fact name, e.g. kernel.riskLevel, execution.success, decision.kind',
      validation: (r) => r.required().regex(/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)*$/, { name: 'dotted fact name' }),
    }),
    defineField({
      name: 'op',
      title: 'Operator',
      type: 'string',
      options: { list: GUARD_OPS, layout: 'dropdown' },
      validation: (r) => r.required(),
    }),
    defineField({ name: 'valueString', title: 'Value (text)', type: 'string' }),
    defineField({ name: 'valueNumber', title: 'Value (number)', type: 'number' }),
    defineField({ name: 'valueBoolean', title: 'Value (true/false)', type: 'boolean' }),
    defineField({ name: 'valueList', title: 'Value (list, for "is one of")', type: 'array', of: [{ type: 'string' }] }),
  ],
  preview: {
    select: { fact: 'fact', op: 'op', s: 'valueString', n: 'valueNumber', b: 'valueBoolean', l: 'valueList' },
    prepare: ({ fact, op, s, n, b, l }) => ({
      title: `${fact ?? '?'} ${op ?? '?'} ${
        s ?? (typeof n === 'number' ? n : undefined) ?? (typeof b === 'boolean' ? String(b) : undefined) ?? (Array.isArray(l) ? `[${l.join(', ')}]` : '')
      }`,
    }),
  },
})

export default defineType({
  name: 'workflow',
  title: 'Process definition',
  type: 'document',
  fields: [
    defineField({ name: 'name', type: 'string', validation: (r) => r.required() }),
    defineField({
      name: 'version',
      type: 'number',
      description: 'Bump when the process changes meaningfully. Stamped on every decision the kernel moves.',
      validation: (r) => r.required().integer().min(1),
    }),
    defineField({
      name: 'trigger',
      type: 'string',
      description: 'What initiates this process (event, condition, request)',
    }),
    defineField({
      name: 'initialState',
      type: 'string',
      description: 'The id of the state every new instance starts in',
      validation: (r) => r.required(),
    }),
    defineField({
      name: 'states',
      type: 'array',
      of: [
        defineArrayMember({
          type: 'object',
          name: 'processState',
          fields: [
            { name: 'id', type: 'string', validation: (r) => r.required() },
            { name: 'label', type: 'string' },
            { name: 'terminal', type: 'boolean', description: 'No transitions may leave a terminal state' },
          ],
          preview: {
            select: { id: 'id', label: 'label', terminal: 'terminal' },
            prepare: ({ id, label, terminal }) => ({ title: label ?? id, subtitle: `${id}${terminal ? ' · terminal' : ''}` }),
          },
        }),
      ],
    }),
    defineField({
      name: 'transitions',
      type: 'array',
      of: [
        defineArrayMember({
          type: 'object',
          name: 'processTransition',
          fields: [
            { name: 'id', type: 'string', validation: (r) => r.required() },
            { name: 'label', type: 'string' },
            { name: 'from', type: 'string', validation: (r) => r.required() },
            { name: 'to', type: 'string', validation: (r) => r.required() },
            {
              name: 'automatic',
              type: 'boolean',
              description: 'The kernel takes this transition on its own as soon as the guard holds',
            },
            {
              name: 'requiresHumanApproval',
              type: 'boolean',
              description: 'Only a human may take this transition',
            },
            {
              name: 'guardAll',
              title: 'Guard: all of',
              type: 'array',
              of: [guardCondition],
              description: 'Every condition must hold',
            },
            {
              name: 'guardAny',
              title: 'Guard: any of',
              type: 'array',
              of: [guardCondition],
              description: 'At least one condition must hold (if any are listed)',
            },
            {
              name: 'guard',
              title: 'Guard note (legacy, not evaluated)',
              type: 'string',
              description: 'Free-text note from the original schema. The kernel ignores it; use the structured guards above.',
              hidden: ({ value }) => !value,
            },
          ],
          preview: {
            select: { id: 'id', from: 'from', to: 'to', automatic: 'automatic', human: 'requiresHumanApproval' },
            prepare: ({ id, from, to, automatic, human }) => ({
              title: `${from} → ${to}`,
              subtitle: [id, automatic ? 'automatic' : null, human ? 'human only' : null].filter(Boolean).join(' · '),
            }),
          },
        }),
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
  preview: {
    select: { name: 'name', version: 'version' },
    prepare: ({ name, version }) => ({ title: name, subtitle: version ? `v${version}` : 'unversioned' }),
  },
})
