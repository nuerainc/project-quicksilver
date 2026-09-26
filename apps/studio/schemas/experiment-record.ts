import { defineType, defineField } from 'sanity'

/**
 * One Genesis experiment (M5, see packages/kernel/src/playbooks/economics.ts
 * and packages/host/src/genesis-store.ts). Its definition and digest are fixed
 * once it leaves draft; measurements and decisions only grow. Written by
 * `npm run genesis` only, so the record is read-only here.
 * Id: "experiment-record.<runId>.<experimentId>".
 */
export default defineType({
  name: 'experimentRecord',
  title: 'Experiment',
  type: 'document',
  readOnly: true,
  fields: [
    defineField({ name: 'runId', type: 'string' }),
    defineField({ name: 'experimentId', type: 'string' }),
    defineField({ name: 'position', type: 'number', description: 'Drafting order within the run.' }),
    defineField({ name: 'status', type: 'string', options: { list: ['draft', 'running', 'killed', 'held', 'scaled', 'completed'] } }),
    defineField({ name: 'hypothesis', type: 'text' }),
    defineField({ name: 'playbookId', type: 'string' }),
    defineField({ name: 'budgetUsd', title: 'Budget (USD)', type: 'number' }),
    defineField({ name: 'durationDays', type: 'number' }),
    defineField({ name: 'customerFacing', type: 'boolean' }),
    defineField({ name: 'proposedBy', type: 'string' }),
    defineField({ name: 'definitionJson', title: 'Definition (JSON)', type: 'text', description: 'The definition exactly as digested.' }),
    defineField({ name: 'digest', type: 'string' }),
    defineField({ name: 'startedAt', type: 'datetime' }),
    defineField({ name: 'startedBy', type: 'string' }),
    defineField({ name: 'endsAt', type: 'datetime' }),
    defineField({ name: 'measurementsJson', type: 'text' }),
    defineField({ name: 'decisionsJson', type: 'text' }),
  ],
  orderings: [{ title: 'Drafting order', name: 'position', by: [{ field: 'runId', direction: 'asc' }, { field: 'position', direction: 'asc' }] }],
  preview: {
    select: { id: 'experimentId', status: 'status', hypothesis: 'hypothesis' },
    prepare: ({ id, status, hypothesis }) => ({ title: `${id ?? '?'} [${status ?? '?'}]`, subtitle: hypothesis }),
  },
})
