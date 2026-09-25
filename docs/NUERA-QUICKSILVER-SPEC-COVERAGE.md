# Nuera Quicksilver blueprint coverage

This is the implementation tracker for the complete cognitive and automation
blueprint. It records repository evidence and remaining work without treating
the target architecture as already shipped.

## Canonical system map

- **System:** Nuera Quicksilver
- **Cognitive authority:** NQC Kernel (Nuera Quicksilver Cognitive Kernel)
- **Worker family:** Nuera Quicksilver Agents
- **Evaluation engine:** Quicksilver Engine
- **Platform:** workflow authoring, hosted execution, SDKs, identity, and secrets
- **Runtime:** triggers, queues, scheduling, and scaling
- **Observability:** logs, metrics, and traces
- **Enterprise:** audit, compliance, and tenant isolation

Status labels: **Foundation** means code exists but the capability is incomplete
or not operational end to end; **Missing** means no implementation was found;
**Blocked** means a prerequisite is not available; **Safety boundary** means the
current implementation intentionally refuses the capability.

## Cognitive layer

| Requirement | Current repository evidence | Status / remaining work |
|---|---|---|
| Reasoning scoring | Deterministic score from output presence, supplied evidence grounding, tool failures, uncertainty, and step count | Foundation; not a semantic correctness measure, not calibrated against labeled outcomes |
| Hallucination detection | Missing cited references and absent evidence raise risk | Foundation; no general factual verification or independent evidence retrieval |
| Brittleness detection | Step count, tool failures, uncertainty, and score feed a brittleness level | Foundation; no adversarial stress suite or measured brittleness benchmark |
| Chain-of-thought stress testing | Engine does not request or retain private reasoning traces | Reframed by design: stress-test observable final answers and action traces without collecting private chain-of-thought |
| Multi-step logic traps | Versioned deterministic challenge generator/scorer covers arithmetic, invalid inference, insufficient information, and contradictory constraints; manual benchmark command runs against a configured model role | Foundation; no calibration dataset, dashboards, or durable benchmark history |
| Failure exemplars | Deterministic evaluator creates examples for observable grounding/tool failures; NQC returns governed memory proposals | Foundation; exemplars are not persisted, retrieved, or fed into a validated learning loop |
| Diagnostic formatting and structured output | Engine/NQC return scores, risks, issues, corrections, safety decision, routing proposal, and memory proposals | Foundation; API contract versioning, durable traces, and client compatibility need work |
| Engine-to-kernel integration | NQC calls the Quicksilver Engine before returning a safety decision; planning decisions also retain deterministic authorization | Foundation; there is no semantic proof of correctness; BLOCK/ALLOW/ESCALATE need comprehensive runtime and audit coverage |
| Reasoning trace request field | No private chain-of-thought field is accepted | Deliberate boundary; use user-visible rationale, evidence references, tool results, and step traces instead |

## Kernel and agent layer

| Requirement | Current repository evidence | Status / remaining work |
|---|---|---|
| Safety engine | Decision approvals require a server-verified supervisor credential, human Sanity entity, current policy snapshot, and action fingerprint; execution verifies approval and appends an outcome record | Foundation; per-person hashed supervisor credentials with RBAC are available (single shared token remains as fallback); no SSO, and live effectful workflow tools remain blocked |
| Routing engine | Route selector and profile update helpers | Foundation; no persisted measurement loop or dispatch integration |
| Tool-use validator | Versioned contract registry wraps Sanity Context MCP tool calls | Foundation; no persistent provider registry, external approvals, or marketplace permissions |
| Memory governor | Validates memory proposals and retention metadata | Foundation; no durable tenant/domain-scoped store, retrieval, deletion, or retention worker |
| Policy writer / closed-loop learning | No automatic policy writer; profile update helper is isolated | Missing operational loop; updates require measured outcomes, review, versioning, rollback, and audit |
| Domain kernel loader | No loader or domain-pack execution contract | Missing; introduce signed/versioned declarative packs and sandbox rules before loading executable extensions |
| Agent family | Registered model-backed agents currently include planner, reviewer, and query | Foundation; Code, Reasoning, Bulk, Router, Tool, Memory, Evaluator, Supervisor and future domain agents are not all implemented as workers |
| Standard agent interface | Generic versioned request/result contract now wraps the query worker and runs its structured output through Quicksilver Engine/NQC; abort signal, tool calls, evidence context, impact, and routing proposal fields are supported. Live workflow returns the full NQC result, including memory proposals | Partial; adapt planner/reviewer and subsequent workers; domain kernel contract and agent creation/deployment API remain |
| Supervisor stage | Existing decision process now records a supervisor identity and approval fingerprint bound to request/action/policy revisions; execution verifies the binding and records its outcome | Partial; no distinct Supervisor Agent, browser identity integration, SSO/RBAC, or durable external tool approval verifier |

## Workflow and runtime layer

