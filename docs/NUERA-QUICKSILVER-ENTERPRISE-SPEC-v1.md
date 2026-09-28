# Nuera Quicksilver — Authoritative Enterprise Build Specification v1

**Status:** Authoritative target specification  
**Owner:** Nuera Research & Developmental Laboratories  
**System:** Nuera Quicksilver  
**Final authority:** NQC Kernel  
**Evaluation engine:** Quicksilver Engine  
**Worker family:** Nuera Quicksilver Agents

> This document merges the Enterprise Build Specification with the repository's
> product definition, architecture, parity gate, threat model, and operational
> requirements. It is the authoritative target for enterprise capability scope.
> It does not claim that every target capability is already implemented.

## 1. Normative authority model

Nuera Quicksilver is a cognitive and automation subsystem providing reasoning
evaluation, cognitive governance, multi-agent orchestration, workflow automation,
hosted execution, developer tooling, observability, and enterprise controls.

The authority hierarchy is normative:

1. **NQC Kernel:** the only component that can authorize, deny, or issue an
   execution authorization. It resolves identity, tenant, capabilities, policy,
   evidence, risk, evaluation, approval requirements, and lifecycle state.
2. **Quicksilver Engine:** deterministic evaluation and diagnostics. It can make
   a proposed outcome stricter, but can never loosen a kernel refusal or grant
   authority.
3. **Supervisor Agent:** a governed control-plane agent. It coordinates the
   evaluation/approval/execution process, maintains readiness, requests human
   approval when required, routes approved work to an executor, observes results,
   and proposes rollback or escalation. It is not an authority holder.
4. **Human Supervisor:** the human principal who may approve human-only or
   approval-required transitions, subject to RBAC, tenant boundaries, policy
   requirements, separation of duties, exact-action binding, and audit.
5. **Executors:** bounded workers that may perform an effect only when presented
   with a current, kernel-issued authorization and every required approval,
   signature, capability, policy revision, tenant binding, and idempotency key.
6. **All other agents:** proposal, analysis, evaluation, routing, memory, or
   bounded-work components. They cannot grant permissions, approve themselves,
   alter policy, or bypass the kernel.

### 1.1 Supervisor Agent clarification

The Supervisor Agent is intentionally retained from the enterprise specification.
It is not the same thing as a human supervisor and it does not replace one.

The Supervisor Agent may:

- receive a candidate action and its Quicksilver Engine evaluation;
- ask the NQC Kernel for an authorization verdict;
- determine whether the workflow is autonomous, approval-required, escalated,
  refused, or waiting for evidence;
- request a human approval through the approved interface;
- verify that the human approval matches the exact action, evidence, policy
  snapshot, content digest, tenant, capability, and risk;
- submit an execution request using a kernel-issued authorization token;
- monitor execution, metrics, failures, and cancellation;
- propose retry, compensation, rollback, or further evidence;
- produce an observable control-plane trace.

The Supervisor Agent may not:

- approve an action merely because it recommends approval;
- mint, extend, or alter a capability or permission;
- change a policy, risk value, exposure, evidence, tenant, or approval record;
- impersonate a human supervisor;
- execute with an expired, changed, unsigned, or mismatched authorization;
- treat model output as authority;
- bypass separation of duties, WAES, budget, or human-only rules.

The kernel must represent the Supervisor Agent as `entityType: agent` and reject
all authority permissions for it. The Supervisor Agent's `approve` operation is
therefore a **request/coordination operation** that invokes the human approval
handler or the kernel's autonomous approval path; it is not a grant of authority.

## 2. Canonical execution flow

The merged execution flow is:

```text
Trigger
  ↓
Workflow admission and validation
  ↓
Nuera Quicksilver Agent proposal
  ↓
Quicksilver Engine evaluation
  ↓
NQC Kernel authorization and routing
  ↓
Supervisor Agent control-plane coordination
  ├─ autonomous path: kernel-issued authorization
  ├─ approval path: Human Supervisor approval
  ├─ evidence path: request more evidence
  └─ refusal path: stop and audit
  ↓
Bounded effect executor
  ↓
Observability, audit, and outcome recording
  ↓
Memory/routing updates as governed proposals
  ↓
NQC Kernel validation of any state update
```

