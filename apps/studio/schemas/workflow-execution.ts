import { defineField, defineType } from 'sanity'

/** Metadata-only workflow run history; request and response bodies are not retained. */
export default defineType({
  name: 'workflowExecution',
  title: 'Workflow execution',
  type: 'document',
  readOnly: true,
  fields: [
    defineField({ name: 'tenantId', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'runId', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'workflowId', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'version', type: 'number', validation: (rule) => rule.required().integer().min(1) }),
    defineField({ name: 'digest', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'requestedBy', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'status', type: 'string', options: { list: ['succeeded', 'blocked', 'failed'] }, validation: (rule) => rule.required() }),
    defineField({ name: 'startedAt', type: 'datetime', validation: (rule) => rule.required() }),
    defineField({ name: 'completedAt', type: 'datetime', validation: (rule) => rule.required() }),
    defineField({ name: 'durationMs', type: 'number', validation: (rule) => rule.required().integer().min(0) }),
    defineField({ name: 'evaluationCount', type: 'number', validation: (rule) => rule.required().integer().min(0) }),
  ],
  preview: {
    select: { workflowId: 'workflowId', version: 'version', status: 'status', runId: 'runId' },
    prepare: ({ workflowId, version, status, runId }) => ({ title: `${workflowId ?? 'Workflow'} v${version ?? '?'}`, subtitle: `${status ?? 'unknown'} · ${runId ?? ''}` }),
  },
})
