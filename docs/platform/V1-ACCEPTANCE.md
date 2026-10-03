# V1 acceptance map

This document closes the last open item in [Gate 0](../V1-SCOPE.md#gate-0-completion-checklist):
it maps every P-001–P-123 requirement to its automated evidence and, where
required, its operational evidence. It is generated from — and must be kept
in sync with — [the parity register](parity-tests.md), which remains
the authoritative, test-enforced source (`npm run parity:test` checks row
count, status totals, and the published counts against this document's own
source of truth). This map adds nothing not already in the register; it
exists so the acceptance question ("is every in-scope item mapped to
evidence?") has one direct answer instead of requiring a full read of the
register.

**As of 2026-10-02:** 86 covered, 9 needing operational evidence, 28 partial, 0 missing (123 total).

## Automated evidence (every P-001–P-123 row)

Status and automated evidence for every row, as currently published in
[parity-tests.md](parity-tests.md). `—` means no automated test is
claimed for that row at this status.

| ID | Status | Automated evidence |
|---|---|---|
| P-001 | covered | `packages/kernel/src/runtime/runtime.test.ts` "FileStore: runs and events survive a restart"; "FileStore: a torn final line is dropped; mid-file corruption refuses to open" |
| P-002 | covered | `packages/kernel/src/runtime/store-contract.test.ts` "[postgres] concurrent claims hand each run to exactly one worker", "[postgres] separate queue instances (other processes) still respect the per-tenant limit" (each also runs as `[memory]` and `[file]`), "Postgres schema: prefixes are validated and applied" |
| P-003 | covered | `runtime.test.ts` "Queue: enqueue validates, snapshots, freezes, and digests the graph", "Queue: idempotency keys deduplicate per tenant and refuse conflicting reuse", "Queue: global and per-tenant backpressure reject new work instead of growing unbounded" |
| P-004 | covered | `runtime.test.ts` "Queue: failures retry with exponential backoff, then dead-letter when attempts run out", "Queue: a failed run whose tool step was dispatched is dead-lettered, never retried", "Queue: redrive needs a dead letter, an actor, and a reason, and resets the attempt budget" |
| P-005 | covered | `runtime.test.ts` "Worker: cancellation requested mid-run aborts the handler signal and ends cancelled"; `packages/kernel/src/workflows/workflows.test.ts` "Runtime: a run-level signal cancels at the next step boundary and aborts the in-flight handler" |
| P-006 | covered | `packages/kernel/src/triggers/triggers.test.ts` "Scheduler: replicas and restarts never duplicate a slot (idempotency key per slot)", "Scheduler: after an outage only the latest missed slot runs, and only inside the catch-up window", "Scheduler: RBAC applies — a schedule without an enqueue-capable principal is refused" |
| P-007 | covered | `workflows.test.ts` "Graph: arbitrary graph back-edges are rejected; repeated work uses an isolated bounded-loop node", "Graph: bounded loops require bounded time, iterations, safe conditions, and a valid isolated body graph", "Condition: validator rejects code, unsupported paths, and malformed values", "Graph: governance config — agents need evaluation + id, side-effect tools need evaluation + approval" |
| P-008 | covered | `packages/host/src/host.test.ts` "an operator starts a configured workflow; the worker runs it under NQC evaluation and records it" |
| P-009 | covered | `packages/host/src/shutdown.test.ts` covers graceful exit, second signal, timeout abort and exit failure; `main.ts` wires process signals to the tested coordinator |
| P-010 | covered | `packages/host/src/config.test.ts` "secrets can only be references, never inline values", "trigger identities must hold only the trigger role", "schedules, workflows and the execution policy are validated at startup" |
| P-011 | covered | `host.test.ts` "tool steps are blocked on the host and never dispatched" |
| P-012 | covered | `packages/kernel/src/nqc/nqc.test.ts` "ToolRegistry: invalid, duplicate, and unsafe manifests are refused", "ToolRegistry: approval ids are ignored for tools that do not need them and verified for those that do"; `workflows.test.ts` "Runtime: side-effect tools are evaluated and approved before execution, in that order" |
| P-013 | covered | `packages/agent/src/contracts.test.ts` "a governed run rejects a task the worker does not implement", "a governed run with a stub worker returns an NQC evaluation"; `nqc.test.ts` "AgentRegistry: built-ins register and dispatch is limited by task and impact" |
| P-014 | needs operational evidence | [always-on hosting](always-on-hosting.md); `deploy/render.yaml`, `deploy/docker-compose.public.yml` |
| P-015 | covered | `packages/host/src/sanity-stores.test.ts`; `packages/agent/src/contracts.test.ts`; `apps/web/lib/sanity-config.test.ts` covers missing, legacy, and dedicated project IDs |
| P-016 | covered | `packages/kernel/src/simulation/simulation.test.ts` "simulateCash is deterministic given a seed, and reports percentiles, reserve and ruin odds per step"; `packages/host/src/whatif.test.ts` "scenarios and experiment odds; nothing is written" |
| P-017 | partial | `packages/agent/src/models.test.ts` "Mode: azure credentials select azure mode, and win over direct provider keys", "Cloud and local providers also produce spec v3 models (Claude/Ollama used to be v1)"; the agent manifest registry |
| P-018 | partial | Operator `operator.test.ts` covers archive search, governed lifecycle, integrity, sensitivity-aware snapshots, feedback, backup/restore, concurrent independent book instances, and ten concurrent writer processes; `setup.test.ts` covers collision-safe identity paths and legacy migration; `operator-cli.test.ts` verifies human-token RBAC, audited allow/deny, backup, restore, feedback, no-overwrite, and tamper refusal |
| P-019 | partial | Playbooks and workflow graphs are reusable templates (`packages/kernel/src/playbooks/playbook.test.ts` "the Onboard playbook is valid content") |
| P-020 | partial | P-006 (cron); P-008 (unattended worker); `packages/operator/src/automations.ts` (`automations.test.ts`, M8 part 5): plain-language schedules, time zones, channel delivery, costs, self-pausing |
| P-021 | partial | `workflows.test.ts` "Runtime: independent agents run concurrently up to the limit and all results reach the output" |
| P-022 | partial | `packages/operator/src/channels` (`channels.test.ts`, M8 part 4): Telegram, Slack, Discord, SMS and email adapters; pairing, allowlists, one memory per person, approvals in the chat |
| P-023 | partial | Sandboxed backends: `packages/operator` local and Docker sandboxes, `operator.test.ts` "sandbox: …", "docker sandbox: …" (M8 part 1); hosting templates (P-014) |
| P-024 | partial | `packages/operator/src/web-search.ts` Brave public web search provider, read-only `web_search` and bounded multi-query `deep_research` evidence tools; `web-search.test.ts` covers citation normalization/deduplication, query coverage, partial failures, key handling, limits, error redaction, timeout and cancellation |
| P-025 | partial | `packages/host/src/media.test.ts` (versioned contract, moderation that fails closed, per-request and total cost caps, retention and purge, hash-chained provenance, HTTP routes; no real provider registered) |
| P-026 | partial | `packages/host/src/hosting.test.ts` (static-only lint, immutable digest-pinned releases, human-only publish behind the WAES review gate, rollback, teardown, automatic teardown when an experiment ends, reconcile) |
| P-027 | partial | `packages/host/src/genesis-payment-webhook.test.ts` "end to end (default): a Stripe-signed delivery through the running host lands in pending; a human confirms it into the ledger", "end to end (autoRecordPaymentWebhooks: true): the delivery is recorded straight into the ledger, once", "mapStripeEvent: …", "sink: concurrent deliveries of the same payment still record it once"; `triggers.test.ts` "Webhook (stripe scheme): …"; `genesis-commerce.test.ts` (test-mode product/price/payment-link creation behind human approval and the WAES gate) |
| P-028 | partial | MCP server: `packages/host/src/mcp-tasks.test.ts` "MCP tool calls return the same results as the HTTP API"; MCP client: the Sanity Context MCP path (`contracts.test.ts`); CSV connector: P-083 |
| P-029 | partial | Approval and per-agent permissions: P-030 to P-037; behavior rules: policies (P-034) |
| P-030 | partial | CLI (P-117), HTTP API (host tests), the console and P-053 intent entry point; global chat offers Ask (read-only `/api/query`), Plan (NQC-governed `/api/plan`), and Work (keyword-auto-routed or explicitly selected business specialist via authenticated, rate-limited `/api/agents/run`); Work carries at most six prior turns (8 KB total) as explicitly labeled context, omits BLOCKed outputs, and specialists return evaluated recommendations without effects; `chat-request.test.ts`, `business-agent-context.test.ts`, `agent-chat-widget.test.ts`, `business-agent-request.test.ts`, `app-routes.test.ts` |
| P-031 | partial | `genesis research export` projects decided Genesis experiments into a digest-bound structured trajectory dataset; export is owner-only, requires explicit privacy confirmation, verifies the ledger, omits free text/raw measurements/source refs/transaction details/private reasoning, and excludes undecided experiments |
| P-032 | covered | `packages/kernel/src/identity/identity.test.ts` "RBAC: deny by default, allow only through a granting role", "RBAC: tenants are hard boundaries, even for supervisors and admins" |
| P-033 | covered | `identity.test.ts` "RBAC: agents never gain authority, even if a role would grant it"; `nqc.test.ts` "AgentRegistry: agents can never hold approval authority" |
| P-034 | covered | `packages/kernel/src/kernel.test.ts` "Authorize: no evidence at all is a hard block (cannot review what does not exist)", "Authorize: parameter change requires approval (kill-shot demo scenario)"; `packages/kernel/src/authority.test.ts` "Structured: a prevailing deny is a hard block in authorize()" |
| P-035 | covered | `packages/kernel/src/policy-versioning.test.ts` "Versions: two live policies at the top version are not silently picked", "Scopes: a more specific scope can never silently loosen an ancestor (deny → human)", "Cycle: two live candidates superseding each other route to a human, and neither is picked" |
| P-036 | covered | `packages/kernel/src/capability-graph.test.ts` "Inheritance never grants: holding the parent does not allow the child, nor the child the parent", "Conflicts: an actor holding both is refused for either; other capabilities are unaffected", "Fail closed: authorize() refuses a capability whose graph is invalid, but not an unrelated one" |
| P-037 | covered | `packages/kernel/src/identity/separation.test.ts` (all seven tests, for example "Separation: a sole operator may override only with a written justification") |
| P-038 | covered | `packages/kernel/src/process.test.ts` "Guards: missing facts fail closed and every operator behaves", "Lifecycle: approving needs a human; an agent is refused with a reason", "Lifecycle: illegal jumps are refused (cannot approve a rejected or executed decision)" |
| P-039 | covered | `apps/web/lib/nqc-approval.test.ts` verifies action/risk/policy/approver binding, stale-policy rejection, kernel BLOCK, required approvals and low-impact path; approval requires the exact reviewer-echoed fingerprint, which the console displays and submits; `app-routes.test.ts` verifies missing and malformed fingerprints fail before Sanity access |
| P-040 | covered | `packages/host/src/tasks.test.ts` "a request or decision changed after approval is refused, not run", "an approved task runs at act-with-approval, bound to the approval; a client token still never approves" |
| P-041 | covered | `nqc.test.ts` "NQC: high impact, high risk, tool failure, or low score escalate", "Upstream escalation: never loosens a block and ignores an ALLOW upstream" |
| P-042 | covered | Kernel and host persistence tests plus `apps/web/lib/evaluation-store.test.ts` prove empty, successful, failed, and privacy-safe writes; query and workflow APIs return `audit.persisted` and record IDs |
| P-043 | covered | `packages/kernel/src/playbooks/economics.test.ts` "spend risk is measured against what is left" |
| P-044 | covered | `economics.test.ts` "WAES gate: customer-facing actions are hard-blocked without a passing review of the exact content"; `packages/host/src/genesis-reviews.test.ts` "the gate: a manual pass unlocks the exact text only when the run allows it, and never for the reviewer as proposer" |
| P-045 | partial | Three NQC-governed model evaluations produce one exact-content, append-only, service-attributed WAES review; incomplete results, unavailable providers and malformed requests fail closed without a record |
| P-046 | covered | `tasks.test.ts` "the three kernel outcomes through the real authorize(): refused, awaiting-approval, queued", "webhooks: a signed delivery becomes a task through the same intake; the payload cannot pick the capability", "the CLI uses the same intake: a founder submits, lists and denies" |
| P-047 | covered | `mcp-tasks.test.ts` "the tools: five, none approves, and each says the kernel decides and a human approves in the console", "MCP tool calls return the same results as the HTTP API" |
| P-048 | covered | `apps/studio/seed/policies.test.ts` "Budget 3 requires approval above $50,000 and fails closed when exposure is unknown", "every live seed policy has a structured effect, so live decisions use the resolver" |
| P-049 | covered | `packages/kernel/src/model-document.test.ts` "Queries are parameterized and project the M7 fields", "End to end from documents: ancestor-scope policy, lineage sibling, requirements and the snapshot ids" |
| P-050 | partial | `nqc.test.ts` routing selector tests; `packages/agent/src/models.test.ts` measured-profile planner dispatch, explicit override, fail-closed constraint, and environment validation regressions; `provider-fallback.test.ts` checks transient-only measured alternatives and verifies live planner, company-query, and reviewer calls use that path |
| P-051 | covered | `nqc.test.ts` "Stress: challenges are deterministic and cycle through all four categories", "Stress: rubrics accept correct final answers and reject traps" |
| P-052 | covered | `packages/aura/src/aura.test.ts` "provenance: every tag has its own source rules", "graph validation: duplicates, dangling edges and cycles are refused", "provenance report meets the charter measures on every labeled objective" |
| P-053 | covered | `aura.test.ts` "entry point: a genesis objective becomes a valid, fully tagged graph with stated values quoted", "impact scoring is deterministic, explained, and favors uncertain high-stakes unknowns"; `packages/host/src/intent-api.test.ts` "an objective becomes an intent with questions; answers are recorded as the provider's own" |
| P-054 | covered | `aura.test.ts` "beliefs: agents may infer, but never overwrite what a human stated or a policy sets" |
| P-055 | covered | `packages/aura/src/ledger.test.ts` "only providers shape intent; admins set rules only; agents do neither", "the ledger is tamper-evident, and signatures prove who kept it", "decisions keep the weights and rule in force when they were made"; `packages/aura/src/store.test.ts` "a ledger file edited behind Aura's back is refused on load" |
| P-056 | covered | `ledger.test.ts` "decision principles are stated intent: providers set and retire their own; admins and agents cannot"; `packages/aura/src/principles.test.ts` "an admin cannot import principles" |
| P-057 | covered | `aura.test.ts` "production parser: the model's parse, except it can never grant acting alone"; `contracts.test.ts` "intent parser: values whose quote is not in the objective are dropped" |
| P-058 | covered | `packages/aura/src/sealed.test.ts` "a pending decision resolves into a journal decision only with a valid choice and a reason"; `packages/aura/src/learn.test.ts` "prequential scores each decision before learning from it"; `packages/host/src/shadow-api.test.ts` "only a human judges; verdicts train Aura and predictions are scored before each verdict" |
| P-059 | covered | `packages/aura/src/predict.test.ts` "the frozen predictor spec is unchanged (edit means a new version, not a silent change)"; `packages/aura/src/predict-v2.test.ts` "the frozen v2 spec is unchanged (edit means a new version, not a silent change)"; `packages/aura/src/impact-v3.test.ts` "the frozen v3 predictions are unchanged (an edit is a new version)"; `packages/agent/src/choice-prompts.test.ts` "the frozen "none" arm prompt and system prompt are unchanged" |
| P-060 | covered | `packages/aura/src/profile.test.ts` "a mirrored pair that disagrees lowers confidence instead of producing a firm number"; `profile-v2.test.ts` "a mirrored pair that disagrees caps that dimension at 3 and lowers consistency"; `packages/aura/src/dimension-score.test.ts` "provider lean is measured against the average option in each scenario" |
| P-061 | covered | `packages/aura/src/decisions.test.ts` "only a human logs a decision", "stores are append-only; the file store survives reloads and refuses duplicate ids"; `packages/host/src/decisions-api.test.ts` "permissions: only humans with intent:provide log; decision:read lists; bad input is refused" |
| P-062 | covered | `packages/aura/src/questions.test.ts` "feedback records the rank at that moment; dismissed questions leave the queue; only humans count"; `packages/aura/src/rank-learn.test.ts` "dismissing a question pushes it down for later intents of the same kind" |
| P-063 | covered | `packages/agent/src/decision-predictor.test.ts` "the founder context has his principles, profile, sets 1 and 2, profile v2 and his journal, never set 3" |
| P-064 | needs operational evidence | Aura README: 27/30 (90.0%) on the held-out set, Azure, 2026-09-26; harness `aura.test.ts` "evaluation harness scores the baseline parser and counts parser errors as misses" |
| P-065 | needs operational evidence | Aura README: frozen v1 6/38 (15.8%); blind model 24/38 (63.2%); frozen v2 10/30 (33.3%) |
| P-066 | needs operational evidence | Measured by `questionQuality` (P-062) |
| P-067 | covered | `playbook.test.ts` "validation: every step names its capability; metric thresholds are ordered; stages exist" |
| P-068 | covered | `playbook.test.ts` "publishing needs a human supervisor who is not the author, and pins the digest", "a run refuses a playbook whose content changed after it started" |
| P-069 | covered | `playbook.test.ts` "a run needs the required variables, then advances only when facts allow", "metrics are judged against thresholds fixed in advance, in the right direction" |
| P-070 | covered | `packages/kernel/src/playbooks/shadow.test.ts` "nothing in shadow mode executes, and only a human judges"; `shadow-api.test.ts` "recommendations are recorded with the kernel verdict and a prediction, and never executed" |
| P-071 | partial | `department-economics.test.ts` covers all four actions, maintain/no-op cases, owner-pinned thresholds, evidence/sample gates, deterministic capital ceilings, proposal digests and independent founder decisions; `department-executor.test.ts` verifies approved changes and audit records; `packages/host/src/operate.test.ts` exercises proposal persistence and founder approval through `operate departments propose/decide` |
| P-072 | covered | Kernel `BUILT_IN_AGENT_MANIFESTS` plus `packages/agent/src/business-agents.ts`; `business-agents.test.ts` verifies all seven identities, specialty, NQC registration, proposal-only authority, moderate impact ceiling, evaluation requirement, strict bounded output/input schemas, and read-only context usage; web `POST /api/agents/run` integrates registered workers with chat, evaluation persistence, trace metadata, and proposal-only output |
| P-073 | covered | `workflows.test.ts` "Graph: bounded loops require bounded time, iterations, safe conditions, and a valid isolated body graph", "Runtime: bounded loop carries state across iterations and records an inspectable trace", "Runtime: bounded loop fails closed when its condition still requests work at the iteration limit", "Runtime: bounded loop enforces its wall-clock budget and aborts the running iteration", "Runtime: caller cancellation aborts an active bounded-loop iteration and stays cancelled", "Runtime: every bounded-loop side-effect iteration repeats kernel authorization before dispatch"; `workflow-page-usability.test.ts` "workflow editor provides bounded-loop authoring with validated non-recursive body graphs" |
| P-074 | covered | `economics.test.ts` "the shipped Genesis playbook and $500 run config are valid" |
| P-075 | covered | `economics.test.ts` "the run cannot start without an approved entity and payment accounts in the vault"; `packages/host/src/genesis-api.test.ts` "blockers are listed and refuse a start" |
| P-076 | covered | `economics.test.ts` "experiments: a human starts them, thresholds are pinned, kill applies on its own, scale needs a human"; `genesis-api.test.ts` "kill applies automatically, as the kernel", "scale waits for a human decision" |
| P-077 | covered | `economics.test.ts` "spend decisions: small experiment spend runs, larger spend asks the founder, prohibited or over-cap is refused"; `genesis-api.test.ts` "money: rejected spends 422, founder decisions 409 until confirmed, and nothing is executed" |
| P-078 | covered | `economics.test.ts` "the money ledger: compute is capital, entries need sources, tampering is detected"; `genesis-api.test.ts` "the ledger is verified on read, and a broken chain stops further recording"; `sanity-stores.test.ts` "money ledger: an entry edited behind the store's back fails verification on load" |
| P-079 | covered | Hash-chained `spendAuthorization` stores decision id, kernel recommendation, risk, reasons, confirmer and confirmation time on spend/compute entries; API and CLI attach it; file and Sanity stores preserve it. `economics.test.ts`, `genesis-api.test.ts`, `sanity-stores.test.ts` |
| P-080 | covered | `genesis-reviews.test.ts` "a manual review is bound to the exact text, marked manual, and made only by a human"; `genesis-api.test.ts` "reviews: only a human provider records a manual founder review, with the caller as reviewer; GET lists them apart from WAES" |
| P-081 | needs operational evidence | [Genesis run](genesis-run.md) |
| P-082 | covered | `playbook.test.ts` "the Onboard playbook is valid content", "a failed back-test loops back to the interview" |
| P-083 | covered | `packages/aura/src/onboard.test.ts` "the CSV ledger connector reads common exports into transactions and observations", "debit/credit exports work too, and unreadable rows are reported, not guessed", "AMP boundary: patent-looking sources are refused" |
| P-084 | covered | `onboard.test.ts` "observations enter the graph as OBSERVED, through the governed updater, without touching stated values" |
| P-085 | covered | `onboard.test.ts` "back-test: a stable seasonal business passes; forecasts only use earlier months", "back-test: erratic revenue fails with reasons; too little history is not a pass" |
| P-086 | covered | `packages/agent/src/shadow-agent.test.ts` "proposals keep only citations that exist in the graph; uncited proposals are dropped"; `shadow-api.test.ts` "the shadow-stage agent proposes; departments it was not asked about are refused" |
| P-087 | covered | `shadow.test.ts` "a department with enough agreement and no bad outcomes is ready for hand-over; others say why not"; `simulation.test.ts` "a bad outcome recorded before the rules are met delays hand-over" |
| P-088 | partial | `packages/aura/src/onboard.test.ts` "payments connector: reads charges, refunds, subscriptions and disputes into observations", "CRM connector: parses pipeline, win rate, deal size and sales cycle", "email connector: parses support volume, resolution time, sentiment and categories", "unified live connector pipeline: ingests multiple connector sources into intent graph" |
| P-089 | needs operational evidence | [Onboard pilot](onboard-pilot.md) |
| P-090 | covered | `packages/kernel/src/playbooks/operate.test.ts` "autonomy: shadow evidence caps act-within-limits at act-with-approval", "autonomy: the grant is the ceiling; evidence never raises it"; `packages/host/src/operate.test.ts` "status: effective autonomy is min(grant, shadow evidence)" |
| P-091 | covered | `operate.test.ts` (kernel) "approving a plan is the founder's, and periods never overlap"; `operate.test.ts` (host) "plan and approve-plan: a proposal, then the founder's append-only approval", "store: plans are append-only and written atomically with mode 0600" |
| P-092 | covered | `operate.test.ts` (kernel) "reinvestment: surplus is revenue minus spend and compute, net of refunds; reserve is topped up first", "reinvestment: the experiment pool is capped by maxExperimentUsd; amounts are in cents" |
| P-093 | covered | `operate.test.ts` (kernel) "experiments: bounded by the approved pool and by maxExperimentUsd", "spend: experiment spend is refused over the pool; business spend always needs the founder" |
| P-094 | covered | `tasks.test.ts` "recommendation only unless the department acts within limits; then the existing run queue carries it out", "an approved task stays queued for a human below act-with-approval, or with no workflow" |
| P-095 | partial | `packages/host/src/tool-executor.test.ts` and `packages/host/src/actions.test.ts` cover the approved-actions path (dry-run tools only); `packages/host/src/department-executor.test.ts` exercises exact proposal/approval binding, owner-only execution, stale-state refusal, atomic mutation failure, idempotent retry, audit creation, and the public challenge project guard |
| P-096 | needs operational evidence | [Operate](operate.md) |
| P-097 | covered | `host-routes.test.ts` "route table (A-9): every route refuses a request without credentials (401) and a principal without its permission (403)", "route table (A-9): the public and any-principal routes are exactly the reviewed lists, each with a reason" (walks the route table `routes.ts`, which `dispatch()` matches first) |
| P-098 | covered | `app-routes.test.ts` "web API routes (A-3, A-9): every handler refuses no credential (401), an unknown token (401) and a principal without its permission (403)" (enumerates `app/api/**/route.ts` on disk), "cross-site check (A-3, T-30): state-changing API requests must be JSON and same-origin" |
| P-099 | covered | `triggers.test.ts` verifies no-ID replay, changed-ID replay on run and task paths, and idempotent exact retry; replay cache binds each verified signature to its first delivery ID |
| P-100 | covered | Host redaction tests plus web `safe-log.test.ts`; web API failures return/log only allowlisted error classes, never exception messages |
| P-101 | covered | `host-routes.test.ts` "rate limits (A-5): write routes are limited per principal with 429 and Retry-After; reads are not", "rate limits (A-5): webhook deliveries are limited per endpoint, before the signature is checked"; `app-routes.test.ts` "web rate limits (A-5): the route handlers apply them (plan: model; decision action: write)"; `tasks.test.ts` "rate limit: a per-client token bucket, with consistent JSON errors" |
| P-102 | covered | `packages/host/src/vault.test.ts` (all six tests); `host.test.ts` "vault-backed webhook secrets rotate through the API without a restart" |
| P-103 | covered | `tasks.test.ts` "the file store is append-only, atomic and private"; `genesis-reviews.test.ts` "append-only: a taken reviewId with different content is a conflict; an identical record is a no-op"; `sanity-stores.test.ts` "recommendations are append-only, and a racing writer loses on the revision check"; `store.test.ts` "two writers racing for the same entry: the second is refused, never overwrites" |
| P-104 | covered | `tasks.test.ts` "boundaries: AMP patent material and writes to frozen Forkling are refused before the kernel"; `onboard.test.ts` "AMP boundary: patent-looking sources are refused" |
| P-105 | covered | `tasks.test.ts` "injection text in the objective or inputs changes neither permissions nor status" |
| P-106 | covered | `host.test.ts` "the host serves exactly one tenant" |
| P-107 | partial | Kernel ACL and queue tests (`identity.test.ts`, `runtime.test.ts`, `store-contract.test.ts`); the store contract proves tenant-scoped queues cannot enqueue, claim, read, cancel, complete, or redrive another tenant's runs across memory, file, and Postgres adapters. `host.test.ts` verifies each queue is bound to its configured tenant; `vault.test.ts` binds vault state and encryption to one tenant. `tasks.test.ts` runs two tenant-scoped task services against shared memory and file stores, proving record reads, lists, idempotency, and task MCP client authentication/revocation are isolated. |
| P-108 | partial | `oidc-browser-auth.test.ts` covers HTTPS discovery, authorization-code exchange, S256 PKCE, state/nonce/browser binding, secure HttpOnly session cookies, server-side token digests, revocation, current role mapping, and refusal of replay/cross-browser attempts; `oidc-route-guard.test.ts` proves browser sessions use the same RBAC and authorization audit as bearer principals. Routes: `/api/auth/oidc/start`, `/api/auth/oidc/callback`, `/api/auth/session`, `/api/auth/logout`; session records use the dedicated Sanity store. Live: a Google sign-in passed on the production site on 2026-10-03 (an unmapped account was refused and logged; after its allowlist row was added it signed in and `/api/auth/session` returned its principal). Not yet shown: the console entry control, and sessions surviving a later deploy. |
| P-109 | partial | [Threat model, section 7](threat-model.md#7-dependency-advisories-npm-audit-2026-09-27) |
| P-110 | needs operational evidence | [Threat model, section 8](threat-model.md#8-prioritized-actions) |
| P-111 | covered | `observability.test.ts` "logs are one JSON object per line with bindings and levels", "redact handles cycles and depth" |
| P-112 | covered | `observability.test.ts` "metrics render Prometheus text with escaped labels, histograms and collectors"; `host.test.ts` "metrics need audit:read unless configured public", "signed webhooks start runs; bad signatures are refused and counted" |
| P-113 | covered | Web: `authorization-audit-store.test.ts` verifies durable Sanity append-before-action; host/kernel: `authorization-audit.test.ts` and `identity.test.ts` verify fsynced hash-chained replay/tamper detection and fail-closed authorization |
| P-114 | partial | `apps/web/lib/telemetry.test.ts` covers metadata-only query and specialist-agent trace construction, nullable provider usage and measured-rate cost estimates, alert rules and fail-closed persistence; `apps/web/lib/app-routes.test.ts` enumerates and authorizes the trace endpoint; OpenAPI route drift check covers `GET /api/monitoring/traces` |
| P-115 | covered | `packages/sdk/src/index.test.ts` covers HTTPS/loopback policy, request bodies, simulation/read-only response contracts, NQC evaluation shapes, error preservation, and abort signals; `npm run sdk:test`; workspace typecheck |
| P-116 | covered | `packages/sdk-python/tests/test_client.py` covers URL policy, typed validation/preview/run results, malformed contracts, HTTP errors, invalid request data, and all three CLI commands; `python -m unittest discover -s packages/sdk-python/tests -v`; `pyproject.toml` has no runtime dependencies |
| P-117 | partial | `cli-args.test.ts` covers production flag profiles; `onboard-cli.test.ts` checks CLI-created and CLI-answered intent through the authenticated HTTP API; `genesis-cli.test.ts` checks review writes and reads both ways across CLI and HTTP using `FileGenesisStore`; existing `operate.test.ts`, `whatif.test.ts`, and `tasks.test.ts` exercise real CLI paths and domain services |
| P-118 | partial | `docs/api/openapi.json` (OpenAPI 3.1, version 0.4.0); `apps/web/lib/app-routes.test.ts` asserts route/method drift, operation IDs, write request bodies, and local reference resolution; workflow graph, validation, simulation, and run schemas |
| P-119 | covered | Go workflow client implements validation, safe preview and read-only run; `client_test.go` covers URL policy, HTTP contracts, safe modes, NQC evaluation validation, errors/size limits and cancellation. The authenticated agent draft API is `apps/web/app/api/agents/drafts/route.ts`, backed by the tested catalog lifecycle in `agent-catalog-store.test.ts` and contract tests |
| P-120 | covered | `apps/web/lib/workflow-layout.test.ts` "lays out branches and merges deterministically without overlap", "handles an empty draft with finite minimum canvas dimensions"; included in `npm run seed:test` |
| P-121 | needs operational evidence | `apps/studio/scripts/e2e-live.ts` (`npm run e2e:live`), `apps/studio/scripts/smoke-test.ts` |
| P-122 | partial | Responsive grouped navigation; business operations dashboard; planning moved into the chat, with `/planning` redirecting to `/decisions`; accessible decision, workflow, agent and monitoring workspaces; full-width workflow map auto-fits through `ResizeObserver`; viewports and typography use responsive breakpoints; covered by `responsive-shell.test.ts`, `home-experience.test.ts`, `workspace-pages.test.ts`, and `workflow-page-usability.test.ts` |
| P-123 | partial | Root page is an operating cockpit with authenticated decision, metric, experiment, workflow and separately finance-authorized ledger summaries; quick actions link to the planning console and task workspaces; explicit loading, empty, permission and source-error states; preserved planner at `/planning`; global chat offers read-only Ask and governed Plan modes and links saved proposals to the decision log; decision review progressively discloses evidence and approval basis; covered by `home-experience.test.ts`, `business-dashboard.test.ts`, `agent-chat-widget.test.ts`, `chat-request.test.ts`, `agent-review.test.ts`, `responsive-shell.test.ts`, and `workflow-page-usability.test.ts` |

## Operational evidence blockers (release blockers, not automated)

Per [V1-SCOPE.md's release evidence categories](../V1-SCOPE.md#release-evidence-categories),
automated tests and operational evidence are separate acceptance criteria.
These five rows explicitly require deployment, pilot, or live-system
evidence and remain release blockers for 1.0.0 regardless of their
automated-test status:

| ID | Requirement | Current status | What operational evidence is still needed |
|---|---|---|---|
| P-014 | The host runs always-on at a public HTTPS address with a Postgres run store, and `/healthz`, `/readyz` and `/api/whoami` answer from outside. | needs operational evidence | Not deployed; waits on the entity decision and payment accounts, and on the threat model's P0 actions |
| P-081 | **Operational:** the $500, 30-day digital-only run completes, and every dollar is traceable. | needs operational evidence | Criteria in section 5.1. Blocked on the entity path, payment accounts and always-on hosting (P-014) |
| P-089 | **Operational:** the Onboard pilot on Nuera meets the hand-over criteria for at least one department. | needs operational evidence | Criteria in section 5.2. Planned Jan–Feb 2027 |
| P-096 | **Operational:** at least one full Operate period on Nuera with an approved plan, every action inside its department's effective autonomy, and every dollar traced. | needs operational evidence | Criteria in section 5.3. Starts after the Onboard pilot and the Genesis run |
| P-121 | The live decision loop (plan, approve, execute, observe, roll back) passes against `f87t11g1`. | needs operational evidence | Scripts exist; record a dated pass with each release candidate |

None of these five are satisfied by a passing test suite alone — each needs
a dated, recorded live event (a deployment, a pilot handover, a completed
Operate period, or a recorded live decision-loop pass) per the criteria in
[always-on-hosting.md](always-on-hosting.md), [genesis-run.md](genesis-run.md),
[onboard-pilot.md](onboard-pilot.md), and [operate.md](operate.md).

## Aura charter measures (tracked, do not gate release)

P-064–P-066 fall inside the P-001–P-123 ID range but are Aura's own charter
ladder measures, reported against Aura's charter rather than a Quicksilver
release gate, per [V1-SCOPE.md](../V1-SCOPE.md#release-evidence-categories):

| ID | Requirement | Status | Note |
|---|---|---|---|
| P-064 | (Aura ladder) Parsing accuracy is at least 90% on a fresh held-out set. | needs operational evidence | Met once; the charter asks to confirm on a larger fresh set. Does not gate Quicksilver |
| P-065 | (Aura ladder) Choice agreement is at least 70% and at least 2× chance on a fresh set, method frozen first, predict-then-learn. | needs operational evidence | **Not met.** Next test: pilot verdicts. Decoupled from Quicksilver releases |
| P-066 | (Aura ladder) Question quality: at least 80% of Aura's top-3 questions are answered rather than dismissed, in real use. | needs operational evidence | Measured during the pilot. Does not gate Quicksilver |

## Missing rows (not yet covered by any test)

| ID | Requirement | Note |
|---|---|---|
| P-088 | Live connectors (bookkeeping, payments, CRM, email) fill the graph with `OBSERVED` values. | Read-only Stripe, HubSpot and QuickBooks Online connectors are built (`connect-live`) and tested against a fake API only; no run against real accounts is recorded, credentials are environment variables rather than vault entries, and there is no live support-inbox source (Resend is a mail channel). P-028 stays partial until a real-account run is recorded. |

## Keeping this map honest

This document does not assert that a required capability is complete
merely because a row above says `covered`. `npm run parity:test` enforces
row count, ID coverage, and status-total agreement between
[parity-tests.md](parity-tests.md) and
[NUERA-QUICKSILVER-SPEC-COVERAGE.md](../NUERA-QUICKSILVER-SPEC-COVERAGE.md);
it does not yet check this file. Any status change in parity-tests.md must
be reflected here in the same change, and this file's own counts should be
spot-checked against the "Counts by status" table in parity-tests.md before
each release candidate.
