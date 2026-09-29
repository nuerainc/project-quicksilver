# Parity tests: the release gate for 0.9.0 and 1.0.0

This document turns the product's parity gate into a list of pass/fail
requirements, each with the evidence that exists for it today. It is the
"pass/fail test for each baseline item" that the
[product definition](../NUERA-QUICKSILVER-PRODUCT.md) (goal 8) asks for. The
statuses reflect the repository on 2026-09-28, with every credential-free
regression suite passing: 610/610 tests and all TypeScript checks. The focused
M7 acceptance suites independently pass 89/89 tests; see [M7 release
evidence](m7-release-evidence.md).

A requirement is not complete until it meets the roadmap's completion
standard: connected to its runtime path, auditable, with defined failure
behavior, and covered by the regression suites. Tests alone are not the
1.0.0 bar; operational evidence is.

## 1. The parity gate

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
| P-007 | Workflow graphs are validated as data: acyclic, data-only conditions, mandatory evaluation for agents, approval for side-effect tools. | automated test | `workflows.test.ts` "Graph: cycles are rejected until a bounded-loop node exists", "Condition: validator rejects code, unsupported paths, and malformed values", "Graph: governance config — agents need evaluation + id, side-effect tools need evaluation + approval" | covered | |
| P-008 | The single-tenant host runs a configured workflow end to end under NQC evaluation and records the evaluation. | automated test | `packages/host/src/host.test.ts` "an operator starts a configured workflow; the worker runs it under NQC evaluation and records it" | covered | |
| P-009 | The host drains in-flight runs on `SIGTERM` (up to 60 s) and aborts on a second signal. | automated test | `runtime.test.ts` "Worker: start/stop polls in the background and shuts down gracefully" covers the worker | partial | The signal handling in `packages/host/src/main.ts` has no test |
| P-010 | Host startup fails closed on an invalid config: inline secrets, trigger identities with extra roles, bad schedules, workflows outside the execution policy. | automated test | `packages/host/src/config.test.ts` "secrets can only be references, never inline values", "trigger identities must hold only the trigger role", "schedules, workflows and the execution policy are validated at startup" | covered | |
| P-011 | Tool steps never dispatch on the host. | automated test | `host.test.ts` "tool steps are blocked on the host and never dispatched" | covered | Effectful executors are P-095 |
| P-012 | The tool registry refuses invalid or unsafe manifests, and a side-effect tool runs only after evaluation and verified approval. | automated test | `packages/kernel/src/nqc/nqc.test.ts` "ToolRegistry: invalid, duplicate, and unsafe manifests are refused", "ToolRegistry: approval ids are ignored for tools that do not need them and verified for those that do"; `workflows.test.ts` "Runtime: side-effect tools are evaluated and approved before execution, in that order" | covered | |
| P-013 | Agent calls run under a registered identity, a supported task, and an NQC evaluation of the result. | automated test | `packages/agent/src/contracts.test.ts` "a governed run rejects a task the worker does not implement", "a governed run with a stub worker returns an NQC evaluation"; `nqc.test.ts` "AgentRegistry: built-ins register and dispatch is limited by task and impact" | covered | |
| P-014 | The host runs always-on at a public HTTPS address with a Postgres run store, and `/healthz`, `/readyz` and `/api/whoami` answer from outside. | operational evidence | [always-on hosting](always-on-hosting.md); `deploy/render.yaml`, `deploy/docker-compose.public.yml` | needs operational evidence | Not deployed; waits on the entity decision and payment accounts, and on the threat model's P0 actions |
| P-015 | The legacy challenge project and its Context MCP endpoints are refused by every component. | automated test | `packages/host/src/sanity-stores.test.ts` "the legacy challenge project is refused by every Sanity store and by the env config"; `contracts.test.ts` "the paused challenge project's Context MCP endpoints and knowledge base are refused" | partial | The web app's `getDedicatedSanityProjectId` has no test |
| P-016 | What-if estimates are deterministic for a seed, state their assumptions and sample size, and write nothing. | automated test | `packages/kernel/src/simulation/simulation.test.ts` "simulateCash is deterministic given a seed, and reports percentiles, reserve and ruin odds per step"; `packages/host/src/whatif.test.ts` "scenarios and experiment odds; nothing is written" | covered | |

### A2. Foundation: product section 7 baseline

