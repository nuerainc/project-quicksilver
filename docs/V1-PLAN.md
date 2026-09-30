# Nuera Quicksilver v1.0.0 execution plan

> This is the dependency-aware execution plan for reaching the repository's declared `1.0.0` bar. It is intentionally explicit: no parity requirement, security gate, operational pilot, or release artifact may be silently skipped.

The enterprise feature commitment is now explicit: **all capabilities in the
authoritative enterprise specification are delivered by M9**. M8 is the
feature-complete `0.9.0` release candidate; M9 closes integration, security,
operational evidence, parity, and release work. See the [M8–M9 enterprise
plan](M8-M9-ENTERPRISE-PLAN.md) for the complete feature matrix and milestone
exit gates.

## 1. Release definition and non-negotiable rules

Quicksilver v1 is complete only when the chosen v1 scope is recorded, every in-scope parity row is covered or has its required operational evidence, Genesis/Onboard/Operate pass their operational gates, the live plan → approve → execute → observe → rollback loop passes against `f87t11g1`, P0 security actions are closed, and a dated redacted audit bundle is published.

Apply these rules to every phase:

1. Agents propose; the NQC Kernel authorizes. Models, prompts, connectors, manifests, and workflows never grant authority.
2. Missing identity, evidence, policy, approval, signature, scope, or required fact fails closed.
3. Every action records request, actor, proposal, evaluation, policy/capability snapshot, approval binding, execution result, and outcome.
4. Workflow definitions are validated data, never executable code strings.
5. Human-only transitions remain human-only: approval, rejection, rollback, money, legal identity, account opening, hand-over, and customer-facing release decisions.
6. Store observable rationale, citations, tool results, evaluation signals, and step traces; never private chain-of-thought.
7. Policies, playbooks, models, API contracts, schemas, and evaluation methods are versioned and never change silently.
8. No public host, live connector, second tenant, customer data, or effectful executor before the relevant threat-model review and evidence exist.

## 2. Gate 0 — decide what “v1 baseline” means

The product owner selected the **literal baseline** on 2026-09-29. The decision
and remaining owner/evidence checklist are tracked in [`V1-SCOPE.md`](V1-SCOPE.md).
Gate 0 remains open until the parity classification and operational decisions
are completed.

The product owner has decided that **all requirements P-001–P-123 are required
for v1.0.0**. P-017–P-031 are the platform-baseline group within that complete
scope, not the only parity rows gated on the release. P-122 and P-123 are also
in scope by explicit product-owner direction. Any exception requires an
explicit owner, rationale, replacement behavior, evidence, and product-owner
approval; nothing may be silently moved post-1.0.0.

Keep verification categories distinct: P-014, P-081, P-089, P-096, and P-121
require operational evidence and remain release blockers until that evidence
is recorded. P-064–P-066 measure Aura's separate charter ladder and, as stated
in the parity register, do not gate a Quicksilver release. Tests alone do not
satisfy operational-evidence requirements.

### Gate 0 checklist

- [x] Record the literal-baseline choice in `docs/V1-SCOPE.md`.
- [x] Record the literal-baseline release-scope decision in `docs/NUERA-QUICKSILVER-PRODUCT.md`.
- [x] Include every P-001–P-123 requirement in the v1.0.0 release scope.
- [x] Define P-122/P-123 acceptance evidence: responsive rendered-app checks and task-based usability/accessibility review remain required before release.
- [ ] Name product, security, operations, data, and finance owners.
- [ ] Choose supported Node, browsers, database, deployment platform, model providers, and Sanity dataset.
- [ ] Decide whether WAES is a service or whether manual founder review remains allowed.
- [ ] Decide whether v1 supports one host replica; if more than one, B-16 is mandatory.
- [ ] Define supported data classes and provider retention/training settings (B-15).
- [ ] Define release increments, branch/tag protection, changelog, migration-note, and exception policies.

**Exit:** the scope matrix is approved; no requirement is ambiguous or labelled merely “later.”

