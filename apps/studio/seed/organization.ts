import type { OrganizationSeed } from './types'

export const organization: OrganizationSeed = {
  _id: 'organization.northforge',
  name: 'Northforge Manufacturing Co.',
  mission:
    'Produce precision CNC parts for aerospace and automotive clients with predictable lead times and zero-defect quality.',
  objectiveIds: ['obj-reduce-downtime', 'obj-launch-product-line', 'obj-reduce-fulfillment-cost'],
  departmentIds: [
    'dept-executive',
    'dept-engineering',
    'dept-production',
    'dept-maintenance',
    'dept-finance',
    'dept-quality',
  ],
  policyIds: [
    'policy-ops-17',
    'policy-emergency-4',
    'policy-maint-12',
    'policy-budget-3',
    'policy-quality-8',
    'policy-ops-17-superseded',
  ],
  resourceEntityIds: ['entity-cnc-1', 'entity-cnc-2', 'entity-cnc-3', 'entity-process-simulator'],
}