# Nuera Quicksilver M8–M9 enterprise delivery plan

**Decision:** All capabilities introduced by the authoritative enterprise
specification are targeted for completion by **M9**. M8 is the build and
integration-preparation milestone. M9 is the hardening, operational-evidence,
and release-completion milestone.

This plan extends the existing M1–M7 sequence and does not erase the product
requirements for Genesis, Onboard, Operate, WAES, provenance, finance, or the
0.9.0/1.0.0 parity gates.

## 1. Milestone contract

| Milestone | Product version | Primary purpose | Exit condition |
|---|---:|---|---|
| M8 | 0.9.0 release candidate | Build all enterprise capability tracks in parallel; integrate the Supervisor Agent control plane; achieve feature-complete RC | Every enterprise requirement has connected implementation, owner, tests, threat-model treatment, and a release classification; no unowned gap remains |
| M9 | 1.0.0 release | Harden, operate, evidence, and release the complete merged system | Every enterprise capability and every in-scope parity item passes automated and operational acceptance; Genesis, Onboard, and Operate pass with published audit evidence |

**M9 does not mean “code exists.”** It means the feature works through its
supported interface, fails safely, is authenticated and tenant-bound, is
observable and auditable, has regression coverage, and has operational evidence
where applicable.

## 2. Non-negotiable architecture rules

1. The NQC Kernel remains the only authority.
2. The Supervisor Agent is a first-class control-plane coordinator. It can
   evaluate readiness, request human approval, submit kernel-issued execution
   authorizations, observe outcomes, and propose rollback. It cannot self-approve,
   impersonate a human, mint authority, or alter the action/policy/evidence
   binding.
3. Human Supervisors retain authority for human-only and approval-required
   transitions.
4. Private chain-of-thought is never requested, stored, exported, or used as an
   evaluator contract. Use observable traces, evidence, tool results, and
   human-readable rationale.
5. Every action is bound to identity, tenant, capability, policy revision,
   evidence set, workflow/agent digest, risk, approval, budget, and idempotency.
6. Missing or stale evidence, identity, approval, signature, tenant, policy,
   authorization, or audit storage fails closed.
7. Marketplace packages and domain kernels never activate authority merely by
   being installed.
8. Existing product gates remain mandatory: intent/provenance, Genesis,
   Onboard, Operate, WAES, money ledger, and the 0.9.0/1.0.0 parity contract.

## 3. M8: enterprise feature-complete release candidate

M8 is organized as parallel workstreams with shared contracts. No workstream may
invent an incompatible identity, authorization, audit, evaluator, or extension
model.

### M8-A — contracts and core governance

- Freeze the versioned agent request/result contract.
- Add explicit Supervisor Agent manifest and control-plane events.
- Add kernel-issued execution authorization tokens with expiry, tenant, action,
  policy, evidence, workflow digest, approval, and capability bindings.
- Define evaluator input/output schemas using observable traces only.
- Define workflow, tool, domain-pack, marketplace, SDK, audit, trace, and
  compliance schemas.
- Publish API error, auth, rate-limit, retry, cancellation, and compatibility
  contracts.
- Add contract-test fixtures shared by TypeScript, Python, Go, CLI, HTTP, MCP,
  and worker implementations.

**Exit:** all downstream workstreams consume versioned contracts rather than
ad-hoc payloads.

### M8-B — cognitive and agent runtime

- Implement Code, Reasoning, Bulk, Router, Tool, Memory, and Evaluator workers
  on the standard contract.
- Implement the Supervisor Agent control-plane worker.
- Connect evaluator results to routing, admission, escalation, and memory
  proposals.
- Add calibration datasets, benchmark history, contradiction cases,
  insufficient-information cases, injection cases, and high-impact cases.
- Persist evaluation records with evaluator version, model/provider, cost,
  latency, observable trace references, and outcome.
- Add model/profile selection with measured history, circuit breakers, budget
  caps, and compliant fallback.
- Persist governed memory namespaces, retrieval, citations, supersession,
  deletion, retention, export, and effectiveness feedback.

