import { defineType, defineField } from 'sanity'

/**
 * The auditable decision artifact.
 * Stored after the kernel authorizes or rejects a proposed action.
 * NOT a chain-of-thought log — a structured record suitable for review.
 */
export default defineType({
  name: 'decision',
  title: 'Decision',
  type: 'document',
  fields: [
    defineField({ name: 'question', type: 'text', rows: 2 }),
    defineField({
      name: 'context',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'entity', }, { type: 'capability' }, { type: 'policy' }] }],
    }),
    defineField({
      name: 'candidateActions',
      type: 'array',
      of: [
        {
          type: 'object',
          fields: [
            { name: 'description', type: 'string' },
            { name: 'actor', type: 'reference', to: [{ type: 'entity' }] },
            { name: 'capability', type: 'reference', to: [{ type: 'capability' }] },
          ],
        },
      ],
    }),
    defineField({ name: 'selectedAction', type: 'string' }),
    defineField({
      name: 'reasoningSummary',
      type: 'text',
      rows: 4,
      description: 'One-paragraph human-readable explanation of why this action was chosen',
    }),
    defineField({
      name: 'evidence',
      type: 'array',
      of: [{ type: 'reference', to: [{ type: 'evidence' }] }],
    }),
    defineField({
      name: 'constraints',
      type: 'array',
      of: [{ type: 'string' }],
    }),
    defineField({
      name: 'policyResolutions',
      type: 'array',
      of: [{ type: 'string' }],
      description: 'Policy disagreements the kernel resolved deterministically by priority.',
      readOnly: true,
    }),
    defineField({
      name: 'policyChecks',
      type: 'array',
      of: [
        {
          type: 'object',
          fields: [
            { name: 'policy', type: 'reference', to: [{ type: 'policy' }] },
            {
              name: 'result',
              type: 'string',
              options: { list: ['applies', 'superseded', 'conflicts', 'inapplicable'] },
            },
            { name: 'reason', type: 'string' },
          ],
        },
      ],
    }),
    defineField({
      name: 'riskLevel',
      type: 'number',
      validation: (r) => r.min(0).max(5),
    }),
    defineField({ name: 'requiredApproval', type: 'boolean' }),
    defineField({
      name: 'policySnapshotVersion',
      type: 'string',
      description: 'SHA-256 of the policy document revisions used by the kernel when this decision was created.',
    }),
    defineField({
      name: 'approvalRecord',
      type: 'object',
      description: 'Supervisor approval bound to this exact action fingerprint and policy snapshot.',
      fields: [
        { name: 'id', type: 'string' },
        { name: 'requestId', type: 'string' },
        { name: 'actionFingerprint', type: 'string' },
        { name: 'policySnapshotVersion', type: 'string' },
        { name: 'supervisorId', type: 'string' },
        { name: 'grantedAt', type: 'datetime' },
        { name: 'soleOperatorOverride', type: 'boolean', description: 'True when the sole operator approved despite a separation-of-duties conflict.' },
        { name: 'waivedConflicts', type: 'array', of: [{ type: 'string' }] },
        { name: 'justification', type: 'text', description: 'Required written reason for a sole-operator override.' },
      ],
    }),
    defineField({
      name: 'executionAudit',
      type: 'object',
      description: 'Outcome record linked to the approval consumed by this execution.',
      fields: [
        { name: 'approvalId', type: 'string' },
        { name: 'actionFingerprint', type: 'string' },
        { name: 'policySnapshotVersion', type: 'string' },
        { name: 'executorId', type: 'string' },
        { name: 'startedAt', type: 'datetime' },
        { name: 'completedAt', type: 'datetime' },
        { name: 'outcome', type: 'string', options: { list: ['succeeded', 'failed'] } },
      ],
    }),
    defineField({
      name: 'safetyDecision',
      type: 'string',
      options: { list: ['ALLOW', 'BLOCK', 'ESCALATE'] },
      description: 'NQC Kernel disposition for the proposed action.',
    }),
    defineField({
      name: 'evaluation',
      type: 'object',
      description: 'Quicksilver Engine deterministic evaluation signals; no private reasoning trace is stored.',
      fields: [
        { name: 'reasoningScore', type: 'number', validation: (r) => r.min(0).max(100) },
        { name: 'hallucinationRisk', type: 'string', options: { list: ['low', 'med', 'high'] } },
        { name: 'brittleness', type: 'string', options: { list: ['low', 'med', 'high'] } },
        { name: 'failedToolCount', type: 'number', validation: (r) => r.min(0) },
        { name: 'issues', type: 'array', of: [{ type: 'string' }] },
        { name: 'corrections', type: 'array', of: [{ type: 'string' }] },
        { name: 'failureExemplars', type: 'array', of: [{ type: 'string' }] },
        { name: 'modelId', type: 'string' },
        { name: 'taskType', type: 'string' },
        { name: 'evaluatedAt', type: 'datetime' },
      ],
    }),
    defineField({
      name: 'reviewerNotes',
      type: 'object',
      description:
        'Independent second opinion from the reviewer model (packages/agent/src/reviewer.ts). ' +
        'Advisory only -- the kernel above is what actually authorizes or blocks.',
      fields: [
        { name: 'valid', type: 'boolean' },
        { name: 'policyConflicts', type: 'array', of: [{ type: 'string' }] },
        { name: 'missingEvidence', type: 'array', of: [{ type: 'string' }] },
        { name: 'riskConcerns', type: 'array', of: [{ type: 'string' }] },
        { name: 'suggestions', type: 'array', of: [{ type: 'string' }] },
      ],
    }),
    defineField({
      name: 'status',
      type: 'string',
      options: {
        list: [
          'proposed',
          'awaiting-approval',
          'approved',
          'rejected',
          'executed',
          'failed',
          'rollback-proposed',
          'rolled-back',
        ],
        layout: 'dropdown',
      },
      description:
        'With the process engine on, this is the current state in the Decision Lifecycle process definition, ' +
        'and only the kernel moves it (see Process history).',
    }),
    defineField({
      name: 'kind',
      type: 'string',
      options: { list: ['plan', 'rollback'] },
      description: 'plan = proposed by the planner; rollback = proposed to undo another decision',
    }),
    defineField({
      name: 'faultInjection',
      type: 'string',
      options: { list: ['success', 'failure', 'deviation'] },
      readOnly: true,
      description: 'Set only when the simulated execution was forced by the e2e test (npm run e2e:live), never by normal use.',
    }),
    defineField({
      name: 'kernelRecommendation',
      type: 'string',
      options: { list: ['execute-autonomously', 'request-approval', 'reject'] },
      description: "The kernel's recommendation at plan time (lets a held decision resume from the same facts)",
    }),
    defineField({ name: 'kernelAuthorized', type: 'boolean' }),
    defineField({
      name: 'rollbackOf',
      type: 'reference',
      to: [{ type: 'decision' }],
      description: 'For a rollback decision: the decision it undoes',
    }),
    defineField({
      name: 'observedDeviation',
      type: 'boolean',
      description: 'Set by /observe: the metric moved the wrong way after execution',
    }),
    defineField({
      name: 'process',
      title: 'Process',
      type: 'object',
      description: 'The process definition governing this decision, as of its last transition',
      fields: [
        { name: 'definition', type: 'reference', to: [{ type: 'workflow' }] },
        { name: 'version', type: 'number' },
        { name: 'revision', type: 'string', description: 'Content revision (_rev) of the definition' },
      ],
    }),
    defineField({
      name: 'processHistory',
      title: 'Process history',
      type: 'array',
      description: 'Every state change the kernel authorized, oldest first',
      of: [
        {
          type: 'object',
          name: 'processHistoryEntry',
          fields: [
            { name: 'transitionId', type: 'string' },
            { name: 'from', type: 'string' },
            { name: 'to', type: 'string' },
            { name: 'actorId', type: 'string' },
            { name: 'actorType', type: 'string' },
            { name: 'at', type: 'datetime' },
            { name: 'processVersion', type: 'number' },
            { name: 'processRevision', type: 'string' },
          ],
          preview: {
            select: { from: 'from', to: 'to', t: 'transitionId', actor: 'actorId', at: 'at' },
            prepare: ({ from, to, t, actor, at }) => ({ title: `${from} → ${to} (${t})`, subtitle: `${actor} · ${at}` }),
          },
        },
      ],
    }),
    defineField({ name: 'requestedBy', type: 'string', readOnly: true, description: 'Principal that submitted the objective or requested the change (separation of duties).' }),
    defineField({ name: 'proposedBy', type: 'string', readOnly: true, description: 'Agent or principal that proposed this action (separation of duties).' }),
    defineField({ name: 'createdAt', type: 'datetime' }),
    defineField({
      name: 'approvedBy',
      type: 'reference',
      to: [{ type: 'entity' }],
    }),
    defineField({ name: 'executedAt', type: 'datetime' }),
  ],
})
