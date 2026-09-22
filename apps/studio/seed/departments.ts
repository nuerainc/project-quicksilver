/**
 * Departments — organizational units.
 */

import type { DepartmentSeed } from './types'

export const departments: DepartmentSeed[] = [
  {
    _id: 'dept-executive',
    name: 'Executive Office',
    purpose: 'Company-wide leadership, strategic objectives, emergency authority.',
    parentDepartmentId: null,
    leaderId: 'entity-sarah-chen',
    memberIds: ['entity-sarah-chen', 'entity-ceo-assistant-agent'],
    capabilityIds: [],
    objectiveIds: ['obj-reduce-downtime'],
  },
  {
    _id: 'dept-engineering',
    name: 'Engineering',
    purpose: 'Process engineering, parameter tuning, simulation, and design for manufacturing.',
    parentDepartmentId: 'dept-executive',
    leaderId: 'entity-marcus-webb',
    memberIds: ['entity-marcus-webb', 'entity-jin-tanaka', 'entity-engineering-agent'],
    capabilityIds: ['cap-process-param', 'cap-process-simulation'],
    objectiveIds: ['obj-reduce-downtime'],
  },
  {
    _id: 'dept-production',
    name: 'Production',
    purpose: 'Day-to-day manufacturing operations across three CNC lines.',
    parentDepartmentId: 'dept-executive',
    leaderId: 'entity-diego-ruiz',
    memberIds: [
      'entity-diego-ruiz',
      'entity-ravi-patel',
      'entity-elena-volkov',
      'entity-cnc-1',
      'entity-cnc-2',
      'entity-cnc-3',
    ],
    capabilityIds: ['cap-line-adjustment', 'cap-tool-replenishment'],
    objectiveIds: ['obj-reduce-downtime'],
  },
  {
    _id: 'dept-maintenance',
    name: 'Maintenance',
    purpose: 'Equipment health, scheduling, and incident response.',
    parentDepartmentId: 'dept-production',
    leaderId: 'entity-tom-bradley',
    memberIds: ['entity-tom-bradley', 'entity-maintenance-agent', 'entity-apex-hydraulics'],
    capabilityIds: ['cap-machine-diagnostics', 'cap-maintenance-scheduling', 'cap-incident-response'],
    objectiveIds: ['obj-reduce-downtime'],
  },
  {
    _id: 'dept-finance',
    name: 'Finance',
    purpose: 'Budgeting, expenditure approvals, financial controls.',
    parentDepartmentId: 'dept-executive',
    leaderId: 'entity-amara-okafor',
    memberIds: ['entity-amara-okafor'],
    capabilityIds: ['cap-budget-reallocation'],
    objectiveIds: [],
  },
  {
    _id: 'dept-quality',
    name: 'Quality',
    purpose: 'Inspection, calibration, and supplier quality.',
    parentDepartmentId: 'dept-production',
    leaderId: 'entity-lisa-park',
    memberIds: ['entity-lisa-park', 'entity-karim-hassan'],
    capabilityIds: ['cap-quality-inspection'],
    objectiveIds: [],
  },
]