**Supervisor Agent acceptance:**

- [ ] Receives Engine output and requests kernel authorization.
- [ ] Cannot reverse a kernel refusal.
- [ ] Routes approval-required work to a Human Supervisor.
- [ ] Cannot change action, risk, tenant, evidence, policy revision, or approval
      identity.
- [ ] Submits execution only with an unexpired kernel authorization.
- [ ] Records wait, timeout, refusal, execution, cancellation, and rollback
      proposals.
- [ ] Stops on stale policy, changed content, invalid signature, missing
      evidence, tenant mismatch, expired approval, or executor failure.

### M8-C — workflow and hosted runtime

- Complete visual graph authoring, workflow draft persistence, review, publish,
  versioning, digest pinning, rollback, and deprecation.
- Add explicit bounded-loop nodes with iteration, time, cost, cancellation,
  recursion, and side-effect budgets.
- Add durable run state, scheduler, worker leases, retries, backpressure,
  cancellation, dead-letter, and audited redrive.
- Add sandboxed per-job execution and resource limits.
- Add API, cron, signed webhook, event-bus, internal-event, and approved file
  triggers.
- Add multi-replica replay protection, queue fairness, tenant quotas, and model/
  agent-aware capacity.
- Add horizontal/vertical scaling and autoscaling policies.
- Enable effectful executors only behind the kernel authorization contract.

**Exit:** a workflow can move from trigger through Supervisor Agent coordination
to an authorized executor and produce a durable trace without bypassing policy.

### M8-D — identity, tenancy, secrets, and audit

- Implement SSO/OIDC, PKCE/state/nonce validation, secure sessions, expiry,
  logout, refresh rotation, and service-principal separation.
- Retire the shared supervisor token for supported deployments.
- Add tenant-scoped principal, role, team, workflow, agent, memory, secret,
  queue, audit, metric, trace, and connector storage.
- Complete encrypted vault and OAuth credential lifecycle.
- Move vault-key protection to KMS/HSM/OS keychain where supported.
- Add durable append-only access/audit storage with integrity verification,
  export, retention, deletion, and legal hold.
- Complete exact-action approval, execution, money, WAES, connector, session,
  and release audit events.

**Exit:** two-tenant integration tests demonstrate isolation across every read,
write, queue, connector, SDK, MCP, webhook, secret, and audit path.

### M8-E — observability and operations

- Propagate correlation IDs through every request, workflow, agent, evaluator,
  kernel, Supervisor Agent, approval, executor, connector, and audit event.
- Add distributed traces without private reasoning or secrets.
- Add dashboards for queue, run, approval, denial, dead letter, model cost,
  routing, evaluator, tool, connector, vault, audit, tenant, and WAES metrics.
- Add alerts for readiness, queue growth, dead letters, audit failure, signature
  failure, backup failure, cost spikes, and repeated safety escalations.
- Add backup/restore, secret rotation, token rotation, provider outage, worker
  kill, dead-letter redrive, and deployment rollback drills.

### M8-F — developer ecosystem and extensions

- Publish stable TypeScript/JavaScript and Python SDKs.
- Build Go SDK against the frozen contract.
- Extend the `qs` CLI to all governed intake and operational functions.
- Implement agent creation, validation, versioning, deployment, revocation, and
  rollback API.
- Implement persistent tool schema registry and extension runtime.
- Define signed/versioned declarative domain-kernel packs and sandbox rules.
- Build local extension test harness and compatibility checks.

### M8-G — marketplace and enterprise packs

- Implement agent, tool, domain-kernel, and enterprise-extension catalogs.
- Implement package signing, publishing, review, approval, installation,
  tenant-scoped permissions, quarantine, revocation, and rollback.
- Implement approved domain packs for Repo, Hydraulic, Compliance, Security, and
  Finance where evidence and owners exist.
- Implement compliance-pack structure and evidence workflows without making
  unsupported certification claims.

### M8-H — product-mode integration

