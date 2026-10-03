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
| Memory governor | Durable per-person Operator memory includes provenance/content hashes, expiry, legal holds, deletion redaction, integrity-checked backup/restore, feedback aggregates, and sensitivity labels; snapshots enforce a caller-provided sensitivity ceiling and default to standard-only; CLI review, feedback, export, restore, and stated-memory writes require a human `memory:approve` principal and append the authorization decision to the hash-chained Operator audit log | Partial; automatic classifier covers a narrow set of health/financial phrases, not all sensitive data; authenticated product memory APIs, source-decision resolution, domain labels, encryption-at-rest, and retention scheduling remain |
| Public web search and evidence gathering | Operator `web_search` is a read-only, citation-bearing Brave Search integration; `deep_research` gathers and deduplicates bounded cross-query evidence with coverage and failure disclosure; both use a server-side key, bounded inputs/time, cancellation, output validation, and credential-safe errors | Partial; source-page retrieval, durable reports and browser automation require a governed browser/runtime design; live API evidence needs owner credentials |
| Policy writer / closed-loop learning | No automatic policy writer; profile update helper is isolated | Missing operational loop; updates require measured outcomes, review, versioning, rollback, and audit |
| Domain kernel loader | No loader or domain-pack execution contract | Missing; introduce signed/versioned declarative packs and sandbox rules before loading executable extensions |
| Agent family | Registered model-backed agents currently include planner, reviewer, and query | Foundation; Code, Reasoning, Bulk, Router, Tool, Memory, Evaluator, Supervisor and future domain agents are not all implemented as workers |
| Standard agent interface | Generic versioned request/result contract now wraps the query worker and runs its structured output through Quicksilver Engine/NQC; abort signal, tool calls, evidence context, impact, and routing proposal fields are supported. Live workflow returns the full NQC result, including memory proposals | Partial; adapt planner/reviewer and subsequent workers; domain kernel contract and agent creation/deployment API remain |
| Supervisor stage | Existing decision process now records a supervisor identity and approval fingerprint bound to request/action/policy revisions; execution verifies the binding and records its outcome | Partial; no distinct Supervisor Agent, browser identity integration, SSO/RBAC, or durable external tool approval verifier |

## Workflow and runtime layer

| Requirement | Current repository evidence | Status / remaining work |
|---|---|---|
| Visual graph | Workflow editor draws an SVG map and separately edits nodes/connections | Foundation; map is not a drag-and-drop canvas and does not yet visualize run-time values |
| Multi-step and conditional branches | Versioned DAG validator, data-only condition expressions, in-process runner; shared workflows have immutable reviewed versions and live reads resolve through the active publication pointer | Foundation; hosted execution still uses the separate host publication store, and web live execution remains opt-in/read-only |
| Parallel execution | Caller can opt into bounded request-local concurrency (1–16) for independent low/moderate agent steps; live read-only route caps at three | Foundation; no durable scheduler, cross-run concurrency limits, queue/backpressure, or rate-limit-aware admission |
| Looping constructs | Explicit loop node contains a separately validated non-recursive DAG; execution requires a data-only continuation expression plus iteration and wall-clock ceilings; cancellation and per-iteration evaluation/approval/authorization are covered by regressions | Implemented in the in-process workflow runner and authoring surfaces; durable hosted checkpoints and resume remain future runtime work |
| Versioning and debugging | Immutable Sanity-backed versions, independent review/publish/rollback with reviewer rationale, append-only lifecycle audit, safety-aware graph diffs, active-version digest verification, and metadata-only published-run history | Foundation; no breakpoints, replay, or distributed trace inspection |
| Agent → evaluator → kernel → supervisor → action pipeline | Planning/API paths use agent, evaluation, deterministic governance, and human approval controls; live workflow route is read-only | Partial; no general workflow action execution path, Supervisor Agent, or unified observability/memory feedback path |
| Retry and timeout | Agent-handler attempts and per-handler timeout are configured in graph; run-level `AbortSignal` cancels at step boundaries and aborts in-flight handlers; run-level retries with exponential backoff honour provider `retryAfterMs` hints; the live route cancels on client disconnect | Foundation; providers must honor cancellation; tool retries are intentionally rejected, and failed runs with dispatched tools are dead-lettered instead |
| Event-driven triggers | `@quicksilver/kernel/triggers`: UTC cron parser and `CronScheduler` (per-slot idempotency, replica-safe, bounded catch-up) and `WebhookTrigger` (HMAC-SHA256 signatures with rotation, ±5 min timestamp tolerance, replay cache, delivery-id idempotency, Fetch-standard handler); both enqueue as `trigger`-role service principals. Covered by `triggers.test.ts` | Foundation; no hosted trigger process or management API, secrets come from env (no vault), no shared replay cache, event-bus/filesystem triggers missing |
| Queues and resilience | `@quicksilver/kernel/runtime`: durable run records with an append-only event log; in-memory, fsync'd JSONL, and PostgreSQL stores held to one contract test (`store-contract.test.ts`, Postgres via embedded PGlite); priority queue with idempotency keys, global/per-tenant backpressure, per-tenant running limits that hold across processes, leases with heartbeat and expiry recovery, cancellation, dead-letter queue, audited redrive, RBAC on enqueue/cancel/redrive; worker with concurrency and graceful shutdown | Foundation; no `SKIP LOCKED` claim fast path, queue metrics dashboard, or retention policy |
| Hosted and scalable runtime | `@quicksilver/host`: one single-tenant process running the worker pool, cron schedules and signed webhooks from a validated config, with a bearer-token management API, graceful shutdown, health/readiness probes, Dockerfile and Compose with Postgres. Covered by `host.test.ts` and `config.test.ts` | Partial: single tenant; no isolated per-job containers, autoscaling, resource limits, or model/agent-aware capacity |