Every transition is tenant-bound, authenticated, versioned, auditable, and
fail-closed. The Supervisor Agent is a participant in the control plane, not a
second authority plane.

## 3. Cognitive layer

### 3.1 Quicksilver Engine

The Engine shall provide:

- reasoning-quality scoring from observable outputs;
- hallucination-risk and unsupported-claim signals;
- brittleness and uncertainty detection;
- observable final-answer stress testing;
- multi-step logic-trap generation;
- failure-exemplar generation;
- diagnostic and correction formatting;
- model/task/impact-aware evaluation;
- versioned evaluator methods and calibration datasets;
- durable evaluation records and benchmark history;
- an interface that reports scores, risks, issues, corrections, safety decision,
  routing proposal, and governed memory proposals.

The evaluator input contract is:

```text
agent_output
observable_step_trace
context_references
published_evidence
 task_type
model_id
tool_calls
impact_level
workflow_id/version/digest
```

The contract deliberately does **not** require private chain-of-thought or hidden
reasoning traces. `observable_step_trace`, evidence references, tool results,
final output, and human-readable rationale provide the auditable substitute.

### 3.2 NQC Kernel

The kernel shall provide:

- safety and authority enforcement;
- routing-policy enforcement;
- tool-use validation;
- governed memory writes;
- policy and domain-kernel loading;
- closed-loop learning under versioning and review;
- capability, tenant, identity, evidence, risk, budget, and approval checks;
- decision lifecycle and rollback;
- append-only, tamper-evident audit records;
- refusal on missing, contradictory, stale, or unverifiable evidence.

Kernel request fields include agent, tenant, task, model, observable output,
trace references, tool calls, context references, impact, workflow digest, and
requested action. Response fields include scores, risks, issues, corrections,
safety decision, routing proposal, memory proposals, authorization status,
approval requirements, exact action fingerprint, and audit identifiers.

## 4. Agent layer

### 4.1 Core worker family

The required standardized agent roles are:

- Code Agent
- Reasoning Agent
- Bulk Agent
- Router Agent
- Tool Agent
- Memory Agent
- Evaluator Agent
- Supervisor Agent

Each role must expose the versioned worker contract, structured inputs/outputs,
NQC evaluation, routing directives, domain-kernel context where applicable, and
workflow execution hooks. Role names identify behavior and configuration; they
do not grant authority.

The current repository's planner, reviewer, and query workers map into this
family as follows:

| Current role | Enterprise role mapping |
|---|---|
| Planner | Reasoning/Planning Agent |
| Reviewer | Evaluator/Review Agent |
| Query | Tool/Research Agent |
| Router configuration | Router Agent foundation |
| Memory proposals | Memory Agent foundation |
| Human approval handler | Human Supervisor control, not an agent |
| Future Supervisor Agent | Control-plane coordinator defined in section 1.1 |

### 4.2 Domain agents and domain kernels

Optional domain agents may include Compliance, Hydraulic, Repo, Security, and
Finance agents. They must run through signed, versioned, declarative domain-kernel
packs. Domain packs must define evidence sources, capabilities, data classes,
evaluation rules, sandbox restrictions, compatibility, owner, review status,
revocation, and rollback. They cannot add executable authority to the kernel.

## 5. Platform layer

### 5.1 Workflow system

The workflow platform shall provide:

- visual graph authoring;
- multi-step workflows;
- data-only conditional logic;
- bounded parallel execution;
- bounded-loop constructs with iteration/time/cost budgets;
- trigger → agent → evaluator → kernel → Supervisor Agent → executor pipelines;
- versioning, publishing, approval, digest pinning, rollback, and deprecation;
- preview, debugging, replay-safe inspection, breakpoints, and trace viewing;
- durable execution history and tenant-scoped workflow storage.