| ID | Requirement | Verified by | Existing evidence | Status | Notes |
|---|---|---|---|---|---|
| P-017 | Agent runtime and models: several providers with bring-your-own keys, named agents with their own model, memory, skills and routines, and project context files. | automated test | `packages/agent/src/models.test.ts` "Mode: azure credentials select azure mode, and win over direct provider keys", "Cloud and local providers also produce spec v3 models (Claude/Ollama used to be v1)"; the agent manifest registry | partial | Providers and keys: covered. Built-in tools are read-only Sanity queries only. Per-agent memory, skills and routines, and project context files: missing |
| P-018 | Memory: persistent memory across sessions, agent-curated memory, full-text recall with summarization, and a model of user preferences. | automated test | `nqc.test.ts` "Memory: the persistence callback runs only for governed writes"; Aura's intent profile and verdict learner (`packages/aura/src/profile-v2.test.ts`, `learn.test.ts`) | partial | Operator memory (M8 part 2, `operator.test.ts` "memory: …"): session archive with full-text recall, agent-curated notes, user profile with provenance and approval. Summarization of recalled runs: not yet |
| P-019 | Skills: skills created from solved problems, reusable workflow templates, portable skills on an open standard. | automated test | Playbooks and workflow graphs are reusable templates (`packages/kernel/src/playbooks/playbook.test.ts` "the Onboard playbook is valid content") | partial | Skills on the SKILL.md standard, agent-written skills held for review, outcome scores: `packages/operator/src/skills.ts` (`operator.test.ts` "skills: …", M8 part 3). Needs operational evidence (skills written and reused in real runs) |
| P-020 | Automation: scheduled jobs described in natural language, unattended agents, delivery to any channel. | automated test | P-006 (cron); P-008 (unattended worker); `packages/operator/src/automations.ts` (`automations.test.ts`, M8 part 5): plain-language schedules, time zones, channel delivery, costs, self-pausing | partial | Triggers on business metrics and events: missing. Operational evidence (automations running for weeks): missing |
| P-021 | Delegation: isolated subagents, scripted pipelines, batch runs. | automated test | `workflows.test.ts` "Runtime: independent agents run concurrently up to the limit and all results reach the output" | partial | Pipelines and bounded batches exist. No isolation per subagent. Departments managed by unit economics: missing |
| P-022 | Channels: messaging platforms, email, SMS and voice with one memory across channels; customer-facing channels pass WAES review. | automated test, operational evidence | `packages/operator/src/channels` (`channels.test.ts`, M8 part 4): Telegram, Slack, Discord, SMS and email adapters; pairing, allowlists, one memory per person, approvals in the chat | partial | More platforms (WhatsApp, Signal, Teams…), voice, customer-facing channels with WAES review, and operational evidence: missing |
| P-023 | Compute: an always-on workspace, sandboxed backends, desktop and remote machine control; an isolated workspace per venture and client. | operational evidence | Sandboxed backends: `packages/operator` local and Docker sandboxes, `operator.test.ts` "sandbox: …", "docker sandbox: …" (M8 part 1); hosting templates (P-014) | partial | Always-on workspace, remote and desktop control, per-venture workspaces: M8 |
| P-024 | Web and browser: search, deep research, browser automation including logged-in sites. | — | — | missing | |
| P-025 | Media: image, video, speech, transcription, diagrams, image understanding. | — | — | missing | |
| P-026 | Hosting: sites, apps, services, custom domains and version history; experiment pages created and torn down per experiment. | — | — | missing | The host templates host Quicksilver itself, not experiment pages |
| P-027 | Commerce: payments, products, prices, payment links and orders, feeding the finance layer. | — | The money ledger records money that already moved (P-078) | missing | Nothing takes or makes payments |
| P-028 | Integrations: MCP client and server, an app catalog, office and productivity tools; Onboard connectors write `OBSERVED` values. | automated test | MCP server: `packages/host/src/mcp-tasks.test.ts` "MCP tool calls return the same results as the HTTP API"; MCP client: the Sanity Context MCP path (`contracts.test.ts`); CSV connector: P-083 | partial | App catalog and office tools: missing. Live connectors: P-088 |
| P-029 | Governance and security: command approval, sandboxing, behavior rules, per-agent permissions, no training on user data. | automated test, manual check | Approval and per-agent permissions: P-030 to P-037; behavior rules: policies (P-034) | partial | Command approval and sandboxing now in `packages/operator` (`operator.test.ts` "policy: …", "gate: …", "loop: approvals …"). "No training on user data" is a model-provider term to confirm (manual check, founder decision) |
| P-030 | Interfaces: desktop, CLI, cloud, API with streaming, open-source option; one intent entry point that selects mode and autonomy depth. | automated test | CLI (P-117), HTTP API (host tests), the console, the intent entry point (P-053) | partial | No desktop app; no streaming API; the repository carries an MIT license |
| P-031 | Research tooling: batch runs and trajectory export for training; experiment logs used as priors for Genesis. | — | Decision export (`npm run onboard -- decisions --export json`) is not a trajectory export | missing | |

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
| P-039 | A supervisor approval in the web app is bound to the exact action and policy revisions, and execution refuses on any change. | automated test | Code: `apps/web/lib/nqc-approval.ts` `decisionActionFingerprint`; `apps/web/app/api/decisions/[id]/execute/route.ts` | partial | No test for any web route. Execute is unauthenticated (threat model F-2). The approver does not echo the fingerprint (threat model B-3) |
| P-040 | A task approval is bound to hashes of the stored request and kernel decision, and a changed task does not run. | automated test | `packages/host/src/tasks.test.ts` "a request or decision changed after approval is refused, not run", "an approved task runs at act-with-approval, bound to the approval; a client token still never approves" | covered | |
| P-041 | NQC evaluation escalates weak or high-impact results and can only tighten a decision. | automated test | `nqc.test.ts` "NQC: high impact, high risk, tool failure, or low score escalate", "Upstream escalation: never loosens a block and ignores an ALLOW upstream" | covered | |
| P-042 | Every agent step's evaluation is stored as an `evaluationRecord`, and the response reports whether the write succeeded. | automated test | `nqc.test.ts` "Evaluation record: captures scores and safety decision without private reasoning"; `host.test.ts` "an operator starts a configured workflow; the worker runs it under NQC evaluation and records it" | partial | The web app's `persistEvaluations` has no test |
| P-043 | Spend risk is measured against the budget that is left. | automated test | `packages/kernel/src/playbooks/economics.test.ts` "spend risk is measured against what is left" | covered | |
| P-044 | A customer-facing action is hard-blocked without a passing review of its exact content by someone other than the proposer. | automated test | `economics.test.ts` "WAES gate: customer-facing actions are hard-blocked without a passing review of the exact content"; `packages/host/src/genesis-reviews.test.ts` "the gate: a manual pass unlocks the exact text only when the run allows it, and never for the reviewer as proposer" | covered | The gate is covered; the WAES evaluator is P-045 |
| P-045 | WAES runs as a service and produces the reviews the gate requires. | — | Manual founder reviews stand in, labeled as such | missing | `waesManualReviewAllowed` stays on until this exists |
| P-046 | Every task, from every channel, goes through one intake: RBAC, rate limit, validation, boundaries, then `authorize()`. | automated test | `tasks.test.ts` "the three kernel outcomes through the real authorize(): refused, awaiting-approval, queued", "webhooks: a signed delivery becomes a task through the same intake; the payload cannot pick the capability", "the CLI uses the same intake: a founder submits, lists and denies" | covered | |
| P-047 | The MCP task server gives the same results as the HTTP API and has no approving tool. | automated test | `mcp-tasks.test.ts` "the tools: five, none approves, and each says the kernel decides and a human approves in the console", "MCP tool calls return the same results as the HTTP API" | covered | |
| P-048 | The seed policies carry structured effects and fail closed on unknown exposure. | automated test | `apps/studio/seed/policies.test.ts` "Budget 3 requires approval above $50,000 and fails closed when exposure is unknown", "every live seed policy has a structured effect, so live decisions use the resolver" | covered | Threat model T-40: the planner can report an exposure of 0 |
| P-049 | Company-model queries are parameterized and fetch everything version and scope resolution need. | automated test | `packages/kernel/src/model-document.test.ts` "Queries are parameterized and project the M7 fields", "End to end from documents: ancestor-scope policy, lineage sibling, requirements and the snapshot ids" | covered | |
| P-050 | Model routing uses measured profiles and feeds the actual dispatch. | automated test | `nqc.test.ts` "Routing: the best measured model wins and others become ordered fallbacks" | partial | The selector is tested; it is not connected to dispatch and has no measured profiles |
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
| P-071 | The running playbooks spawn, fund, shrink and retire departments through kernel proposals. | — | — | missing | Product section 5.4 |
| P-072 | A business agent family (research, offer, content, outreach, sales, fulfillment, finance) exists, each defined by a manifest. | — | Only the planner, reviewer, query, intent and shadow agents | missing | |
| P-073 | Bounded loops run inside workflow graphs with iteration and time budgets. | — | Cycles are refused; loops run at the process level | missing | |

