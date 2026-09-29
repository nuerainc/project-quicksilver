# Kernel depth (M7): policy lineage and the capability graph

M7 (Quicksilver 0.8.0) deepens the NQC Kernel's company model without
changing who decides. The kernel still authorizes every action
deterministically, fails closed, and never asks a model. Every new field is
optional. A company model without them behaves exactly as it did before.

**Status:** all four parts are built (2026-09-27):

- policy versioning, supersession and scope nesting (`packages/kernel/src/authority.ts`)
- the capability graph (`packages/kernel/src/capability-graph.ts`)
- the what-if engine (`packages/kernel/src/simulation/`, `npm run whatif`):
  Monte Carlo cash, experiment outcome odds, stress scenarios and
  counterfactuals on shadow logs. Every result is an estimate, never a
  decision. See [What-if engine](what-if.md).
- the governed task interface (`packages/host/src/tasks.ts`, `npm run tasks`,
  `npm run mcp:tasks`): one intake path for tasks from the HTTP API, the MCP
  server, signed webhooks and the CLI. Each task passes the boundaries (AMP
  patent material, frozen projects) and then the normal `authorize()`. The
  channel grants nothing, the task text is untrusted data, and a human
  approves. A task runs only when the kernel allows it without approval and
  its department acts within limits. See [Task interface](tasks.md).

## Part 1: policies

### Versions and lineages

Policies that are versions of one rule share a `lineageId`. Each has a
`version`, a positive integer. Among a lineage's **live** policies (effective
and not expired), only the highest version applies. Lower versions are
recorded as `superseded-by-version`.

| Policy | Lineage | Version | Effective | Result on 2026-10-01 |
|---|---|---|---|---|
| Refund limit (2025) | `refund-limit` | 1 | 2025-01-01 | superseded by version 2 |
| Refund limit (2026) | `refund-limit` | 2 | 2026-01-01 | **applies** |
| Refund limit (2027) | `refund-limit` | 3 | 2027-01-01 | not yet effective |

Edge cases:

- **The newest version moved to another scope.** The older version is still
  superseded, and the newest version's row says `out-of-scope`. A human must
  confirm that the rule no longer applies to this action.
- **The current version can't be determined.** This happens when a live
  member has no valid version, or when two live members share the top
  version. The kernel doesn't choose. All members apply, and the ambiguity is
  a policy conflict that goes to a human.

### Supersession

`supersedesIds` still works as before, with two changes:

- **Only a live policy supersedes.** A policy that isn't effective yet used to
  retire its predecessor early, which left a gap. It no longer does.
- **Cycles go to a human.** If live candidates supersede each other in a
  cycle (A → B → A, any length), the kernel doesn't pick one. Every member is
  recorded as `supersession-cycle` and none of them is applied. The cycle is a
  conflict, so the action needs human approval.

### Scope nesting

Scopes are dot-separated. A policy scoped `finance` governs a capability
whose governing scopes include `finance` or any `finance.*` descendant. A
policy scoped `finance.payments` doesn't govern a capability scoped only
`finance`.

When an ancestor-scope policy and a descendant-scope policy disagree, the
more specific scope wins only if it is at least as restrictive. The kernel
never lets a more specific scope silently loosen an ancestor. This follows the
same principle as priority:

| `finance` | `finance.payments` | Outcome |
|---|---|---|
| require-approval | deny | deny (the specific scope is stricter) |
| require-approval | require-approval | require-approval (one reason, from `finance.payments`) |
| deny | allow | a human approves (a loosening; never an autonomous run) |
| require-approval | allow | a human approves (a loosening) |

Priority resolves disagreements within one scope. Specificity resolves them
between nested scopes. Free-text policies in nested scopes need a human to
reconcile them, just as they do when they share a scope.

### Audit rows

Every policy row in the decision record now has a `reasonCode`:

- `applies`
- `expired`
- `not-yet-effective`
- `conditions-not-met`
- `superseded-by-id` (with `supersededById`)
- `superseded-by-version` (with `supersededById`)
- `supersession-cycle`
- `out-of-scope`

