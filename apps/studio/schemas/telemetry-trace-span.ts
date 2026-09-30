import { defineField, defineType } from 'sanity'

/** Immutable telemetry metadata. Do not add prompt, output, tool-argument, or credential fields. */
export default defineType({
  name: 'telemetryTraceSpan',
  title: 'Telemetry trace span',
  type: 'document',
  readOnly: true,
  fields: [
    defineField({ name: 'tenantId', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'traceId', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'spanId', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'parentSpanId', type: 'string' }),
    defineField({ name: 'source', type: 'string', options: { list: ['query', 'plan', 'workflow', 'decision'] }, validation: (rule) => rule.required() }),
    defineField({ name: 'kind', type: 'string', options: { list: ['request', 'model', 'tool', 'evaluation', 'decision', 'workflow'] }, validation: (rule) => rule.required() }),
    defineField({ name: 'name', type: 'string', validation: (rule) => rule.required().max(96) }),
    defineField({ name: 'status', type: 'string', options: { list: ['ok', 'error', 'blocked'] }, validation: (rule) => rule.required() }),
    defineField({ name: 'startedAt', type: 'datetime', validation: (rule) => rule.required() }),
    defineField({ name: 'completedAt', type: 'datetime', validation: (rule) => rule.required() }),
    defineField({ name: 'durationMs', type: 'number', validation: (rule) => rule.required().integer().min(0) }),
    defineField({ name: 'requestedBy', type: 'string', validation: (rule) => rule.required() }),
    defineField({ name: 'runId', type: 'string' }),
    defineField({ name: 'workflowId', type: 'string' }),
    defineField({ name: 'decisionId', type: 'string' }),
    defineField({ name: 'agentId', type: 'string' }),
    defineField({ name: 'modelId', type: 'string' }),
    defineField({ name: 'toolName', type: 'string' }),
    defineField({ name: 'toolSucceeded', type: 'boolean' }),
    defineField({ name: 'inputTokens', type: 'number' }),
    defineField({ name: 'outputTokens', type: 'number' }),
    defineField({ name: 'totalTokens', type: 'number' }),
    defineField({ name: 'estimatedCostUsd', type: 'number', description: 'Blended estimate from the model performance profile, not a provider invoice.' }),
    defineField({ name: 'safetyDecision', type: 'string', options: { list: ['ALLOW', 'BLOCK', 'ESCALATE'] } }),
  ],
  preview: {
    select: { traceId: 'traceId', kind: 'kind', name: 'name', status: 'status' },
    prepare: ({ traceId, kind, name, status }) => ({ title: `${kind ?? 'span'} · ${name ?? '?'}`, subtitle: `${status ?? '?'} · ${traceId ?? ''}` }),
  },
})
