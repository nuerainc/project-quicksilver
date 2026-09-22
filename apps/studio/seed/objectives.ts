/**
 * Objectives — the active goal that drives the demo.
 */

import type { ObjectiveSeed } from './types'

export const objectives: ObjectiveSeed[] = [
  {
    _id: 'obj-reduce-downtime',
    name: 'Reduce production downtime by 20%',
    description:
      'Cut CNC-line downtime by 20% over the next 30 days without increasing OPEX and without adding headcount.',
    ownerId: 'entity-diego-ruiz',
    priority: 9,
    deadline: '2026-10-21',
    constraints: ['No additional headcount', 'No new equipment purchases', 'Stay within $25,000 budget'],
    successMetrics: ['Downtime hours per week', 'On-time delivery rate', 'Mean time to recovery'],
    budget: { amount: 25000, currency: 'USD' },
    status: 'active',
  },
  {
    _id: 'obj-launch-product-line',
    name: 'Launch aerospace product line',
    description: 'Onboard the new AS9100-certified production line.',
    ownerId: 'entity-marcus-webb',
    priority: 6,
    deadline: '2026-12-15',
    constraints: ['AS9100 certification required'],
    successMetrics: ['First article inspection pass', 'Customer qualification'],
    budget: { amount: 180000, currency: 'USD' },
    status: 'active',
  },
  {
    _id: 'obj-reduce-fulfillment-cost',
    name: 'Reduce fulfillment cost per unit',
    description: 'Drive down per-unit fulfillment cost by 8% via process and routing improvements.',
    ownerId: 'entity-amara-okafor',
    priority: 5,
    deadline: '2026-11-30',
    constraints: ['Maintain on-time delivery rate ≥ 96%'],
    successMetrics: ['Cost per unit shipped'],
    budget: { amount: 50000, currency: 'USD' },
    status: 'active',
  },
]