- Finish intent/provenance enforcement across enterprise workflows.
- Integrate Genesis economics, ledger, budget, payment, and processor paths.
- Integrate Onboard connectors, backtest, shadow mode, and hand-over.
- Integrate Operate reinvestment and bounded experiment loops.
- Enforce WAES on all customer-facing outputs.
- Connect every mode to the Supervisor Agent and kernel authorization path.

## 4. M8 exit gate

M8 is complete only when:

- [ ] All enterprise capability rows have an implementation owner and location.
- [ ] All interfaces have versioned schemas and contract tests.
- [ ] Supervisor Agent acceptance tests pass.
- [ ] No authority permission can be assigned to an agent.
- [ ] Every effectful path is kernel-authorized and approval-bound.
- [ ] Multi-tenant isolation tests pass.
- [ ] SSO/OIDC and session tests pass.
- [ ] Durable audit, trace, metrics, and alert paths work.
- [ ] Marketplace packages are signed and revocable.
- [ ] Domain packs are declarative, sandboxed, versioned, and reviewed.
- [ ] SDKs, CLI, and API compatibility checks pass.
- [ ] All 121 parity items are classified as covered, partial with named M9
      closure, operational-evidence, or explicitly out of scope with owner
      approval.
- [ ] A clean release-candidate deployment can be installed, upgraded,
      backed up, restored, rolled back, and audited.

M8 produces the **0.9.0 release candidate**. It does not claim 1.0.0.

## 5. M9: hardening, evidence, and complete release

M9 has one purpose: close every remaining feature and evidence gap. No new
enterprise capability is deferred beyond M9 without an explicit product-owner
change to this contract.

### M9-A — integration and failure-path closure

- Run full cross-system tests across HTTP, SDKs, CLI, MCP, webhooks, cron,
  event triggers, workers, marketplace packages, domain packs, and connectors.
- Test stale policy, changed evidence, altered content, expired approval,
  tenant mismatch, replay, duplicate delivery, cancellation, timeout, provider
  outage, audit outage, vault outage, queue loss, worker loss, and rollback.
- Test every Supervisor Agent boundary and all human-only transitions.
- Test extension revocation while installed and while queued/running.
- Test bounded loops under limits, cancellation, partial failure, and retries.
- Verify effectful tools never execute after a failed or missing authorization.

### M9-B — security and compliance closure

- Close all P0 and P1 threat-model actions.
- Complete penetration testing and remediate accepted findings.
- Complete dependency audit, SBOM, license review, image scan, secret scan, and
  supply-chain signature verification.
- Verify SSO/OIDC, tenant isolation, vault protection, redaction, retention,
  deletion, legal hold, export, and access audit.
- Review every compliance pack with the appropriate security/legal owner.
- Publish residual-risk and exception records.

### M9-C — operational evidence

Produce dated, redacted, reproducible evidence for:

- Genesis $500/30-day run;
- Onboard pilot and shadow-mode agreement;
- Operate period, reinvestment, and bounded experiments;
- live plan → evaluate → kernel → Supervisor Agent → approve → execute → observe
  → rollback flow;
- money-ledger reconciliation;
- WAES exact-content blocks and approvals;
- backup/restore and rollback drills;
- multi-tenant isolation;
- scale, queue, dead-letter, and provider-outage drills;
- marketplace publish/install/revoke/rollback;
- domain-pack review and execution;
- SDK/CLI compatibility;
- audit export and integrity verification.

### M9-D — parity closure

The approved release scope is P-001–P-123, as recorded in
[`V1-SCOPE.md`](V1-SCOPE.md). The product owner explicitly included P-122 and
P-123 in the 1.0.0 acceptance matrix.

For every P-001–P-123:

1. Identify implementation and owner.
2. Run the automated test or manual check.
3. Attach operational evidence when the requirement says operational evidence.
4. Record expected and observed results.
5. Record residual risk and rollback plan.
6. Mark covered, partial, operationally evidenced, not applicable, or approved
   post-M9 exception.

No row may remain silently partial or missing.

Keep evidence categories distinct: P-014, P-081, P-089, P-096, and P-121
require operational evidence and block release until their specified deployment,
pilot, or live-system evidence is recorded. P-064–P-066 fall within the
P-001–P-121 ID range but are Aura charter ladder measures and, per the parity
register, do not gate a Quicksilver release. Automated test results do not
replace required operational evidence.

