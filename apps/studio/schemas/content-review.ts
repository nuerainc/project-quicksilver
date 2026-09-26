import { defineType, defineField } from 'sanity'

/**
 * One review of a Genesis run's customer-facing text (M5, see
 * packages/host/src/genesis-reviews.ts and genesis-store.ts). Until WAES runs
 * as a service these are MANUAL FOUNDER REVIEWS (kind "manual",
 * components ["MANUAL-FOUNDER-REVIEW"]), never WAES evaluations.
 * Append-only: written with createIfNotExists, never edited here; a new
 * decision is a new document. Id: "content-review.<runId>.<reviewId>".
 */
export default defineType({
  name: 'contentReview',
  title: 'Content review',
  type: 'document',
  readOnly: true,
  fields: [
    defineField({ name: 'runId', type: 'string' }),
    defineField({ name: 'reviewId', type: 'string' }),
    defineField({ name: 'kind', type: 'string', options: { list: [{ title: 'Manual founder review (not WAES)', value: 'manual' }, { title: 'WAES', value: 'waes' }] } }),
    defineField({ name: 'contentDigest', type: 'string', description: 'sha256 of the exact text reviewed.' }),
    defineField({ name: 'text', type: 'text', description: 'The exact text reviewed.' }),
    defineField({ name: 'verdict', type: 'string', options: { list: ['pass', 'revise', 'block'] } }),
    defineField({ name: 'components', type: 'array', of: [{ type: 'string' }] }),
    defineField({ name: 'reviewer', type: 'string' }),
    defineField({ name: 'reviewerKind', type: 'string', options: { list: ['human', 'service'] } }),
    defineField({ name: 'reviewedAt', type: 'datetime' }),
    defineField({ name: 'note', type: 'string' }),
    defineField({ name: 'experimentId', type: 'string' }),
    defineField({ name: 'channel', type: 'string' }),
  ],
  orderings: [{ title: 'Reviewed', name: 'reviewedAt', by: [{ field: 'reviewedAt', direction: 'desc' }] }],
  preview: {
    select: { kind: 'kind', verdict: 'verdict', channel: 'channel', text: 'text' },
    prepare: ({ kind, verdict, channel, text }) => ({ title: `${kind === 'manual' ? 'Manual founder review' : 'WAES'} · ${verdict ?? '?'} · ${channel ?? '?'}`, subtitle: text }),
  },
})
