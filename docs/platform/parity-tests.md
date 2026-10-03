# Parity tests: the release gate for 0.9.0 and 1.0.0

This document turns the product's parity gate into a list of pass/fail
requirements, each with the evidence that exists for it today. It is the
"pass/fail test for each baseline item" that the
[product definition](../NUERA-QUICKSILVER-PRODUCT.md) (goal 8) asks for. The
baseline status snapshot is from 2026-09-28; later dated checkpoints below
record subsequent verified changes and evidence.
The original snapshot had every credential-free
regression suite passing: 610/610 tests and all TypeScript checks. The focused
M7 acceptance suites independently pass 89/89 tests; see [M7 release
evidence](m7-release-evidence.md).

Checkpoint verification on 2026-09-29 for P-009, P-015, P-042, P-079, P-099
and P-100 passed 678 tests across kernel, agent, host, Aura and web/security
suites, plus TypeScript checks for eight projects. The separate Operator suite
had 26/34 pass and 8 failures on Windows; review those failures before release.

Checkpoint verification on 2026-09-30 ran all 112 TypeScript test files across
`packages/` and `apps/`: 859 passed, one Windows-only test was skipped, and none
failed. All eight workspace TypeScript checks passed. The specialist chat/web
API regression suite covers 46 cases, including context bounds, BLOCKed-output
exclusion, route authorization, and NQC proposal behavior. P-107 shared-store
isolation tests pass across memory, file, and Postgres adapters. This verifies
code and regression behavior only; it does not close the live deployment,
usability, connector, or provider evidence called out in the rows below.

Checkpoint verification on 2026-09-30: the web regression suite passed 69/69
and web typecheck passed; the latest full Operator suite passed 48/49 with one
Windows environment skip (`taskkill` access denied), and its typecheck passed.
It covers cross-process memory serialization and stale-lock recovery. The host
suite passed 129/129 with host typecheck passing. Operator regression tests are
included in `npm run verify` as of this checkpoint. The Go SDK checks could
not run locally because no Go executable is installed; the duplicate-import
fix still needs CI confirmation.

Checkpoint verification on 2026-09-30: the host regression suite passed
137/137 tests with the department executor and founder CLI path included; host
and Studio TypeScript checks passed. The executor tests use a fake Sanity
client. The live Nuera Sanity write credential is not available in this
environment, so P-071/P-095 production application and the operational rows
remain unverified.

Checkpoint verification on 2026-09-30: all 112 TypeScript test files passed
with 860 passing tests, one Windows-only sandbox process-tree test skipped by
the runner, and zero failures. All eight workspace TypeScript checks passed.
The run includes the P-107 task-store changes: shared memory/file stores keep
task records and idempotency tenant-scoped; Task MCP credentials are partitioned
and concurrent updates preserve both tenants. This is code-level evidence only;
legacy untagged task/client records need reviewed migration, and the host still
serves one tenant per process.

Checkpoint verification on 2026-09-30: all 113 TypeScript test files passed
with 864 passing tests, one Windows-only sandbox process-tree test skipped,
and zero failures; all eight workspace TypeScript checks passed. Four new
OIDC identity-mapping tests are included in the web `seed:test` CI suite. They
verify an explicit issuer/subject allowlist and reject untrusted role/tenant
claims, unknown identities, and cross-tenant mappings. P-108 remains missing:
no login protocol or server-side session existed at this checkpoint.

Checkpoint verification on 2026-09-30: the seven sequential `verify.mjs`
regression groups passed with 865 passing tests and one Windows-only sandbox
test skipped; all eight workspace TypeScript checks passed, and `git diff
--check` passed. CI's test list was compared against all 113 TypeScript test
files; the Sanity project-separation suite had been omitted, so it is now part
of `seed:test` and passes 3/3. OIDC test coverage now verifies token signatures,
issuer, audience/authorized-party, expiry/age, nonce, explicit user mapping,
and tenant separation. This was protocol-helper evidence only at that
checkpoint; see the current P-108 row for subsequent implementation.

Checkpoint verification on 2026-10-01: `npm run verify` passed 873/873 tests
and all TypeScript checks. The run includes the browser OIDC authorization-code
and PKCE flow, durable session store, revocation, and route-guard regressions.
This proves the tested code path, not a live identity-provider deployment or
task-based usability review.

Checkpoint verification on 2026-10-02 extends the P-107 store-level tagging
pattern (previously task records and task-client registries only) to Aura's
intent-graph store and to all three Genesis stores (money ledger, experiments,
content reviews), across their memory, file, and Sanity implementations.
`aura:test` passed 108/108, including a new test proving two tenants' intent
graphs stay isolated in shared memory and file stores even when they pick a
colliding graph id. `host:test` passed 142/142, including a new test proving
two tenants' Genesis money ledgers, experiments, and content reviews stay
isolated across file and Sanity (fake-client) stores even when they pick a
colliding runId, experiment id, or review id. All eight workspace TypeScript
checks passed. `tenantId` is a storage-partition key only (directory nesting,
Sanity document field and query filter, or a Map key) and was never added to
a hash-chained ledger entry's digested content, so no ledger's hash chain
changed shape. Operate was left out of this pass: the host registers no HTTP
routes for it today (it is CLI-only), so there is no live cross-tenant
exposure to close. The host itself still serves one tenant per process; this
is store-level evidence only, not an integrated multi-tenant hosted service.

A requirement is not complete until it meets the roadmap's completion
standard: connected to its runtime path, auditable, with defined failure
behavior, and covered by the regression suites. Tests alone are not the
1.0.0 bar; operational evidence is.

## 1. The parity gate

The product owner selected the literal baseline on 2026-09-29 and confirmed
on 2026-09-30 that every P-001–P-123 requirement is required before 1.0.0.
P-017–P-031 are the platform-baseline subset; P-122 and P-123 are usability
requirements in the same release scope. See [`V1-SCOPE.md`](../V1-SCOPE.md).
This does not mark unimplemented parity rows complete or waive any requirement.

From the product definition (sections 7, 8 and 8.1):

- **Platform baseline parity** is goal 8: "proven by a pass/fail test for each
  baseline item".
- Section 7: the runtime "must provide every baseline capability below before
  version 1.0.0. Because 1.0.0 requires all three modes, the parity gate
  covers the whole baseline."
- **0.9.0** (release candidate): all three modes (Genesis, Onboard, Operate)
  pass the parity gate **in testing**.
- **1.0.0**: all three modes pass the parity gate **with operational
  evidence**: pilot and demo results, not only tests. Because both pilots are
  founder-owned, the 1.0.0 evidence includes the published audit trail.
- The roadmap adds two platform commitments before 0.9.0: SSO and
  multi-tenant hosting.
