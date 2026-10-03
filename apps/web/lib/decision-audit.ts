import { createHash } from 'node:crypto'

/** Everything the decision page shows, in one query, so the page and the audit export cannot disagree. */
export const DECISION_DETAIL_QUERY = `*[_type == "decision" && _id == $id][0]{
  _id, question, selectedAction, reasoningSummary, constraints, riskLevel, requiredApproval, status, safetyDecision,
  requestedBy, proposedBy, createdAt, executedAt, policySnapshotVersion, policyResolutions, kind, observedDeviation,
  "actorId": candidateActions[0].actor._ref,
  "policyIds": policyChecks[].policy._ref,
  "approvedByName": approvedBy->name,
  "policyChecks": policyChecks[]{ result, reason, "policyName": policy->name },
  "evidenceTitles": evidence[]->title,
  evaluation{ reasoningScore, hallucinationRisk, brittleness, failedToolCount, issues, corrections, modelId, evaluatedAt },
  reviewerNotes,
  why,
  "processName": process.definition->name,
  "processVersion": process.version,
  processHistory[]{ transitionId, from, to, actorId, actorType, at }
}`

export interface DecisionAuditExport {
  schema: 'quicksilver.decision-audit/1'
  exportedAt: string
  exportedBy: string
  decision: Record<string, unknown>
  integrity: { algorithm: 'sha256'; digest: string; covers: 'decision' }
}

/** JSON with object keys sorted, so the same record always hashes to the same digest. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * The evidence an outside reviewer asks for: the decision as recorded (question, action, risk,
 * policy checks, the kernel's explanation, evaluator scores, who did what and when) with a digest
 * of exactly that record, who exported it and when. The digest shows the file was not edited after
 * export; it is not a signature, and it does not prove the record itself was never changed.
 */
export function buildDecisionAudit(doc: Record<string, unknown>, exportedBy: string, exportedAt = new Date().toISOString()): DecisionAuditExport {
  const { policyIds: _ids, ...decision } = doc
  void _ids
  return {
    schema: 'quicksilver.decision-audit/1',
    exportedAt,
    exportedBy,
    decision,
    integrity: { algorithm: 'sha256', digest: createHash('sha256').update(canonicalJson(decision)).digest('hex'), covers: 'decision' },
  }
}

/** True when `exported.integrity.digest` matches the decision it carries. */
export function auditDigestMatches(exported: DecisionAuditExport): boolean {
  return createHash('sha256').update(canonicalJson(exported.decision)).digest('hex') === exported.integrity.digest
}
