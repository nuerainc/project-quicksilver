# Nuera Quicksilver — Architecture

> Internal design document. Updated as decisions lock.

---

## 1. Canonical component names

The full subsystem is **Nuera Quicksilver**. Its final authority is the **NQC
Kernel** (Nuera Quicksilver Cognitive Kernel), its worker family is **Nuera
Quicksilver Agents**, and its deterministic evaluation core is the **Quicksilver
Engine**. The current code mapping and implementation boundaries are recorded
in [NUERA-QUICKSILVER-NAMING.md](./docs/NUERA-QUICKSILVER-NAMING.md).

## 2. The model

A company is not a document. It is a graph of **entities** (humans, agents, systems, services) bound by **policies**, **capabilities**, **permissions**, and **evidence**, pursuing **objectives** through **workflows**, producing and consuming **state**.

Nuera Quicksilver's job is to make that graph **machine-queryable**, **reason-over-able**, and **authoritative**.

## 3. The schema (locked Day 1, refined Days 2–5)

Ten document types. Enough to express the company; few enough to keep authoring manageable.

| Type | Purpose | Status |
|---|---|---|
| `organization` | The fictional company (root doc) | implemented |
| `department` | Organizational units with leader, members, capabilities, objectives | implemented |
| `entity` | The unified entity abstraction (human, agent, robot, service, system, contractor) | implemented |
| `capability` | What can be done, by whom, with what risk and tools | implemented |
| `policy` | Rules with scope, priority, supersedes, appliesTo, approvalRequirements | implemented |
| `objective` | Goal with deadline, constraints, successMetrics, budget, status | implemented |
| `workflow` | State machine: states, transitions, requiredCapabilities, rollback | implemented |
| `evidence` | Source of truth with type, claim, confidence, supports/contradicts | implemented |
| `decision` | Auditable record: question, evidence, candidateActions, selectedAction, policyChecks, riskLevel, status | implemented |
| `metric` | Measurable state with baseline + direction; not seeded — created at runtime by the closed-loop execute/observe flow | implemented |

Schema lives in `apps/studio/schemas/`. Deployed via `sanity schema deploy` (required for Context MCP GROQ mode).

### The `entity` abstraction (key insight)

```
entity {
  name
  entityType     // human | agent | robot | service | contractor | system
  capabilities[] // refs to capability docs
  permissions[]  // refs to policy/permission docs
  constraints[]  // refs to policy docs that constrain this entity
  reportsTo      // ref to entity
  department     // ref to department
  availability
  riskProfile
  costProfile
}
```

This lets the kernel reason about humans and machines using **the same organizational primitive**. Crucial for "the agent" being just another entity with a `entityType: agent`.

## 4. The runtime

```
            USER (CEO)
               │
               ▼
      ┌──────────────────┐
      │ Nuera Quicksilver│   Next.js App Router
      │  (apps/web)      │
      └─────────┬────────┘
                │
                ▼
      ┌──────────────────┐
      │ Nuera Quicksilver Agents │ packages/agent
      │  (AI SDK 6)      │
      │                  │
      │  ┌────────────┐  │
      │  │  Planner   │──┼──→  gpt-5.6-sol     (configurable per role)
      │  │  Reviewer  │──┼──→  claude-sonnet-5
      │  │  Router    │──┼──→  gpt-5.6-luna
      │  └────────────┘  │
      │                  │
      │  MCP client ─────┼──→  Sanity Context MCP
      │                  │      ├ GROQ mode (structured queries)
      │                  │      └ Knowledge Base mode (provenance)
      └─────────┬────────┘
                │ candidate action + evidence
                ▼
      ┌──────────────────┐
      │  NQC Kernel      │   packages/kernel
      │  Kernel          │
      │                  │   DETERMINISTIC — no LLM
      │  • capability    │
      │  • authority     │
      │  • risk          │
      │  • approval      │
      │  • Quicksilver Engine evaluation
      │  • tool-use validation
      └─────────┬────────┘
                │ decision record
                ▼
      ┌──────────────────┐
      │  Approval gate   │
      │  (UI / API)      │
      └─────────┬────────┘
                │ approved action
                ▼
      ┌──────────────────┐
      │  Simulated exec  │   dry-run for the demo
      └─────────┬────────┘
                │ state delta
                ▼
      Next.js API route → @sanity/client → Content Lake (writes)
```

## 5. Architectural principle: separate cognition from authority

The LLM proposes. The kernel authorizes. **Never** the other way around.

