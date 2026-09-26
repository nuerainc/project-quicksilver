/**
 * Aura intent graph (Quicksilver Layer 2).
 *
 * An objective becomes a decision graph of variables. Every variable carries
 * provenance, so any decision can be traced to a human, a system constraint,
 * an observation, or an agent inference. Aura has no authority: it describes
 * what the human wants and what is still unknown; the NQC Kernel decides.
 *
 * Three layers (from the Aura charter):
 *   - Value:       HUMAN_SPECIFIED and SYSTEM_CONSTRAINT variables
 *   - Context:     OBSERVED and AGENT_INFERRED variables
 *   - Interaction: the intent entry point and targeted questions
 */

export const PROVENANCES = ['HUMAN_SPECIFIED', 'SYSTEM_CONSTRAINT', 'OBSERVED', 'AGENT_INFERRED'] as const
export type Provenance = (typeof PROVENANCES)[number]

export const VARIABLE_KINDS = ['goal', 'constraint', 'metric', 'assumption', 'unknown'] as const
export type VariableKind = (typeof VARIABLE_KINDS)[number]

export const OPERATING_MODES = ['genesis', 'onboard', 'operate'] as const
export type OperatingMode = (typeof OPERATING_MODES)[number]

/** How far Quicksilver may go on its own for this objective. The kernel still gates every action. */
export const AUTONOMY_DEPTHS = ['advise', 'propose', 'act-with-approval', 'act-within-limits'] as const
export type AutonomyDepth = (typeof AUTONOMY_DEPTHS)[number]

export type SourceType = 'human' | 'policy' | 'waes' | 'evidence' | 'observation' | 'agent'

export interface VariableSource {
  type: SourceType
  /** Principal id, document id, metric id, or agent id. */
  ref: string
  /** For human text: the exact span the value came from. */
  quote?: string
}

export interface GraphVariable {
  id: string
  label: string
  kind: VariableKind
  /** Absent while the variable is an open unknown. */
  value?: string | number | boolean
  unit?: string
  provenance: Provenance
  /** 0–1. HUMAN_SPECIFIED and SYSTEM_CONSTRAINT values are 1 by definition. */
  confidence: number
  /** 0–1: how much the objective depends on getting this right. */
  importance: number
  sources: VariableSource[]
  /** Required for AGENT_INFERRED values: why the agent believes this. */
  explanation?: string
  updatedAt: string
  updatedBy: string
}

export type EdgeRelation = 'depends-on' | 'constrains' | 'informs'

/** `from` relies on `to`: a change or uncertainty in `to` affects `from`. */
export interface DecisionEdge {
  from: string
  to: string
  relation: EdgeRelation
}

export interface IntentGraph {
  id: string
  objective: string
  mode: OperatingMode | null
  autonomyDepth: AutonomyDepth
  requestedBy: string
  createdAt: string
  variables: GraphVariable[]
  edges: DecisionEdge[]
  /** Append-only record of every accepted change. */
  history: BeliefChange[]
}

export interface BeliefChange {
  at: string
  variableId: string
  actor: string
  from?: GraphVariable['value']
  to: GraphVariable['value']
  provenance: Provenance
  confidence: number
  reason: string
}