## 3. Required evidence and documents

Create and maintain these artifacts:

- `docs/V1-SCOPE.md` — approved scope, owners, exceptions, and parity classification.
- `docs/V1-ACCEPTANCE.md` — machine-checkable acceptance checklist.
- `docs/V1-OPERATIONS.md` — deploy, backup, restore, rotation, incident, and rollback runbook.
- `docs/V1-SECURITY-REVIEW.md` — threat-model actions, dependency decisions, residual risk, and penetration-test disposition.
- `docs/V1-AUDIT-BUNDLE.md` — index of release and pilot evidence.
- `docs/api/` — versioned API contract, auth, error model, webhooks, SDK compatibility, and migrations.
- Private `evidence/v1/` storage — immutable test outputs, deployment checks, run exports, approval records, ledger verification, audit hashes, and redacted/public counterparts.

Every acceptance item must identify: exact requirement ID, implementation location, automated evidence, operational evidence, owner, and date. A unit test is not operational evidence; a demo without an exportable audit trail is not a pilot.

## 4. Phase 1 — reproducible baseline and CI

1. Start from a clean checkout and record commit, Node/npm, TypeScript, Next, Sanity, database, and model SDK versions.
2. Run `npm ci`, `npm run verify`, `npm run typecheck`, the production web build, and `npm audit --json`; save outputs without secrets.
3. Add CI for credential-free verification, typecheck, web build, lint/format, secret scan, and dependency/SBOM reporting.
4. Keep credentialed integration tests separate from pull-request tests and redact their output.
5. Confirm `.env*`, vaults, `data/`, build output, and private evidence are ignored.
6. Generate/check test counts and parity references rather than maintaining them by hand.
7. Add a regression manifest mapping every test to its parity ID.
8. Keep the currently covered foundation green: P-001–P-008, P-010–P-013, P-016; P-032–P-038, P-040–P-041, P-043–P-044, P-046–P-049, P-051; P-052–P-063, P-067–P-070; P-074–P-078, P-080, P-082–P-087; P-090–P-094, P-097–P-098, P-101–P-106, P-111–P-112.

**Exit:** a clean checkout can reproduce the baseline with no credentials and CI is green.

## 5. Phase 2 — dedicated Sanity environment (P-015 dependency)

### Project, tokens, and access

1. Confirm dedicated project `f87t11g1`, intended private dataset, and dedicated Context MCP endpoints.
2. Create Viewer `SANITY_READ_TOKEN`, Editor `SANITY_WRITE_TOKEN`, and the reviewed schema-deploy credential.
3. Configure read paths to use Viewer and write paths to use Editor; retain the legacy combined token only during a documented migration window, with a one-time warning.
4. Remove the combined token from local, Vercel, Render, and CI settings; unset `SANITY_AUTH_TOKEN`.
5. Review Studio users with Editor or higher; Studio read-only schemas do not provide access control.
6. Confirm Viewer cannot mutate, writes cannot accidentally use read credentials, and every component refuses the legacy challenge project.
7. Add the missing web `getDedicatedSanityProjectId` test.

### Schema and seed

1. Deploy schemas to the dedicated project.
2. Verify evaluation records, intents, ledger entries, shadow recommendations, Aura learner data, money entries, experiments, reviews, and audit records.
3. Seed only the dedicated dataset and run smoke tests.
4. Confirm policy conflict, evidence contradiction, optimistic locking, private-dataset behavior, and legacy-project refusal.
5. Record schema revision, dataset, seed commit, document counts, and environment hash.

**Exit:** P-015 is covered and the dedicated environment is private, seeded, and independently verified.

## 6. Phase 3 — close security and dependency blockers before exposure

### Regression-lock existing P0 fixes

Keep tests for A-1/F-1 substituted-delivery replay, A-2/F-2 execute/observe/resume authentication, A-3 web auth and same-origin checks, A-4 loopback default, A-5 per-principal/write/model/webhook limits, A-9 route-table enumeration, and A-10 production refusal of development switches.