| Requirement | Current repository evidence | Status / remaining work |
|---|---|---|
| Visual graph | Workflow editor draws an SVG map and separately edits nodes/connections | Foundation; map is not a drag-and-drop canvas and does not yet visualize run-time values |
| Multi-step and conditional branches | Versioned DAG validator, data-only condition expressions, in-process sequential runner | Foundation; no shared published workflow or durable run state |
| Parallel execution | Caller can opt into bounded request-local concurrency (1–16) for independent low/moderate agent steps; live read-only route caps at three | Foundation; no durable scheduler, cross-run concurrency limits, queue/backpressure, or rate-limit-aware admission |
| Looping constructs | Cycles are rejected unless represented by a future bounded-loop node | Missing; needs strict iteration and time budgets, cancellation, and safety checks per iteration |
| Versioning and debugging | Graph has schema/version fields; preview and step outcome responses exist | Foundation; no diff/release history, breakpoints, replay, or durable trace inspection |
| Agent → evaluator → kernel → supervisor → action pipeline | Planning/API paths use agent, evaluation, deterministic governance, and human approval controls; live workflow route is read-only | Partial; no general workflow action execution path, Supervisor Agent, or unified observability/memory feedback path |
| Retry and timeout | Agent-handler attempts and per-handler timeout are configured in graph; run-level `AbortSignal` cancels at step boundaries and aborts in-flight handlers; run-level retries with exponential backoff honour provider `retryAfterMs` hints; the live route cancels on client disconnect | Foundation; providers must honor cancellation; tool retries are intentionally rejected, and failed runs with dispatched tools are dead-lettered instead |
| Event-driven triggers | `@quicksilver/kernel/triggers`: UTC cron parser and `CronScheduler` (per-slot idempotency, replica-safe, bounded catch-up) and `WebhookTrigger` (HMAC-SHA256 signatures with rotation, ±5 min timestamp tolerance, replay cache, delivery-id idempotency, Fetch-standard handler); both enqueue as `trigger`-role service principals. Covered by `triggers.test.ts` | Foundation; no hosted trigger process or management API, secrets come from env (no vault), no shared replay cache, event-bus/filesystem triggers missing |
| Queues and resilience | `@quicksilver/kernel/runtime`: durable run records with an append-only event log; in-memory, fsync'd JSONL, and PostgreSQL stores held to one contract test (`store-contract.test.ts`, Postgres via embedded PGlite); priority queue with idempotency keys, global/per-tenant backpressure, per-tenant running limits that hold across processes, leases with heartbeat and expiry recovery, cancellation, dead-letter queue, audited redrive, RBAC on enqueue/cancel/redrive; worker with concurrency and graceful shutdown | Foundation; no `SKIP LOCKED` claim fast path, queue metrics dashboard, or retention policy |
| Hosted and scalable runtime | `@quicksilver/host`: one single-tenant process running the worker pool, cron schedules and signed webhooks from a validated config, with a bearer-token management API, graceful shutdown, health/readiness probes, Dockerfile and Compose with Postgres. Covered by `host.test.ts` and `config.test.ts` | Partial: single tenant; no isolated per-job containers, autoscaling, resource limits, or model/agent-aware capacity |

## Developer ecosystem and enterprise layer

| Requirement | Current repository evidence | Status / remaining work |
|---|---|---|
| Python / JavaScript SDKs and CLI | Internal Python SDK + `qs` CLI and internal TypeScript SDK for workflow validate/preview/gated read-only run | Foundation; not published, stable API contract not declared, broader auth/agent APIs absent |
| Go SDK and local harness | Neither found | Missing; build after stable API contract and auth model |
| Agent creation API | No API to create, validate, version, or deploy agent definitions | Missing; requires standard agent contract, identity, permissions, and audit model |
| Plugin and tool schemas | Versioned in-process tool schemas and validation for current MCP path | Foundation; no install lifecycle, isolation, permissions UX, or persistent catalog |
| Marketplace and publishing | No extension catalog | Missing: versioning, signing, review, approval, publishing, revocation, and tenant trust controls |
| Secrets vault and OAuth credentials | `SecretsVault` (`packages/host/src/vault.ts`): AES-256-GCM at rest with the key only in the environment, name/version bound as associated data, `secret:use`/`read`/`write` RBAC, rotation with a grace period, audited access without values, atomic writes; webhook secrets are references and rotate without a restart. Covered by `vault.test.ts` | Partial: no OAuth credential lifecycle, KMS/HSM key storage, or automatic rotation schedule |
| Authentication, RBAC, collaboration | Kernel RBAC (`identity/rbac.ts`): principals, built-in and tenant-scoped custom roles, deny-by-default, tenant isolation, agents barred from authority permissions, audited decisions; hashed bearer-token provider; enforced on the queue, the web decision routes and the host API. Decisions record `requestedBy` and `proposedBy`, and approvals pass `checkSeparationOfDuties` with an audited sole-operator override. Covered by `identity.test.ts` and `separation.test.ts` | Foundation; no SSO/OIDC or browser sessions, persistent principal/role administration, durable access-audit store, or team collaboration features |
| Logs, metrics, traces, dashboards | Structured JSON logs with redaction by key, credential shape and resolved secret value; Prometheus metrics for runs, run duration, queue depth, webhooks, schedules, NQC evaluations, vault access and HTTP; durable `evaluationRecord` documents for query and workflow steps. Covered by `observability.test.ts` | Partial: no distributed traces, dashboards, alerting, or log retention policy |
| Compliance and data governance | No compliance packs or tenant governance layer | Missing: policy packs, HIPAA/SOC 2/PCI/FedRAMP evidence workflows, retention/deletion controls, and exportable audit reports; compliance claims require legal/security review |
| Tenant isolation | Kernel RBAC and the run queue enforce tenant boundaries; the host serves exactly one tenant and refuses principals from any other | Partial: single tenant by design at 0.3.0; multi-tenant hosting and isolation tests come before 0.9.0 |
| Separate Sanity environment | New dedicated project `f87t11g1` created; its production dataset is private; local app and Studio project IDs point to it; schemas remain separate from challenge history | Blocked pending a new project-scoped server token and Context MCP endpoints; no deploy or seed has run |