### E. Genesis mode

| ID | Requirement | Verified by | Existing evidence | Status | Notes |
|---|---|---|---|---|---|
| P-074 | The Genesis playbook and the $500, 30-day run config are valid. | automated test | `economics.test.ts` "the shipped Genesis playbook and $500 run config are valid" | covered | |
| P-075 | The run cannot start without an approved entity and the payment accounts in the vault. | automated test | `economics.test.ts` "the run cannot start without an approved entity and payment accounts in the vault"; `packages/host/src/genesis-api.test.ts` "blockers are listed and refuse a start" | covered | |
| P-076 | A human starts each experiment with fixed thresholds; kill applies on its own; scale waits for a human. | automated test | `economics.test.ts` "experiments: a human starts them, thresholds are pinned, kill applies on its own, scale needs a human"; `genesis-api.test.ts` "kill applies automatically, as the kernel", "scale waits for a human decision" | covered | `decide` is not bound to the verdict the founder saw (threat model T-53) |
| P-077 | Spend outside the rules is refused; above $10, above risk 2 or outside an experiment, the founder decides; nothing is executed. | automated test | `economics.test.ts` "spend decisions: small experiment spend runs, larger spend asks the founder, prohibited or over-cap is refused"; `genesis-api.test.ts` "money: rejected spends 422, founder decisions 409 until confirmed, and nothing is executed" | covered | Daily cap $50 in `deploy/genesis/genesis-500.json` |
| P-078 | Every ledger entry has a source, compute counts as capital, tampering is detected, and a broken chain stops recording. | automated test | `economics.test.ts` "the money ledger: compute is capital, entries need sources, tampering is detected"; `genesis-api.test.ts` "the ledger is verified on read, and a broken chain stops further recording"; `sanity-stores.test.ts` "money ledger: an entry edited behind the store's back fails verification on load" | covered | |
| P-079 | Every recorded dollar is traceable to its source **and** to the spend decision and who confirmed it. | automated test | Source and `recordedBy` are stored | partial | The spend decision and the founder's confirmation are not stored in the entry (threat model B-4) |
| P-080 | Manual founder reviews are bound to the exact text, labeled manual, counted apart from WAES, and made only by a human. | automated test | `genesis-reviews.test.ts` "a manual review is bound to the exact text, marked manual, and made only by a human"; `genesis-api.test.ts` "reviews: only a human provider records a manual founder review, with the caller as reviewer; GET lists them apart from WAES" | covered | |
| P-081 | **Operational:** the $500, 30-day digital-only run completes, and every dollar is traceable. | operational evidence | [Genesis run](genesis-run.md) | needs operational evidence | Criteria in section 5.1. Blocked on the entity path, payment accounts and always-on hosting (P-014) |

