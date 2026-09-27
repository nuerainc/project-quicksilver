# Supervisor approval gate

Decision approvals use the existing Sanity `decision` document and NQC process
lifecycle. They do not create a second approval store. The decision records a
SHA-256 policy snapshot version derived from the `_rev` values of the policy
documents resolved when the plan is evaluated.

## Approval flow

1. A supervisor request is authenticated from its `Authorization: Bearer`
   header: a per-person principal token when `QUICKSILVER_PRINCIPALS` is set
   (human, holding `decision:approve` in `QUICKSILVER_TENANT_ID`), otherwise
   the interim shared `NQC_SUPERVISOR_TOKEN` with the identity in
   `NQC_SUPERVISOR_ID`. The approver recorded (`approvedBy`,
   `approvalRecord.supervisorId`) is always that authenticated principal,
   never a request body field: the approve body accepts only `action` and
   `comment`, and a body naming an approver (`approvedBy`, `supervisorId`, ...)
   is refused with 400.
2. The configured identity must resolve to a human Sanity entity. If a policy
   lists required approvers, that identity must appear in every applicable
   policy's approval requirements.
3. The API verifies the policy snapshot is still current and the NQC Kernel
   did not return `BLOCK`.
3a. **Separation of duties.** The approver may not be the decision's
   requester (`requestedBy`), its proposer (`proposedBy`), or the entity that
   would carry out the action. A configured sole operator
   (`QUICKSILVER_SOLE_OPERATOR_ID`) may approve anyway only with a written
   justification of 20+ characters, which is stored on the approval record
   with `soleOperatorOverride: true` and the waived conflicts. See
   [identity and RBAC](identity-rbac.md#separation-of-duties-in-decisions).
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
`Authorization: Bearer <token>` (a per-person principal token, or the interim
`NQC_SUPERVISOR_TOKEN`). Execute requires a human with `decision:execute`;
observe and resume require `decision:read` or `decision:propose`.

Since threat model A-3 no web API route is anonymous. Each checks the bearer
token before it reads the body, calls a model or touches Sanity:

| Route | Permission |
|---|---|
| `POST /api/plan` | `decision:propose` (the principal is recorded as `requestedBy`; the body cannot name one) |
| `POST /api/query` | `decision:read` |
| `POST /api/workflows/validate`, `/simulate` | `workflow:read` |
| `POST /api/workflows/run` | `run:enqueue` (and still off unless `QUICKSILVER_WORKFLOW_LIVE_RUNS=on`, never in production) |
| `POST /api/decisions/:id/action` | `decision:approve` (human) |
| `POST /api/decisions/:id/execute` | `decision:execute` (human) |
| `POST /api/decisions/:id/observe`, `/resume` | `decision:read` or `decision:propose` |
| `POST /api/decisions/:id/rollback` | `decision:rollback` (human) |
| `GET /api/whoami` | any valid token; grants nothing |

The built-in `supervisor` role does not hold `decision:propose`. A founder who
both plans and approves needs a principal with both roles, for example
`"roles": ["supervisor", "developer"]` (or `intent-provider` plus
`developer`). The interim shared `NQC_SUPERVISOR_TOKEN` stands for that one
founder: it may plan (`decision:propose`), ask (`decision:read`), validate and
simulate workflows (`workflow:read`) and act on decisions, but not start live
workflow runs.

Every `POST` to `/api/*` must also send `Content-Type: application/json`
(415 otherwise), and a browser request must come from the app's own origin:
`Origin` and `Sec-Fetch-Site`, when present, must match (403 otherwise).
`middleware.ts` checks this once, before any route; set
`QUICKSILVER_WEB_ALLOWED_ORIGINS` (comma-separated) only if a proxy serves the
app under another origin. Model routes (plan, query, live runs) and the
decision routes are rate-limited per principal (see
[hosted runtime](hosted-runtime.md#rate-limits)); a refusal is 429 with
`Retry-After`. Never put a
token in `NEXT_PUBLIC_*` variables or in the built browser bundle; the only way
it reaches a browser is a person pasting their own token into the sign-in box
below. The single shared token is an interim credential, not SSO, user
sessions, team RBAC, or multi-tenant authorization.

## Signing in on the decision page

The web app's home page (the objective console with the decision cards) has a
**Supervisor or principal token** box above the CEO intent field.

1. Paste your own token (from `npm run principal:token`, or the interim
   `NQC_SUPERVISOR_TOKEN` in a single-supervisor setup) and press **Sign in**.
   The field is a password field and is emptied after sign-in.
2. The page calls `GET /api/whoami` with the token. It validates the header
   with the same helpers the decision routes use and returns only the
   principal id, kind, tenant, display name and permissions (no token, digest
   or other secret), or 401. The page shows "Signed in as ..." with the
   decision actions you can take. A token the server rejects (401) is not
   kept.
3. The Approve, Reject, Request more evidence, Execute, Observe, Resume and
   Propose rollback buttons send `Authorization: Bearer <token>`. A 401 shows
   "Sign in to do this"; a 403 shows "Your account can't do this (needs
   `<permission>`)" followed by the server's reason (for example separation of
   duties). Nothing is retried automatically.
4. **Sign out** removes the token from the tab.

How the token is stored:

- Only in the tab's `sessionStorage` (key `quicksilver.console.token`) and in
  page memory. The browser clears `sessionStorage` when the tab closes. It is
  never written to `localStorage` or a cookie.
- It is sent only to this app's own API routes, each listed exactly in
  `mayCarryConsoleToken` (`apps/web/lib/console-auth.ts`): the
  `/api/decisions/<id>/<route>` endpoints, `/api/whoami`, `/api/plan`,
  `/api/query` and `/api/workflows/{validate,simulate,run}`; never to another
  origin or any other path. The workflow builder reads the same tab's token.
- A plan made from the page is recorded with the signed-in person as
  `requestedBy`. When that same person then approves it, separation of duties
  refuses the approval. If they are the configured sole operator
  (`QUICKSILVER_SOLE_OPERATOR_ID`), the server says so in the 403
  (`soleOperatorOverride.available: true`) and the page shows a
  **justification** box: a written reason of at least 20 characters, sent as
  the approval's `comment` and stored on the approval record with
  `soleOperatorOverride: true` and the waived conflicts. Anyone else sees the
  refusal and needs another human to approve.
- If the browser blocks storage (some private windows), the token is kept in
  page memory only and is lost on reload; the page says so.
- Anyone who can run script in the page can read the token. The web app sends
  a nonce-based Content-Security-Policy (only its own nonce-stamped scripts,
  `connect-src 'self'`, no framing; threat model T-67) to make that hard;
  still use the page on a trusted machine and sign out when done.

## Live end-to-end run

`npm run e2e:live` sends `QUICKSILVER_SUPERVISOR_TOKEN` (a human supervisor's
token for the deployment under test) to the decision routes and exits with a
message when it is unset. `/api/plan` gets `QUICKSILVER_E2E_REQUESTER_TOKEN`
(a principal with `decision:propose`, a different person from the supervisor)
or, when that is unset, the supervisor token; approvals then carry a
sole-operator justification, which works only where that supervisor is
`QUICKSILVER_SOLE_OPERATOR_ID`. Its fault-injection scenario cannot run where
`NODE_ENV=production` (A-10), so target a non-production deployment; against
production it prints a note and skips that scenario.

Policy changes after planning or approval invalidate the decision for
execution. Request a fresh plan so the kernel evaluates the current policy
documents. Live workflow tool execution remains disabled; this decision gate
does not enable external tool side effects.
