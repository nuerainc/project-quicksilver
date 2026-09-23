/**
 * Process definitions -- executable workflows the kernel runs.
 *
 * These are the single source of truth for both the Sanity seed and the
 * kernel tests (packages/kernel/src/process.test.ts imports this file), so
 * the tests always exercise exactly what gets loaded into Content Lake.
 *
 * Guards are structured data: { fact, op, value }. The kernel evaluates
 * them against a flat set of facts; it never evaluates strings as code.
 *
 * Automatic transitions are tried in the order they are declared, and the
 * first whose guard holds wins. In the decision lifecycle that is why
 * `kernel-reject` comes first: a hard block always beats every other route.
 */

import type { WorkflowSeed } from './types'

/**
 * The lifecycle every `decision` document moves through. With
 * QUICKSILVER_PROCESS_ENGINE=on, the /api/plan and /api/decisions/* routes
 * ask the kernel to authorize each status change against this definition
 * instead of using hard-coded status checks.
 *
 * The one to watch in the demo is `auto-approve`: it is the company's
 * autonomy ceiling, written as content. Even if the kernel's env thresholds
 * are loosened, this process never auto-approves anything above risk 2.
 * Change that number in Studio and behavior changes, with the new
 * definition revision stamped on every decision it touches.
 */
export const decisionLifecycle: WorkflowSeed = {
  _id: 'workflow-decision-lifecycle',
  name: 'Decision Lifecycle',
  // v2 (from the Sep 22 live stress test): rollback retry after a failed
  // rollback, no "roll back a rollback", and plan decisions only for
  // rollback proposals.
  // v3 (Sep 23 pre-submission audit): route-to-human is the catch-all for
  // every non-rejected decision that auto-approve doesn't take, so an editor
  // can tighten the autonomy ceiling by changing ONE number in Studio.
  version: 3,
  trigger: 'The planner proposes an action and the kernel authorizes it (POST /api/plan).',
  initialState: 'proposed',
  states: [
    { id: 'proposed', label: 'Proposed' },
    { id: 'awaiting-approval', label: 'Awaiting human approval' },
    { id: 'approved', label: 'Approved' },
    { id: 'executed', label: 'Executed' },
    { id: 'failed', label: 'Execution failed' },
    { id: 'rollback-proposed', label: 'Rollback proposed' },
    { id: 'rejected', label: 'Rejected', terminal: true },
    { id: 'rolled-back', label: 'Rolled back', terminal: true },
  ],
  transitions: [
    {
      id: 'kernel-reject',
      label: 'Kernel hard block',
      from: 'proposed',
      to: 'rejected',
      automatic: true,
      guard: { all: [{ fact: 'kernel.recommendation', op: 'eq', value: 'reject' }] },
    },
    {
      id: 'auto-approve',
      label: 'Auto-approve (autonomous lane)',
      from: 'proposed',
      to: 'approved',
      automatic: true,
      guard: {
        all: [
          { fact: 'kernel.recommendation', op: 'eq', value: 'execute-autonomously' },
          { fact: 'kernel.authorized', op: 'eq', value: true },
          { fact: 'kernel.riskLevel', op: 'lte', value: 2 },
        ],
      },
    },
    {
      id: 'route-to-human',
      label: 'Route to a human',
      from: 'proposed',
      to: 'awaiting-approval',
      automatic: true,
      guard: {
        any: [
          // Everything the kernel didn't hard-block and auto-approve didn't
          // take: approval requests, and "autonomous" actions above this
          // process's autonomy ceiling (whatever number the ceiling holds).
          { fact: 'kernel.recommendation', op: 'in', value: ['request-approval', 'execute-autonomously'] },
          // Older decision documents stored no recommendation: risk alone
          // still sends them to a human.
          { fact: 'kernel.riskLevel', op: 'gt', value: 2 },
          // Rollback decisions always get a human, whatever the risk math says.
          { fact: 'decision.kind', op: 'eq', value: 'rollback' },
        ],
      },
    },
    {
      id: 'approve',
      label: 'Approve',
      from: 'awaiting-approval',
      to: 'approved',
      requiresHumanApproval: true,
    },
    {
      id: 'reject',
      label: 'Reject',
      from: 'awaiting-approval',
      to: 'rejected',
      requiresHumanApproval: true,
    },
    {
      id: 'request-evidence',
      label: 'Request more evidence',
      from: 'awaiting-approval',
      to: 'awaiting-approval',
      requiresHumanApproval: true,
    },
    {
      id: 'execute-succeeded',
      label: 'Execution succeeded',
      from: 'approved',
      to: 'executed',
      guard: { all: [{ fact: 'execution.success', op: 'eq', value: true }] },
    },
    {
      id: 'execute-failed',
      label: 'Execution failed',
      from: 'approved',
      to: 'failed',
      guard: { all: [{ fact: 'execution.success', op: 'eq', value: false }] },
    },
    {
      id: 'propose-rollback',
      label: 'Propose rollback (metric moved the wrong way)',
      from: 'executed',
      to: 'rollback-proposed',
      requiresHumanApproval: true,
      guard: {
        all: [
          { fact: 'observation.deviationDetected', op: 'eq', value: true },
          // A rollback decision is never itself rolled back.
          { fact: 'decision.kind', op: 'eq', value: 'plan' },
        ],
      },
    },
    {
      id: 'propose-rollback-after-failure',
      label: 'Propose rollback (execution failed)',
      from: 'failed',
      to: 'rollback-proposed',
      requiresHumanApproval: true,
      guard: { all: [{ fact: 'decision.kind', op: 'eq', value: 'plan' }] },
    },
    {
      // Found live: a rollback whose own execution fails used to leave the
      // original decision stuck in rollback-proposed with no way forward.
      id: 'retry-rollback',
      label: 'Retry rollback (previous attempt failed)',
      from: 'rollback-proposed',
      to: 'rollback-proposed',
      requiresHumanApproval: true,
      guard: {
        all: [
          { fact: 'rollback.lastAttemptFailed', op: 'eq', value: true },
          { fact: 'rollback.pendingAttempts', op: 'eq', value: 0 },
        ],
      },
    },
    {
      id: 'complete-rollback',
      label: 'Rollback executed',
      from: 'rollback-proposed',
      to: 'rolled-back',
      guard: { all: [{ fact: 'rollback.executed', op: 'eq', value: true }] },
    },
  ],
  requiredCapabilityIds: [],
  approvalRequirementIds: [],
  failureHandlers: [
    'If execution fails, the decision moves to "failed" and a human can propose a rollback.',
    'If a rollback itself fails, a human can retry it with a new rollback decision.',
  ],
  rollbackProcedure:
    'A rollback is its own decision. It always routes to a human; once it executes, the original decision moves to "rolled-back".',
}

