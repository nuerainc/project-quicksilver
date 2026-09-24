# Nuera Quicksilver implementation roadmap

This roadmap maps the enterprise cognitive and platform goals to the existing
Quicksilver repository. Work extends the current kernel, agents, workflows, and
Sanity audit model; it does not replace them.

The target has twelve principles: cognitive integrity, safety, auditability,
closed-loop learning, domain intelligence, multi-model optimization, developer
experience, workflow orchestration, hosted runtime reliability, secrets and
RBAC security, observability, and an extensible SDK/plugin ecosystem.

## Existing foundation to preserve

- `packages/kernel` already provides deterministic capability, policy, risk,
  approval, and process governance. Its existing tests remain the regression
  baseline.
- `packages/agent` already provides model configuration, a Sanity MCP planner,
  and an advisory reviewer.
- `apps/web` already provides the objective console and decision APIs for
  approval, simulated execution, observation, rollback, and resume.
- `apps/studio` already provides the company schemas and the versioned Decision
  Lifecycle definition. Decision and process history are persisted in Sanity.

## Current NQC additions

The new `packages/kernel/src/engine`, `packages/kernel/src/nqc`, `packages/kernel/src/tools`, and `packages/kernel/src/workflows` folders add
deterministic evaluation signals plus a bounded, provider-neutral reasoning
stress challenge generator/scorer, NQC escalation around existing authorization,
a versioned tool-contract registry used by the shared Sanity Context MCP dispatch path, a static versioned workflow-graph validator, an in-browser workflow draft builder and validation API, route
selection and performance-update functions, and governed memory-write
proposals. Evaluation and safety results are returned by the live plan path and
added to the Sanity decision schema. Query responses also include evaluation
signals, and their MCP calls pass through the same validator.

The kernel also contains a versioned Nuera Quicksilver Agent manifest
registry. Planner, reviewer, and query model calls check that their identity and
task are registered before dispatch. Manifests describe policy; they do not
grant agents authority to approve or execute actions.

The agent package now defines a shared versioned worker request/result
contract. The existing read-only query worker is adapted to it and runs through
Quicksilver Engine/NQC evaluation before returning to the live workflow runner.
Planner and reviewer calls still use their earlier specialized interfaces.

The workflow package also includes an in-process DAG runner with injected
agent/tool/evaluator/approval handlers. Configured agent attempts retry with
bounded backoff; configured handler timeouts send abort signals, including to
the live read-only query model call. Tool calls are never automatically
retried. Independent low/moderate-impact agent steps support opt-in bounded
request-local concurrency; the live route caps concurrent query steps at
three. It is not connected to a hosted worker, web-builder execution, shared
storage, or durable run history. High-impact and side-effect tools are
evaluated and approved before dispatch.

These additions are not yet a complete evaluator or hosted platform. Current
evaluation checks observable grounding and tool signals; it does not prove
semantic correctness or perform adversarial reasoning stress tests. Routing
needs persisted, measured model profiles and is not yet connected to planner
dispatch.
Memory decisions are policy helpers and proposals; a persistent memory store,
retrieval path, retention job, and domain isolation are still needed. Tool
validation now wraps the existing Sanity Context MCP execution path, but
multi-step dependencies and verified approval for effectful integrations still
need to be connected. Query evaluation is returned to the caller; it is not yet
stored as a durable run record.

## Gap analysis against the enterprise specification

The detailed requirement-by-requirement tracker, including the expanded
workflow, runtime, ecosystem, observability, compliance, and tenant requirements,
is the [blueprint coverage document](NUERA-QUICKSILVER-SPEC-COVERAGE.md).

The labels below describe repository evidence today; they are not product
readiness claims.

