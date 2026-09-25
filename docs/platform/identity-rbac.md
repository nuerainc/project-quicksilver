# Identity and RBAC (foundation)

`@quicksilver/kernel` now includes a deny-by-default access model
(`identity/rbac.ts`). It runs in any environment because it has no
dependencies. A server-only bearer-token identity provider lives at
`@quicksilver/kernel/identity/tokens`. The durable run queue enforces the
model, and so do the web app's supervisor decision routes.

## Model

- **Principal:** `{ id, kind: 'human' | 'service' | 'agent', tenantId, roles, disabled? }`.
- **Permission:** one of a fixed list. Examples: `run:enqueue`, `run:cancel`,
  `run:redrive`, `decision:approve`, `decision:rollback`, `workflow:publish`,
  `memory:approve`, `routing:approve`, `secret:*`, `audit:read`,
  `tenant:admin`.
- **Roles:** built in are `viewer`, `operator`, `developer`, `supervisor`,
  `auditor`, `tenant-admin`, `trigger` (enqueue only) and `agent-worker`.
  Tenants can define **custom roles**. A custom role is scoped to one tenant
  and cannot redefine a built-in role.

## Rules enforced by `AccessController.authorize`

1. **Deny by default.** A permission is granted only through a role the
   principal holds. Unknown roles or permissions grant nothing.
2. **Tenant isolation.** A principal can only act on resources in its own
   tenant. No super-role crosses tenants.
3. **Agents never hold authority.** Agent principals can't approve, execute,
   roll back, redrive, publish, read or write secrets, or administer, even if
   a role would grant it. This matches the agent-manifest rule that agents
   propose and a human authorizes.
4. **Separation of duties.** A principal can't approve a decision, memory
   change, routing change or workflow publication that it requested itself.
5. **Audit.** Every decision, allowed or denied, goes to the configured audit
   sink with the principal, permission, tenant, resource and reasons. If the
   sink fails, the decision still stands.

## Credentials

`StaticTokenIdentityProvider` stores only SHA-256 digests of bearer tokens
and compares them in constant time. It refuses shared tokens, duplicate
principals, disabled principals and malformed digests.
`principalsFromJson` fails loudly on bad configuration, so a config error
can't silently grant or drop access. Generate a token with:

```bash
npm run principal:token -- entity-ana supervisor
```

The token is shown once. The printed JSON entry holds only the digest.

## Where it is enforced

| Path | Enforcement |
|---|---|
| `WorkflowRunQueue` (`access` option) | `enqueue` needs `run:enqueue` for the request's tenant. `cancel` needs `run:cancel` and `redrive` needs `run:redrive` for the run's tenant, and both reject plain actor strings. The run stores `requestedBy`. Denials are added to the run's event log as `access-denied`. |
| Web decision routes | When `QUICKSILVER_PRINCIPALS` is set, approve/reject needs `decision:approve` and rollback needs `decision:rollback`, from a **human** principal in `QUICKSILVER_TENANT_ID`. Each supervisor has their own token, and the principal id is that supervisor's Sanity entity id. If the variable is unset, the interim single `NQC_SUPERVISOR_TOKEN` still works. Approvals also pass the separation-of-duties check below. |
| Plan, query and workflow routes | A bearer token, when sent, must be valid (401 otherwise). The verified principal is recorded as the decision's `requestedBy` or the evaluation record's requester. Without a token the requester is `console:anonymous`. |
| Hosted runtime | Every `/api` route on the host needs a bearer token and the matching permission; see [hosted runtime](hosted-runtime.md). The host refuses principals from any other tenant. |
| Secrets vault | `secret:use`, `secret:read` and `secret:write`, checked on every vault operation. |

## Separation of duties in decisions

`checkSeparationOfDuties` (`identity/separation.ts`) runs on every decision
approval. Each decision records `requestedBy` (the verified caller of
`/api/plan`) and `proposedBy` (`nuera-quicksilver:planner`, or the supervisor
for a rollback proposal). The approver may not be:

- the principal that requested the decision,
- the principal or agent that proposed the action, or
- the entity that would carry out the action.

A conflict returns 403 with the reasons.

**Sole-operator mode.** A one-person organization can set
`QUICKSILVER_SOLE_OPERATOR_ID` to that person's principal id. That person may
then approve despite a conflict, but only with a written justification of at
least 20 characters in the approval comment. The approval record is stamped
`soleOperatorOverride: true` with `waivedConflicts` and the `justification`,
so the audit trail shows exactly when separation of duties was waived and why.
Without the variable, the rule is strict.

Without an `access` option the queue still accepts named actors, which keeps
local development and the existing tests simple. Configure `access` for any
shared deployment.

## Not yet built

- SSO/OIDC sign-in and browser sessions, behind the same `IdentityProvider`
  port.
- Persistent principal and role administration, including a UI and an
  audited `tenant:admin` API.
- Durable storage for the access-audit sink. Today denials go to the web
  server log and to the host's structured logs.
- ~~Secrets vault~~: see [hosted runtime](hosted-runtime.md#secrets-vault).
  ~~Separation of duties in the decision routes~~: done (above).