```ts
// Illustrative pseudocode. The real calls are planObjective() in
// packages/agent/src/planner.ts and authorize() in packages/kernel/src/approval.ts,
// which returns { authorized, riskLevel, requiresApproval, recommendation,
//                 blockingReasons, concerns }.

// ❌ wrong
const decision = await llm(`Can ${entity} do ${action}?`)

// ✅ right
const proposal = await planner.propose(objective, context)
const decision = kernel.authorize({
  actor: proposal.actor,
  action: proposal.action,
  capability: proposal.requiredCapability,
  policies: proposal.applicablePolicies,
  evidence: proposal.supportingEvidence,
})
// kernel.decision is { authorized: boolean, riskLevel: 0-5, requiresApproval: boolean, reasons: [...] }
```

This is what makes Quicksilver more than a chatbot. The agent has *opinions*; the kernel has *authority*.

## 6. Model configuration

Models are role names. Names are IDs. Roles are code.

```ts
// packages/agent/src/models.ts
export type QuicksilverModelRole = 'planner' | 'reviewer' | 'router' | 'executor'

export const MODELS: Record<QuicksilverModelRole, string> = {
  planner:  'gpt-5.6-sol',
  reviewer: 'claude-sonnet-5',
  router:   'gpt-5.6-luna',
  executor: 'gemini-3.8-flash',
}
```

These are the direct-provider defaults. The live deployment runs on Azure OpenAI, where each role maps to a deployment (`qs-planner`, `qs-reviewer`, `qs-router`, `qs-executor`). Only the **planner** and **reviewer** are called at runtime today; `router` and `executor` are configured and health-checked by `npm run verify:llm`, and execution is simulated.

## 7. The MCP integration

### Reads — Sanity Context MCP (hosted, read-only)

```
Endpoint: https://api.sanity.io/v1/context/organizations/:orgId/mcp/:endpointName
Auth:     Bearer <SANITY_CONTEXT_TOKEN, org-scoped, Context Viewer permission>
Modes:    GROQ (live dataset, structured) | Knowledge Base (compiled index)
Tools:    initial_context, schema_explorer, groq_query, array_field_reader (GROQ)
          initial_context, knowledge_base_read (KB)
```

Prerequisites:
- Context enabled on org (Manage → Labs → Context)
- Org API token with `Context Viewer` grant
- For GROQ mode: `sanity schema deploy` (Studio ≥5.1.0)

### Writes — Sanity HTTP API (direct)

Context MCP is read-only. Decision records, state updates, execution logs, and workflow transitions go through Next.js API route handlers (`apps/web/app/api/**`) using `@sanity/client` mutations. Simpler than wiring a second MCP client.

```
Endpoint: https://<projectId>.api.sanity.io/v2024-10-01/data/mutate/<dataset>   (via @sanity/client)
Auth:     Bearer <SANITY_AUTH_TOKEN>
```

## 8. The decision object (auditability without private reasoning traces)

We do not store chain-of-thought. We store the **decision artifact**:

```
decision {
  question
  context[]              // refs to entity, capability, policy docs that were considered
  candidateActions[]
  selectedAction
  reasoningSummary       // one-paragraph human-readable explanation
  evidence[]             // refs to evidence docs supporting the choice
  constraints[]
  policyChecks[]         // [{ policy (ref), result: applies|superseded|conflicts|inapplicable, reason }]
  riskLevel              // 0-5, computed by kernel
  requiredApproval       // bool, computed by kernel
  status                 // proposed | awaiting-approval | approved | rejected | executed
                         //   | failed | rollback-proposed | rolled-back
  kind                   // plan | rollback  (rollbackOf → the decision being rolled back)
  process                // { definition ref, version, revision } of the lifecycle in force
  processHistory[]       // one row per transition: from, to, transition, actor, version, _rev, at
  reviewerNotes          // the independent reviewer's advisory output
  createdAt
  approvedBy?            // ref to entity (human) if status >= approved
  executedAt?
}
```

Judges see *why* without exposing internal LLM scratch space.

## 8. The kill-shot demo moment

A policy conflict surfaced mid-decision. What the kernel computes for the
parameter change (the card shows these fields; wording of the plan varies
per run):

```
PROPOSED ACTION   Adjust CNC 2 controller parameter X by +5%
Actor             Engineering Agent (holds Process Parameter Modification ✓)
Risk              5 / 5   ·  reversible: no
Policy conflict   Multiple non-superseded policies share scope
                  "production.parameter_changes": Operations Policy 17,
                  Emergency Policy 4
Recommendation    request-approval  →  Awaiting human approval (route-to-human)
```

