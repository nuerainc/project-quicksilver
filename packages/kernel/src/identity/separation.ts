/**
 * Separation of duties for decision approval.
 *
 * An approver may not approve a decision that they requested, proposed, or
 * would carry out themselves. This is deterministic and has no LLM in it.
 *
 * Sole-operator mode: an organization with a single human (for example a
 * founder-run lab) can name that person as the sole operator. They may then
 * approve their own requests, but only with a written justification, and the
 * approval is stamped `soleOperatorOverride: true` so the audit trail shows
 * that separation of duties was waived and why. Without a configured sole
 * operator, the rule is strict.
 */

export interface SeparationOfDutiesInput {
  /** The human principal / entity id granting approval. */
  approverId: string
  /** Principal that submitted the objective or requested the change. */
  requestedBy?: string | null
  /** Principal or agent that proposed the specific action. */
  proposedBy?: string | null
  /** Entity that would carry out the action. */
  actorId?: string | null
  /** Configured sole operator for single-human organizations (off when unset). */
  soleOperatorId?: string | null
  /** Written justification; required for a sole-operator override. */
  justification?: string | null
}

export interface SeparationOfDutiesResult {
  allowed: boolean
  /** Conflicts found (always reported, even when an override allows the approval). */
  conflicts: string[]
  /** Why the approval was refused, when it was. */
  reasons: string[]
  /** True when a sole operator approved despite a conflict. */
  soleOperatorOverride: boolean
}

/** Minimum length of a sole-operator justification, to force a real sentence. */
export const MIN_SOLE_OPERATOR_JUSTIFICATION = 20

export function checkSeparationOfDuties(input: SeparationOfDutiesInput): SeparationOfDutiesResult {
  const approver = input.approverId.trim()
  const conflicts: string[] = []
  if (!approver) {
    return { allowed: false, conflicts, reasons: ['An approver identity is required.'], soleOperatorOverride: false }
  }
  if (input.requestedBy && input.requestedBy === approver) conflicts.push('The approver requested this decision.')
  if (input.proposedBy && input.proposedBy === approver) conflicts.push('The approver proposed this action.')
  if (input.actorId && input.actorId === approver) conflicts.push('The approver would carry out this action.')

  if (conflicts.length === 0) return { allowed: true, conflicts, reasons: [], soleOperatorOverride: false }

  const soleOperator = input.soleOperatorId?.trim()
  if (soleOperator && soleOperator === approver) {
    const justification = input.justification?.trim() ?? ''
    if (justification.length >= MIN_SOLE_OPERATOR_JUSTIFICATION) {
      return { allowed: true, conflicts, reasons: [], soleOperatorOverride: true }
    }
    return {
      allowed: false,
      conflicts,
      reasons: [
        ...conflicts,
        `As the sole operator you may approve this, but only with a written justification of at least ${MIN_SOLE_OPERATOR_JUSTIFICATION} characters.`,
      ],
      soleOperatorOverride: false,
    }
  }
  return {
    allowed: false,
    conflicts,
    reasons: [...conflicts, 'Separation of duties: another human must approve this decision.'],
    soleOperatorOverride: false,
  }
}
