/**
 * Evidence — sources of truth with explicit confidence and (where relevant) contradiction.
 *
 * The dataset intentionally contains conflicting sources. The kernel + agent must surface
 * these conflicts rather than papering over them.
 */

import type { EvidenceSeed } from './types'

export const evidence: EvidenceSeed[] = [
  {
    _id: 'evidence-maint-847',
    title: 'Maintenance Report #847 — CNC 2 Hydraulic Anomaly',
    type: 'report',
    source: 'Tom Bradley, Maintenance Lead',
    claim: 'CNC 2 has exhibited hydraulic pressure anomalies over the last 72 hours, correlating with sub-spec tolerance on three parts. Recommend investigation.',
    confidence: 0.85,
    effectiveDate: '2026-09-15',
    relatedEntityIds: ['entity-cnc-2', 'entity-tom-bradley'],
    supportsObjectiveIds: ['obj-reduce-downtime'],
    contradictsEvidenceIds: [],
  },
  {
    _id: 'evidence-eng-analysis-c2',
    title: 'Engineering Analysis — Controller Parameter Drift (CNC 2)',
    type: 'analysis',
    source: 'Jin Tanaka, Senior Process Engineer',
    claim: 'Telemetry shows controller parameter X drifting by 4.7% over the last 7 days. Increasing by 5% would compensate and return output to spec.',
    confidence: 0.78,
    effectiveDate: '2026-09-17',
    relatedEntityIds: ['entity-cnc-2', 'entity-jin-tanaka', 'entity-engineering-agent'],
    supportsObjectiveIds: ['obj-reduce-downtime'],
    contradictsEvidenceIds: ['evidence-historical-17'],
  },
  {
    _id: 'evidence-historical-17',
    title: 'Historical Incident #17 — August 2025 Pressure Issue',
    type: 'incident',
    source: 'Maintenance archive',
    claim: 'A similar pressure anomaly on CNC 4 in August 2025 was caused by a worn hydraulic seal, not by parameter drift. Replacing the seal resolved the issue within 48 hours at $4,200.',
    confidence: 0.92,
    effectiveDate: '2025-08-22',
    relatedEntityIds: [],
    supportsObjectiveIds: [],
    contradictsEvidenceIds: ['evidence-eng-analysis-c2'],
  },
  {
    _id: 'evidence-vendor-bulletin-jun25',
    title: 'Vendor Bulletin — CNC Controller Firmware 4.2.1',
    type: 'external',
    source: 'Controller vendor',
    claim: 'Firmware 4.2.1 addresses a known controller-drift issue affecting units shipped before Jan 2025. Recommended for all CNC units.',
    confidence: 0.7,
    effectiveDate: '2025-06-10',
    relatedEntityIds: [],
    supportsObjectiveIds: [],
    contradictsEvidenceIds: [],
  },
  {
    _id: 'evidence-eng-procedure',
    title: 'Engineering Procedure — Parameter Change Verification (rev. Jan 2026)',
    type: 'report',
    source: 'Marcus Webb, VP Engineering',
    claim: 'Always verify simulated impact before adjusting a production parameter. Document expected outcome. Run a controlled test before full deployment.',
    confidence: 0.95,
    effectiveDate: '2026-01-30',
    relatedEntityIds: [],
    supportsObjectiveIds: [],
    contradictsEvidenceIds: ['evidence-ops-memo'],
  },
  {
    _id: 'evidence-ops-memo',
    title: 'Operations Memo — Aggressive Tuning Under Downtime Pressure (rev. Aug 2026)',
    type: 'report',
    source: 'Diego Ruiz, VP Operations',
    claim: 'When downtime escalates, authorize parameter adjustments aggressively to restore throughput. Do not wait for engineering review cycles.',
    confidence: 0.6,
    effectiveDate: '2026-08-12',
    relatedEntityIds: ['entity-diego-ruiz'],
    supportsObjectiveIds: ['obj-reduce-downtime'],
    contradictsEvidenceIds: ['evidence-eng-procedure'],
  },
]