import { defineType, defineField } from 'sanity'

/**
 * One entry of a Genesis run's money ledger (M5, see
 * packages/kernel/src/playbooks/economics.ts and packages/host/src/genesis-store.ts).
 * Append-only and hash-chained: written with createIfNotExists, verified on
 * every load, never edited here. Id: "money-entry.<runId>.<seq>".
 */
export default defineType({
  name: 'moneyEntry',
  title: 'Money entry',
  type: 'document',
  readOnly: true,
  fields: [
    defineField({ name: 'runId', type: 'string' }),
    defineField({ name: 'seq', type: 'number' }),
    defineField({ name: 'kind', type: 'string', options: { list: ['spend', 'compute', 'revenue', 'refund'] } }),
    defineField({ name: 'amountUsd', title: 'Amount (USD)', type: 'number' }),
    defineField({ name: 'category', type: 'string' }),
    defineField({ name: 'description', type: 'string' }),
    defineField({ name: 'experimentId', type: 'string' }),
    defineField({ name: 'sourceType', type: 'string', options: { list: ['receipt', 'invoice', 'provider-usage', 'payment-processor', 'bank', 'manual'] } }),
    defineField({ name: 'sourceRef', type: 'string' }),
    defineField({ name: 'occurredAt', type: 'datetime' }),
    defineField({ name: 'recordedAt', type: 'datetime' }),
    defineField({ name: 'recordedBy', type: 'string' }),
    defineField({ name: 'prevHash', type: 'string' }),
    defineField({ name: 'hash', type: 'string' }),
  ],
  orderings: [{ title: 'Sequence', name: 'seq', by: [{ field: 'runId', direction: 'asc' }, { field: 'seq', direction: 'asc' }] }],
  preview: {
    select: { run: 'runId', seq: 'seq', kind: 'kind', amount: 'amountUsd', description: 'description' },
    prepare: ({ run, seq, kind, amount, description }) => ({ title: `${run ?? '?'} #${seq ?? '?'} · ${kind ?? '?'} $${typeof amount === 'number' ? amount.toFixed(2) : '?'}`, subtitle: description }),
  },
})