### Complete open actions

- [ ] **A-6:** platform secrets for vault key, principals, model keys; webhook secrets only as vault references; separate backups for vault and key; full-disk encryption.
- [ ] **A-7:** complete Viewer/Editor token migration and Studio access review.
- [ ] **A-8:** keep AMP disconnected and Forkling read-only; confirm the boundary before each connector.
- [ ] **B-1 / P-108:** implement OIDC sign-in, PKCE/state/nonce validation, secure sessions, expiry, logout, refresh rotation, token-client separation, and retirement of the shared supervisor token.
- [ ] **B-2 / P-113:** durable append-only access-audit store for denials, grants, approval attempts, secret access, sessions, and administrative changes.
- [ ] **B-3 / P-039:** approvals echo exact action/policy/evidence fingerprint, actor, capability, exposure, request ID, and evaluator result; reject any mismatch.
- [ ] **B-4 / P-079:** money entries include spend recommendation, reasons, risk, action fingerprint, confirming actor, justification, and time.
- [ ] **B-5:** Ed25519-sign host intent entries; chain shadow logs and decisions; anchor heads outside the machine.
- [ ] **B-6:** host-sign approval records and verify signature at execution.
- [ ] **B-7 / T-40:** planner risk is a floor over catalog/capability values; missing/zero exposure is unknown.
- [ ] **B-8 / P-100:** register model/Sanity values for redaction, expand credential-shape matching, redact web logs, and stop returning raw `err.message`.
- [ ] **B-9 / P-109:** remove unused `ai@5` from web; update Sanity deliberately; plan/test Next 16; document all remaining advisories.
- [ ] **B-10:** minimal host production image, no Studio tooling, no `.env*`, and an SBOM.
- [ ] **B-11:** byte caps before parsing; `question <= 2,000`, `comment <= 1,000`, and equivalent limits elsewhere.
- [ ] **B-12:** index task idempotency and submitter lookup.
- [ ] **B-14 / P-107:** tenant-aware stores, queues, vault, audit, limits, metrics, logs, and isolation tests.
- [ ] **B-15:** data-class/provider rules and task-client capability/data scope.
- [ ] **B-16:** shared durable webhook replay cache if multiple replicas are enabled.
- [ ] **C-1:** move vault master key to OS keychain/KMS/HSM where possible.
- [ ] **C-4:** independent penetration test before any non-founder customer.
- [ ] **C-5:** monthly and milestone `npm audit`, SBOM per release.
- [ ] **C-7:** Host-header allow-list and DNS-rebinding tests.

**Exit:** P-039, P-100, P-107, P-108, P-109, P-110, and P-113 are closed or have approved release classification; every P0 is closed; security owner signs `V1-SECURITY-REVIEW.md`.

## 7. Phase 4 — authentication, tenants, and durable audit

### Identity and sessions

1. Define `IdentityProvider` for discovery, authorization, callback, refresh, logout, claims, tenant claims, and errors.
2. Implement strict issuer/audience/nonce/state/PKCE/redirect validation.
3. Use secure server-side sessions; no credentials or sensitive claims in browser local storage.
4. Map IdP claims to tenant-scoped roles deny-by-default; audit privilege changes.
5. Keep service principals for webhooks, CLI, SDK, and MCP separate from browser sessions.
6. Test missing/invalid/expired/revoked sessions, role changes, CSRF, redirect abuse, and cross-tenant access for every route family.

### Tenancy

1. Propagate authenticated tenant from ingress through kernel, queues, stores, Sanity, vault, logs, metrics, model calls, connectors, and audit.
2. Reject tenant IDs from request bodies when they differ from identity.
3. Scope idempotency keys, concurrency, rate limits, data, memory, workflows, and tools by tenant.
4. Add two-tenant integration attacks for every read/write/MCP/SDK/webhook path.
5. Add tenant export/deletion, retention, and legal-hold procedures.

### Audit

