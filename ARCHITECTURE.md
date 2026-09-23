# Quicksilver — Architecture

> Internal design document. Updated as decisions lock.

---

## 1. The model

A company is not a document. It is a graph of **entities** (humans, agents, systems, services) bound by **policies**, **capabilities**, **permissions**, and **evidence**, pursuing **objectives** through **workflows**, producing and consuming **state**.

Quicksilver's job is to make that graph **machine-queryable**, **reason-over-able**, and **authoritative**.

## 2. The schema (locked Day 1, refined Days 2–5)

Ten document types. Enough to express the company; few enough to keep authoring manageable.

| Type | Purpose | Status |
|---|---|---|
| `organization` | The fictional company (root doc) | stub |
| `department` | Organizational units with leader, members, capabilities, objectives | stub |
| `entity` | The unified entity abstraction (human, agent, robot, service, system, contractor) | stub |
| `capability` | What can be done, by whom, with what risk and tools | stub |
| `policy` | Rules with scope, priority, supersedes, appliesTo, approvalRequirements | stub |
| `objective` | Goal with deadline, constraints, successMetrics, budget, status | stub |
| `workflow` | State machine: states, transitions, requiredCapabilities, rollback | stub |
| `evidence` | Source of truth with type, claim, confidence, supports/contradicts | stub |
| `decision` | Auditable record: question, evidence, candidateActions, selectedAction, policyChecks, riskLevel, status | stub |
| `metric` | Measurable state with baseline + direction; not seeded — created at runtime by the closed-loop execute/observe flow | stub |

Schema lives in `apps/studio/schemas/`. Deployed via `sanity schema deploy` (required for Context MCP GROQ mode).

### The `entity` abstraction (key insight)

```
entity {
  name
  entityType     // human | agent | robot | service | contractor | system
  capabilities[] // refs to capability docs
  permissions[]  // refs to policy/permission docs
  constraints[]  // derived at runtime by kernel
  reportsTo      // ref to entity
  department     // ref to department
  availability
  riskProfile
  costProfile
}
```

This lets the kernel reason about humans and machines using **the same organizational primitive**. Crucial for "the agent" being just another entity with a `entityType: agent`.

## 3. The runtime

```
            USER (CEO)
               │
               ▼
      ┌──────────────────┐
      │  Quicksilver UI  │   Next.js App Router
      │  (apps/web)      │
      └─────────┬────────┘
                │
                ▼
      ┌──────────────────┐
      │  Agent runtime   │   packages/agent
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
      │  Quicksilver     │   packages/kernel
      │  Kernel          │
      │                  │   DETERMINISTIC — no LLM
      │  • capability    │
      │  • authority     │
      │  • risk          │
      │  • approval      │
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
      Next.js server action → Sanity HTTP API → Content Lake (writes)
```

## 4. Architectural principle: separate cognition from authority

The LLM proposes. The kernel authorizes. **Never** the other way around.

```ts
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

## 5. Model configuration

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

A bake-off (Day 14–15) would test `gemini-3.8-flash` against `gpt-5.6-sol` for the planner role. Google's explicit positioning of Gemini 3.8 Flash for "autonomous agents and complex enterprise workflows" makes it a serious candidate.

## 6. The MCP integration

### Reads — Sanity Context MCP (hosted, read-only)

```
Endpoint: https://api.sanity.io/v1/context/organizations/:orgId/mcp/:endpointName
Auth:     Bearer <SANITY_ORG_TOKEN with Context Viewer permission>
Modes:    GROQ (live dataset, structured) | Knowledge Base (compiled index)
Tools:    initial_context, schema_explorer, groq_query, array_field_reader (GROQ)
          initial_context, knowledge_base_read (KB)
```

Prerequisites:
- Context enabled on org (Manage → Labs → Context)
- Org API token with `Context Viewer` grant
- For GROQ mode: `sanity schema deploy` (Studio ≥5.1.0)

### Writes — Sanity HTTP API (direct)

Context MCP is read-only. Decision records, state updates, execution logs, and workflow transitions go through Next.js server actions → Sanity HTTP API. Simpler than wiring a second MCP client.

```
Endpoint: https://<projectId>.api.sanity.io/v2024-01-01/data/mutate/<dataset>
Auth:     Bearer <SANITY_WRITE_TOKEN>
```

## 7. The decision object (auditability without CoT)

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
  policyChecks[]         // [{ policyId, result: applies|superseded|conflicts, reason }]
  riskLevel              // 0-5, computed by kernel
  requiredApproval       // bool, computed by kernel
  status                 // proposed | approved | rejected | executed | failed
  createdAt
  approvedBy?            // ref to entity (human) if status >= approved
  executedAt?
}
```

Judges see *why* without exposing internal LLM scratch space.

## 8. The kill-shot demo moment

A policy conflict surfaced mid-decision:

```
PROPOSED ACTION

Change CNC controller parameter X.

Capability:    Engineering Agent ✓
Permission:   Production Systems ✓
Evidence:     3 supporting reports ✓

Policy conflict detected:
  Operations Policy 17     "Approval required for parameter changes."
  Emergency Policy 4        "Automatic changes permitted under emergency conditions."
  Current incident status:  NOT classified as emergency.

Risk: 4 / 5
Reversibility: ✗ (requires controlled rollback)

→ HUMAN APPROVAL REQUIRED
```

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
approved ─execute (execution.success)───────▶ executed | failed
executed ─propose-rollback (human, deviation observed)─▶ rollback-proposed
failed   ─propose-rollback (human)──────────▶ rollback-proposed
rollback-proposed ─complete-rollback (rollback executed)─▶ rolled-back ■
rollback-proposed ─retry-rollback (human; last attempt failed, none pending)─▶ rollback-proposed
```

v2 (after the Sep 22 live stress test) also restricts rollback proposals to
`decision.kind = plan`, so a rollback is never rolled back. It also adds
`POST /api/decisions/[id]/resume`, which re-runs the automatic step for a
decision held in `proposed` (for example while the definition was invalid),
using the kernel verdict stored on the decision.

Wiring: `apps/web/lib/process-engine.ts`, used by `/api/plan` and
`/api/decisions/[id]/{action,execute,observe,rollback}`. It's behind
`QUICKSILVER_PROCESS_ENGINE=on`. If the definition isn't in the
dataset, the routes fall back to their built-in checks. If it's present
but invalid, they return 409 and move nothing.

## 9. Things we are NOT building

- Real robotic control
- Real financial transactions
- Multi-tenant architecture
- Auth complexity (single-user demo)
- Full ERP, CRM, HR, payroll
- Multiple specialized agents (CEO agent, COO agent, …) — one primary agent with a kernel
- A general-purpose autonomous agent marketplace

## 10. Open questions (Day 1)

- [ ] Sanity org ID (Context MCP requires org-level setup)
- [ ] Public dataset for judge inspection
- [ ] Whether to enter both paths (decision: yes)
- [ ] Demo video length target (3 min)