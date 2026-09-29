/**
 * Policy snapshot: a stable identifier for the policy state a decision was
 * governed under.
 *
 * A grant that is evaluated under one set of policies and executed minutes
 * later under a different one is executing against rules nobody checked. The
 * plan's non-negotiable rules bind every action to a policy revision, and the
 * Supervisor is required to stop on a stale policy — which it can only do if
 * it can tell whether the policy has moved.
 *
 * The snapshot is a canonical digest over the fields that actually affect
 * evaluation, sorted by policy id, so it is deterministic and independent of
 * the order policies happen to be supplied in. Cosmetic fields such as a
 * policy's display name are excluded on purpose: renaming a policy does not
 * change what it does, and should not invalidate a grant.
 */
import { createHash } from 'node:crypto'

import type { PolicyRef } from './types.ts'

/** Digest of the policy state, as `sha256:<hex>`. */
export function policySnapshot(policies: readonly PolicyRef[] | null | undefined): string {
  const rows = (policies ?? [])
    .map((policy) => ({
      id: policy.id,
      version: policy.version ?? null,
      lineageId: policy.lineageId ?? null,
      scope: policy.scope,
      priority: policy.priority,
      effect: policy.effect ?? null,
      maxRiskLevel: policy.maxRiskLevel ?? null,
      effectiveDate: policy.effectiveDate ?? null,
      expirationDate: policy.expirationDate ?? null,
      supersedesIds: [...(policy.supersedesIds ?? [])].sort(),
      approvalRequirementIds: [...(policy.approvalRequirementIds ?? [])].sort(),
      appliesToEntityIds: [...(policy.appliesToEntityIds ?? [])].sort(),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return `sha256:${createHash('sha256').update(canonical(rows)).digest('hex')}`
}

/**
 * Compare the policy a decision was governed under against the policy in force
 * now. An absent "current" snapshot is never treated as a match: a caller that
 * cannot determine the live policy state has not established that the decision
 * is current.
 */
export function policySnapshotIsCurrent(evaluated: string, current: string | null | undefined): boolean {
  return typeof current === 'string' && current.trim() !== '' && current === evaluated
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}
