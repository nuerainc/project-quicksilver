/**
 * Workflows — the lifecycle of an action through the company.
 */

import type { WorkflowSeed } from './types'

export const workflows: WorkflowSeed[] = [
  {
    _id: 'workflow-param-change',
    name: 'Production Parameter Change',
    trigger: 'Engineering proposes a parameter change on a production system.',
    states: [
      { id: 'diagnose', label: 'Diagnose' },
      { id: 'simulate', label: 'Simulate' },
      { id: 'approval', label: 'Approval Required' },
      { id: 'deploy', label: 'Deploy' },
      { id: 'monitor', label: 'Monitor' },
      { id: 'success', label: 'Success' },
      { id: 'rollback', label: 'Rollback' },
    ],
    transitions: [
      { from: 'diagnose', to: 'simulate', guard: 'diagnostic_complete' },
      { from: 'simulate', to: 'approval', guard: 'simulation_complete' },
      { from: 'approval', to: 'deploy', guard: 'kernel.requiresApproval == false OR approval_granted' },
      { from: 'approval', to: 'rollback', guard: 'approval_denied' },
      { from: 'deploy', to: 'monitor', guard: 'change_applied' },
      { from: 'monitor', to: 'success', guard: 'metrics_improved_within_window' },
      { from: 'monitor', to: 'rollback', guard: 'metrics_degraded' },
    ],
    requiredCapabilityIds: ['cap-process-param', 'cap-process-simulation'],
    approvalRequirementIds: ['entity-marcus-webb', 'entity-diego-ruiz'],
    failureHandlers: [
      'If simulation diverges from expected outcome, escalate to VP Engineering.',
      'If monitoring shows degradation, trigger automatic rollback.',
    ],
    rollbackProcedure:
      'Restore previous parameter value from versioned config. Run post-rollback diagnostics. File incident report within 4 hours.',
  },
]