| Specification area | Repository evidence | Gap and dependency | Status |
|---|---|---|---|
| Cognitive evaluation | Deterministic signals score supplied grounding, tool failures, uncertainty, and plan length; NQC returns scores and safety outcomes | Semantic correctness, adversarial reasoning evaluation, calibrated baselines, and persisted evaluation records are absent | Partial foundation |
| Safety and governance | Existing Sanity decision lifecycle now requires a server-verified configured human supervisor for decision actions, stores policy snapshot and action fingerprints, and records execution outcomes; workflow tool dispatch remains blocked in web live runs | Replace interim single-token identity with authenticated sessions/SSO and RBAC; add durable external-tool approval records and end-to-end authorization | Partial foundation |
| Agents and orchestration | Versioned manifests gate planner, reviewer, and query calls; workflow DAG contract and in-process runner support branch evaluation | Remaining agent family is not implemented; no bounded concurrent scheduler, durable jobs, cancellation propagation for every provider, queue/backpressure, or dead-letter processing | Partial foundation |
| Workflow builder | Browser-based graph editor, branch validation, JSON import/export, local autosave, preview, retry/timeout fields | No drag-and-drop canvas, shared drafts, review/publish lifecycle, deployed workflow versions, or persistent execution history | Partial foundation |
| Routing optimization | Deterministic route-selection and profile-update helpers exist | No measured/persisted model profiles, route decision history, or connection to actual planner selection | Not operational |
| Memory and learning | Memory-write governance proposal and retention metadata helpers | No tenant/domain-scoped persistent store, retrieval, provenance lifecycle, deletion, feedback loop, or validated improvement evidence | Not operational |
| Tool/plugin ecosystem | Versioned in-process tool contracts validate the current Sanity MCP path | No persistent catalog, general plugin install/permission system, hosted tool runtime, marketplace, or externally verifiable approvals | Partial foundation |
| SDK and developer experience | Internal TypeScript client and Python client/CLI cover validate, preview, and gated read-only run | No stable/published API, Go SDK, agent creation API, docs portal, or compatibility guarantees | Partial foundation |
| Hosted runtime and triggers | Durable run records, journaled store, governed priority queue (idempotency, backpressure, per-tenant limits, leases, retries with rate-limit hints, cancellation, dead letters, audited redrive) and a worker in `@quicksilver/kernel/runtime` | Multi-host transactional store, trigger adapters (webhook/cron/events), isolated execution, auth on queue operations, metrics | Partial foundation |
| Identity, tenancy, and secrets | Deployment environment variables and Sanity tokens | No authentication, RBAC, tenant isolation, credentials vault/rotation, or secret-access audit trail; required before public live execution | Not built |
| Monitoring and audit | Existing decision/process history in Sanity; live workflow response contains an in-memory step trace | No durable workflow run records, structured platform logs, metrics, traces, model/cost dashboards, or alerting | Partial foundation |
| Enterprise deployment and extensions | Separate Studio schemas are prepared; canonical docs and roadmap are separated from challenge history | Dedicated Sanity project ID and Context MCP endpoints are pending; compliance packs, identity-provider integration, team collaboration, and governed extension releases are absent | Blocked / not built |
| Domain kernels | Task labels and shared kernel contracts provide extension points | Repo, hydraulic, compliance, security, and finance domain rules, evidence sources, and domain-specific evaluation are not implemented | Not built |

### Recommended closure order

1. **Local workflow authoring:** a graph map and handler retry/timeout controls
   are now present in the editor. Next, add regression coverage for layout,
   invalid graphs, and execution settings before calling this slice complete.
2. **Unlock the separate content environment:** configure the new Sanity
   project ID and Context MCP endpoints, then deploy the already-separated
   Studio schemas there. This is a hard dependency for shared workflow and
   durable audit content that uses Sanity.
3. **Build secure workflow identity and persistence:** authentication, tenant
   scoping, RBAC, versioned workflow storage, approvals, secrets handling, and
   durable run records must precede customer-facing execution.
4. **Operationalize cognitive governance:** persist evaluation, routing, and
   memory evidence; connect measured routing profiles; validate closed-loop
   changes against regression scenarios before they can update policy.
5. **Add runtime infrastructure:** isolated workers, bounded concurrency,
   durable queues, cancellation, event/cron/webhook triggers, rate-limit
   controls, retries, and dead-letter handling under the authenticated gates.
6. **Expand the ecosystem:** stabilize API contracts, publish SDKs, build
   agent/tool creation and extension review, then add team collaboration,
   monitoring dashboards, compliance packs, and domain kernels.

## Platform feature status

| Platform capability | Current state |
|---|---|
| Workflow execution | Drafts autosave locally; safe preview is available; opt-in live path supports read-only query-agent nodes through NQC evaluation. Bounded request-local concurrency for independent low/moderate agent steps, agent-handler retries, and abortable handler timeouts are supported; tools are blocked in the live route and never auto-retried. Shared storage/hosted execution/run history remain unbuilt |
| Agent runtime | Planner, reviewer, and query calls use registered versioned manifests; still request-scoped Next.js execution with no isolated hosted worker pool or job queue |
| Tools and integrations | Versioned per-request tool registry wired to Sanity Context MCP; no persistent plugin catalog or marketplace |
| Developer experience | Internal TypeScript SDK plus dependency-free Python SDK and `qs` CLI for workflow validation, safe preview, and opt-in read-only runs; neither is published as a stable API. No Go SDK or agent creation API |
| Identity and secrets | Environment credentials and Sanity token; no RBAC, team tenancy, or credential vault |
| Monitoring | Decision log and process history; no metrics, traces, or operations dashboard |
| Triggers and resilience | Queue with backpressure, retries, cancellation, and a dead-letter queue exists in the kernel runtime; triggers are typed on run records but no webhook/cron/event adapter feeds the queue yet |
| Collaboration and release | Git/process versions exist; no team workspace, approval roles, or workflow deployment pipeline |