1. Define immutable event types: access decision, proposal, evaluation, policy resolution, approval, execution, trigger, secret access, session, connector, money, hand-over, and release.
2. Include event ID, tenant, correlation ID, actor/kind, source channel, subject/action/capability, revisions, hashes, result/reason, time, and previous hash.
3. Make writes atomic and durable; required audit failure blocks the operation.
4. Provide auditor-only paginated, tenant-bound, redacted export and integrity verification.
5. Define retention, deletion, legal hold, and restore rules.

**Exit:** P-032/P-033/P-037/P-046/P-097/P-106/P-107/P-108/P-113 pass through real auth/tenant/audit implementations.

## 8. Phase 5 — observability and operational readiness

1. Propagate correlation ID from ingress through queue, model, tool, approval, execution, connector, Sanity, and audit.
2. Add traces for requests, runs, steps, model calls, tool calls, approval waits, and external calls without sensitive payloads.
3. Record model/provider/profile version, latency, cost estimate, retries, rate limits, outcome, and evaluation.
4. Dashboard queue depth, leases, retries, dead letters, cancellations, denials, approval age, tool/connector failures, model cost, webhook replay, vault/audit failure, and tenant limits.
5. Alert on readiness failure, queue growth, dead letters, repeated denials, failed signatures, audit gaps, rotation failure, budget/cost spikes, and backup failure.
6. Add C-6 denial/verification traces, dashboards, and alerts; close P-114.
7. Perform backup/restore, token rotation, secret rotation, worker kill, provider outage, dead-letter redrive, and deployment rollback drills.
8. Record drill dates, hashes, recovery time, data loss, failures, and corrective actions.

**Exit:** P-111/P-112/P-113/P-114 are covered and the operations owner can trace, stop, quarantine, restore, or redrive a run without secret access.

## 9. Phase 6 — cognitive governance and memory

### Evaluation and routing

1. Version evaluator input/output contracts and calibration data; store evaluator version on every record.
2. Add grounding, contradiction, insufficient-information, injection, tool-failure, high-impact, and policy-conflict cases.
3. Require evaluation for each agent step; malformed/missing evaluation blocks.
4. Ensure ALLOW never loosens a kernel block and escalation cannot bypass a human gate.
5. Test web `persistEvaluations` and report persistence failure (P-042).
6. Define model profile with task, model/provider/version, cost, latency, quality, failure rate, data rules, and validity window.
7. Persist measured profile updates and connect tested selector to actual dispatch, with compliant fallbacks, circuit breakers, budget caps, and route history (P-050).

### Governed memory

1. Define tenant/domain namespaces, memory kind, sensitivity, provenance, confidence, supersession, retention, deletion, and source decision.
2. Implement durable isolated storage and append-only history.
3. Allow agent writes only through governed proposals; never overwrite human or system values.
4. Retrieve with policy checks, citations, freshness, and source hashes.
5. Summarize without fabricating facts; support retention, deletion, export, legal hold, restore, and effectiveness feedback.
6. Test cross-tenant reads, private data, stale/conflicting memory, deletion, and human-value immutability (P-018).

### Aura ladder

Measure P-064 parsing, P-065 choice agreement, and P-066 question quality during the pilot with method frozen first and predict-then-learn. The parity document decouples these from Quicksilver release gates, so they must be reported honestly but do not silently grant autonomy.

**Exit:** P-018/P-041/P-042/P-050 are covered with durable, versioned evidence.

## 10. Phase 7 — workflow platform and effectful execution

### Editor and publishing

1. Keep graph definitions data-only; add deterministic layout and a regression test (P-120).
2. Add tenant-owned drafts, optimistic revisions, validation errors, diff/comments, human publish approval, digest pinning, promotion, rollback, deprecation, and execution history.
3. Pin graph/version/content digest at admission; add redacted replay-safe preview and run inspection.

### Runtime