/**
 * The production parameter change process (the demo's kill-shot scenario),
 * now with structured guards. Declared and validated by the kernel; not yet
 * driven by an API route.
 */
export const paramChange: WorkflowSeed = {
  _id: 'workflow-param-change',
  name: 'Production Parameter Change',
  version: 2,
  trigger: 'Engineering proposes a parameter change on a production system.',
  initialState: 'diagnose',
  states: [
    { id: 'diagnose', label: 'Diagnose' },
    { id: 'simulate', label: 'Simulate' },
    { id: 'approval', label: 'Approval Required' },
    { id: 'deploy', label: 'Deploy' },
    { id: 'monitor', label: 'Monitor' },
    { id: 'success', label: 'Success', terminal: true },
    { id: 'rollback', label: 'Rollback', terminal: true },
  ],
  transitions: [
    {
      id: 'diagnosed',
      from: 'diagnose',
      to: 'simulate',
      automatic: true,
      guard: { all: [{ fact: 'diagnostic.complete', op: 'eq', value: true }] },
    },
    {
      id: 'simulated',
      from: 'simulate',
      to: 'approval',
      automatic: true,
      guard: { all: [{ fact: 'simulation.complete', op: 'eq', value: true }] },
    },
    {
      id: 'deploy-autonomously',
      label: 'Deploy (kernel says no approval needed)',
      from: 'approval',
      to: 'deploy',
      automatic: true,
      guard: {
        all: [
          { fact: 'kernel.requiresApproval', op: 'eq', value: false },
          { fact: 'incident.classification', op: 'eq', value: 'emergency' },
        ],
      },
    },
    {
      id: 'deploy-approved',
      label: 'Deploy (approved by a human)',
      from: 'approval',
      to: 'deploy',
      requiresHumanApproval: true,
    },
    {
      id: 'deny',
      from: 'approval',
      to: 'rollback',
      requiresHumanApproval: true,
    },
    {
      id: 'applied',
      from: 'deploy',
      to: 'monitor',
      automatic: true,
      guard: { all: [{ fact: 'change.applied', op: 'eq', value: true }] },
    },
    {
      id: 'improved',
      from: 'monitor',
      to: 'success',
      automatic: true,
      guard: { all: [{ fact: 'metric.improvedWithinWindow', op: 'eq', value: true }] },
    },
    {
      id: 'degraded',
      from: 'monitor',
      to: 'rollback',
      automatic: true,
      guard: { all: [{ fact: 'metric.degraded', op: 'eq', value: true }] },
    },
  ],
  requiredCapabilityIds: ['cap-process-param', 'cap-process-simulation'],
  approvalRequirementIds: ['entity-marcus-webb', 'entity-diego-ruiz'],
  failureHandlers: [
    'If simulation diverges from expected outcome, escalate to VP Engineering.',
    'If monitoring shows degradation, trigger automatic rollback.',
  ],
  rollbackProcedure:
    'Restore previous parameter value from versioned config. Run post-rollback diagnostics. File incident report within 4 hours.',
}

export const workflows: WorkflowSeed[] = [decisionLifecycle, paramChange]