### F. Onboard mode

| ID | Requirement | Verified by | Existing evidence | Status | Notes |
|---|---|---|---|---|---|
| P-082 | The Onboard playbook is valid, and a failed back-test loops back to the interview. | automated test | `playbook.test.ts` "the Onboard playbook is valid content", "a failed back-test loops back to the interview" | covered | |
| P-083 | The CSV ledger connector reads common exports, reports unreadable rows, and refuses AMP-looking sources. | automated test | `packages/aura/src/onboard.test.ts` "the CSV ledger connector reads common exports into transactions and observations", "debit/credit exports work too, and unreadable rows are reported, not guessed", "AMP boundary: patent-looking sources are refused" | covered | |
| P-084 | Observations enter the graph as `OBSERVED` through the governed updater and never touch stated values. | automated test | `onboard.test.ts` "observations enter the graph as OBSERVED, through the governed updater, without touching stated values" | covered | |
| P-085 | The back-test passes a stable business and fails erratic revenue or too little history. | automated test | `onboard.test.ts` "back-test: a stable seasonal business passes; forecasts only use earlier months", "back-test: erratic revenue fails with reasons; too little history is not a pass" | covered | |
| P-086 | The shadow-stage agent's proposals keep only citations from the graph. | automated test | `packages/agent/src/shadow-agent.test.ts` "proposals keep only citations that exist in the graph; uncited proposals are dropped"; `shadow-api.test.ts` "the shadow-stage agent proposes; departments it was not asked about are refused" | covered | |
| P-087 | A department is ready for hand-over only with enough judged recommendations, enough agreement and no bad outcomes. | automated test | `shadow.test.ts` "a department with enough agreement and no bad outcomes is ready for hand-over; others say why not"; `simulation.test.ts` "a bad outcome recorded before the rules are met delays hand-over" | covered | Thresholds: 20 judged, 80% agreement |
| P-088 | Live connectors (bookkeeping, payments, CRM, email) fill the graph with `OBSERVED` values. | — | — | missing | Need the founder's credentials in the vault |
| P-089 | **Operational:** the Onboard pilot on Nuera meets the hand-over criteria for at least one department. | operational evidence | [Onboard pilot](onboard-pilot.md) | needs operational evidence | Criteria in section 5.2. Planned Jan–Feb 2027 |