1. Connect runner to durable queue/worker; enforce tenant/workflow/agent/global concurrency.
2. Propagate cancellation, timeouts, bounded retries, provider hints, dead letters, and graceful SIGTERM drain/second-signal abort (P-009).
3. Add bounded loop nodes only with iteration/time/cost budgets; ordinary cycles remain refused.
4. Route cron, signed webhook, metric/event, and manual triggers through one intake.
5. Add replay/idempotency behavior for replicas.

### Agent family and departments

1. Define versioned manifests for research, offer, content, outreach, sales, fulfillment, finance, memory, evaluator, router, and supervisor roles required by scope.
2. Give each manifest task/data/tool/capability/impact/budget permissions; agents cannot approve, execute, grant autonomy, alter policy, or change human values.
3. ~~Implement spawn/fund/shrink/retire department proposals and unit economics (P-071).~~ Kernel and Operate CLI proposal/decision foundation plus a founder-only, atomic Sanity department status/budget executor are covered by `department-economics.test.ts`, `operate.test.ts`, and `department-executor.test.ts`. P-071 still needs attributable period evidence and a live ledger/pilot; P-095 still needs general workflow/tool executors and operational evidence.
4. Implement required business agent family (P-072) and bounded loops (P-073).

### Executor

1. Define executor contract: tenant, idempotency key, action fingerprint, capability, approval ID/signature, timeout, cancellation, receipt, and result.
2. Implement one reversible low-risk executor behind dry-run/sandbox mode.
3. Require current kernel decision, verified signature, exact policy/content digest, and valid tenant before dispatch.
4. Record effect receipt, provider hash, retries, outcome, compensation/rollback, and actor.
5. Do not automatically retry an effect unless provider idempotency is proven.
6. Test duplicate, stale approval, timeout, provider outage, cancellation, compensation, and failure injection.
7. Keep unreviewed tools disabled; only the reviewed department metadata executor may apply approved structure. Close the remaining P-095 workflow/tool execution gap before broader Operate actions are enabled.

## 11. Phase 8 — in-scope platform baseline and connectors

This phase is conditional on Gate 0; a provider SDK alone is not evidence.

### P-017 through P-031

- **P-017:** add per-agent model, memory, skills, routines, project context, permission/tool allow-list, provider failure, cost cap, and data-policy tests.
- **P-018:** complete Phase 6 memory.
- **P-019:** define portable versioned skill format; human approval, provenance, compatibility, revocation, import/export.
- **P-020:** translate natural-language schedule into reviewable proposal; human activation; delivery idempotency, consent, retries, rate limits, receipts, and channel audit.
- **P-021/P-023:** isolate subagent workspaces, filesystem/network/CPU/memory/time/credentials; cleanup and quota tests; document unsupported desktop/remote control honestly.
- **P-022:** implement approved channel/email path, consent/unsubscribe, delivery receipt, rollback, exact-content WAES.
- **P-024:** domain-allowlisted search/browser contract with login boundary, egress, redaction, timeout, and human gate for authenticated/effectful actions.
- **P-025:** versioned media/transcription/image contract with moderation, retention, cost cap, and asset provenance.
- **P-026:** experiment hosting with tenant isolation, custom/versioned release, digest, teardown, and audit.
- **P-027:** products/prices/payment links/orders/refunds/processor references/webhooks/reconciliation; credentials in vault, no raw card data, ledger linkage.
- **P-028/P-088:** connector manifests, least-privilege OAuth/API keys, rotation, read/import validation, `OBSERVED` provenance, AMP refusal, malformed/injection/outage/replay/cross-tenant tests. Build only bookkeeping, payment, CRM, and email connectors required by scope.
- **P-029/P-030:** sandboxing, no-training/data-handling decision, safe streaming if included, one governed intake for CLI/HTTP/cloud/SDK.
- **P-031:** bounded batch runs and trajectory export of observable inputs/tools/outputs/evaluations/approvals/outcomes, excluding private reasoning; reviewed imports to Genesis priors. A privacy-reviewed, digest-bound quantitative export of decided Genesis experiment outcomes is now implemented; batch orchestration, broader workflow trajectories, and reviewed prior import remain open.

