import { z } from 'zod'
import { MIN_SOLE_OPERATOR_JUSTIFICATION, type SeparationOfDutiesResult } from '@quicksilver/kernel/identity'

/**
 * Body of `POST /api/decisions/[id]/action`. Strict: the approver is always
 * the principal authenticated from the `Authorization` header
 * (`verifySupervisorCredential`), never a body field. A body that tries to
 * name one (`approvedBy`, `supervisorId`, `actorId`, ...) is refused with 400
 * rather than silently ignored. `comment` doubles as the sole-operator
 * justification when the approver requested the decision themselves.
 */
export const DecisionActionBody = z.object({
  action: z.enum(['approve', 'reject', 'request-evidence']),
  comment: z.string().optional(),
  /** Must match the action and policy snapshot the approver reviewed. */
  expectedActionFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
}).strict().superRefine((body, context) => {
  if (body.action === 'approve' && !body.expectedActionFingerprint) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['expectedActionFingerprint'],
      message: 'Approval requires the exact action fingerprint shown to the reviewer.',
    })
  }
})

/** The 403 body when separation of duties refuses an approval. */
export interface SeparationRefusalBody {
  error: 'Separation of duties'
  reasons: string[]
  conflicts: string[]
  /**
   * Whether this approver may still approve as the configured sole operator
   * by sending a written justification (at least `minJustificationLength`
   * characters) as `comment`. The console shows a justification field when
   * `available` is true, instead of a dead end.
   */
  soleOperatorOverride: { available: boolean; minJustificationLength: number }
}

/**
 * Build the separation-of-duties refusal. The override is available only
 * when the approver is the configured sole operator (QUICKSILVER_SOLE_OPERATOR_ID);
 * everyone else needs another human to approve.
 */
export function separationRefusal(
  result: Pick<SeparationOfDutiesResult, 'reasons' | 'conflicts'>,
  approverId: string,
  soleOperatorId: string | null,
): SeparationRefusalBody {
  const available = !!soleOperatorId && soleOperatorId.trim() === approverId.trim() && result.conflicts.length > 0
  return {
    error: 'Separation of duties',
    reasons: result.reasons,
    conflicts: result.conflicts,
    soleOperatorOverride: { available, minJustificationLength: MIN_SOLE_OPERATOR_JUSTIFICATION },
  }
}
