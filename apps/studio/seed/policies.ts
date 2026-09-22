/**
 * Policies — rules with scope, priority, supersedes, and approval requirements.
 *
 * The conflict pair is the demo's killer moment:
 *   - Operations Policy 17: approval required for parameter changes
 *   - Emergency Policy 4: automatic changes permitted under emergency conditions
 *
 * When Quicksilver proposes a parameter change, the kernel must surface this conflict.
 */

import type { PolicySeed } from './types'

export const policies: PolicySeed[] = [
  {
    _id: 'policy-ops-17',
    name: 'Operations Policy 17 — Production Parameter Changes',
    scope: 'production.parameter_changes',
    priority: 5,
    rules: [
      'All changes to production equipment parameters require written approval from a VP.',
      'Approval must be logged in the change-management system before execution.',
      'Rollback procedure must be confirmed prior to change.',
    ],
    effectiveDate: '2026-01-15',
    expirationDate: null,
    supersedesIds: [],
    approvalRequirementIds: ['entity-diego-ruiz', 'entity-marcus-webb'],
  },
  {
    _id: 'policy-emergency-4',
    name: 'Emergency Policy 4 — Deviations Under Emergency Conditions',
    scope: 'production.parameter_changes',
    priority: 7,
    rules: [
      'When an incident is officially classified as Emergency, parameter changes below risk level 3 may be applied automatically.',
      'The classification must be declared by the CEO or VP Operations.',
      'All automatic changes must be reviewed within 24 hours.',
    ],
    effectiveDate: '2026-02-01',
    expirationDate: null,
    supersedesIds: [],
    approvalRequirementIds: ['entity-sarah-chen', 'entity-diego-ruiz'],
  },
  {
    _id: 'policy-maint-12',
    name: 'Maintenance Policy 12 — Scheduled Maintenance Priority',
    scope: 'maintenance.scheduling',
    priority: 6,
    rules: [
      'Scheduled maintenance windows take precedence over production targets.',
      'Postponements require Maintenance Lead approval.',
    ],
    effectiveDate: '2026-03-10',
    expirationDate: null,
    supersedesIds: [],
    approvalRequirementIds: ['entity-tom-bradley'],
  },
  {
    _id: 'policy-budget-3',
    name: 'Budget Policy 3 — Expenditure Above $50k',
    scope: 'finance.expenditure',
    priority: 8,
    rules: [
      'Any single expenditure above $50,000 requires written CFO approval.',
      'Recurring commitments above $25,000/month require CEO countersignature.',
    ],
    effectiveDate: '2026-01-01',
    expirationDate: null,
    supersedesIds: [],
    approvalRequirementIds: ['entity-amara-okafor', 'entity-sarah-chen'],
  },
  {
    _id: 'policy-quality-8',
    name: 'Quality Policy 8 — Pre-shipment Inspection',
    scope: 'quality.inspection',
    priority: 7,
    rules: [
      'All production parts must pass quality inspection before shipment.',
      'Failed inspections block related work orders automatically.',
    ],
    effectiveDate: '2026-01-20',
    expirationDate: null,
    supersedesIds: [],
    approvalRequirementIds: ['entity-lisa-park'],
  },
  {
    _id: 'policy-ops-17-superseded',
    name: 'Operations Policy 17 (legacy 2024)',
    scope: 'production.parameter_changes',
    priority: 3,
    rules: [
      'Legacy: parameter changes require senior engineer approval only.',
    ],
    effectiveDate: '2024-06-01',
    expirationDate: '2026-01-14',
    supersedesIds: [],
    approvalRequirementIds: ['entity-jin-tanaka'],
  },
]