**Exit:** every scoped P-017–P-031 row has implementation, failure behavior, tests, docs, and required operational evidence.

## 12. Phase 9 — stable API, SDK, and CLI

### P-118 API contract

1. Inventory every route/message shape and define explicit `/v1` boundary.
2. Specify authentication, tenant, idempotency, pagination, revisions, errors, retry-after, rate limits, webhooks, redaction, timestamps, hashes, signatures, compatibility, and deprecation.
3. Generate/validate OpenAPI or equivalent schema.
4. Contract-test success and 400/401/403/404/409/422/429/500/503, retries, stale revisions, and cross-tenant access.
5. Publish migration notes from the internal API.

### P-115/P-116 SDKs

1. Make TypeScript/Python SDKs consume the versioned contract and validate all boundary shapes.
2. Enforce HTTPS except approved localhost; never log credentials.
3. Support validate/preview/run/status/cancel/redrive/audit where scoped.
4. Test auth, contract, timeout, retry, redaction, and cross-tenant behavior; publish package docs/examples.
5. Add Go SDK only if P-119 remains v1 scope.

### P-117 CLI and P-119 agent API

1. Add direct parser tests for host, onboard, genesis, operate, tasks, and what-if; test invalid args, credentials, revisions, tenant, confirmation, output, exit codes, and redaction.
2. Ensure CLI uses the same services and authorization as HTTP/MCP.
3. If P-119 is in scope, add versioned agent manifest create/update/review/publish/deprecate, human publish approval, digest pinning, rollback, revocation, and audit.

**Exit:** P-115/P-116/P-117/P-118 pass; P-119 is pass or explicitly post-v1 with owner approval.

## 13. Phase 10 — operational mode gates

### Onboard first (P-082–P-089)

1. Use Nuera data with at least 12 months history; verify no AMP material and record source manifest.
2. Import CSV/live connector; validate dates, currency, duplicates, unreadable rows, and source references.
3. Start intent as human provider; preserve human values and record answers in ledger.
4. Back-test six-plus forecast months: error <=30%, at least 70% inside 80% range; reject short/erratic history honestly.
5. Run shadow-only recommendations; prove nothing executed.
6. For one department collect at least 20 judged recommendations, >=80% agreement (modified half), and zero bad outcomes on accepted recommendations.
7. Run daily verdicts with predict-before-learn; separately report Aura P-064–P-066.
8. Record founder hand-over entry with department, depth, reason, evidence, time, and chain head.
9. Export source manifest, back-test, shadow logs, verdicts, outcomes, learner state, intent ledger, and audit hash.
10. Product/security owner sign P-089.

### Genesis next (P-074–P-081)

1. Resolve entity path and payment accounts in vault; deploy always-on host and verify health/readiness/whoami externally.
2. Validate `$500`, 30-day, digital-only config, prohibited categories, daily cap, experiment budgets, and capital/compute sources.
3. Start only with no blockers; pin every experiment's hypothesis, metrics, budget, duration, kill/hold/scale thresholds and digest.
4. Human starts experiments; exact customer content passes WAES or is separately labelled manual founder review.
5. Record only kernel-permitted spend; store spend decision/confirmation binding, processor/receipt references, compute, revenue, refunds, and ledger hashes.
6. Apply kill automatically; require human scale/hold/modify decisions and bind them to the verdict seen.
7. Run full 30 days unless documented kill/stop rule applies; reconcile every dollar to source.
8. Report capital, compute, revenue, return, thresholds, interventions, and review counts; export redacted audit trail/private evidence.
9. Product/finance/security/operations sign P-081.

### Operate last (P-090–P-096)