### Validating a policy set

`validatePolicySet(policies)` is pure and reports problems a human should
fix.

Errors:

- supersession cycles of any length, including a policy that supersedes itself
- duplicate policy ids
- invalid versions
- a lineage with duplicate versions, or with members that have no version
- a policy that supersedes a higher version of its own lineage

Warnings:

- a superseded id that isn't in the set
- a version on a policy that has no lineage
- partial supersession: A supersedes version 1 of another lineage but not
  that lineage's version 2, so it's unclear whether the whole rule is retired

Some cases are unambiguous and aren't flagged:

- superseding a policy in another scope
- superseding the newest version of another rule
- superseding an older version of the policy's own lineage

## Part 2: the capability graph

A capability can declare four optional fields:

| Field | Meaning |
|---|---|
| `inherits` | Parents. The child inherits their constraints: the union of governing scopes, a base-risk floor (the maximum of the parents' base risks), dependencies, conflicts and risk multipliers. |
| `requires` | To use this capability, the actor must also hold each of these, transitively. |
| `conflictsWith` | The same actor may not hold both. The relation is symmetric and inherited. |
| `riskMultiplier` | A finite number of at least 1. Multipliers along the inheritance chain multiply, and each distinct ancestor counts once. |

### Inheritance never grants a right

`payments.refund-large` inherits `payments.refund`. Policies on
`finance.payments` therefore also govern large refunds, and a large refund is
never less risky than a refund. But an actor who holds only
`payments.refund` can't issue a large refund. Holding the child doesn't
grant the parent either. Only restrictions flow down the graph, so a broad
grant can never quietly imply a narrower, riskier one.

### Dependencies

If `x` requires `y` and `y` requires `z`, the actor must hold `y` and `z` to
use `x`. Holding means the same as for `x` itself: the capability is in the
actor's profile and granted to the actor. The decision record lists the
missing requirements.

### Conflicts

When `pay.approve` conflicts with `pay.create`, an actor holding both is
refused either one. For conflicts, holding is read broadly: the capability is
in the profile or granted, so a half-recorded grant can't hide a conflict.
`validateCapabilityGraph(capabilities, entities)` reports such holdings in the
company model.

The one exception is the existing separation-of-duties sole-operator override
(`identity/separation.ts`). The configured sole operator, acting as
themselves, may proceed with a written justification of at least 20
characters. The decision record stamps `soleOperatorOverride: true`, and the
action still goes to a human; it never runs autonomously. Pass the setting to
`authorize()` as `separation: { soleOperatorId, justification }`.

### Risk multipliers

The kernel computes risk as before (`risk.ts`, clamped to 0–5). It multiplies
that risk by the effective multiplier, rounds **up** to the next whole level,
and clamps the result to 0–5. Policies then see this final value.

Rounding up is the conservative choice: any multiplier above 1 raises a
nonzero risk by at least one level. A small epsilon keeps floating-point noise
from rounding an exact product up.

| Computed risk | Multiplier | Final risk |
|---|---|---|
| 2 | 1.5 | 3 |
| 2 | 1.1 | 3 |
| 1 | 1.5 × 2 (inherited) | 3 |
| 4 | 2 | 5 (clamped) |

### Structured authorization explanation

Every `authorize()` result now includes an `explanation` object intended for
decision records, APIs, dashboards, and evaluators. It contains:

- `appliedPolicies`: the policy IDs considered applicable;
- `conflictsDetected`: deterministic policy conflicts surfaced by the kernel;
- `riskComponents`: base risk, financial and operational impact tiers,
  reversibility, uncertainty, pre-multiplier risk, multiplier, and final risk;
- `guardEvaluations`: policy check outcomes with stable reason codes.

This is observable governance data, not model reasoning. It deliberately does
not contain private chain-of-thought, prompts, or hidden evaluator state. The
explanation is derived from the same values used for authorization, so it
cannot disagree with the decision shown to the caller.

### Kernel-signed execution authorization

Protected steps do not run on a boolean. The kernel issues a signed execution
authorization (`@quicksilver/kernel/runtime/authorization`), and that record is
what makes a step eligible to execute.

**Contract version 3 binds the workflow content and the approval.** Every
record carries a `workflowDigest` and an `approvalDigest` alongside tenant, run,
node, action fingerprint, policy snapshot, evidence digest, and capability. A
grant issued for one workflow is refused for another, so published content and
the authority to act on it cannot drift apart. The approval digest is taken over
the human approval binding with `approvalDigest()`, so the authority to execute
is tied to one specific approval rather than to the fact that somebody
approved something similar.

**A human approval expires.** `HumanApprovalBinding` carries `expiresAt` and the
Supervisor refuses a lapsed approval. Without it an approval granted once would
authorize the same action indefinitely.

**An unsigned record is never acceptable.** Verification checks the signature
whenever one is present *and* refuses a record that has none, so a hand-built
object carrying the right tenant, fingerprint, policy, evidence, and capability
cannot pass on its face alone.

**The Supervisor gate verifies cryptographically.**
`coordinateSupervisorControl(request, key)` requires the signing key and calls
`verifyExecutionAuthorization` before it can return `ready-to-execute`. Field
comparison is kept as defense in depth, but a `ready-to-execute` result now
means a live kernel signature over exactly the bindings in the request. This
closes the M8-B requirements that the Supervisor Agent stops on an invalid
signature, on a changed workflow, and on an expired approval.

**Known gap — stale policy.** `policySnapshot` is carried and compared for
equality, but the kernel does not yet resolve whether a snapshot is still the
live one. Policy currency is computed inside `authorize()` in `authority.ts`
(lineage, supersession, effective windows) and is not plumbed through to the
control plane, and the host currently issues the literal placeholder
`kernel:current`. A genuine staleness check needs that resolved snapshot
carried on the grant, which is separate work.

### Failing closed on an invalid graph

`validateCapabilityGraph` reports:

- inheritance cycles and dependency cycles
- unknown ids
- a capability that requires one it conflicts with
- a capability that conflicts with itself
- multipliers below 1 or non-finite
- duplicate ids

`authorize()` refuses an action when its capability, any of its ancestors, or
any transitive requirement appears in one of these problems. Problems
elsewhere in the graph don't block unrelated capabilities.

### What the decision record shows

`authorize()` returns `capabilityGraph` with these fields:

- the effective scopes used and the ancestors they were inherited from
- the effective base risk
- the multiplier, with the risk before and after it
- the transitive requirements and any missing ones
- conflicting capabilities held, and whether the sole-operator override applied
- graph problems

## Wiring notes

- The Studio schemas have the new fields:
  - policy: `lineageId`, `version`
  - capability: `inherits`, `requires`, `conflictsWith`, `riskMultiplier`
- Run `npm run schema:deploy` to publish them.
- The web plan route (`apps/web/app/api/plan/route.ts`) passes all of this to
  `authorize()`. Its queries and document mapping live in
  `packages/kernel/src/model-document.ts` and are all parameterized:
  - It fetches **all capabilities**. A conflict can be declared only on the
    other capability, and every capability granted to the actor counts, so a
    walk out from the action's capability could miss one. Company models are
    small, so one query is simpler and can't under-fetch.
  - It fetches the policies that are cited, that name the actor, or whose
    scope is one of the capability's effective scopes or an ancestor of one.
    It also fetches **lineage siblings**, so version resolution sees a newer
    version even after it moved scope.
  - The policy snapshot covers the policies the decision's audit rows name.
    The execute and approval routes recompute it from those rows.
  - Plan-time separation of duties is strict. The sole-operator override
    needs a written justification, and only the approval step collects one.
- The host's shadow verdict (`packages/host/src/shadow-api.ts`) builds its own
  one-capability model rather than reading Sanity, so it's unchanged.