- Aura's own targets (70% choice agreement and the rest of its charter) are
  **Aura's ladder**, decoupled from Quicksilver's releases (roadmap, "M3
  released as 0.4.0"). They appear below for completeness and do not gate
  0.9.0 or 1.0.0. What gates a department's autonomy is shadow-mode agreement
  on the owner's verdicts and the provider's own hand-over.

### Baseline capabilities named in the product definition (section 7)

| Domain | Baseline | Quicksilver adds |
|---|---|---|
| Agent runtime and models | Multiple providers and bring-your-own keys; broad built-in tools; named agents with their own model, memory, skills and routines; project context files | Role-agnostic agents spawned from the decision graph; cost-aware routing with compute billed as capital |
| Memory | Persistent memory across sessions; agent-curated memory; full-text recall with summarization; a model of user preferences | Provenance-tagged business memory; belief changes linked to the experiment that caused them |
| Skills | Skills created from solved problems; reusable workflow templates; portable skills on an open standard | Skills scored by the outcomes they produce |
| Automation | Scheduled jobs described in natural language; unattended agents; delivery to any channel | Triggers on business metrics and events |
| Delegation | Isolated subagents; scripted pipelines; batch runs | Departments managed by unit economics |
| Channels | 20+ messaging platforms, email, SMS, voice; one memory across channels | Customer-facing channels with WAES review |
| Compute | An always-on cloud workspace; sandboxed backends; desktop and remote machine control | An isolated workspace per venture and per client |
| Web and browser | Search, deep research, browser automation including logged-in sites | Research that becomes hypotheses directly |
| Media | Image, video, speech, transcription, diagrams, image understanding | Experiment assets ranked by conversion |
| Hosting | Sites, apps, services, custom domains, version history | Pages and funnels per experiment, torn down when it ends |
| Commerce | Payments, products, prices, payment links, orders | Full finance layer: ledger, CAC, margin, cash forecast, capital allocation |
| Integrations | MCP client and server; large app catalog; office suites and productivity tools | Onboard connectors that fill the graph with `OBSERVED` values |
| Governance and security | Command approval, sandboxing, behavior rules, per-agent permissions, no training on user data | Action tiers, budget caps, WAES, replayable provenance audit |
| Interfaces | Desktop, CLI, cloud, API with streaming, open-source option | A single intent entry point that selects the mode and autonomy depth |
| Research tooling | Batch runs; trajectory export for training | Experiment logs used as priors for Genesis |

The platform areas the roadmap tracks alongside these (durable runs,
triggers, RBAC, SDKs, observability, the hosted runtime) are in group A and
the security, observability and developer-experience groups below.

## 2. How to read the table

- **Verified by:** *automated test* (a regression suite), *operational
  evidence* (a dated record from a real run or pilot), or *manual check* (a
  person inspects configuration or documents).
- **Status:**
  - **covered**: an automated test proves the requirement as stated.
  - **partial**: some of it is proven, or the code exists without a test, or
    a known defect remains.
  - **missing**: not built, or built with no evidence at all.
  - **needs operational evidence**: the tests pass; the requirement itself is
    about a real run.
- Test names are quoted exactly. File paths are relative to the repository
  root.

## 3. Requirements

### A. Foundation: platform runtime

| ID | Requirement | Verified by | Existing evidence | Status | Notes |
|---|---|---|---|---|---|
| P-001 | Run records and their event logs survive a process restart. | automated test | `packages/kernel/src/runtime/runtime.test.ts` "FileStore: runs and events survive a restart"; "FileStore: a torn final line is dropped; mid-file corruption refuses to open" | covered | |
| P-002 | The memory, file and Postgres run stores all satisfy one store contract, including concurrent claims across processes. | automated test | `packages/kernel/src/runtime/store-contract.test.ts` "[postgres] concurrent claims hand each run to exactly one worker", "[postgres] separate queue instances (other processes) still respect the per-tenant limit" (each also runs as `[memory]` and `[file]`), "Postgres schema: prefixes are validated and applied" | covered | Postgres runs through PGlite in tests; a real Postgres run is part of P-014 |
| P-003 | The queue validates, digests and freezes each graph at admission, deduplicates by idempotency key, and refuses work beyond its backpressure limits. | automated test | `runtime.test.ts` "Queue: enqueue validates, snapshots, freezes, and digests the graph", "Queue: idempotency keys deduplicate per tenant and refuse conflicting reuse", "Queue: global and per-tenant backpressure reject new work instead of growing unbounded" | covered | |
| P-004 | Failed runs retry with backoff, then dead-letter; a run whose tool step dispatched is never retried; redrive needs an actor and a reason. | automated test | `runtime.test.ts` "Queue: failures retry with exponential backoff, then dead-letter when attempts run out", "Queue: a failed run whose tool step was dispatched is dead-lettered, never retried", "Queue: redrive needs a dead letter, an actor, and a reason, and resets the attempt budget" | covered | |
| P-005 | Cancelling a run aborts the in-flight handler and stops at the next step boundary. | automated test | `runtime.test.ts` "Worker: cancellation requested mid-run aborts the handler signal and ends cancelled"; `packages/kernel/src/workflows/workflows.test.ts` "Runtime: a run-level signal cancels at the next step boundary and aborts the in-flight handler" | covered | |
| P-006 | Cron schedules enqueue each slot once across restarts and replicas, catch up only the latest missed slot, and obey RBAC. | automated test | `packages/kernel/src/triggers/triggers.test.ts` "Scheduler: replicas and restarts never duplicate a slot (idempotency key per slot)", "Scheduler: after an outage only the latest missed slot runs, and only inside the catch-up window", "Scheduler: RBAC applies — a schedule without an enqueue-capable principal is refused" | covered | |
| P-007 | Workflow graphs are validated as data: acyclic except for isolated bounded loops, data-only conditions, mandatory evaluation for agents, approval for side-effect tools. | automated test | `workflows.test.ts` "Graph: arbitrary graph back-edges are rejected; repeated work uses an isolated bounded-loop node", "Graph: bounded loops require bounded time, iterations, safe conditions, and a valid isolated body graph", "Condition: validator rejects code, unsupported paths, and malformed values", "Graph: governance config — agents need evaluation + id, side-effect tools need evaluation + approval" | covered | |
| P-008 | The single-tenant host runs a configured workflow end to end under NQC evaluation and records the evaluation. | automated test | `packages/host/src/host.test.ts` "an operator starts a configured workflow; the worker runs it under NQC evaluation and records it" | covered | |
| P-009 | The host drains in-flight runs on `SIGTERM` (up to 60 s) and aborts on a second signal. | automated test | `packages/host/src/shutdown.test.ts` covers graceful exit, second signal, timeout abort and exit failure; `main.ts` wires process signals to the tested coordinator | covered | |
| P-010 | Host startup fails closed on an invalid config: inline secrets, trigger identities with extra roles, bad schedules, workflows outside the execution policy. | automated test | `packages/host/src/config.test.ts` "secrets can only be references, never inline values", "trigger identities must hold only the trigger role", "schedules, workflows and the execution policy are validated at startup" | covered | |
| P-011 | Tool steps never dispatch on the host. | automated test | `host.test.ts` "tool steps are blocked on the host and never dispatched" | covered | Effectful executors are P-095 |
| P-012 | The tool registry refuses invalid or unsafe manifests, and a side-effect tool runs only after evaluation and verified approval. | automated test | `packages/kernel/src/nqc/nqc.test.ts` "ToolRegistry: invalid, duplicate, and unsafe manifests are refused", "ToolRegistry: approval ids are ignored for tools that do not need them and verified for those that do"; `workflows.test.ts` "Runtime: side-effect tools are evaluated and approved before execution, in that order" | covered | |
| P-013 | Agent calls run under a registered identity, a supported task, and an NQC evaluation of the result. | automated test | `packages/agent/src/contracts.test.ts` "a governed run rejects a task the worker does not implement", "a governed run with a stub worker returns an NQC evaluation"; `nqc.test.ts` "AgentRegistry: built-ins register and dispatch is limited by task and impact" | covered | |
| P-014 | The host runs always-on at a public HTTPS address with a Postgres run store, and `/healthz`, `/readyz` and `/api/whoami` answer from outside. | operational evidence | [always-on hosting](always-on-hosting.md); `deploy/render.yaml`, `deploy/docker-compose.public.yml` | needs operational evidence | Not deployed; waits on the entity decision and payment accounts, and on the threat model's P0 actions |
| P-015 | The legacy challenge project and its Context MCP endpoints are refused by every component. | automated test | `packages/host/src/sanity-stores.test.ts`; `packages/agent/src/contracts.test.ts`; `apps/web/lib/sanity-config.test.ts` covers missing, legacy, and dedicated project IDs | covered | |
| P-016 | What-if estimates are deterministic for a seed, state their assumptions and sample size, and write nothing. | automated test | `packages/kernel/src/simulation/simulation.test.ts` "simulateCash is deterministic given a seed, and reports percentiles, reserve and ruin odds per step"; `packages/host/src/whatif.test.ts` "scenarios and experiment odds; nothing is written" | covered | |

### A2. Foundation: product section 7 baseline

| ID | Requirement | Verified by | Existing evidence | Status | Notes |
|---|---|---|---|---|---|
| P-017 | Agent runtime and models: several providers with bring-your-own keys, named agents with their own model, memory, skills and routines, and project context files. | automated test | `packages/agent/src/models.test.ts` "Mode: azure credentials select azure mode, and win over direct provider keys", "Cloud and local providers also produce spec v3 models (Claude/Ollama used to be v1)"; the agent manifest registry | partial | Providers and keys: covered. Built-in tools are read-only Sanity queries only. Per-agent memory, skills and routines, and project context files: missing |
| P-018 | Memory: persistent memory across sessions, agent-curated memory, full-text recall with summarization, and a model of user preferences. | automated test | Operator `operator.test.ts` covers archive search, governed lifecycle, integrity, sensitivity-aware snapshots, feedback, backup/restore, concurrent independent book instances, and ten concurrent writer processes; `setup.test.ts` covers collision-safe identity paths and legacy migration; `operator-cli.test.ts` verifies human-token RBAC, audited allow/deny, backup, restore, feedback, no-overwrite, and tamper refusal | partial | Implemented: exact UTF-8 identity IDs encoded as base64url, automatic migration for simple legacy IDs, manual-review refusal for ambiguous legacy paths, per-person memory books, provenance/content hashes, confidence and expiry, explicit replacement lineage, hash-chained metadata events, cited prompt snapshots, automatic health/financial sensitivity labels excluded by default from agent context, stricter caller labels and explicit retrieval ceilings, credential/ID/card refusal, deletion redaction, retention purge, legal holds, feedback aggregates (one rating per reviewer and version), CLI-mediated export/restore/feedback with `memory:approve` RBAC and hash-chained authorization audit, and local-filesystem process locks for writes to a canonical path. Locks time out after 30 seconds and stale lock directories are reclaimed after ten minutes. Still required: authenticated product memory APIs and source-decision existence validation. Cross-process locking assumes a local filesystem with atomic directory creation; network filesystems and multi-host coordination are not established. Export bundles contain plaintext and their digest is not a signature; hash chains detect altered edits when reopened but a privileged writer can recompute them. |
| P-019 | Skills: skills created from solved problems, reusable workflow templates, portable skills on an open standard. | automated test | Playbooks and workflow graphs are reusable templates (`packages/kernel/src/playbooks/playbook.test.ts` "the Onboard playbook is valid content") | partial | Skills on the SKILL.md standard, agent-written skills held for review, outcome scores: `packages/operator/src/skills.ts` (`operator.test.ts` "skills: …", M8 part 3). Needs operational evidence (skills written and reused in real runs) |
| P-020 | Automation: scheduled jobs described in natural language, unattended agents, delivery to any channel. | automated test | P-006 (cron); P-008 (unattended worker); `packages/operator/src/automations.ts` (`automations.test.ts`, M8 part 5): plain-language schedules, time zones, channel delivery, costs, self-pausing | partial | Triggers on business metrics and events: missing. Operational evidence (automations running for weeks): missing |
| P-021 | Delegation: isolated subagents, scripted pipelines, batch runs. | automated test | `workflows.test.ts` "Runtime: independent agents run concurrently up to the limit and all results reach the output" | partial | Pipelines and bounded batches exist. No isolation per subagent. Departments managed by unit economics: missing |
| P-022 | Channels: messaging platforms, email, SMS and voice with one memory across channels; customer-facing channels pass WAES review. | automated test, operational evidence | `packages/operator/src/channels` (`channels.test.ts`, M8 part 4): Telegram, Slack, Discord, SMS and email adapters; pairing, allowlists, one memory per person, approvals in the chat | partial | More platforms (WhatsApp, Signal, Teams…), voice, customer-facing channels with WAES review, and operational evidence: missing |
| P-023 | Compute: an always-on workspace, sandboxed backends, desktop and remote machine control; an isolated workspace per venture and client. | operational evidence | Sandboxed backends: `packages/operator` local and Docker sandboxes, `operator.test.ts` "sandbox: …", "docker sandbox: …" (M8 part 1); hosting templates (P-014) | partial | Always-on workspace, remote and desktop control, per-venture workspaces: M8 |
| P-024 | Web and browser: search, deep research, browser automation including logged-in sites. | automated test, operational evidence | `packages/operator/src/web-search.ts` Brave public web search provider, read-only `web_search` and bounded multi-query `deep_research` evidence tools; `web-search.test.ts` covers citation normalization/deduplication, query coverage, partial failures, key handling, limits, error redaction, timeout and cancellation | partial | Public web search and bounded evidence gathering are implemented; source-page retrieval, durable research reports and browser automation (especially authenticated browser sessions) remain missing. Live provider evidence needs `BRAVE_SEARCH_API_KEY`. |
| P-025 | Media: image, video, speech, transcription, diagrams, image understanding. | automated test | `packages/host/src/media.test.ts` (input contract for all six kinds, policy, a hash-chained provenance log, moderation on input and output that fails closed, the per-request and total cost caps including simultaneous requests, retention and purge, and the HTTP routes) | partial | A versioned contract (v1) and its controls, with no real provider: until a vendor adapter implements `MediaProvider` and is registered, requests are refused with "no provider". See [media](media.md). Still missing: a real provider for any kind, a Sanity-backed store (file-only), recording media cost into the Genesis ledger automatically (each result carries a suggested entry for a human), a console panel, and live evidence |
| P-026 | Hosting: sites, apps, services, custom domains and version history; experiment pages created and torn down per experiment. | automated test | `packages/host/src/hosting.test.ts` (static-only file lint, digest-pinned immutable releases, append-only history, file and memory stores, the file adapter, and the HTTP chain: human-only publish behind the WAES review gate, rollback, teardown, automatic teardown when an experiment is killed, reconcile) | partial | Static experiment pages only, behind a deploy-adapter interface; the one adapter that ships writes files to a directory and deploys nothing. See [experiment hosting](experiment-hosting.md). Still missing: a real deploy target (Azure is the chosen host; no adapter yet), custom domains, apps and services, a Sanity-backed store (file-only), a console panel, and live evidence |
| P-027 | Commerce: payments, products, prices, payment links and orders, feeding the finance layer. | automated test | `packages/host/src/genesis-payment-webhook.test.ts` "end to end (default): a Stripe-signed delivery through the running host lands in pending; a human confirms it into the ledger", "end to end (autoRecordPaymentWebhooks: true): the delivery is recorded straight into the ledger, once", "mapStripeEvent: …", "sink: concurrent deliveries of the same payment still record it once"; `triggers.test.ts` "Webhook (stripe scheme): …"; `packages/host/src/genesis-commerce.test.ts` (Stripe client with a fake `fetch`, proposals, the human-approval and WAES gates, idempotent retry, test-key-only) | partial | Recording side: a signed Stripe webhook (`payment_intent.succeeded`, paid `checkout.session.completed`) records revenue that already moved into the Genesis ledger, pending a human confirm by default (`autoRecordPaymentWebhooks`), one entry per PaymentIntent. Commerce actions (test mode only, off by default via `commerceMode`): a product, price or payment link is created in Stripe only after a human approves a proposal and any customer-facing text has a passing WAES review of its exact text; the one Stripe write client (`createStripeCommerceClient`) has those three create calls and refuses live keys. Nothing initiates a charge, payout, refund or transfer. Still missing: orders; a live mode; customer refunds (`charge.refunded` is ignored: the ledger has no kind for money returned to a customer); a Sanity-backed pending queue (file-only for v1); live Stripe delivery evidence |
| P-028 | Integrations: MCP client and server, an app catalog, office and productivity tools; Onboard connectors write `OBSERVED` values. | automated test | MCP server: `packages/host/src/mcp-tasks.test.ts` "MCP tool calls return the same results as the HTTP API"; MCP client: the Sanity Context MCP path (`contracts.test.ts`); CSV connector: P-083 | partial | App catalog and office tools: missing. Live connectors: deferred until P-088 closes (sequenced last by product-owner decision) |
| P-029 | Governance and security: command approval, sandboxing, behavior rules, per-agent permissions, no training on user data. | automated test, manual check | Approval and per-agent permissions: P-030 to P-037; behavior rules: policies (P-034) | partial | Command approval and sandboxing now in `packages/operator` (`operator.test.ts` "policy: …", "gate: …", "loop: approvals …"). "No training on user data" is a model-provider term to confirm (manual check, founder decision) |
| P-030 | Interfaces: desktop, CLI, cloud, API with streaming, open-source option; one intent entry point that selects mode and autonomy depth. | automated test | CLI (P-117), HTTP API (host tests), the console and P-053 intent entry point; global chat offers Ask (read-only `/api/query`), Plan (NQC-governed `/api/plan`), and Work (keyword-auto-routed or explicitly selected business specialist via authenticated, rate-limited `/api/agents/run`); Work carries at most six prior turns (8 KB total) as explicitly labeled context, omits BLOCKed outputs, and specialists return evaluated recommendations without effects; `chat-request.test.ts`, `business-agent-context.test.ts`, `agent-chat-widget.test.ts`, `business-agent-request.test.ts`, `app-routes.test.ts` | partial | No desktop app or streaming API. Chat context applies to Work only; chat does not itself approve or execute actions. Proposals are reviewable in existing workspaces |
| P-031 | Research tooling: batch runs and trajectory export for training; experiment logs used as priors for Genesis. | `node --experimental-strip-types --no-warnings --test packages/host/src/genesis-research.test.ts` | `genesis research export` projects decided Genesis experiments into a digest-bound structured trajectory dataset; export is owner-only, requires explicit privacy confirmation, verifies the ledger, omits free text/raw measurements/source refs/transaction details/private reasoning, and excludes undecided experiments | partial | No general batch-run service, tool/output trajectory export, or reviewed import of trajectory priors back into Genesis; the bounded quantitative export is a foundation only |

### B. Layer 1: NQC Kernel

| ID | Requirement | Verified by | Existing evidence | Status | Notes |
|---|---|---|---|---|---|
| P-032 | Access is deny-by-default with hard tenant boundaries. | automated test | `packages/kernel/src/identity/identity.test.ts` "RBAC: deny by default, allow only through a granting role", "RBAC: tenants are hard boundaries, even for supervisors and admins" | covered | |
| P-033 | Agents never hold authority. | automated test | `identity.test.ts` "RBAC: agents never gain authority, even if a role would grant it"; `nqc.test.ts` "AgentRegistry: agents can never hold approval authority" | covered | |
| P-034 | `authorize()` checks capability, policies, evidence and risk; no evidence is a hard block; deny prevails. | automated test | `packages/kernel/src/kernel.test.ts` "Authorize: no evidence at all is a hard block (cannot review what does not exist)", "Authorize: parameter change requires approval (kill-shot demo scenario)"; `packages/kernel/src/authority.test.ts` "Structured: a prevailing deny is a hard block in authorize()" | covered | |
| P-035 | Policy versions, supersession and nested scopes never loosen silently; ambiguity goes to a human. | automated test | `packages/kernel/src/policy-versioning.test.ts` "Versions: two live policies at the top version are not silently picked", "Scopes: a more specific scope can never silently loosen an ancestor (deny → human)", "Cycle: two live candidates superseding each other route to a human, and neither is picked" | covered | |
| P-036 | The capability graph passes restrictions down, never grants, refuses conflicts, and fails closed on an invalid graph. | automated test | `packages/kernel/src/capability-graph.test.ts` "Inheritance never grants: holding the parent does not allow the child, nor the child the parent", "Conflicts: an actor holding both is refused for either; other capabilities are unaffected", "Fail closed: authorize() refuses a capability whose graph is invalid, but not an unrelated one" | covered | |
| P-037 | Separation of duties: no one approves what they requested, proposed or would carry out, except the sole operator with a written justification. | automated test | `packages/kernel/src/identity/separation.test.ts` (all seven tests, for example "Separation: a sole operator may override only with a written justification") | covered | |
| P-038 | The decision lifecycle is content: guards fail closed, human-only transitions refuse agents, illegal jumps are refused. | automated test | `packages/kernel/src/process.test.ts` "Guards: missing facts fail closed and every operator behaves", "Lifecycle: approving needs a human; an agent is refused with a reason", "Lifecycle: illegal jumps are refused (cannot approve a rejected or executed decision)" | covered | |
| P-039 | A supervisor approval in the web app is bound to the exact action and policy revisions, and execution refuses on any change. | automated test | `apps/web/lib/nqc-approval.test.ts` verifies action/risk/policy/approver binding, stale-policy rejection, kernel BLOCK, required approvals and low-impact path; approval requires the exact reviewer-echoed fingerprint, which the console displays and submits; `app-routes.test.ts` verifies missing and malformed fingerprints fail before Sanity access | covered | The action route rechecks live policy revisions and refuses stale reviewer fingerprints; execution route rechecks live policy revisions and current human approver before effects. Sanity-backed end-to-end integration remains in the separate P-121 live loop |
| P-040 | A task approval is bound to hashes of the stored request and kernel decision, and a changed task does not run. | automated test | `packages/host/src/tasks.test.ts` "a request or decision changed after approval is refused, not run", "an approved task runs at act-with-approval, bound to the approval; a client token still never approves" | covered | |
| P-041 | NQC evaluation escalates weak or high-impact results and can only tighten a decision. | automated test | `nqc.test.ts` "NQC: high impact, high risk, tool failure, or low score escalate", "Upstream escalation: never loosens a block and ignores an ALLOW upstream" | covered | |
| P-042 | Every agent step's evaluation is stored as an `evaluationRecord`, and the response reports whether the write succeeded. | automated test | Kernel and host persistence tests plus `apps/web/lib/evaluation-store.test.ts` prove empty, successful, failed, and privacy-safe writes; query and workflow APIs return `audit.persisted` and record IDs | covered | |
| P-043 | Spend risk is measured against the budget that is left. | automated test | `packages/kernel/src/playbooks/economics.test.ts` "spend risk is measured against what is left" | covered | |
| P-044 | A customer-facing action is hard-blocked without a passing review of its exact content by someone other than the proposer. | automated test | `economics.test.ts` "WAES gate: customer-facing actions are hard-blocked without a passing review of the exact content"; `packages/host/src/genesis-reviews.test.ts` "the gate: a manual pass unlocks the exact text only when the run allows it, and never for the reviewer as proposer" | covered | The gate is covered; the WAES evaluator is P-045 |
| P-045 | WAES runs as a service and produces the reviews the gate requires. | `packages/agent/src/waes.test.ts`; `packages/host/src/genesis-api.test.ts` WAES service review cases | Three NQC-governed model evaluations produce one exact-content, append-only, service-attributed WAES review; incomplete results, unavailable providers and malformed requests fail closed without a record | partial | Automated contract and failure-path coverage exists. Live-provider calibration, evidence-quality evaluation and operational evidence remain required before claiming production-grade evaluation. |
| P-046 | Every task, from every channel, goes through one intake: RBAC, rate limit, validation, boundaries, then `authorize()`. | automated test | `tasks.test.ts` "the three kernel outcomes through the real authorize(): refused, awaiting-approval, queued", "webhooks: a signed delivery becomes a task through the same intake; the payload cannot pick the capability", "the CLI uses the same intake: a founder submits, lists and denies" | covered | |
| P-047 | The MCP task server gives the same results as the HTTP API and has no approving tool. | automated test | `mcp-tasks.test.ts` "the tools: five, none approves, and each says the kernel decides and a human approves in the console", "MCP tool calls return the same results as the HTTP API" | covered | |
| P-048 | The seed policies carry structured effects and fail closed on unknown exposure. | automated test | `apps/studio/seed/policies.test.ts` "Budget 3 requires approval above $50,000 and fails closed when exposure is unknown", "every live seed policy has a structured effect, so live decisions use the resolver" | covered | Threat model T-40: the planner can report an exposure of 0 |
| P-049 | Company-model queries are parameterized and fetch everything version and scope resolution need. | automated test | `packages/kernel/src/model-document.test.ts` "Queries are parameterized and project the M7 fields", "End to end from documents: ancestor-scope policy, lineage sibling, requirements and the snapshot ids" | covered | |
| P-050 | Model routing uses measured profiles and feeds the actual dispatch. | automated test | `nqc.test.ts` routing selector tests; `packages/agent/src/models.test.ts` measured-profile planner dispatch, explicit override, fail-closed constraint, and environment validation regressions; `provider-fallback.test.ts` checks transient-only measured alternatives and verifies live planner, company-query, and reviewer calls use that path | partial | Measured profiles feed live planner/query/reviewer dispatch, with ordered eligible fallbacks only for transient provider failures; explicit per-role overrides remain authoritative. Profiles are static process configuration, not learned from outcomes; persistent performance history remains open. |
| P-051 | The reasoning stress harness is deterministic and scores only final answers. | automated test | `nqc.test.ts` "Stress: challenges are deterministic and cycle through all four categories", "Stress: rubrics accept correct final answers and reject traps" | covered | |

### C. Layer 2: Aura (intent)

| ID | Requirement | Verified by | Existing evidence | Status | Notes |
|---|---|---|---|---|---|
| P-052 | Every variable carries provenance; graphs with duplicates, dangling edges or cycles are refused. | automated test | `packages/aura/src/aura.test.ts` "provenance: every tag has its own source rules", "graph validation: duplicates, dangling edges and cycles are refused", "provenance report meets the charter measures on every labeled objective" | covered | Aura charter: 100% tagging, 0 unsupported inferences |
| P-053 | The intent entry point turns an objective into a tagged graph and asks the highest-impact questions. | automated test | `aura.test.ts` "entry point: a genesis objective becomes a valid, fully tagged graph with stated values quoted", "impact scoring is deterministic, explained, and favors uncertain high-stakes unknowns"; `packages/host/src/intent-api.test.ts` "an objective becomes an intent with questions; answers are recorded as the provider's own" | covered | Threat model F-3 concerns who may answer |
| P-054 | Agents may infer but never overwrite a human's stated value or a system constraint. | automated test | `aura.test.ts` "beliefs: agents may infer, but never overwrite what a human stated or a policy sets" | covered | |
| P-055 | The intent ledger enforces provider rules, is tamper-evident, and keeps each decision's context. | automated test | `packages/aura/src/ledger.test.ts` "only providers shape intent; admins set rules only; agents do neither", "the ledger is tamper-evident, and signatures prove who kept it", "decisions keep the weights and rule in force when they were made"; `packages/aura/src/store.test.ts` "a ledger file edited behind Aura's back is refused on load" | covered | Signing is not enabled on the host (threat model B-5) |
| P-056 | Decision principles are the provider's own; admins and agents cannot set them. | automated test | `ledger.test.ts` "decision principles are stated intent: providers set and retire their own; admins and agents cannot"; `packages/aura/src/principles.test.ts` "an admin cannot import principles" | covered | |
| P-057 | The model parser keeps only grounded values and can never grant autonomy. | automated test | `aura.test.ts` "production parser: the model's parse, except it can never grant acting alone"; `contracts.test.ts` "intent parser: values whose quote is not in the objective are dropped" | covered | |
| P-058 | Predictions are recorded before the verdict and scored predict-then-learn. | automated test | `packages/aura/src/sealed.test.ts` "a pending decision resolves into a journal decision only with a valid choice and a reason"; `packages/aura/src/learn.test.ts` "prequential scores each decision before learning from it"; `packages/host/src/shadow-api.test.ts` "only a human judges; verdicts train Aura and predictions are scored before each verdict" | covered | |
| P-059 | Frozen evaluation methods and their data do not change silently. | automated test | `packages/aura/src/predict.test.ts` "the frozen predictor spec is unchanged (edit means a new version, not a silent change)"; `packages/aura/src/predict-v2.test.ts` "the frozen v2 spec is unchanged (edit means a new version, not a silent change)"; `packages/aura/src/impact-v3.test.ts` "the frozen v3 predictions are unchanged (an edit is a new version)"; `packages/agent/src/choice-prompts.test.ts` "the frozen "none" arm prompt and system prompt are unchanged" | covered | |
| P-060 | Intent-profile instruments score consistently and flag contradictions. | automated test | `packages/aura/src/profile.test.ts` "a mirrored pair that disagrees lowers confidence instead of producing a firm number"; `profile-v2.test.ts` "a mirrored pair that disagrees caps that dimension at 3 and lowers consistency"; `packages/aura/src/dimension-score.test.ts` "provider lean is measured against the average option in each scenario" | covered | |
| P-061 | The decision journal is append-only and only humans log decisions. | automated test | `packages/aura/src/decisions.test.ts` "only a human logs a decision", "stores are append-only; the file store survives reloads and refuses duplicate ids"; `packages/host/src/decisions-api.test.ts` "permissions: only humans with intent:provide log; decision:read lists; bad input is refused" | covered | |
| P-062 | Question order learns from answers and dismissals; only a human's actions count. | automated test | `packages/aura/src/questions.test.ts` "feedback records the rank at that moment; dismissed questions leave the queue; only humans count"; `packages/aura/src/rank-learn.test.ts` "dismissing a question pushes it down for later intents of the same kind" | covered | |
| P-063 | The decision predictor's context holds the provider's own material and never the scored set. | automated test | `packages/agent/src/decision-predictor.test.ts` "the founder context has his principles, profile, sets 1 and 2, profile v2 and his journal, never set 3" | covered | |
| P-064 | (Aura ladder) Parsing accuracy is at least 90% on a fresh held-out set. | operational evidence | Aura README: 27/30 (90.0%) on the held-out set, Azure, 2026-09-26; harness `aura.test.ts` "evaluation harness scores the baseline parser and counts parser errors as misses" | needs operational evidence | Met once; the charter asks to confirm on a larger fresh set. Does not gate Quicksilver |
| P-065 | (Aura ladder) Choice agreement is at least 70% and at least 2× chance on a fresh set, method frozen first, predict-then-learn. | operational evidence | Aura README: frozen v1 6/38 (15.8%); blind model 24/38 (63.2%); frozen v2 10/30 (33.3%) | needs operational evidence | **Not met.** Next test: pilot verdicts. Decoupled from Quicksilver releases |
| P-066 | (Aura ladder) Question quality: at least 80% of Aura's top-3 questions are answered rather than dismissed, in real use. | operational evidence | Measured by `questionQuality` (P-062) | needs operational evidence | Measured during the pilot. Does not gate Quicksilver |

### D. Layer 3: playbooks

| ID | Requirement | Verified by | Existing evidence | Status | Notes |
|---|---|---|---|---|---|
| P-067 | A playbook is data only: every step names its capability, thresholds are ordered, stages exist. | automated test | `playbook.test.ts` "validation: every step names its capability; metric thresholds are ordered; stages exist" | covered | |
| P-068 | Publishing a playbook needs a human supervisor who is not the author and pins the content digest; a run refuses changed content. | automated test | `playbook.test.ts` "publishing needs a human supervisor who is not the author, and pins the digest", "a run refuses a playbook whose content changed after it started" | covered | |
| P-069 | Stage transitions advance only when facts allow, with thresholds fixed in advance. | automated test | `playbook.test.ts` "a run needs the required variables, then advances only when facts allow", "metrics are judged against thresholds fixed in advance, in the right direction" | covered | |
| P-070 | Shadow mode never executes, and only a human judges. | automated test | `packages/kernel/src/playbooks/shadow.test.ts` "nothing in shadow mode executes, and only a human judges"; `shadow-api.test.ts` "recommendations are recorded with the kernel verdict and a prediction, and never executed" | covered | |
| P-071 | The running playbooks spawn, fund, shrink and retire departments through kernel proposals. | kernel and Operate CLI regression tests | `department-economics.test.ts` covers all four actions, maintain/no-op cases, owner-pinned thresholds, evidence/sample gates, deterministic capital ceilings, proposal digests and independent founder decisions; `department-executor.test.ts` verifies approved changes and audit records; `packages/host/src/operate.test.ts` exercises proposal persistence and founder approval through `operate departments propose/decide` | partial | The reviewed Sanity executor now applies founder-approved structural/budget metadata changes atomically and records immutable audit evidence. P-071 remains partial: the economics evidence still does not normalize department attribution or independently prove each qualifying accounting period, and live ledger/pilot evidence is outstanding. This does not transfer or disburse funds. |
| P-072 | A business agent family (research, offer, content, outreach, sales, fulfillment, finance) exists, each defined by a manifest. | automated tests | Kernel `BUILT_IN_AGENT_MANIFESTS` plus `packages/agent/src/business-agents.ts`; `business-agents.test.ts` verifies all seven identities, specialty, NQC registration, proposal-only authority, moderate impact ceiling, evaluation requirement, strict bounded output/input schemas, and read-only context usage; web `POST /api/agents/run` integrates registered workers with chat, evaluation persistence, trace metadata, and proposal-only output | covered | These workers produce evaluated proposals; they do not perform the external business actions they recommend. Live provider/MCP credentials and domain integrations remain operational requirements for exercising them against a company. |
| P-073 | Bounded loops run inside workflow graphs with iteration and time budgets. | automated test | `workflows.test.ts` "Graph: bounded loops require bounded time, iterations, safe conditions, and a valid isolated body graph", "Runtime: bounded loop carries state across iterations and records an inspectable trace", "Runtime: bounded loop fails closed when its condition still requests work at the iteration limit", "Runtime: bounded loop enforces its wall-clock budget and aborts the running iteration", "Runtime: caller cancellation aborts an active bounded-loop iteration and stays cancelled", "Runtime: every bounded-loop side-effect iteration repeats kernel authorization before dispatch"; `workflow-page-usability.test.ts` "workflow editor provides bounded-loop authoring with validated non-recursive body graphs" | covered | Isolated loop body is a validated DAG; nested loops are rejected. Each iteration repeats normal evaluator, approval, and signed authorization gates. Runtime remains in-process; hosted queue execution and operational evidence are separate requirements. |

### E. Genesis mode

| ID | Requirement | Verified by | Existing evidence | Status | Notes |
|---|---|---|---|---|---|
| P-074 | The Genesis playbook and the $500, 30-day run config are valid. | automated test | `economics.test.ts` "the shipped Genesis playbook and $500 run config are valid" | covered | |
| P-075 | The run cannot start without an approved entity and the payment accounts in the vault. | automated test | `economics.test.ts` "the run cannot start without an approved entity and payment accounts in the vault"; `packages/host/src/genesis-api.test.ts` "blockers are listed and refuse a start" | covered | |
| P-076 | A human starts each experiment with fixed thresholds; kill applies on its own; scale waits for a human. | automated test | `economics.test.ts` "experiments: a human starts them, thresholds are pinned, kill applies on its own, scale needs a human"; `genesis-api.test.ts` "kill applies automatically, as the kernel", "scale waits for a human decision" | covered | `decide` is not bound to the verdict the founder saw (threat model T-53) |
| P-077 | Spend outside the rules is refused; above $10, above risk 2 or outside an experiment, the founder decides; nothing is executed. | automated test | `economics.test.ts` "spend decisions: small experiment spend runs, larger spend asks the founder, prohibited or over-cap is refused"; `genesis-api.test.ts` "money: rejected spends 422, founder decisions 409 until confirmed, and nothing is executed" | covered | Daily cap $50 in `deploy/genesis/genesis-500.json` |
| P-078 | Every ledger entry has a source, compute counts as capital, tampering is detected, and a broken chain stops recording. | automated test | `economics.test.ts` "the money ledger: compute is capital, entries need sources, tampering is detected"; `genesis-api.test.ts` "the ledger is verified on read, and a broken chain stops further recording"; `sanity-stores.test.ts` "money ledger: an entry edited behind the store's back fails verification on load" | covered | |
| P-079 | Every recorded dollar is traceable to its source **and** to the spend decision and who confirmed it. | automated test | Hash-chained `spendAuthorization` stores decision id, kernel recommendation, risk, reasons, confirmer and confirmation time on spend/compute entries; API and CLI attach it; file and Sanity stores preserve it. `economics.test.ts`, `genesis-api.test.ts`, `sanity-stores.test.ts` | covered | Existing ledger rows created before this field remain verifiable; new spend/compute entries require the authorization record. |
| P-080 | Manual founder reviews are bound to the exact text, labeled manual, counted apart from WAES, and made only by a human. | automated test | `genesis-reviews.test.ts` "a manual review is bound to the exact text, marked manual, and made only by a human"; `genesis-api.test.ts` "reviews: only a human provider records a manual founder review, with the caller as reviewer; GET lists them apart from WAES" | covered | |
| P-081 | **Operational:** a configured Genesis run completes within that run's own budget, duration and category rules, and every dollar is traceable. | operational evidence | [Genesis run](genesis-run.md) | needs operational evidence | Criteria in section 5.1. `deploy/genesis/genesis-500.json` ($500, 30 days, digital only) is the out-of-the-box default any run may override; no dollar figure or time window is a product-wide hard ceiling. Blocked on the entity path, payment accounts and always-on hosting (P-014) |

### F. Onboard mode

| ID | Requirement | Verified by | Existing evidence | Status | Notes |
|---|---|---|---|---|---|
| P-082 | The Onboard playbook is valid, and a failed back-test loops back to the interview. | automated test | `playbook.test.ts` "the Onboard playbook is valid content", "a failed back-test loops back to the interview" | covered | |
| P-083 | The CSV ledger connector reads common exports, reports unreadable rows, and refuses AMP-looking sources. | automated test | `packages/aura/src/onboard.test.ts` "the CSV ledger connector reads common exports into transactions and observations", "debit/credit exports work too, and unreadable rows are reported, not guessed", "AMP boundary: patent-looking sources are refused" | covered | |
| P-084 | Observations enter the graph as `OBSERVED` through the governed updater and never touch stated values. | automated test | `onboard.test.ts` "observations enter the graph as OBSERVED, through the governed updater, without touching stated values" | covered | |
| P-085 | The back-test passes a stable business and fails erratic revenue or too little history. | automated test | `onboard.test.ts` "back-test: a stable seasonal business passes; forecasts only use earlier months", "back-test: erratic revenue fails with reasons; too little history is not a pass" | covered | |
| P-086 | The shadow-stage agent's proposals keep only citations from the graph. | automated test | `packages/agent/src/shadow-agent.test.ts` "proposals keep only citations that exist in the graph; uncited proposals are dropped"; `shadow-api.test.ts` "the shadow-stage agent proposes; departments it was not asked about are refused" | covered | |
| P-087 | A department is ready for hand-over only with enough judged recommendations, enough agreement and no bad outcomes. | automated test | `shadow.test.ts` "a department with enough agreement and no bad outcomes is ready for hand-over; others say why not"; `simulation.test.ts` "a bad outcome recorded before the rules are met delays hand-over" | covered | Thresholds: 20 judged, 80% agreement |
| P-088 | Live connectors (bookkeeping, payments, CRM, email) fill the graph with `OBSERVED` values. | automated test | `packages/aura/src/onboard.test.ts` "payments connector: reads charges, refunds, subscriptions and disputes into observations", "CRM connector: parses pipeline, win rate, deal size and sales cycle", "email connector: parses support volume, resolution time, sentiment and categories", "unified live connector pipeline: ingests multiple connector sources into intent graph" | missing | Tests cover CSV/JSON file parsing into OBSERVED graph variables, not live API sync. No provider OAuth/API-key credentials or vault wiring exist yet; file parsing does not satisfy the requirement's "live connectors" language. Sequenced last among remaining 0.9.0 work (see Shortest path, below); P-028 stays partial until this closes. |
| P-089 | **Operational:** the Onboard pilot on Nuera meets the hand-over criteria for at least one department. | operational evidence | [Onboard pilot](onboard-pilot.md) | needs operational evidence | Criteria in section 5.2. Planned Jan–Feb 2027 |

### G. Operate mode

| ID | Requirement | Verified by | Existing evidence | Status | Notes |
|---|---|---|---|---|---|
| P-090 | Effective autonomy is min(the provider's grant, the shadow evidence); evidence never raises it. | automated test | `packages/kernel/src/playbooks/operate.test.ts` "autonomy: shadow evidence caps act-within-limits at act-with-approval", "autonomy: the grant is the ceiling; evidence never raises it"; `packages/host/src/operate.test.ts` "status: effective autonomy is min(grant, shadow evidence)" | covered | |
| P-091 | The reinvestment plan always needs the founder; plans are append-only and periods never overlap. | automated test | `operate.test.ts` (kernel) "approving a plan is the founder's, and periods never overlap"; `operate.test.ts` (host) "plan and approve-plan: a proposal, then the founder's append-only approval", "store: plans are append-only and written atomically with mode 0600" | covered | |
| P-092 | The surplus split tops up the reserve first and caps the experiment pool. | automated test | `operate.test.ts` (kernel) "reinvestment: surplus is revenue minus spend and compute, net of refunds; reserve is topped up first", "reinvestment: the experiment pool is capped by maxExperimentUsd; amounts are in cents" | covered | |
| P-093 | Operate experiments stay inside the approved pool and the cap; business spend always needs the founder. | automated test | `operate.test.ts` (kernel) "experiments: bounded by the approved pool and by maxExperimentUsd", "spend: experiment spend is refused over the pool; business spend always needs the founder" | covered | |
| P-094 | A task runs on its own only at `act-within-limits`, or after a human approves at `act-with-approval` or above. | automated test | `tasks.test.ts` "recommendation only unless the department acts within limits; then the existing run queue carries it out", "an approved task stays queued for a human below act-with-approval, or with no workflow" | covered | |
| P-095 | Effectful executors exist behind the kernel and approval. | host executor regression tests | `packages/host/src/department-executor.test.ts` exercises exact proposal/approval binding, owner-only execution, stale-state refusal, atomic mutation failure, idempotent retry, audit creation, and the public challenge project guard | partial | A dedicated-Sanity executor exists for internal department status/budget metadata only, invoked by the founder-only `operate departments apply` command after rechecking the current approved plan. General workflow/tool executors, API path, dedicated Sanity write credentials, and live operational evidence remain open; no money transfer or external tool action is implemented. |
| P-096 | **Operational:** at least one full Operate period on Nuera with an approved plan, every action inside its department's effective autonomy, and every dollar traced. | operational evidence | [Operate](operate.md) | needs operational evidence | Criteria in section 5.3. Starts after the Onboard pilot and the Genesis run |

### S. Security

| ID | Requirement | Verified by | Existing evidence | Status | Notes |
|---|---|---|---|---|---|
| P-097 | Every host `/api` route refuses a missing or invalid token (401) and a principal without the permission (403). | automated test | `host-routes.test.ts` "route table (A-9): every route refuses a request without credentials (401) and a principal without its permission (403)", "route table (A-9): the public and any-principal routes are exactly the reviewed lists, each with a reason" (walks the route table `routes.ts`, which `dispatch()` matches first) | covered | Threat model A-9 |
| P-098 | Every state-changing web route authenticates its caller. | automated test | `app-routes.test.ts` "web API routes (A-3, A-9): every handler refuses no credential (401), an unknown token (401) and a principal without its permission (403)" (enumerates `app/api/**/route.ts` on disk), "cross-site check (A-3, T-30): state-changing API requests must be JSON and same-origin" | covered | Threat model A-3 |
| P-099 | Webhook deliveries cannot be replayed, including with a substituted delivery id. | automated test | `triggers.test.ts` verifies no-ID replay, changed-ID replay on run and task paths, and idempotent exact retry; replay cache binds each verified signature to its first delivery ID | covered | |
| P-100 | No API returns a secret value, and no log line contains a credential. | automated test | Host redaction tests plus web `safe-log.test.ts`; web API failures return/log only allowlisted error classes, never exception messages | covered | Structured values and expected validation errors remain explicit; unexpected provider/store exception details are withheld. |
| P-101 | Every write and model-calling route is rate-limited per principal. | automated test | `host-routes.test.ts` "rate limits (A-5): write routes are limited per principal with 429 and Retry-After; reads are not", "rate limits (A-5): webhook deliveries are limited per endpoint, before the signature is checked"; `app-routes.test.ts` "web rate limits (A-5): the route handlers apply them (plan: model; decision action: write)"; `tasks.test.ts` "rate limit: a per-client token bucket, with consistent JSON errors" | covered | In memory: per host process, and per serverless instance for the web app (threat model A-5) |
| P-102 | The secrets vault encrypts at rest, enforces RBAC, rotates with a grace period and fails closed. | automated test | `packages/host/src/vault.test.ts` (all six tests); `host.test.ts` "vault-backed webhook secrets rotate through the API without a restart" | covered | |
| P-103 | Append-only records refuse rewrites through every code path (tasks, reviews, ledgers, shadow verdicts, plans). | automated test | `tasks.test.ts` "the file store is append-only, atomic and private"; `genesis-reviews.test.ts` "append-only: a taken reviewId with different content is a conflict; an identical record is a no-op"; `sanity-stores.test.ts` "recommendations are append-only, and a racing writer loses on the revision check"; `store.test.ts` "two writers racing for the same entry: the second is refused, never overwrites" | covered | Against the code paths only; see the threat model, check 5, for a local attacker |
| P-104 | AMP patent material and writes to frozen Forkling are refused before the kernel. | automated test | `tasks.test.ts` "boundaries: AMP patent material and writes to frozen Forkling are refused before the kernel"; `onboard.test.ts` "AMP boundary: patent-looking sources are refused" | covered | |
| P-105 | Injected instructions in task text change neither permissions nor status. | automated test | `tasks.test.ts` "injection text in the objective or inputs changes neither permissions nor status" | covered | |
| P-106 | The host serves exactly one tenant and refuses foreign principals. | automated test | `host.test.ts` "the host serves exactly one tenant" | covered | |
| P-107 | Multi-tenant hosting keeps tenants isolated. | automated test | Kernel ACL and queue tests (`identity.test.ts`, `runtime.test.ts`, `store-contract.test.ts`); the store contract proves tenant-scoped queues cannot enqueue, claim, read, cancel, complete, or redrive another tenant's runs across memory, file, and Postgres adapters. `host.test.ts` verifies each queue is bound to its configured tenant; `vault.test.ts` binds vault state and encryption to one tenant. `tasks.test.ts` runs two tenant-scoped task services against shared memory and file stores, proving record reads, lists, idempotency, and task MCP client authentication/revocation are isolated. `store.test.ts` (Aura) runs two tenant-scoped intent-graph stores against shared memory and file backends, proving `get`/`list` filter by tenant and a colliding graph id in one tenant never surfaces in another's. `sanity-stores.test.ts` runs two tenant-scoped Genesis stores (money ledger, experiments, content reviews) against shared file and Sanity (fake-client) backends, proving loads/lists filter by tenant and a colliding runId, experiment id, or review id in one tenant never surfaces in another's. | partial | Shared run storage, task records, task-client registries, Aura's intent-graph store, and all three Genesis stores now carry tenant boundaries (a storage-partition key only — directory nesting, a Sanity document field and query filter, or a Map key — never added to a hash-chained ledger entry's digested content). The hosted service still serves one tenant per host process; workflow publication/configuration, schedules, principal provisioning, and operational provisioning have not been integrated and tested as one multi-tenant hosted service. Operate has no host HTTP routes today (it is CLI-only), so it carries no live cross-tenant exposure to close. Legacy task/client/intent/Genesis files without a tenant ID remain inaccessible through tenant-scoped APIs until explicitly migrated. |
| P-108 | People sign in through SSO/OIDC with sessions. | automated test, live IdP verification | `oidc-browser-auth.test.ts` covers HTTPS discovery, authorization-code exchange, S256 PKCE, state/nonce/browser binding, secure HttpOnly session cookies, server-side token digests, revocation, current role mapping, and refusal of replay/cross-browser attempts; `oidc-route-guard.test.ts` proves browser sessions use the same RBAC and authorization audit as bearer principals. Routes: `/api/auth/oidc/start`, `/api/auth/oidc/callback`, `/api/auth/session`, `/api/auth/logout`; session records use the dedicated Sanity store. | partial | Protocol and session implementation is present and tested. Live evidence (2026-10-03): Google is the identity provider; on the production site an account that was not on the allowlist was refused and logged by issuer and subject, then after its allowlist row was added the same account signed in and `GET /api/auth/session` returned its principal, tenant and role. Still needed: a user-facing SSO entry/control integrated with the console, and evidence that sessions survive a later deploy. |
| P-109 | No high-severity advisory is in a runtime dependency path, and every advisory has a recorded decision. | manual check | [Threat model, section 7](threat-model.md#7-dependency-advisories-npm-audit-2026-09-27) | partial | Host runtime: none. Web: `undici` through the unused `ai@5`, `postcss` through `next`. Studio tooling: several |
| P-110 | The threat model's P0 actions are closed before any hosting or public exposure. | manual check | [Threat model, section 8](threat-model.md#8-prioritized-actions) | needs operational evidence | Code controls A-1–A-5, A-9, and A-10 are implemented and regression-tested. A-6 (hosting secrets and disk encryption), A-7 (the separate Sanity Viewer/Editor tokens are now created and in use; still open: confirming both are set in every environment, deleting the old combined token, and a Studio access review), and A-8 (AMP isolation/Forkling read-only confirmation) still require founder/operations evidence before hosting or public exposure. |

### O. Observability

| ID | Requirement | Verified by | Existing evidence | Status | Notes |
|---|---|---|---|---|---|
| P-111 | Logs are one JSON object per line, with levels and bindings. | automated test | `observability.test.ts` "logs are one JSON object per line with bindings and levels", "redact handles cycles and depth" | covered | |
| P-112 | Metrics render in Prometheus format with bounded labels and need `audit:read` unless configured public. | automated test | `observability.test.ts` "metrics render Prometheus text with escaped labels, histograms and collectors"; `host.test.ts` "metrics need audit:read unless configured public", "signed webhooks start runs; bad signatures are refused and counted" | covered | |
| P-113 | Access decisions are kept in a durable audit store. | automated test | Web: `authorization-audit-store.test.ts` verifies durable Sanity append-before-action; host/kernel: `authorization-audit.test.ts` and `identity.test.ts` verify fsynced hash-chained replay/tamper detection and fail-closed authorization | covered | Host JSONL integrity assumes durable mounted storage and one writer per path; a privileged operator replacing both log and checkpoint is outside its threat boundary. Not a compliance attestation. |
| P-114 | Traces, dashboards and alerts cover runs, decisions, tool calls, model usage and cost. | automated test | `apps/web/lib/telemetry.test.ts` covers metadata-only query and specialist-agent trace construction, nullable provider usage and measured-rate cost estimates, alert rules and fail-closed persistence; `apps/web/lib/app-routes.test.ts` enumerates and authorizes the trace endpoint; OpenAPI route drift check covers `GET /api/monitoring/traces` | partial | Web query, plan, specialist-agent and read-only workflow paths write tenant-scoped request/model/tool/evaluation/decision spans; `/monitoring/traces` shows a bounded sample and evaluates in-app alerts. Host queue/schedule/webhook traces, external alert delivery, complete history/retention, live-provider evidence, and provider-billed cost reconciliation remain open. Cost is estimated only when an operator supplies measured per-model rates. |

### X. Developer experience

| ID | Requirement | Verified by | Existing evidence | Status | Notes |
|---|---|---|---|---|---|
| P-115 | The TypeScript SDK validates, previews and runs workflows, refuses plain HTTP off localhost, and checks response shapes. | automated test | `packages/sdk/src/index.test.ts` covers HTTPS/loopback policy, request bodies, simulation/read-only response contracts, NQC evaluation shapes, error preservation, and abort signals; `npm run sdk:test`; workspace typecheck | covered | |
| P-116 | The Python SDK and `qs` CLI do the same without dependencies. | automated test | `packages/sdk-python/tests/test_client.py` covers URL policy, typed validation/preview/run results, malformed contracts, HTTP errors, invalid request data, and all three CLI commands; `python -m unittest discover -s packages/sdk-python/tests -v`; `pyproject.toml` has no runtime dependencies | covered | |
| P-117 | The operator CLIs (host, onboard, genesis, operate, tasks, whatif) use the same rules as the API. | automated test | `cli-args.test.ts` covers production flag profiles; `onboard-cli.test.ts` checks CLI-created and CLI-answered intent through the authenticated HTTP API; `genesis-cli.test.ts` checks review writes and reads both ways across CLI and HTTP using `FileGenesisStore`; existing `operate.test.ts`, `whatif.test.ts`, and `tasks.test.ts` exercise real CLI paths and domain services | partial | All five CLI entry points now share the parser. Onboard and Genesis share persisted data with their HTTP APIs; Tasks uses shared `TaskService`, and `tasks list --limit` now matches the API default/bounds. Operate/What-if behavior is covered through CLI tests but not yet compared directly against matching HTTP operations, and authorization/validation parity for every CLI/API path remains to be demonstrated. Host route auth is separately covered by P-097/P-098 |
| P-118 | The API has a declared, versioned, stable contract. | automated test, manual check | `docs/api/openapi.json` (OpenAPI 3.1, version 0.4.0); `apps/web/lib/app-routes.test.ts` asserts route/method drift, operation IDs, write request bodies, and local reference resolution; workflow graph, validation, simulation, and run schemas | partial | Concrete workflow contract coverage was added. Most agent, publication, decision, planning, query, and monitoring operations still use generic placeholder schemas; complete error catalogs, idempotency and revision conflict semantics, pagination guarantees, SDK compatibility, and a stable 1.0.0 promise remain unspecified |
| P-119 | A Go SDK and an agent creation API exist. | Go SDK CI build/vet/test; agent API regression tests | Go workflow client implements validation, safe preview and read-only run; `client_test.go` covers URL policy, HTTP contracts, safe modes, NQC evaluation validation, errors/size limits and cancellation. The authenticated agent draft API is `apps/web/app/api/agents/drafts/route.ts`, backed by the tested catalog lifecycle in `agent-catalog-store.test.ts` and contract tests | partial | Both capabilities now exist; the earlier “agent creation API absent” note was stale. Current Go SDK changes still need `go test`, `go vet` and `go build` evidence: this Windows environment has no Go executable, and the GitHub Actions result for this uncommitted snapshot is not yet available. |
| P-120 | The workflow editor's graph map has a layout regression test. | automated test | `apps/web/lib/workflow-layout.test.ts` "lays out branches and merges deterministically without overlap", "handles an empty draft with finite minimum canvas dimensions"; included in `npm run seed:test` | covered | The editor imports the same tested layout function from `apps/web/lib/workflow-layout.ts` |
| P-121 | The live decision loop (plan, approve, execute, observe, roll back) passes against `f87t11g1`. | operational evidence | `apps/studio/scripts/e2e-live.ts` (`npm run e2e:live`), `apps/studio/scripts/smoke-test.ts` | needs operational evidence | Scripts exist; record a dated pass with each release candidate |

### XI. Interface usability

| ID | Requirement | Verified by | Existing evidence | Status | Notes |
|---|---|---|---|---|---|
| P-122 | The existing Nuera Quicksilver UI is mobile-first, clean and easy to navigate, with responsive layouts and controls that adapt across viewport sizes, aspect ratios and portrait/landscape orientations; all existing capabilities remain accessible. | automated viewport checks, manual usability review | Responsive grouped navigation; business operations dashboard; preserved objective planner at `/planning`; accessible decision, workflow, agent and monitoring workspaces; full-width workflow map auto-fits through `ResizeObserver`; viewports and typography use responsive breakpoints; covered by `responsive-shell.test.ts`, `home-experience.test.ts`, `workspace-pages.test.ts`, and `workflow-page-usability.test.ts` | partial | Run rendered-app checks at representative phone/tablet/desktop widths and portrait/landscape, and manually verify no clipping/overlap, touch targets, and access to every capability. Automated helper/static tests are not a substitute for those checks. |
| P-123 | The platform provides an exceptionally usable end-to-end experience: people can discover the right capability, understand current state and next steps, complete common tasks with clear guidance, and recover from errors without hidden controls or unexplained system behavior. | task-based usability tests, accessibility checks, manual review | Root page is an operating cockpit with authenticated decision, metric, experiment, workflow and separately finance-authorized ledger summaries; quick actions link to the planning console and task workspaces; explicit loading, empty, permission and source-error states; preserved planner at `/planning`; global chat offers read-only Ask and governed Plan modes and links saved proposals to the decision log; decision review progressively discloses evidence and approval basis; covered by `home-experience.test.ts`, `business-dashboard.test.ts`, `agent-chat-widget.test.ts`, `chat-request.test.ts`, `agent-review.test.ts`, `responsive-shell.test.ts`, and `workflow-page-usability.test.ts` | partial | Complete task-based usability sessions and keyboard/screen-reader review, including initial sign-in, chat plan/review, publish/run workflow, recover from authorization/data errors, and supervisor-only finance access. |

## 4. Every test file, mapped

Each test file maps to at least one requirement.

| Test file | Tests | Requirements |
|---|---|---|
| `apps/studio/seed/policies.test.ts` | 4 | P-048 |
| `apps/web/lib/agent-review.test.ts` | 1 | P-123 |
| `apps/web/lib/responsive-shell.test.ts` | 3 | P-122, P-123 |
| `apps/web/lib/nqc-approval.test.ts` | 6 | P-039 |
| `apps/web/lib/telemetry.test.ts` | 6 | P-114 |
| `apps/web/lib/monitoring-traces.test.ts` | 2 | P-114 |
| `apps/web/lib/workflow-layout.test.ts` | 3 | P-120, P-122, P-123 |
| `packages/agent/src/choice-prompts.test.ts` | 7 | P-059 |
| `packages/agent/src/contracts.test.ts` | 7 | P-013, P-015, P-057 |
| `packages/agent/src/decision-predictor.test.ts` | 2 | P-063 |
| `packages/agent/src/models.test.ts` | 15 | P-017, P-050, P-114 |
| `packages/agent/src/schemas.test.ts` | 1 | P-013 (strict structured output) |
| `packages/agent/src/shadow-agent.test.ts` | 2 | P-086 |
| `packages/aura/src/aura.test.ts` | 14 | P-052, P-053, P-054, P-057, P-064 |
| `packages/aura/src/decisions.test.ts` | 6 | P-061 |
| `packages/aura/src/dimension-score.test.ts` | 3 | P-060 |
| `packages/aura/src/impact-v3.test.ts` | 2 | P-059 |
| `packages/aura/src/learn.test.ts` | 8 | P-058 |
| `packages/aura/src/ledger.test.ts` | 13 | P-055, P-056 |
| `packages/aura/src/onboard.test.ts` | 11 | P-083, P-084, P-085, P-104 |
| `packages/aura/src/predict-v2.test.ts` | 9 | P-059 |
| `packages/aura/src/predict.test.ts` | 4 | P-059 |
| `packages/aura/src/principles.test.ts` | 4 | P-056 |
| `packages/aura/src/profile-v2.test.ts` | 13 | P-018, P-060 |
| `packages/aura/src/profile.test.ts` | 6 | P-060 |
| `packages/aura/src/questions.test.ts` | 1 | P-062, P-066 |
| `packages/aura/src/rank-learn.test.ts` | 3 | P-062 |
| `packages/aura/src/sealed.test.ts` | 4 | P-058 |
| `packages/aura/src/store.test.ts` | 6 | P-055, P-103 |
| `packages/host/src/authorization-audit.test.ts` | 2 | P-113 |
| `packages/host/src/config.test.ts` | 7 | P-010 |
| `packages/host/src/cli-args.test.ts` | 4 | P-117 |
| `packages/host/src/decisions-api.test.ts` | 3 | P-061, P-097 |
| `packages/host/src/genesis-api.test.ts` | 10 | P-075, P-076, P-077, P-078, P-080, P-097, P-117 |
| `packages/host/src/genesis-cli.test.ts` | 1 | P-117 |
| `packages/host/src/genesis-research.test.ts` | 4 | P-031 |
| `packages/host/src/genesis-reviews.test.ts` | 5 | P-044, P-080, P-103, P-117 |
| `packages/host/src/host.test.ts` | 12 | P-008, P-011, P-097, P-100, P-102, P-106, P-112 |
| `packages/host/src/intent-api.test.ts` | 4 | P-053, P-055, P-097 |
| `packages/host/src/mcp-tasks.test.ts` | 4 | P-028, P-047 |
| `packages/host/src/observability.test.ts` | 5 | P-100, P-111, P-112 |
| `packages/host/src/operate.test.ts` | 4 | P-071, P-090, P-091, P-117 |
| `packages/host/src/department-executor.test.ts` | 3 | P-071, P-095 |
| `packages/host/src/onboard-cli.test.ts` | 1 | P-117 |
| `packages/host/src/sanity-stores.test.ts` | 12 | P-015, P-078, P-103 |
| `packages/host/src/shadow-api.test.ts` | 5 | P-058, P-070, P-086 |
| `packages/host/src/tasks.test.ts` | 18 | P-040, P-046, P-094, P-097, P-101, P-103, P-104, P-105, P-117 |
| `packages/host/src/vault.test.ts` | 6 | P-102 |
| `packages/host/src/whatif.test.ts` | 4 | P-016, P-117 |
| `packages/sdk-go/client_test.go` | 7 | P-119 |
| `packages/sdk-python/tests/test_client.py` | 7 | P-116 |
| `packages/sdk/src/index.test.ts` | 5 | P-115 |
| `packages/kernel/src/authority.test.ts` | 16 | P-034, P-035 |
| `packages/kernel/src/capability-graph.test.ts` | 17 | P-036 |
| `packages/kernel/src/identity/identity.test.ts` | 16 | P-032, P-033, P-113 |
| `packages/kernel/src/identity/separation.test.ts` | 7 | P-037 |
| `packages/kernel/src/kernel.test.ts` | 16 | P-034 |
| `packages/kernel/src/model-document.test.ts` | 6 | P-049 |
| `packages/kernel/src/nqc/nqc.test.ts` | 35 | P-012, P-013, P-018, P-033, P-041, P-042, P-050, P-051 |
| `packages/kernel/src/playbooks/economics.test.ts` | 9 | P-043, P-044, P-074, P-075, P-076, P-077, P-078 |
| `packages/kernel/src/playbooks/operate.test.ts` | 14 | P-090, P-091, P-092, P-093 |
| `packages/kernel/src/playbooks/department-economics.test.ts` | 6 | P-071 |
| `packages/kernel/src/playbooks/playbook.test.ts` | 8 | P-019, P-067, P-068, P-069, P-082 |
| `packages/kernel/src/playbooks/shadow.test.ts` | 3 | P-070, P-087 |
| `packages/kernel/src/policy-versioning.test.ts` | 24 | P-035 |
| `packages/kernel/src/process.test.ts` | 23 | P-038 |
| `packages/kernel/src/runtime/runtime.test.ts` | 26 | P-001, P-003, P-004, P-005, P-009 |
| `packages/kernel/src/runtime/store-contract.test.ts` | 7 | P-002 |
| `packages/kernel/src/simulation/simulation.test.ts` | 10 | P-016, P-087 |
| `packages/kernel/src/triggers/triggers.test.ts` | 20 | P-006, P-099 |
| `packages/kernel/src/workflows/workflows.test.ts` | 45 | P-005, P-007, P-012, P-021, P-073 |
| `packages/operator/src/operator.test.ts` | 33 | P-018, P-019, P-023, P-029 |
| `packages/operator/src/operator-cli.test.ts` | 1 | P-018 |
| `packages/operator/src/setup.test.ts` | 3 | P-018 |
| `packages/operator/src/web-search.test.ts` | 5 | P-024 |

Direct command-parsing tests now cover Onboard, Genesis, Operate, Tasks and
What-if. Complete CLI/API authorization, validation and persistence parity
evidence remains open for several of these CLIs (P-117).

## 5. Operational-evidence criteria per mode

These are the numbers already fixed in the pilot, run and product documents.
They are the pass/fail line for the operational rows.

### 5.1 Genesis (P-081)

Genesis is reused across many ventures with different budgets, durations and
category scopes, so no single dollar figure or time window below is a
product-wide hard ceiling. `deploy/genesis/genesis-500.json` ($500, 30 days,
digital only, $50 daily cap, $10 autonomous-spend ceiling) is the
out-of-the-box convenience/demo config a run can start from; the criteria
below are written against that default and apply, scaled to whatever budget,
duration and spend limits that run's own config sets.

| Criterion | Pass when | Source |
|---|---|---|
| The run happens | An approved entity exists, the payment accounts are in the host vault, and the host is always on | [Genesis run](genesis-run.md), `genesisBlockers()` |
| Budget and duration | Capital used (compute included) stays within that run's configured budget and duration (the default config: $500 over 30 days; digital only) | `deploy/genesis/genesis-500.json` |
| Spend rules held | No recorded spend in a prohibited or unlisted category; none over that run's configured daily cap or an experiment's budget; every spend above that run's autonomous-spend ceiling, above risk 2 or outside an experiment carries the founder's confirmation | `decideSpend`; B-4 in the threat model for recording the confirmation |
| Every dollar traceable | Every ledger entry has a source; the chain verifies at the end; each entry reconciles to a receipt, provider usage or processor record | `verifyMoneyLedger`; section "What the run reports" |
| Thresholds fixed in advance | Every experiment's kill, hold and scale values were pinned at its start, and every verdict names who applied it | `startExperiment`, `applyEvaluation` |
| Customer-facing text reviewed | Every shipped text has a passing review of its exact digest, with manual founder reviews listed apart from WAES reviews | `reviewSummary` |
| Result judged by process | Return on capital is reported against kill below 0.1, hold at 0.5, scale at 1.0. A loss is a valid result; the pass is that every decision followed the fixed rules | [Genesis run](genesis-run.md) |

### 5.2 Onboard (P-089)

| Criterion | Pass when | Source |
|---|---|---|
| Back-test | 12+ months of history; forecasts over 6+ months with error at most 30% and at least 70% of actuals inside the 80% range | [Onboard pilot](onboard-pilot.md), stage table |
| Shadow agreement per department | At least 20 judged recommendations and at least 80% agreement (modified counts half) | same; `handOver` in `deploy/operate/operate-nuera.json` |
| No bad outcomes | Zero `bad` outcomes on accepted recommendations in a department that graduates | same |
| Hand-over | The founder's own `handover` entry in the intent ledger, verified chain | same |
| Audit completeness | Every observed value names its source; every intent change is in the chained ledger | same, "What the pilot measures" |
| AMP boundary | No AMP material in any connected export while PPA Rev 4.2 is unfiled | same, "Boundaries" |

### 5.3 Operate (P-096)

| Criterion | Pass when | Source |
|---|---|---|
| Autonomy | Every action in the period was within its department's effective autonomy, min(grant, evidence); nothing ran without a grant | [Operate](operate.md) |
| Plan | A reinvestment plan approved by the founder for the period; reserve floor $1,000 topped up first; reinvest 50% of the rest; experiment pool 30% of that, at most $250 | `deploy/operate/operate-nuera.json` |
| Experiments | Every Operate experiment fit in the approved pool; kills applied automatically | same |
| Money | Every dollar traced, as in Genesis | same |
| Human interventions | Every approval and hand-over recorded with who and when | product section 9 |

### 5.4 Aura (its own ladder, not a Quicksilver gate)

| Criterion | Target | Status | Source |
|---|---|---|---|
| Choice agreement | ≥ 70% and ≥ 2× chance on a fresh set, method frozen first, predict-then-learn | Not met (best fresh result 33.3%) | [Aura README](../../packages/aura/README.md#charter-success-criteria-aura-040-and-status) |
| Parsing accuracy | ≥ 90% | Met on the held-out set (27/30); confirm on a larger fresh set | same |
| Provenance tagging | 100% | Enforced by validation | same |
| Unsupported inferences | 0 | Enforced by validation | same |
| Question quality | ≥ 80% of top-3 questions answered rather than dismissed, in real use | Measured from the pilot | same |

The roadmap decoupled these from Quicksilver's releases: Quicksilver's safety
never depended on Aura, and autonomy is gated by shadow-mode agreement and
the provider's own hand-over.

## 6. Summary

### Counts by status

| Status | Count |
|---|---|
| covered | 85 |
| partial | 28 |
| missing | 1 |
| needs operational evidence | 9 |
| **Total** | **123** |

As of 2026-10-01, the matrix has 85 covered, 28 partial, 1 missing, and 9
requirements that need operational evidence. P-026 moved from missing to
partial (2026-10-03): static experiment pages can be staged as immutable
releases, published by a human behind the review gate, and torn down with their
experiment; no real deploy target exists yet. P-025 moved from missing to
partial (2026-10-03): a versioned media contract with moderation, a cost cap,
retention and provenance exists, with no real provider registered. P-027 moved from missing to
partial (2026-10-02): a signed Stripe webhook now records payments that
already happened into the Genesis ledger; nothing initiates a payment, and
products, prices, payment links, orders and customer refunds remain open. P-088 moved from covered to
missing: the existing tests cover CSV/JSON file parsing, not live API sync,
and the product owner has decided it stays missing until real provider
credentials and vault wiring land -- deliberately sequenced as the last
requirement closed before 0.9.0. P-108 moved from missing to partial after
the browser login/session path and route-guard tests were added; a live
Google sign-in passed on 2026-10-03; the SSO entry UI and session-persistence
evidence are still open.
P-039 and P-113 moved to covered with execution-binding regression tests and
durable web/host authorization audit stores. P-115, P-116, and P-120 moved to
covered with SDK contract suites and workflow layout regression coverage.
P-018 now has tests for restart recall, cited memory, supersession history,
tamper detection (including verification before legacy provenance migration),
sensitivity-aware retrieval, sensitive-data refusal, retention redaction, legal
holds, reviewer feedback, and integrity-checked export/restore through the CLI;
CLI operations now require human-token RBAC with audited decisions. Authenticated
product APIs, tenant/domain isolation, and source-decision validation remain
unfinished. P-024 now has tested read-only Brave search and bounded multi-query
evidence gathering; source retrieval, durable reports, logged-in browsing and
live-provider evidence remain open. P-118 now has a versioned
pre-1.0 OpenAPI contract and route/method drift test, but stable 1.0.0
semantics remain unfinished. P-119's agent draft/review/publish API is present;
its former “API absent” gap is corrected, while the local Go toolchain and CI
evidence for the current working tree remain outstanding.
P-088 remains missing: live business connectors. P-025 (media) is partial:
the contract and controls exist, with no real provider.
P-026 (experiment hosting) is partial: the contract, stores and a file adapter
exist, with no real deploy target. P-027 (commerce) is partial: incoming Stripe payments are
recorded, and test-mode products, prices and payment links can be created
after a human approves them, but nothing takes or makes payments. P-031 now has a privacy-reviewed quantitative Genesis experiment
trajectory export but remains partial pending general batch runs, broader
observable workflow trajectories, and a reviewed import into Genesis priors.
Six Quicksilver rows still require operational evidence; three are Aura-ladder rows that do not gate
Quicksilver releases. P-122 and P-123 extend V1.0.0 with responsive interface
and end-to-end usability acceptance criteria.

### Shortest path to 0.9.0 (all three modes pass in testing)

1. **Close the security rows that block exposure:** fix threat-model findings
   F-1 to F-3 with tests (P-098, P-099), add the missing auth tests (P-097),
   rate limits (P-101) and redaction (P-100). These are the threat model's P0
   actions (P-110) and are mostly small.
2. **Turn the remaining mode partials into covered:** store the spend decision
   and confirmation in the ledger (P-079); finish route-level coverage for the
   remaining plan/query contracts (P-042, P-015).
3. **Finish identity and tenant operation:** expose the implemented SSO/OIDC
   flow in the console and verify it against a real IdP (P-108); complete
   integrated multi-tenant isolation across hosted services (P-107).
4. **Apply the M8–M9 enterprise decision.** The authoritative enterprise
   specification and [M8–M9 enterprise plan](../M8-M9-ENTERPRISE-PLAN.md) now
   commit all new enterprise capabilities to completion by M9. The exact
   baseline mapping still belongs in `V1-SCOPE.md`, but no enterprise feature
   may be silently labelled post-1.0.0. If a baseline row is excluded, record
   the rationale, owner, replacement behavior, and explicit product-owner
   exception before the 0.9.0 candidate.
5. **Build the mode-critical missing pieces** that remain in scope after step
   4: effectful executors behind approval (P-095) and complete WAES
   live-provider calibration and evidence-quality evaluation (P-045).
6. **Live connectors (P-088), deliberately last.** The product owner has
   decided this closes after every other P-item above. P-028 (Integrations)
   depends on it and stays partial until P-088 closes -- do not pull P-028
   or P-088 forward ahead of this ordering.

### Shortest path to 1.0.0 (with operational evidence)

1. Everything for 0.9.0.
2. **Onboard pilot** (Jan–Feb 2027) meets section 5.2 for at least one
   department, with the founder's hand-over entry (P-089).
3. **Always-on hosting** deployed after the P0 actions (P-014), then the
   **Genesis run** meets section 5.1 (P-081).
4. **One full Operate period** meets section 5.3 (P-096).
5. **The live decision loop** passes and is recorded (P-121).
6. Publish the audit trail for both founder-owned pilots, as the product
   definition requires.

Aura's targets (section 5.4) keep their own schedule and do not hold up
either release.