1. Verify hand-over, executor, vault, policy, and budget blockers are clear.
2. Set department grant and shadow evidence; enforce effective autonomy `min(grant,evidence)`.
3. Start non-overlapping period; observe approved revenue/spend/compute/refunds.
4. Produce append-only founder-approved plan: reserve first, 50% reinvestment, experiment pool 30% of that capped at $250.
5. Keep experiments within pool/cap; every action uses kernel, executor, and WAES where customer-facing.
6. Require founder decisions for scale, modification, business spend, and plan changes; automatically kill at threshold/budget/end.
7. Reconcile money/compute; record approvals, hand-overs, actions, outcomes, rollback/compensation, and interventions.
8. Complete one period and export report/audit; sign P-096.

## 14. Phase 11 — always-on deployment and recovery

1. Choose Render/VPS, record region/cost/owner, provision private Postgres and encrypted persistent data volume.
2. Build minimal host image; configure approved TLS edge, DNS, Host allow-list, headers, secrets, Postgres SSL/limits/backups.
3. Keep reviewed deployment gate (`autoDeploy: false` or equivalent); run migrations before traffic.
4. Verify external `/healthz`, `/readyz`, `/api/whoami`, console auth, protected metrics, route 401/403, signed webhooks, rate limits, replay/idempotency, and audit.
5. Verify real Postgres multi-process claims, not only PGlite.
6. Back up Postgres/data/vault and key separately; restore into isolated environment with new host identity.
7. Verify ledger/audit/intent chains, queue claims, webhook replay, and no lost audit events after restore.
8. Measure recovery objectives and record drill.
9. Drill token/session revoke, webhook rotation, vault restore, worker kill, provider outage, dead-letter redrive, policy/workflow/model/deployment rollback.
10. Close P-014 and operational C-1/C-3/C-5/C-6/C-7 items.

## 15. Phase 12 — live loop and release candidate

Run `npm run smoke` and `npm run e2e:live` against `f87t11g1` with dated commit/environment record.

- [ ] Plan records `requestedBy`, `proposedBy`, evidence, policy, capability, and risk.
- [ ] Conflicting/weak/missing evidence routes to human or refuses.
- [ ] No agent/service/submitter/wrong tenant can approve.
- [ ] Human approval verifies fingerprint/signature; stale action/policy/evidence refuses.
- [ ] Execute records executor, effect receipt, and outcome.
- [ ] Observe detects wrong direction and records evidence.
- [ ] Rollback follows lifecycle and is itself audited.
- [ ] Test stale approval, invalid process, duplicate action, cancellation, unauthorized call, failed evaluator, and audit failure.
- [ ] Export decisions, process history, evaluation records, audit, metrics, and rollback records; close P-039/P-042/P-121.

### 0.9.0 candidate gate

Do not tag RC until Gate 0 scope is approved; all scoped partial/missing rows are closed; P-014/P-081/P-089/P-096/P-121 have required RC status; P-107/P-108 remain complete if retained; P0 review is closed; audit/SBOM/image/secret/license scans pass; API/migration/rollback/operations docs are published; clean checkout builds and clean integration environment can schema-deploy, seed, smoke, and run e2e.

## 16. Phase 13 — final v1 acceptance and publication

### Sign-off

- [ ] Product owner signs scope and all three mode outcomes.
- [ ] Security owner signs threat model, dependency review, penetration-test disposition, data policy, and residual risk.
- [ ] Operations owner signs hosting, backup/restore, alerts, incident, rotation, and rollback drills.
- [ ] Finance/data owner signs ledger reconciliation and retention/export.
- [ ] Founder signs Genesis, Onboard, Operate, and hand-over decisions.
- [ ] Auditor verifies audit bundle hashes and sample traces.

### Audit bundle

Index release SHA/tag, versions, schemas, environment IDs, test summary, parity matrix, security/dependency review, deployment checks, Onboard source/back-test/shadow/hand-over evidence, Genesis configuration/experiments/30-day ledger/reviews, Operate plan/actions/period/ledger, live e2e, backup/restore, drills, API/SDK compatibility, and post-v1 capabilities. Publish redacted summaries and hashes; retain private data only in approved private storage.

### Release

