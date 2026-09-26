import { defineType, defineField } from 'sanity'

/**
 * One entry of an Aura intent ledger (see packages/aura/src/ledger.ts).
 * Append-only and hash-chained: entries are written by Aura with
 * createIfNotExists and never edited here. Ids contain a dot
 * ("intent-ledger.<company>.<seq>"), which keeps them out of
 * unauthenticated reads.
 */
export default defineType({
  name: 'intentLedgerEntry',
  title: 'Intent ledger entry',
  type: 'document',
  readOnly: true,
  fields: [
    defineField({ name: 'companyId', type: 'string' }),
    defineField({ name: 'seq', type: 'number' }),
    defineField({ name: 'at', type: 'datetime' }),
    defineField({ name: 'actorId', type: 'string', description: 'Kernel principal id of the provider or admin.' }),
    defineField({ name: 'actorRole', type: 'string', options: { list: ['provider', 'admin'] } }),
    defineField({ name: 'changeType', type: 'string', options: { list: ['company.create', 'providers.set', 'admins.set', 'rule.set', 'goal.set', 'goal.retire', 'weight.set', 'autonomy.set', 'commitment.set', 'commitment.retire', 'principle.set', 'principle.retire'] } }),
    defineField({ name: 'changeJson', type: 'text', description: 'The change exactly as hashed.' }),
    defineField({ name: 'previousJson', type: 'text', description: 'The value this change replaced.' }),
    defineField({ name: 'reason', type: 'string' }),
    defineField({ name: 'prevHash', type: 'string' }),
    defineField({ name: 'hash', type: 'string' }),
    defineField({ name: 'signature', type: 'string', description: 'Ed25519 signature of the hash, when signing is on.' }),
  ],
  orderings: [{ title: 'Sequence', name: 'seq', by: [{ field: 'companyId', direction: 'asc' }, { field: 'seq', direction: 'asc' }] }],
  preview: {
    select: { company: 'companyId', seq: 'seq', type: 'changeType', actor: 'actorId', role: 'actorRole' },
    prepare: ({ company, seq, type, actor, role }) => ({ title: `${company ?? '?'} #${seq ?? '?'} · ${type ?? '?'}`, subtitle: `${actor ?? '?'} (${role ?? '?'})` }),
  },
})
