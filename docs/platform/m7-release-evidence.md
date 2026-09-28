# M7 release evidence: Kernel depth

**Milestone:** M7 — Kernel depth  
**Target version:** 0.8.0  
**Verification date:** 2026-09-28  
**Repository commit at verification:** `c02206a` plus the current working tree before this documentation-only synchronization

M7 was checked against executable implementation and tests, not only roadmap labels. All four contracted parts are present and pass their focused acceptance suites.

## Acceptance matrix

| M7 part | Implementation | Verification | Result |
|---|---|---|---|
| Policy versioning, supersession, and scope nesting | `packages/kernel/src/authority.ts`, `packages/kernel/src/policy-versioning.ts` | `authority.test.ts`, `policy-versioning.test.ts` | **Pass** |
| Capability graph | `packages/kernel/src/capability-graph.ts` | `capability-graph.test.ts` | **Pass** |
| What-if simulation | `packages/kernel/src/simulation/`, `packages/host/src/whatif-cli.ts` | `simulation.test.ts`, `whatif.test.ts` | **Pass** |
| Governed task interface | `packages/host/src/tasks.ts`, `tasks-api.ts`, `mcp-tasks.ts`, `tasks-cli.ts` | `tasks.test.ts` | **Pass** |

## Exact verification command

```bash
node --experimental-strip-types --no-warnings --test \
  packages/kernel/src/authority.test.ts \
  packages/kernel/src/policy-versioning.test.ts \
  packages/kernel/src/capability-graph.test.ts \
  packages/kernel/src/simulation/simulation.test.ts \
  packages/host/src/whatif.test.ts \
  packages/host/src/tasks.test.ts
```

**Observed result:** `89/89` tests passed, with zero failures, cancellations, skips, or todos.

The repository-wide credential-free verification also passed:

```bash
npm run verify
```

**Observed result:** `610/610` tests passed and all TypeScript checks passed.

## Scope confirmed by the tests

- Policy lineage chooses only the highest live version, handles future and expired versions, records supersession reasons, detects cycles, and resolves nested scopes conservatively.
- Capability inheritance carries restrictions but never grants rights; transitive dependencies, conflicts, risk multipliers, graph validation, and fail-closed authorization are covered.
- What-if outputs are deterministic for a seed, expose assumptions and sample sizes, cover cash, experiment, stress, and counterfactual scenarios, and never write or make decisions.
- HTTP, MCP, signed webhook, and CLI tasks share one governed intake with authentication, RBAC, validation, idempotency, boundaries, approval binding, append-only audit, and safe execution routing.

## Release interpretation

M7 is **implementation-complete and regression-verified**. This does not mean the repository is a hosted 1.0.0 service. M8/M9 work remains for SSO/OIDC, multi-tenant hosting, effectful executors, stable public SDKs, traces, marketplace and domain-pack controls, operational evidence, and the other enterprise gaps listed in the parity matrix.
