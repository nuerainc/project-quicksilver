import { defineType, defineField } from 'sanity'

/**
 * One shadow-mode recommendation (M4, see packages/kernel/src/playbooks/shadow.ts
 * and packages/host/src/shadow-store-sanity.ts). Nothing here was executed:
 * the kernel's verdict shows what Quicksilver WOULD have done. Written by the
 * host only. The recommendation is append-only; the owner's verdict and the
 * outcome are each recorded once and never rewritten, so the document is
 * read-only here. Ids contain a dot ("shadow-recommendation.<intentId>.<recId>"),
 * which keeps them out of unauthenticated reads.
 */
const stamp = (name: string, title: string, values: string[]) =>
  defineField({
    name,
    title,
    type: 'object',
    readOnly: true,
    fields: [
      defineField({ name: 'value', type: 'string', options: { list: values } }),
      defineField({ name: 'by', type: 'string', description: 'Kernel principal id of the human who recorded it.' }),
      defineField({ name: 'at', type: 'datetime' }),
      defineField({ name: 'note', type: 'string' }),
    ],
  })

export default defineType({
  name: 'shadowRecommendation',
  title: 'Shadow recommendation',
  type: 'document',
  readOnly: true,
  fields: [
    defineField({ name: 'intentId', type: 'string' }),
    defineField({ name: 'recId', title: 'Recommendation id', type: 'string' }),
    defineField({ name: 'seq', type: 'number', description: 'Position in the shadow log.' }),
    defineField({ name: 'department', type: 'string' }),
    defineField({ name: 'description', type: 'text' }),
    defineField({ name: 'proposedAt', type: 'datetime' }),
    defineField({ name: 'source', type: 'string', options: { list: ['human', 'agent'] } }),
    defineField({ name: 'kernelRecommendation', type: 'string', options: { list: ['execute-autonomously', 'request-approval', 'reject'] } }),
    defineField({ name: 'kernelRiskLevel', type: 'number' }),
    defineField({ name: 'executed', type: 'boolean', description: 'Always false: shadow mode never executes.' }),
    defineField({ name: 'featuresJson', type: 'text', description: 'Plain-number features for Aura\'s learner.' }),
    defineField({
      name: 'prediction',
      type: 'object',
      description: 'Aura\'s prediction of the verdict, recorded before it (AGENT_INFERRED).',
      fields: [
        defineField({ name: 'accept', type: 'number' }),
        defineField({ name: 'observations', type: 'number' }),
        defineField({ name: 'model', type: 'string' }),
      ],
    }),
    stamp('verdict', 'Verdict', ['accepted', 'modified', 'rejected']),
    stamp('outcome', 'Outcome', ['good', 'neutral', 'bad']),
  ],
  orderings: [{ title: 'Log order', name: 'seq', by: [{ field: 'intentId', direction: 'asc' }, { field: 'seq', direction: 'asc' }] }],
  preview: {
    select: { dept: 'department', description: 'description', verdict: 'verdict.value', kernel: 'kernelRecommendation' },
    prepare: ({ dept, description, verdict, kernel }) => ({ title: `${dept ?? '?'} · ${description ?? ''}`, subtitle: `kernel: ${kernel ?? '?'} · verdict: ${verdict ?? 'pending'}` }),
  },
})