### M9-E — release and hand-off

- Freeze schemas, API contracts, agent manifests, evaluator versions, policy
  packs, domain packs, marketplace package versions, and migration notes.
- Run clean-checkout verification, typecheck, build, tests, security checks,
  deployment checks, backup/restore, and rollback.
- Publish release notes, API/SDK docs, known limitations, operational runbooks,
  audit-bundle index, incident contacts, and support ownership.
- Tag product `1.0.0` only after all three modes and the enterprise acceptance
  matrix pass.
- Monitor the first release window with heightened alerts and a named rollback
  owner; complete a post-release review.

## 6. M9 definition of done

M9 is complete only if all statements below are true:

- [ ] Cognitive core, standard agents, evaluator, routing, memory, and Supervisor
      Agent are operational.
- [ ] Supervisor Agent coordinates approval and execution without holding
      authority.
- [ ] Workflow authoring, publishing, bounded loops, runtime isolation,
      triggers, queues, retries, cancellation, backpressure, dead letters, and
      scaling are operational.
- [ ] TypeScript/JavaScript, Python, and Go SDKs and the CLI are released against
      a stable contract.
- [ ] Agent creation/deployment and extension runtime are operational.
- [ ] SSO/OIDC, RBAC, team administration, tenant isolation, secrets, OAuth,
      audit, retention, deletion, and export are operational.
- [ ] Logs, metrics, traces, dashboards, alerts, cost analytics, and safety
      analytics are operational.
- [ ] Marketplace publishing, review, signing, installation, revocation,
      rollback, and tenant trust controls are operational.
- [ ] Approved domain kernels and compliance packs are operational or explicitly
      excluded with signed owner decisions.
- [ ] Intent/provenance, Genesis, Onboard, Operate, finance/ledger, and WAES
      requirements are operational.
- [ ] All in-scope parity requirements pass.
- [ ] All required operational evidence is published in the audit bundle.
- [ ] No private chain-of-thought is stored or required anywhere in the system.
- [ ] Product `1.0.0` is released only after the complete evidence review.

## 7. Critical path and parallelism

The critical path is:

```text
contract freeze
  → identity/tenant/audit
  → kernel authorization grant
  → Supervisor Agent control plane
  → effectful executor
  → hosted scaling and extensions
  → marketplace/domain packs
  → full operational evidence
  → 1.0.0
```

The following may proceed in parallel after contracts are frozen:

- cognitive calibration and agent workers;
- workflow UI and durable runtime;
- SSO/tenancy/audit;
- observability;
- SDKs and CLI;
- marketplace/catalog services;
- domain packs and compliance evidence;
- Genesis/Onboard/Operate connector work.

The following may not be treated as independent parallel shortcuts:

- effectful execution before kernel authorization and audit;
- marketplace installation before signing and permission review;
- domain-pack execution before sandbox and revocation;
- multi-tenant hosting before tenant-bound stores and isolation tests;
- public exposure before threat-model closure;
- 1.0.0 before operational evidence.

## 8. Required tracking artifacts

Maintain:

- `docs/M8-M9-ENTERPRISE-PLAN.md` — this plan;
- `docs/V1-SCOPE.md` — exact parity and enterprise scope;
- `docs/V1-ACCEPTANCE.md` — machine-checkable acceptance matrix;
- `docs/V1-OPERATIONS.md` — deployment, backup, restore, incident, and rollback;
- `docs/V1-SECURITY-REVIEW.md` — threats, dependencies, penetration test, and
  residual risk;
- `docs/V1-AUDIT-BUNDLE.md` — evidence index;
- `docs/api/` — stable contracts and compatibility;
- private `evidence/m8/` and `evidence/m9/` storage — immutable outputs,
  deployment checks, run exports, audit hashes, and redacted counterparts.

Every item must have an owner, issue/PR, implementation location, automated
evidence, operational evidence requirement, target milestone, and rollback plan.