## Developer ecosystem and enterprise layer

| Requirement | Current repository evidence | Status / remaining work |
|---|---|---|
| Python / JavaScript SDKs and CLI | Internal Python SDK + `qs` CLI and internal TypeScript SDK for workflow validate/preview/gated read-only run | Foundation; not published, stable API contract not declared, broader auth/agent APIs absent |
| Go SDK and local harness | Dependency-free internal Go client at `packages/sdk-go`; supports validate, safe preview, and gated read-only run; CI builds and vets the module | Foundation only; no contract tests, stable API guarantee, publishing, or local harness |
| Agent definition catalog/API | Tenant-scoped catalog and version listing; validated immutable drafts; human submit/review/publish flow; active-version CAS pointer; append-only audit; protected built-in IDs; dedicated agent permissions; rollback creates a new draft from an integrity-checked archived version and retains normal review/publication gates | Foundation; declarative metadata only, not runtime registration or executable plugin deployment; no archive or editable-draft endpoint |
| Plugin and tool schemas | Versioned in-process tool schemas and validation for current MCP path | Foundation; no install lifecycle, isolation, permissions UX, or persistent catalog |
| Marketplace and publishing | No extension catalog | Missing: versioning, signing, review, approval, publishing, revocation, and tenant trust controls |
| Secrets vault and OAuth credentials | `SecretsVault` (`packages/host/src/vault.ts`): AES-256-GCM at rest with the key only in the environment, name/version bound as associated data, `secret:use`/`read`/`write` RBAC, rotation with a grace period, audited access without values, atomic writes; webhook secrets are references and rotate without a restart. Covered by `vault.test.ts` | Partial: no OAuth credential lifecycle, KMS/HSM key storage, or automatic rotation schedule |
| Authentication, RBAC, collaboration | Kernel RBAC (`identity/rbac.ts`): principals, built-in and tenant-scoped custom roles, deny-by-default, tenant isolation, agents barred from authority permissions, audited decisions; hashed bearer-token provider; enforced on the queue, the web decision routes and the host API. Decisions record `requestedBy` and `proposedBy`, and approvals pass `checkSeparationOfDuties` with an audited sole-operator override. Browser OIDC now includes HTTPS discovery, authorization-code/PKCE, signed ID-token verification, explicit issuer/subject mappings, durable Sanity-backed sessions, secure cookies, revocation, current-role revalidation, and route RBAC/audit tests | P-108 is partial pending console sign-in controls and live IdP/deployed-session evidence. Persistent principal/role administration and team collaboration are also open |
| Logs, metrics, traces, dashboards | Structured JSON logs with redaction by key, credential shape and resolved secret value; Prometheus metrics for host runs, queue depth, webhooks, schedules, NQC evaluations, vault access and HTTP; durable `evaluationRecord` documents; tenant-scoped metadata-only traces for web query/plan/read-only workflow activity; `/monitoring/traces` dashboard with model token usage, optional measured-rate cost estimates, tool/evaluation/decision spans, and in-app alert rules. `telemetry.test.ts` covers sanitization, alert thresholds, and persistence failure; `app-routes.test.ts` covers auth and API contract drift | Partial: web paths are instrumented, but host queue/schedule/webhook traces, external alert delivery, trace retention/pagination, live-provider evidence, and provider-billed cost reconciliation remain open; costs are estimates only when rates are explicitly configured |
| Threat model and security review | [Threat model](platform/threat-model.md): scope, assets, trust boundaries, STRIDE and LLM threats with code and test references, the npm audit triage, and prioritized actions. Three findings need a fix: webhook replay with a substituted delivery id, unauthenticated web execute/observe/resume, and intent answers recorded as human for any principal | Partial: 10 P0 actions open before any hosting or public exposure |
| Compliance and data governance | No compliance packs or tenant governance layer | Missing: policy packs, HIPAA/SOC 2/PCI/FedRAMP evidence workflows, retention/deletion controls, and exportable audit reports; compliance claims require legal/security review |
| Tenant isolation | Kernel RBAC and tenant-scoped queue instances enforce tenant boundaries over shared run storage; queue contract tests cover memory, file, and Postgres adapters. Task records and Task MCP client records are tenant-labeled; cross-tenant reads, lists, idempotency, token use/revocation, and concurrent registry updates are covered over shared stores/files. | Partial: each host still serves one tenant; publication, schedule, intent, Genesis, Operate, principal-provisioning, and hosted-control-plane boundaries need an integrated multi-tenant implementation and isolation tests. Legacy task/client files without tenant IDs need an explicit migration before sharing. |
| Conversational business interface | The authenticated global chat separates read-only Ask, governed Plan, and Work modes. Work transparently routes to a business specialist or honors an explicit selection; specialist output passes through NQC evaluation, BLOCK suppresses the result, ESCALATE is labeled provisional, and specialists return proposals without effects. Follow-up Work requests receive a bounded six-turn/8 KB context; BLOCKed outputs are excluded. Route, permission, rate-limit, request, response, context, and widget regressions are covered. | Foundation: chat-triggered review/approval/execution across existing workspaces, streaming, and rendered usability/accessibility evidence remain open. Ask and Plan are still individual API requests. The ordinary business UI remains available independently of chat. |
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
| Bounded loops | `WorkflowGraph` supports an isolated, non-recursive loop body DAG with iteration/time limits and a data-only continuation condition; the in-process runtime carries state, records per-iteration step traces, propagates cancellation, and repeats evaluation and authorization for each iteration. Studio schema and responsive web workflow editor expose loop configuration and validated body editing. | Implemented and regression-tested for the in-process graph runner; hosted queue scheduling, durable loop checkpoints/resume, and live operational evidence remain separate requirements |
| Genesis mode and economic playbook | None | Missing; `experiment` type, thresholds set before start, paid-signal experiments |
| Onboard mode | None | Missing; connectors, owner interview, backtest, shadow mode, per-department autonomy graduation |
| Operate mode | None | Missing; reinvestment and bounded experiments inside a running business |
| Dynamic organization | Kernel produces digest-bound spawn/fund/shrink/retire proposals from ledger-backed unit-economics inputs, with owner-defined pinned thresholds, evidence/sample gates, approved capital ceilings, and an independent founder decision; founder-only Operate apply uses a dedicated-Sanity executor to atomically update department status/budget metadata and append audit evidence | Partial: does not transfer/disburse funds; department attribution and independent period evidence are unresolved; no general workflow/tool executor or live Sanity integration evidence (P-071/P-095) |
| Finance layer | Decisions record financial exposure | Missing; `ledgerEntry`, CAC, margin, cash forecast, compute billed as capital |
| Connectors | CSV ledger, payments, CRM, and email connectors in `packages/aura/src/connectors.ts` parse CSV/JSON exports into `OBSERVED` intent-graph variables, with boundary enforcement and unified ingest, covered by `onboard.test.ts` | Partial (P-088): read-only live Stripe, HubSpot and QuickBooks Online connectors (`live-connectors.ts`, `npm run onboard -- connect-live`) are tested against a fake API only; no real-account run is recorded, credentials are environment variables rather than vault entries, and there is no live support-inbox source (Resend is a mail channel) |
| WAES review | The NQC WAES gate binds service reviews to exact content, checks proposer/reviewer separation, and blocks on revise/block/missing/stale results; Genesis exposes a model-backed three-component evaluator that persists append-only reviews | Partial: automated contract and fail-closed paths are tested; live-provider calibration, evidence-quality evaluation and operational evidence remain open (P-045) |
| Small-budget spend risk | Financial tiers start at $1,000 | Missing; a lower tier scale for Genesis runs |
| Business agent family | Planner, reviewer and query manifests | Missing; research, offer, content, outreach, sales, fulfillment and finance agents, each defined by a manifest |
| Platform feature baseline | See the tables above; the pass/fail list is [parity tests](platform/parity-tests.md) (123 requirements: 85 covered, 29 partial, 0 missing, 9 needing operational evidence, as of 2026-10-03) | Partial; P-001–P-123 are required for v1.0.0. No row is missing; nine need operational evidence. P-088 (live connectors) has read-only Stripe, HubSpot and QuickBooks connectors tested against a fake API; a real-account run is still needed. P-122/P-123 are in scope by the product owner's explicit direction. |

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
