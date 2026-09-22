/**
 * Capabilities — the things that can be done.
 *
 * Each capability carries its base risk and the set of entities authorized to invoke it.
 * The kernel's capability check verifies: actor has the capability in their profile
 * AND the capability grants it to the actor.
 */

import type { CapabilitySeed } from './types'

export const capabilities: CapabilitySeed[] = [
  {
    _id: 'cap-process-param',
    name: 'Process Parameter Modification',
    description: 'Modify operating parameters on production equipment (CNC controllers, PLCs, etc.).',
    requiredSkills: ['Process Engineering', 'CNC Operation'],
    riskLevel: 4,
    authorizedEntityIds: ['entity-engineering-agent', 'entity-jin-tanaka', 'entity-marcus-webb'],
    requiredTools: ['Production System Access', 'Process Simulation'],
  },
  {
    _id: 'cap-machine-diagnostics',
    name: 'Machine Diagnostics',
    description: 'Read and interpret machine telemetry to identify faults.',
    requiredSkills: ['Maintenance', 'Telemetry Analysis'],
    riskLevel: 1,
    authorizedEntityIds: ['entity-maintenance-agent', 'entity-tom-bradley'],
    requiredTools: ['Production System Access'],
  },
  {
    _id: 'cap-maintenance-scheduling',
    name: 'Maintenance Scheduling',
    description: 'Schedule and adjust maintenance windows.',
    requiredSkills: ['Maintenance Planning'],
    riskLevel: 2,
    authorizedEntityIds: ['entity-maintenance-agent', 'entity-tom-bradley'],
    requiredTools: ['Maintenance Calendar'],
  },
  {
    _id: 'cap-quality-inspection',
    name: 'Quality Inspection',
    description: 'Inspect finished parts against specification.',
    requiredSkills: ['Quality Engineering'],
    riskLevel: 1,
    authorizedEntityIds: ['entity-karim-hassan'],
    requiredTools: ['CMM Access'],
  },
  {
    _id: 'cap-tool-replenishment',
    name: 'Tool Replenishment',
    description: 'Replenish consumable tooling on a CNC line.',
    requiredSkills: ['CNC Operation'],
    riskLevel: 1,
    authorizedEntityIds: ['entity-ravi-patel', 'entity-cnc-1', 'entity-cnc-2', 'entity-cnc-3'],
    requiredTools: ['Tool Inventory'],
  },
  {
    _id: 'cap-line-adjustment',
    name: 'Production Line Adjustment',
    description: 'Adjust production line configuration (assignment, schedule).',
    requiredSkills: ['Operations'],
    riskLevel: 3,
    authorizedEntityIds: ['entity-diego-ruiz'],
    requiredTools: ['MES Access'],
  },
  {
    _id: 'cap-emergency-override',
    name: 'Emergency Override',
    description: 'Override standard policies under declared emergency.',
    requiredSkills: ['Executive Authority'],
    riskLevel: 5,
    authorizedEntityIds: ['entity-sarah-chen', 'entity-diego-ruiz'],
    requiredTools: [],
  },
  {
    _id: 'cap-budget-reallocation',
    name: 'Budget Reallocation',
    description: 'Reallocate budget between departments or line items.',
    requiredSkills: ['Finance'],
    riskLevel: 4,
    authorizedEntityIds: ['entity-amara-okafor', 'entity-sarah-chen'],
    requiredTools: ['ERP Access'],
  },
  {
    _id: 'cap-incident-response',
    name: 'Incident Response',
    description: 'Coordinate response to a production incident.',
    requiredSkills: ['Incident Management'],
    riskLevel: 3,
    authorizedEntityIds: [
      'entity-maintenance-agent',
      'entity-engineering-agent',
      'entity-tom-bradley',
      'entity-jin-tanaka',
    ],
    requiredTools: ['Incident Management System'],
  },
  {
    _id: 'cap-process-simulation',
    name: 'Process Simulation',
    description: 'Run a simulation of a parameter change against a digital twin.',
    requiredSkills: ['Simulation'],
    riskLevel: 1,
    authorizedEntityIds: ['entity-process-simulator', 'entity-engineering-agent', 'entity-jin-tanaka'],
    requiredTools: ['Process Simulation'],
  },
]