Ordinary cycles remain invalid. Loop nodes must be explicit, bounded, cancellable,
rate-limited, and evaluated per iteration.

### 5.2 Hosted runtime

The runtime shall provide:

- containerized and sandboxed agent execution;
- isolated per-job workspaces;
- durable queues and leases;
- horizontal and vertical capacity management;
- model-aware and agent-aware capacity policies;
- rate-limit-aware scheduling;
- retry and backpressure policies;
- dead-letter queues and audited redrive;
- cron, webhook, API, internal-event, event-bus, and approved file triggers;
- graceful shutdown and cancellation propagation;
- shared replay protection for multi-replica deployments;
- health/readiness probes, backup, restore, and rollback.

The current single-tenant host and deployment templates are the foundation; they
are not evidence that horizontal scaling or public hosting is complete.

### 5.3 Developer ecosystem

The platform shall provide:

- published TypeScript/JavaScript and Python SDKs;
- Go SDK after the stable API contract;
- CLI tools using the same governed intake as HTTP and MCP;
- agent creation, validation, versioning, publishing, deployment, revocation,
  and rollback API;
- structured tool schema registry;
- extension runtime with isolation and permission controls;
- local testing and preview harness;
- versioned API contracts, compatibility guarantees, migration notes, and
  generated contract tests.

### 5.4 Security subsystem

The security subsystem shall provide:

- encrypted secrets vault;
- API-key, OAuth, and webhook credential lifecycle;
- RBAC and deny-by-default access;
- tenant-specific permissions and team administration;
- SSO/OIDC browser sessions;
- secret-access audit records;
- KMS/HSM or equivalent vault-key protection where available;
- redaction in responses, logs, traces, and exported evidence;
- data-class/provider retention and no-training decisions;
- penetration testing before non-founder customers.

## 6. Marketplace and extension subsystem

The marketplace is an enterprise capability track, not an implicit authority
source. It shall provide:

- agent catalog;
- tool catalog;
- domain-kernel catalog;
- enterprise-extension catalog;
- signed packages and manifests;
- compatibility and dependency validation;
- publishing/versioning;
- review and approval workflows;
- tenant-scoped installation;
- permission and data-scope review;
- revocation, rollback, quarantine, and trust records;
- marketplace audit dashboards.

Marketplace installation never directly activates authority. The kernel must
revalidate every installed capability and tool at runtime.

## 7. Runtime, scheduling, and scaling

The runtime shall support:

- webhooks;
- cron;
- event listeners;
- approved file watchers;
- API triggers;
- internal system triggers;
- task and priority queues;
- backpressure detection;
- rate-limit-aware scheduling;
- bounded retries and dead letters;
- horizontal scaling;
- vertical scaling;
- autoscaling policies;
- model-aware capacity;
- agent-aware capacity;
- tenant-aware quotas and fairness.

Every trigger must enter the same intake sequence:

```text
identity → tenant → rate limit → validation → boundary checks → evaluation → authorize()
```

A trigger cannot select a capability or bypass the kernel by placing it in a
payload.

## 8. Observability and evidence

### Logging

Provide structured logs for agents, kernel decisions, workflows, tools, domain
kernels, Supervisor Agent coordination, human approvals, executors, connectors,
and security events. Logs must be one JSON object per line, correlated, redacted,
tenant-scoped, and retained according to policy.

### Metrics

Provide metrics for agent/model performance, workflow throughput, queue health,
kernel decisions, safety escalations, routing, approvals, tool calls, costs,
connector health, tenant quotas, memory operations, and WAES outcomes.

### Tracing

Provide distributed traces for request, workflow, agent step, Engine evaluation,
kernel authorization, Supervisor Agent coordination, human approval wait, tool
call, executor effect, memory proposal, and rollback. Traces expose observable
control-plane data, never private chain-of-thought or raw credentials.

