import { z } from 'zod'

/**
 * Body of `POST /api/decisions/[id]/action`. Strict: the approver is always
 * the principal authenticated from the `Authorization` header
 * (`verifySupervisorCredential`), never a body field. A body that tries to
 * name one (`approvedBy`, `supervisorId`, `actorId`, ...) is refused with 400
 * rather than silently ignored.
 */
export const DecisionActionBody = z.object({
  action: z.enum(['approve', 'reject', 'request-evidence']),
  comment: z.string().optional(),
}).strict()
