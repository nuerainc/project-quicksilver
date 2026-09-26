import { defineType, defineField } from 'sanity'

/**
 * A playbook (M4): business stages as a process definition, a workflow graph
 * per working stage, metrics with kill / hold / scale thresholds, a budget
 * and an owner (see packages/kernel/src/playbooks). The definition is data
 * only. Publishing goes through the kernel: a human with workflow:publish who
 * is not the author, pinned to the content digest, so status fields are
 * read-only here.
 */
export default defineType({
  name: 'playbook',
  title: 'Playbook',
  type: 'document',
  fields: [
    defineField({ name: 'playbookId', type: 'string', validation: (r) => r.required() }),
    defineField({ name: 'version', type: 'number', validation: (r) => r.required().integer().min(1) }),
    defineField({ name: 'name', type: 'string', validation: (r) => r.required() }),
    defineField({ name: 'modes', type: 'array', of: [{ type: 'string' }], options: { list: ['genesis', 'onboard', 'operate'] } }),
    defineField({ name: 'definitionJson', title: 'Definition (JSON)', type: 'text', rows: 20, description: 'The full playbook definition. Validated by the kernel before it can be published.' }),
    defineField({ name: 'status', type: 'string', options: { list: ['draft', 'published', 'retired'] }, readOnly: true, initialValue: 'draft' }),
    defineField({ name: 'digest', type: 'string', readOnly: true }),
    defineField({ name: 'authoredBy', type: 'string', readOnly: true }),
    defineField({ name: 'publishedBy', type: 'string', readOnly: true }),
    defineField({ name: 'publishedAt', type: 'datetime', readOnly: true }),
  ],
  preview: {
    select: { title: 'name', v: 'version', status: 'status' },
    prepare: ({ title, v, status }) => ({ title: title ?? '(unnamed playbook)', subtitle: `v${v ?? '?'} · ${status ?? 'draft'}` }),
  },
})