### Operational evidence

A capability is not complete merely because code and unit tests exist. Release
evidence must include clean-build output, integration tests, configuration review,
security checks, deployment checks, audit exports, backup/restore results, and
real pilot/run results where the requirement is operational.

## 9. Enterprise layer

### Compliance and data governance

The platform shall support auditable policy packs and evidence workflows for the
chosen compliance scope, including SOC 2, HIPAA, PCI, FedRAMP, or other regimes
only after legal/security review. A compliance pack is not a certification claim.

Required controls include:

- policy enforcement;
- audit dashboards;
- memory retention/deletion/export;
- data-class rules;
- legal hold;
- tenant data boundaries;
- evidence provenance;
- incident and access review;
- compliance-pack versioning and review.

### Multi-tenant isolation

Every tenant must have isolated:

- identity and roles;
- routing and quotas;
- memory and retrieval;
- secrets and credentials;
- workflows and agents;
- queues and idempotency keys;
- audit and exports;
- logs, metrics, and traces;
- connector data and model-provider policy.

Cross-tenant requests fail closed, including requests made by supervisors,
administrators, agents, service principals, or marketplace packages.

## 10. Quicksilver-specific product requirements

The enterprise platform is also the foundation for the Nuera Quicksilver product.
The following are mandatory product layers and are not optional merely because
they were absent from the enterprise source specification.

### Intent and provenance

The product must provide one intent entry point, a decision graph, impact-ranked
unknowns, and provenance tags:

- `HUMAN_SPECIFIED`
- `OBSERVED`
- `AGENT_INFERRED`
- `SYSTEM_CONSTRAINT`

Agents may update inferred observations through the memory governor but may never
overwrite human values or system constraints.

### Three operating modes

- **Genesis:** discover and test a business with a small fixed budget, fixed
  experiment thresholds, automatic kills, and human-controlled scale decisions.
- **Onboard:** connect business data, back-test, operate in shadow mode, and
  graduate departments one at a time based on evidence and the provider's
  hand-over.
- **Operate:** execute within effective autonomy, reinvest under an approved plan,
  run bounded experiments, and trace every dollar.

### Playbooks and finance

Playbooks are versioned data combining process stages and workflow graphs. They
must define modes, triggers, variables, capabilities, budgets, metrics,
kill/hold/scale thresholds, outputs, owner, and graph digests.

The finance layer must provide a hash-chained money ledger, source references,
compute-as-capital accounting, spend decisions, confirmation lineage, CAC,
margin, cash forecast, capital allocation, processor reconciliation, and rollback
or correction procedures.

### WAES

WAES reviews every offer, marketing claim, and outbound customer-facing message
before shipping. The review is bound to the exact content digest, separate from
the proposer, auditable, and a hard block on failure. Manual founder review must
be labelled separately from automated/service WAES review.

### Product release contract

The product's repository version remains independent of this architecture
capability roadmap:

| Product version | Gate |
|---|---|
| 0.8.0 | M7 kernel depth verified; current implementation baseline |
| 0.5.0 | Playbooks and Onboard pilot evidence |
| 0.6.0 | Genesis demonstration |
| 0.7.0 | Operate foundation |
| 0.8.0 | Kernel depth |
| 0.9.0 | Three modes pass parity in testing |
| 1.0.0 | Three modes pass parity with operational evidence |

The enterprise capability roadmap may use v1.0–v1.5 capability phases, but those
labels must not replace the product's 0.x/1.0.0 release contract.

## 11. Capability roadmap

### Enterprise capability v1.0 — cognitive core

- Quicksilver Engine;
- NQC Kernel;
- standard agent contract;
- core agents and Supervisor Agent control plane;
- basic routing and safety;
- observable evaluation and stress harness;
- no private chain-of-thought storage.

### Enterprise capability v1.1 — platform foundation