## Product layers (intent and playbooks)

These requirements come from the [product definition](NUERA-QUICKSILVER-PRODUCT.md).

| Requirement | Current repository evidence | Status / remaining work |
|---|---|---|
| Intent entry point | CEO objective console sends a plain objective to the planner | Foundation; no parsing into objective, constraints, autonomy depth and mode |
| Decision graph | None | Missing; `intent` and `graphVariable` types, storage, impact scoring for open unknowns |
| Provenance tags | None; evidence documents carry confidence | Missing; `HUMAN_SPECIFIED` / `OBSERVED` / `AGENT_INFERRED` / `SYSTEM_CONSTRAINT` on every variable, write rules enforced by the kernel |
| Confidence calibration | Evaluator scores are uncalibrated | Missing; calibration method and labeled outcomes |
| Playbook type | Process definitions and workflow graphs exist separately | Missing; `playbook` document joining stages to stage graphs, with modes, budget, metrics and thresholds |
| Bounded loops | Graph cycles are rejected | Missing in graphs; playbook iteration runs at the process level until a bounded-loop node exists |
| Genesis mode and economic playbook | None | Missing; `experiment` type, thresholds set before start, paid-signal experiments |
| Onboard mode | None | Missing; connectors, owner interview, backtest, shadow mode, per-department autonomy graduation |
| Operate mode | None | Missing; reinvestment and bounded experiments inside a running business |
| Finance layer | Decisions record financial exposure | Missing; `ledgerEntry`, CAC, margin, cash forecast, compute billed as capital |
| Connectors | Sanity Context MCP only | Missing; ledger, CRM, payments and email connectors that write `OBSERVED` values |
| WAES review | None | Missing; `wellbeingReview` type, review contract, hard block on failure |
| Small-budget spend risk | Financial tiers start at $1,000 | Missing; a lower tier scale for Genesis runs |
| Business agent family | Planner, reviewer and query manifests | Missing; research, offer, content, outreach, sales, fulfillment and finance agents, each defined by a manifest |
| Platform feature baseline | See the tables above | Partial; a pass/fail test list for each baseline item is still to be written |

## Regression coverage

`npm run kernel:test` now covers the workflow validator, condition language,
and runtime (`workflows.test.ts`); the Quicksilver Engine, NQC contract, routing,
memory governance, stress suite, and tool/agent registries (`nqc.test.ts`);
and the durable run layer (`runtime.test.ts`), in addition to the original
kernel and process suites. Writing these tests surfaced one runtime defect,
now fixed: concurrent batching could execute an agent on an unselected
condition branch.

## Build order and gates

1. **Finish local foundations:** ~~regression coverage for graph validation,
   settings, retries, timeout cancellation, and branch behavior~~ (done); a
   graph-map layout test remains for the editor UI.
2. **Extend stable contracts:** adapt planner/reviewer and future workers to
   the new shared agent request/result contract; define domain-pack metadata,
   tool permissions, and SDK versioning.
   Preserve the no-private-chain-of-thought boundary.
3. **Unlock isolated content:** receive the dedicated Sanity project ID and
   Context MCP endpoints; deploy the separate schemas only to that project.
4. **Secure and persist:** authentication, tenant scoping, RBAC, managed
   credentials, versioned workflow storage, approvals, and durable run/audit
   records. Keep public live execution disabled until these gates are met.
5. **Operate the runtime:** workers, durable queues, triggers, cancellation,
   rate-limit-aware scheduling, dead letters, logs/metrics/traces, and measured
   routing and memory feedback.
6. **Expand the ecosystem:** agent/tool creation, SDK publication, Go SDK,
   reviewed marketplace, domain packs, collaboration, and compliance packs.

The fuller repository status and dependencies remain in the
[implementation roadmap](NUERA-QUICKSILVER-ROADMAP.md). Product comparisons and
enterprise readiness require operational evidence; this blueprint tracker is
not itself evidence of parity with another product.
