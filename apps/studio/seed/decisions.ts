/**
 * Decisions — the auditable artifacts. We seed one proposed decision that the demo walks through.
 */

import type { DecisionSeed } from './types'

export const decisions: DecisionSeed[] = [
  {
    _id: 'decision-cnc2-param',
    question: 'Should we increase CNC 2 controller parameter X by 5% to address the recent drift?',
    contextEntityIds: ['entity-cnc-2', 'entity-engineering-agent'],
    contextCapabilityIds: ['cap-process-param'],
    contextPolicyIds: ['policy-ops-17', 'policy-emergency-4'],
    candidateActions: [
      {
        description: 'Adjust controller parameter X on CNC 2 by +5%',
        actorId: 'entity-engineering-agent',
        capabilityId: 'cap-process-param',
      },
      {
        description: 'Replace hydraulic seal on CNC 2 (per historical incident #17)',
        actorId: 'entity-maintenance-agent',
        capabilityId: 'cap-machine-diagnostics',
      },
      {
        description: 'Upgrade CNC 2 controller firmware to 4.2.1',
        actorId: 'entity-jin-tanaka',
        capabilityId: 'cap-process-param',
      },
    ],
    selectedAction: 'Adjust controller parameter X on CNC 2 by +5%',
    reasoningSummary:
      'Engineering analysis supports a parameter adjustment to compensate for controller drift. However, Operations Policy 17 (priority 5) requires VP approval for parameter changes, and Emergency Policy 4 (priority 7) permits automatic changes only under an officially declared emergency. Current incident status is NOT classified as emergency. Historical Incident #17 also suggests the underlying cause may be a worn seal rather than parameter drift, contradicting the parameter-adjustment hypothesis with higher confidence (0.92 vs 0.78). Kernel computes risk 5/5 and routes to human approval.',
    evidenceIds: [
      'evidence-maint-847',
      'evidence-eng-analysis-c2',
      'evidence-historical-17',
      'evidence-vendor-bulletin-jun25',
      'evidence-eng-procedure',
      'evidence-ops-memo',
    ],
    constraints: ['No additional headcount', 'Stay within $25,000 budget'],
    policyChecks: [
      { policyId: 'policy-ops-17', result: 'applies', reason: 'Scope matches: production.parameter_changes' },
      { policyId: 'policy-emergency-4', result: 'conflicts', reason: 'Same scope, higher priority (7 > 5); not currently applicable because no declared emergency' },
    ],
    riskLevel: 5,
    requiredApproval: true,
    status: 'awaiting-approval',
    createdAt: '2026-09-19T14:00:00Z',
    approvedById: null,
    executedAt: null,
  },
]