### G. Operate mode

| ID | Requirement | Verified by | Existing evidence | Status | Notes |
|---|---|---|---|---|---|
| P-090 | Effective autonomy is min(the provider's grant, the shadow evidence); evidence never raises it. | automated test | `packages/kernel/src/playbooks/operate.test.ts` "autonomy: shadow evidence caps act-within-limits at act-with-approval", "autonomy: the grant is the ceiling; evidence never raises it"; `packages/host/src/operate.test.ts` "status: effective autonomy is min(grant, shadow evidence)" | covered | |
| P-091 | The reinvestment plan always needs the founder; plans are append-only and periods never overlap. | automated test | `operate.test.ts` (kernel) "approving a plan is the founder's, and periods never overlap"; `operate.test.ts` (host) "plan and approve-plan: a proposal, then the founder's append-only approval", "store: plans are append-only and written atomically with mode 0600" | covered | |
| P-092 | The surplus split tops up the reserve first and caps the experiment pool. | automated test | `operate.test.ts` (kernel) "reinvestment: surplus is revenue minus spend and compute, net of refunds; reserve is topped up first", "reinvestment: the experiment pool is capped by maxExperimentUsd; amounts are in cents" | covered | |
| P-093 | Operate experiments stay inside the approved pool and the cap; business spend always needs the founder. | automated test | `operate.test.ts` (kernel) "experiments: bounded by the approved pool and by maxExperimentUsd", "spend: experiment spend is refused over the pool; business spend always needs the founder" | covered | |
| P-094 | A task runs on its own only at `act-within-limits`, or after a human approves at `act-with-approval` or above. | automated test | `tasks.test.ts` "recommendation only unless the department acts within limits; then the existing run queue carries it out", "an approved task stays queued for a human below act-with-approval, or with no workflow" | covered | |
| P-095 | Effectful executors exist behind the kernel and approval. | — | Host workflows are read-only | missing | Required before Operate can act beyond reading |
| P-096 | **Operational:** at least one full Operate period on Nuera with an approved plan, every action inside its department's effective autonomy, and every dollar traced. | operational evidence | [Operate](operate.md) | needs operational evidence | Criteria in section 5.3. Starts after the Onboard pilot and the Genesis run |

### S. Security

| ID | Requirement | Verified by | Existing evidence | Status | Notes |
|---|---|---|---|---|---|
| P-097 | Every host `/api` route refuses a missing or invalid token (401) and a principal without the permission (403). | automated test | `host-routes.test.ts` "route table (A-9): every route refuses a request without credentials (401) and a principal without its permission (403)", "route table (A-9): the public and any-principal routes are exactly the reviewed lists, each with a reason" (walks the route table `routes.ts`, which `dispatch()` matches first) | covered | Threat model A-9 |
| P-098 | Every state-changing web route authenticates its caller. | automated test | `app-routes.test.ts` "web API routes (A-3, A-9): every handler refuses no credential (401), an unknown token (401) and a principal without its permission (403)" (enumerates `app/api/**/route.ts` on disk), "cross-site check (A-3, T-30): state-changing API requests must be JSON and same-origin" | covered | Threat model A-3 |
| P-099 | Webhook deliveries cannot be replayed, including with a substituted delivery id. | automated test | `triggers.test.ts` "Webhook: a replayed signature without a delivery id is refused", "Webhook: a sender retry of the same delivery returns the same run" | partial | Threat model F-1 |
| P-100 | No API returns a secret value, and no log line contains a credential. | automated test | `host.test.ts` "secrets: admins write, values are never returned, rotation keeps the old secret during grace", "schedules and webhooks are listed without secrets"; `packages/host/src/observability.test.ts` "secrets are redacted by key, by credential shape, and by registered value" | partial | Model and Sanity keys are not registered for redaction; the web app does not redact (threat model B-8) |
| P-101 | Every write and model-calling route is rate-limited per principal. | automated test | `host-routes.test.ts` "rate limits (A-5): write routes are limited per principal with 429 and Retry-After; reads are not", "rate limits (A-5): webhook deliveries are limited per endpoint, before the signature is checked"; `app-routes.test.ts` "web rate limits (A-5): the route handlers apply them (plan: model; decision action: write)"; `tasks.test.ts` "rate limit: a per-client token bucket, with consistent JSON errors" | covered | In memory: per host process, and per serverless instance for the web app (threat model A-5) |
| P-102 | The secrets vault encrypts at rest, enforces RBAC, rotates with a grace period and fails closed. | automated test | `packages/host/src/vault.test.ts` (all six tests); `host.test.ts` "vault-backed webhook secrets rotate through the API without a restart" | covered | |
| P-103 | Append-only records refuse rewrites through every code path (tasks, reviews, ledgers, shadow verdicts, plans). | automated test | `tasks.test.ts` "the file store is append-only, atomic and private"; `genesis-reviews.test.ts` "append-only: a taken reviewId with different content is a conflict; an identical record is a no-op"; `sanity-stores.test.ts` "recommendations are append-only, and a racing writer loses on the revision check"; `store.test.ts` "two writers racing for the same entry: the second is refused, never overwrites" | covered | Against the code paths only; see the threat model, check 5, for a local attacker |
| P-104 | AMP patent material and writes to frozen Forkling are refused before the kernel. | automated test | `tasks.test.ts` "boundaries: AMP patent material and writes to frozen Forkling are refused before the kernel"; `onboard.test.ts` "AMP boundary: patent-looking sources are refused" | covered | |
| P-105 | Injected instructions in task text change neither permissions nor status. | automated test | `tasks.test.ts` "injection text in the objective or inputs changes neither permissions nor status" | covered | |
| P-106 | The host serves exactly one tenant and refuses foreign principals. | automated test | `host.test.ts` "the host serves exactly one tenant" | covered | |
| P-107 | Multi-tenant hosting keeps tenants isolated. | automated test | — | missing | Roadmap: before 0.9.0 |
| P-108 | People sign in through SSO/OIDC with sessions. | automated test | — | missing | Roadmap: before 0.9.0 |
| P-109 | No high-severity advisory is in a runtime dependency path, and every advisory has a recorded decision. | manual check | [Threat model, section 7](threat-model.md#7-dependency-advisories-npm-audit-2026-09-27) | partial | Host runtime: none. Web: `undici` through the unused `ai@5`, `postcss` through `next`. Studio tooling: several |
| P-110 | The threat model's P0 actions are closed before any hosting or public exposure. | manual check | [Threat model, section 8](threat-model.md#8-prioritized-actions) | missing | 10 P0 actions open |

### O. Observability

| ID | Requirement | Verified by | Existing evidence | Status | Notes |
|---|---|---|---|---|---|
| P-111 | Logs are one JSON object per line, with levels and bindings. | automated test | `observability.test.ts` "logs are one JSON object per line with bindings and levels", "redact handles cycles and depth" | covered | |
| P-112 | Metrics render in Prometheus format with bounded labels and need `audit:read` unless configured public. | automated test | `observability.test.ts` "metrics render Prometheus text with escaped labels, histograms and collectors"; `host.test.ts` "metrics need audit:read unless configured public", "signed webhooks start runs; bad signatures are refused and counted" | covered | |
| P-113 | Access decisions are kept in a durable audit store. | automated test | `identity.test.ts` "RBAC: every decision reaches the audit sink, and a failing sink changes nothing" (the sink, not a durable store) | missing | Today the sink writes to logs |
| P-114 | Traces, dashboards and alerts cover runs, decisions, tool calls, model usage and cost. | — | — | missing | |

### X. Developer experience

| ID | Requirement | Verified by | Existing evidence | Status | Notes |
|---|---|---|---|---|---|
| P-115 | The TypeScript SDK validates, previews and runs workflows, refuses plain HTTP off localhost, and checks response shapes. | automated test | Code: `packages/sdk/src/index.ts`; [TypeScript SDK](sdk-typescript.md) | partial | No test found |
| P-116 | The Python SDK and `qs` CLI do the same without dependencies. | automated test | Code: `packages/sdk-python`; [Python SDK](sdk-python.md) | partial | No test found |
| P-117 | The operator CLIs (host, onboard, genesis, operate, tasks, whatif) use the same rules as the API. | automated test | `tasks.test.ts` "the CLI uses the same intake: a founder submits, lists and denies"; `whatif.test.ts` "cash: prints an estimate with seed, runs and history size, deterministically; refuses without history"; `genesis-reviews.test.ts` "input parsing and the CLI text argument (a file when it exists, else the text itself)"; `packages/host/src/operate.test.ts` "plan and approve-plan: a proposal, then the founder's append-only approval"; `genesis-api.test.ts` "the file store uses the CLI layout: <dir>/<runId>/{experiments,ledger,run}.json" | partial | The onboard and genesis CLIs' own command parsing has no direct test |
| P-118 | The API has a declared, versioned, stable contract. | manual check | — | missing | The product promises stability only at 1.0.0 |
| P-119 | A Go SDK and an agent creation API exist. | — | — | missing | Roadmap build sequence, step 4 |
| P-120 | The workflow editor's graph map has a layout regression test. | automated test | — | missing | Noted in the spec coverage's build order |
| P-121 | The live decision loop (plan, approve, execute, observe, roll back) passes against `f87t11g1`. | operational evidence | `apps/studio/scripts/e2e-live.ts` (`npm run e2e:live`), `apps/studio/scripts/smoke-test.ts` | needs operational evidence | Scripts exist; record a dated pass with each release candidate |

## 4. Every test file, mapped

Each test file maps to at least one requirement.

| Test file | Tests | Requirements |
|---|---|---|
| `apps/studio/seed/policies.test.ts` | 4 | P-048 |
| `packages/agent/src/choice-prompts.test.ts` | 7 | P-059 |
| `packages/agent/src/contracts.test.ts` | 7 | P-013, P-015, P-057 |
| `packages/agent/src/decision-predictor.test.ts` | 2 | P-063 |
| `packages/agent/src/models.test.ts` | 10 | P-017 |
| `packages/agent/src/schemas.test.ts` | 1 | P-013 (strict structured output) |
| `packages/agent/src/shadow-agent.test.ts` | 2 | P-086 |
| `packages/aura/src/aura.test.ts` | 14 | P-052, P-053, P-054, P-057, P-064 |
| `packages/aura/src/decisions.test.ts` | 6 | P-061 |
| `packages/aura/src/dimension-score.test.ts` | 3 | P-060 |
| `packages/aura/src/impact-v3.test.ts` | 2 | P-059 |
| `packages/aura/src/learn.test.ts` | 8 | P-058 |
| `packages/aura/src/ledger.test.ts` | 13 | P-055, P-056 |
| `packages/aura/src/onboard.test.ts` | 7 | P-083, P-084, P-085, P-104 |
| `packages/aura/src/predict-v2.test.ts` | 9 | P-059 |
| `packages/aura/src/predict.test.ts` | 4 | P-059 |
| `packages/aura/src/principles.test.ts` | 4 | P-056 |
| `packages/aura/src/profile-v2.test.ts` | 13 | P-018, P-060 |
| `packages/aura/src/profile.test.ts` | 6 | P-060 |
| `packages/aura/src/questions.test.ts` | 1 | P-062, P-066 |
| `packages/aura/src/rank-learn.test.ts` | 3 | P-062 |
| `packages/aura/src/sealed.test.ts` | 4 | P-058 |
| `packages/aura/src/store.test.ts` | 6 | P-055, P-103 |
| `packages/host/src/config.test.ts` | 7 | P-010 |
| `packages/host/src/decisions-api.test.ts` | 3 | P-061, P-097 |
| `packages/host/src/genesis-api.test.ts` | 10 | P-075, P-076, P-077, P-078, P-080, P-097, P-117 |
| `packages/host/src/genesis-reviews.test.ts` | 5 | P-044, P-080, P-103, P-117 |
| `packages/host/src/host.test.ts` | 12 | P-008, P-011, P-097, P-100, P-102, P-106, P-112 |
| `packages/host/src/intent-api.test.ts` | 4 | P-053, P-055, P-097 |
| `packages/host/src/mcp-tasks.test.ts` | 4 | P-028, P-047 |
| `packages/host/src/observability.test.ts` | 5 | P-100, P-111, P-112 |
| `packages/host/src/operate.test.ts` | 3 | P-090, P-091, P-117 |
| `packages/host/src/sanity-stores.test.ts` | 12 | P-015, P-078, P-103 |
| `packages/host/src/shadow-api.test.ts` | 5 | P-058, P-070, P-086 |
| `packages/host/src/tasks.test.ts` | 18 | P-040, P-046, P-094, P-097, P-101, P-103, P-104, P-105, P-117 |
| `packages/host/src/vault.test.ts` | 6 | P-102 |
| `packages/host/src/whatif.test.ts` | 4 | P-016, P-117 |
| `packages/kernel/src/authority.test.ts` | 16 | P-034, P-035 |
| `packages/kernel/src/capability-graph.test.ts` | 17 | P-036 |
| `packages/kernel/src/identity/identity.test.ts` | 16 | P-032, P-033, P-113 |
| `packages/kernel/src/identity/separation.test.ts` | 7 | P-037 |
| `packages/kernel/src/kernel.test.ts` | 16 | P-034 |
| `packages/kernel/src/model-document.test.ts` | 6 | P-049 |
| `packages/kernel/src/nqc/nqc.test.ts` | 35 | P-012, P-013, P-018, P-033, P-041, P-042, P-050, P-051 |
| `packages/kernel/src/playbooks/economics.test.ts` | 9 | P-043, P-044, P-074, P-075, P-076, P-077, P-078 |
| `packages/kernel/src/playbooks/operate.test.ts` | 14 | P-090, P-091, P-092, P-093 |
| `packages/kernel/src/playbooks/playbook.test.ts` | 8 | P-019, P-067, P-068, P-069, P-082 |
| `packages/kernel/src/playbooks/shadow.test.ts` | 3 | P-070, P-087 |
| `packages/kernel/src/policy-versioning.test.ts` | 24 | P-035 |
| `packages/kernel/src/process.test.ts` | 23 | P-038 |
| `packages/kernel/src/runtime/runtime.test.ts` | 26 | P-001, P-003, P-004, P-005, P-009 |
| `packages/kernel/src/runtime/store-contract.test.ts` | 7 | P-002 |
| `packages/kernel/src/simulation/simulation.test.ts` | 10 | P-016, P-087 |
| `packages/kernel/src/triggers/triggers.test.ts` | 20 | P-006, P-099 |
| `packages/kernel/src/workflows/workflows.test.ts` | 37 | P-005, P-007, P-012, P-021 |

Code with no test file: `apps/web` (every route), `packages/sdk`,
`packages/sdk-python`, the host's `main.ts` wiring and signal handling, and the
`onboard`, `genesis` and `operate` CLIs' argument parsing.

## 5. Operational-evidence criteria per mode

These are the numbers already fixed in the pilot, run and product documents.
They are the pass/fail line for the operational rows.

### 5.1 Genesis (P-081)

| Criterion | Pass when | Source |
|---|---|---|
| The run happens | An approved entity exists, the payment accounts are in the host vault, and the host is always on | [Genesis run](genesis-run.md), `genesisBlockers()` |
| Budget and duration | Capital used (compute included) stays within $500 over 30 days; digital only | `deploy/genesis/genesis-500.json` |
| Spend rules held | No recorded spend in a prohibited or unlisted category; none over the $50 daily cap or an experiment's budget; every spend above $10, above risk 2 or outside an experiment carries the founder's confirmation | `decideSpend`; B-4 in the threat model for recording the confirmation |
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
| covered | 69 |
| partial | 22 |
| missing | 22 |
| needs operational evidence | 8 |
| **Total** | **121** |

Of the 22 missing, 7 are product section 7 baseline domains with nothing
built (channels, compute, web and browser, media, hosting, commerce, research
tooling), and 8 of the 22 partials are section 7 domains with only part
built. Of the 8 needing operational evidence, 3 are Aura-ladder rows that do
not gate Quicksilver's releases.

### Shortest path to 0.9.0 (all three modes pass in testing)

1. **Close the security rows that block exposure:** fix threat-model findings
   F-1 to F-3 with tests (P-098, P-099), add the missing auth tests (P-097),
   rate limits (P-101) and redaction (P-100). These are the threat model's P0
   actions (P-110) and are mostly small.
2. **Turn the mode partials into covered:** store the spend decision and
   confirmation in the ledger (P-079), bind `decide` and web approvals to what
   the approver saw (P-039), add web route tests (P-039, P-042, P-015).
3. **Build what the roadmap already commits to before 0.9.0:** SSO/OIDC
   (P-108) and multi-tenant isolation with tests (P-107).
4. **Apply the M8–M9 enterprise decision.** The authoritative enterprise
   specification and [M8–M9 enterprise plan](../M8-M9-ENTERPRISE-PLAN.md) now
   commit all new enterprise capabilities to completion by M9. The exact
   baseline mapping still belongs in `V1-SCOPE.md`, but no enterprise feature
   may be silently labelled post-1.0.0. If a baseline row is excluded, record
   the rationale, owner, replacement behavior, and explicit product-owner
   exception before the 0.9.0 candidate.
5. **Build the mode-critical missing pieces** that remain in scope after step
   4: live connectors (P-088), effectful executors behind approval (P-095),
   WAES as a service (P-045) or an explicit decision to keep manual reviews.

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
