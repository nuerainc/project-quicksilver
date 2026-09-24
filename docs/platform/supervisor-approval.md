# Supervisor approval gate

Decision approvals use the existing Sanity `decision` document and NQC process
lifecycle. They do not create a second approval store. The decision records a
SHA-256 policy snapshot version derived from the `_rev` values of the policy
documents resolved when the plan is evaluated.

## Approval flow

1. A supervisor request is authenticated with the server-side
   `NQC_SUPERVISOR_TOKEN`; the supervisor identity comes from
   `NQC_SUPERVISOR_ID`, never from a request body.
2. The configured identity must resolve to a human Sanity entity. If a policy
   lists required approvers, that identity must appear in every applicable
   policy's approval requirements.
3. The API verifies the policy snapshot is still current and the NQC Kernel
   did not return `BLOCK`.
4. The API stores an approval record on the decision, bound to the decision
   id, exact selected action, risk value, and policy snapshot digest. Status
   changes still pass through the existing process lifecycle when enabled.
5. Execution recomputes the policy snapshot and action fingerprint. A changed
   policy, changed action, missing approval, or mismatched approver blocks the
   run. The outcome is appended as `executionAudit` on that same decision.

Rollback proposals reuse the same decision lifecycle and policy snapshot; they
also require a recorded approval before execution.

## Configuration

Set these server-only variables after creating the supervisor as a human entity
in the dedicated Nuera Quicksilver Sanity project:

```env
NQC_SUPERVISOR_ID=entity-your-supervisor
NQC_SUPERVISOR_TOKEN=<random secret with at least 32 characters>
```

Approval, rejection, evidence-request, and rollback endpoints require
`Authorization: Bearer <NQC_SUPERVISOR_TOKEN>`. Keep the token in a trusted
server-side caller; never add it to `NEXT_PUBLIC_*` variables or browser code.
The current single-token identity is an interim trusted-server credential, not
SSO, user sessions, team RBAC, or multi-tenant authorization.

Policy changes after planning or approval invalidate the decision for
execution. Request a fresh plan so the kernel evaluates the current policy
documents. Live workflow tool execution remains disabled; this decision gate
does not enable external tool side effects.