Freeze/tag only after clean credential-free and credentialed checks, schema compatibility, migration, audit, SBOM, image, secret, license, backup, and rollback checks. Publish `v1.0.0`, release notes, audit index, API/SDK docs, known limitations, and incident contacts. Monitor the first release window with heightened alerts and a named rollback owner; conduct a post-release review.

## 17. Complete parity traceability

The following map is the required work assignment for every parity row:

- **Preserve/regression-lock:** P-001–P-008, P-010–P-013, P-016; P-032–P-038, P-040–P-041, P-043–P-044, P-046–P-049, P-051; P-052–P-063, P-067–P-070; P-074–P-078, P-080, P-082–P-087; P-090–P-094, P-097–P-098, P-101–P-106, P-111–P-112.
- **Phase 2:** P-015.
- **Phase 3:** P-039, P-079, P-099, P-100, P-109, P-110, plus the A/B/C threat-model actions.
- **Phase 4:** P-107, P-108, P-113, and the tenant/auth portions of P-032/P-033/P-046/P-097/P-106.
- **Phase 5:** P-009 operational shutdown, P-111, P-112, P-114.
- **Phase 6:** P-018, P-041, P-042, P-050, P-064, P-065, P-066.
- **Phase 7:** P-019, P-021, P-029, P-038, P-045, P-067–P-073, P-095, P-120.
- **Phase 8:** P-017–P-031 and P-088, conditional on Gate 0.
- **Phase 9:** P-115–P-119 and CLI portion of P-117.
- **Phase 10:** P-081, P-089, P-096.
- **Phase 11:** P-014 and operational security/hosting evidence.
- **Phase 12:** P-039, P-042, P-121 and live decision evidence.

### Exact parity ID index

This redundant index is machine-checkable and intentionally lists all 121 IDs:

`P-001, P-002, P-003, P-004, P-005, P-006, P-007, P-008, P-009, P-010, P-011, P-012, P-013, P-014, P-015, P-016, P-017, P-018, P-019, P-020, P-021, P-022, P-023, P-024, P-025, P-026, P-027, P-028, P-029, P-030, P-031, P-032, P-033, P-034, P-035, P-036, P-037, P-038, P-039, P-040, P-041, P-042, P-043, P-044, P-045, P-046, P-047, P-048, P-049, P-050, P-051, P-052, P-053, P-054, P-055, P-056, P-057, P-058, P-059, P-060, P-061, P-062, P-063, P-064, P-065, P-066, P-067, P-068, P-069, P-070, P-071, P-072, P-073, P-074, P-075, P-076, P-077, P-078, P-079, P-080, P-081, P-082, P-083, P-084, P-085, P-086, P-087, P-088, P-089, P-090, P-091, P-092, P-093, P-094, P-095, P-096, P-097, P-098, P-099, P-100, P-101, P-102, P-103, P-104, P-105, P-106, P-107, P-108, P-109, P-110, P-111, P-112, P-113, P-114, P-115, P-116, P-117, P-118, P-119, P-120, P-121.`

## 18. Ordered work queue

1. Gate 0 scope and owners.
2. Evidence artifacts, CI, clean baseline, release/change policy.
3. Dedicated Sanity project, token separation, schema, seed.
4. P0 security, data policy, dependency cleanup, minimal image.
5. SSO/sessions, tenant isolation, durable access audit.
6. Approval signatures, money lineage, redaction, input limits, web evaluation persistence.
7. Observability, dashboards, alerts, backup/restore, incident drills.
8. Measured routing and governed memory.
9. Workflow publishing, durable execution, bounded loops, agents, executor.
10. Scoped platform baseline and live connectors.
11. API, SDK, CLI, and optional Go/agent API.
12. Onboard, Genesis, then Operate evidence.
13. Always-on deployment, live loop, 0.9.0 gate.
14. Final sign-off, audit publication, and `1.0.0`.

Any skipped step requires an owner-approved exception in `docs/V1-SCOPE.md` with affected parity IDs, residual risk, compensating control, and revised acceptance date.