The contradicting evidence (Historical Incident #17: worn hydraulic seal,
confidence 0.92) is surfaced by the agent and by the Knowledge Base's own
contradiction detection, not by the kernel.

That single interaction demonstrates: structured content, relationships, provenance, policy, authority, reasoning, workflow, human-in-the-loop, agent execution.

## 8b. Process engine: workflows the kernel executes

The `workflow` document type (Studio label: "Process definition") is
executable. `packages/kernel/src/process.ts` runs it:

```
ProcessDefinition { id, name, version, revision (_rev), initialState,
                    states[{ id, label, terminal }],
                    transitions[{ id, from, to, automatic, requiresHumanApproval,
                                  guard: { all[], any[] } of { fact, op, value } }] }

validateProcessDefinition(def)      // ids, dangling refs, reachability, dead ends, guard shape
evaluateGuard(guard, facts)         // closed operator set; missing fact → false; no eval
authorizeTransition({ definition, currentState, transitionId | to, facts, actor })
nextAutomaticTransition(def, state, facts)   // first automatic transition whose guard holds
historyEntry(def, decision, actor, at)       // audit row incl. version + revision
```

Principles:

- **Guards are data, never code.** No string is ever evaluated, so a
  definition, even one an agent proposes later, can't inject logic
  into the kernel.
- **Fail closed.** Missing facts fail their conditions. An invalid
  definition authorizes nothing. `requiresHumanApproval` transitions
  refuse non-human actors.
- **Auditable.** Every allowed transition appends `processHistory` on the
  decision with the definition version and `_rev`. Writes use
  `ifRevisionId`, so a stale click can't apply a transition from an old
  state.
- **Single source of truth.** `apps/studio/seed/workflows.ts` is both the
  Sanity seed and the kernel test fixture. `process-document.ts`
  round-trips it to Sanity's typed fields, and that round trip is tested.

The **Decision Lifecycle** definition governs every `decision`:

```
proposed ─kernel-reject (auto)──────────────▶ rejected ■
proposed ─auto-approve (auto, risk ≤ 2)─────▶ approved
proposed ─route-to-human (auto)─────────────▶ awaiting-approval
awaiting-approval ─approve / reject (human)─▶ approved / rejected ■
awaiting-approval ─request-evidence (human)─▶ awaiting-approval
approved ─execute (execution.success)───────▶ executed | failed
executed ─propose-rollback (human, deviation observed)─▶ rollback-proposed
failed   ─propose-rollback-after-failure (human)─▶ rollback-proposed
rollback-proposed ─complete-rollback (rollback executed)─▶ rolled-back ■
rollback-proposed ─retry-rollback (human; last attempt failed, none pending)─▶ rollback-proposed
```

8 states, 12 transitions. `route-to-human` is the catch-all for every
decision that isn't hard-blocked and isn't auto-approved (v3), so tightening
the auto-approve ceiling in Studio is a one-number edit.

v2 (after the Sep 22 live stress test) also restricts rollback proposals to
`decision.kind = plan`, so a rollback is never rolled back. It also adds
`POST /api/decisions/[id]/resume`, which re-runs the automatic step for a
decision held in `proposed` (for example while the definition was invalid),
using the kernel verdict stored on the decision.

Wiring: `apps/web/lib/process-engine.ts`, used by `/api/plan` and
`/api/decisions/[id]/{action,execute,observe,rollback,resume}`. It's behind
`QUICKSILVER_PROCESS_ENGINE=on`. If the definition isn't in the
dataset, the routes fall back to their built-in checks. If it's present
but invalid, the decision routes return 409 and move nothing, and
`/api/plan` still records the plan but holds every decision in `proposed`
(resumable once the definition is fixed).

## 9. Things we are NOT building

- Real robotic control
- Real financial transactions
- Multi-tenant architecture
- Auth complexity (single-user demo)
- Full ERP, CRM, HR, payroll
- Multiple specialized agents (CEO agent, COO agent, …) — one primary agent with a kernel
- A general-purpose autonomous agent marketplace

## 10. Day 1 open questions (all resolved)

- [x] Sanity org ID: `ou5ydq271`, Context enabled
- [x] Public dataset for judge inspection: `production` is public
- [x] Enter both paths: yes
- [x] Working demo: live at https://quicksilver-seven.vercel.app