- workflow builder and publishing;
- hosted runtime;
- durable queues;
- trigger system;
- cancellation, retries, backpressure, and dead letters;
- bounded loops;
- effectful executors behind kernel authorization.

### Enterprise capability v1.2 — developer ecosystem

- stable API;
- TypeScript/JavaScript and Python SDKs;
- Go SDK;
- CLI;
- agent creation API;
- tool schema registry;
- extension runtime;
- local test harness.

### Enterprise capability v1.3 — enterprise controls

- secrets/OAuth vault;
- SSO/OIDC;
- RBAC/team administration;
- durable audit;
- tenant isolation;
- data governance;
- reviewed compliance packs.

### Enterprise capability v1.4 — observability

- structured logs;
- metrics;
- distributed traces;
- dashboards;
- alerts;
- cost, safety, routing, and approval analytics.

### Enterprise capability v1.5 — marketplace and domains

- agent/tool/domain-kernel marketplaces;
- signed extension packages;
- publishing, review, approval, revocation, and rollback;
- repo, hydraulic, compliance, security, and finance domain packs where approved.

These capability phases are architectural sequencing labels. They do not override
the Quicksilver product release gates in section 10.

All capabilities in v1.0 through v1.5 are targeted for delivery by **M9**. M8
is the enterprise feature-complete release candidate (product `0.9.0`); M9 is
the integration, hardening, operational-evidence, and product `1.0.0` release
gate. The detailed dependency-aware delivery contract is the
[M8–M9 enterprise plan](M8-M9-ENTERPRISE-PLAN.md).

## 12. Acceptance and implementation authority

The following repository documents remain the implementation evidence sources:

- [Product definition](NUERA-QUICKSILVER-PRODUCT.md)
- [Roadmap](NUERA-QUICKSILVER-ROADMAP.md)
- [Parity tests](platform/parity-tests.md)
- [Threat model](platform/threat-model.md)
- [v1 execution plan](V1-PLAN.md)

The parity tracker governs pass/fail status. The v1 execution plan governs order,
dependencies, operational evidence, and release work. This document governs the
merged enterprise capability target and the Supervisor Agent semantics.

No implementation may mark a requirement complete without:

1. connected runtime behavior;
2. defined failure behavior;
3. authentication, tenancy, and audit boundaries;
4. regression or contract tests;
5. operational evidence where required;
6. a versioned owner and release classification.

## 13. Supervisor Agent acceptance tests

The Supervisor Agent implementation is complete only when all of these pass:

- [ ] Agent identity is `kind: agent`; authority permissions are rejected.
- [ ] It can receive Engine output and request a kernel authorization verdict.
- [ ] It cannot turn a refusal into approval.
- [ ] It cannot alter action, risk, evidence, tenant, policy revision, content
      digest, or approval identity.
- [ ] It routes approval-required work to a human supervisor.
- [ ] Human approval is bound to the exact action and policy/evidence snapshot.
- [ ] It cannot self-approve, approve on behalf of a human, or impersonate one.
- [ ] It can submit execution only with a current kernel-issued authorization.
- [ ] It records coordination, wait, timeout, refusal, execution, and rollback
      events without private reasoning traces.
- [ ] It stops on stale policy, changed content, invalid signature, missing
      evidence, tenant mismatch, expired approval, or executor failure.
- [ ] It can propose rollback, but rollback itself passes the same kernel and
      human-approval rules.

## 14. Authority statement

This specification supersedes conflicting terminology in earlier architecture
notes and the source enterprise draft. In particular:

- “Supervisor Agent” means the governed control-plane coordinator defined here.
- “Human Supervisor” means the authority-bearing human principal.
- “NQC Kernel” remains the final authority.
- “reasoning trace” means observable trace references, not private chain-of-thought.
- “v1.0 enterprise capability” does not mean Quicksilver product `1.0.0`.
- Marketplace, domain-kernel, compliance, and scaling capabilities are target
  capabilities unless their parity and operational evidence explicitly show them
  complete.