## Build sequence

### 1. Finish the governance path

- Route every external tool invocation, including future non-Sanity providers,
  through the NQC validator and require verified supervisor approval for
  effectful calls.
- Add explicit supervisor approval for side effects, merges, deployments,
  configuration changes, and policy or routing updates.
- Persist approval and execution events with actor, policy version, request ID,
  and outcome in the existing audit trail.
- Decision-plan approval now extends the existing Sanity decision and process
  history: a server-verified human supervisor approves the exact action bound
  to the policy document revisions; execution rechecks that binding and
  appends its outcome. This remains an interim single-supervisor credential,
  not a general external-tool approval service.
- Add evaluated multi-step scenarios, contradiction checks, and correction
  retries with bounded attempts and clear stop conditions.

### 2. Make routing and memory operational

- Collect per-model cost, latency, task quality, failure, and rate-limit
  outcomes; persist versioned profiles and route decisions.
- Feed measured profiles into the new route selector and use its fallbacks in
  the actual agent runtime.
- Add a tenant- and domain-scoped memory store with retention, provenance,
  access policy, approval, and deletion support.
- Store failure exemplars only after the memory governor approves them; use
  retrieved memories as evidence with provenance, never as authority.

### 3. Add governed orchestration

- Extend the planner, reviewer, and query manifests with versioned capabilities,
  tool schemas, and execution permissions for the full Nuera Quicksilver Agents
  family.
- Connect the in-process graph runner to an orchestration runtime with
  concurrency limits, retries, timeouts, cancellation, backpressure, and
  dead-letter handling.
- Add event, webhook, and scheduled triggers. Keep every resulting action
  behind the NQC decision gate.
- Promote the existing process definition into a visual workflow builder while
  retaining the deterministic process engine as the runtime authority.

### 4. Build the developer and platform layer

- Stabilize and publish the existing TypeScript and Python SDKs, then add Go;
  evolve the `qs` CLI and versioned plugin/tool contracts alongside the API.
- Add hosted agent and tool execution with isolated jobs and resource limits.
- Add agent/workflow creation UI, versioned deployments, team collaboration,
  and a reviewed extension catalog.
- Add centralized monitoring for runs, decisions, tool calls, model usage,
  latency, costs, failures, and traces.

### 5. Meet enterprise deployment requirements

- Implement authentication, RBAC, tenant isolation, managed credentials,
  secrets rotation, and auditable administrative actions before shared hosted
  execution.
- Add policy packs, retention controls, exportable audit evidence, compliance
  reporting, and identity-provider integration.
- Add domain kernels for repo, hydraulic, and compliance work behind shared NQC
  safety and audit contracts.

### 6. Close the platform ecosystem gap

- Harden and publish versioned JavaScript and Python SDKs, then add Go, a stable
  agent creation API, and broader CLI workflows.
- Provide a workflow/automation graph UI backed by the existing deterministic
  process engine, with branching, parallel nodes, triggers, and versioned
  releases.
- Build an isolated hosted runtime with queues, cancellation, retries,
  backpressure, rate-limit controls, and dead-letter handling.
- Add team workspaces, collaboration, RBAC, tenant isolation, and an audited
  secrets vault before opening hosted execution to customers.
- Add logs, metrics, traces, performance dashboards, and a governed extension
  catalog for tools, agents, and domain kernels.

## Completion standard

Do not describe a capability as complete until it is connected to its runtime
path, its decisions are auditable, failure behavior is defined, and the existing
kernel/agent regression suites cover the new behavior. Product comparisons and
enterprise readiness claims require evidence from implemented features and
operational validation, not this roadmap alone.

## Sanity and documentation boundary

The original Quicksilver Sanity Challenge environment (`d280bqjc` /
`production`) contains the tested baseline and historical challenge material.
The dedicated Nuera Quicksilver project (`f87t11g1`) now exists, its
`production` dataset is private, and local app/Studio IDs point to it. Do not
deploy schemas or seed data until the new project-scoped server token and
Context MCP endpoints are configured.

Keep challenge writeups as historical/reference material. Canonical cognitive
and platform docs now have separate homes under `docs/nqc/` and
`docs/platform/`, linked from `docs/README.md`. Avoid rewriting historical
claims as current product capabilities.
