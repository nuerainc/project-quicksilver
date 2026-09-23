# Quicksilver — Sanity Challenge Submission

> An Autonomous Company Operating System that turns a company's structure,
> rules, capabilities, objectives, and current state into a machine-readable
> operating model that AI agents can reason over and act against.

---

## Paths

| Path | Title | DEV post |
|---|---|---|
| **Path One** — *Ship an Agent That Queries Real Content* | Quicksilver: An Autonomous Company Operating System | [`docs/DEV-POST-PATH-ONE.md`](./docs/DEV-POST-PATH-ONE.md) |
| **Path Two** — *Vibe-Code Something Strange* | Quicksilver: The Company That Operates Itself | [`docs/DEV-POST-PATH-TWO.md`](./docs/DEV-POST-PATH-TWO.md) |

Same codebase, two distinct narratives. Two separate DEV posts required.

See [`BUILD-LOG.md`](./BUILD-LOG.md) for the full day-by-day build history —
one unified log covering all three environments that touched this repo
(MiniMax Agent's initial architecture-through-hardening pass, Claude
Code via Cowork's integration/deploy pass covered in this document, and
the user's own manual work in VS Code), with explicit handoff notes
between them.

---

## Repository

https://github.com/nuerainc/quicksilver-sanity-challenge (public, MIT licensed)

## Live deployment

**https://quicksilver-seven.vercel.app** — deployed on Vercel, no login
required, running against real Azure LLM + Sanity infrastructure
end-to-end (verified: plan → kernel authorization → independent review →
approve → simulated execute → observe → rollback). The **Decision log**
(https://quicksilver-seven.vercel.app/decisions) shows every decision on
record with its full process history.

**Studio:** https://qkslvr.sanity.studio (a Sanity login with project
access is required; the dataset itself is public, see below).

## Required Sanity Information

| Field | Value |
|---|---|
| Project URL | https://www.sanity.io/organizations/ou5ydq271/project/d280bqjc |
| Organization ID | `ou5ydq271` |
| Project ID | `d280bqjc` |
| Dataset (default) | `production` (**public** — confirmed in Sanity Manage → Datasets) |
| Public dataset access | [See details below](#the-dataset-is-public-for-judges) |
| Testing access | No login required for the app or the dataset — Quicksilver has no auth. The deployed Studio needs a Sanity login. |

### The dataset is public for judges

The judging criteria explicitly call out that judges will inspect the
dataset directly. `d280bqjc/production` is set to **public** visibility
(confirmed in Sanity Manage → Datasets):

1. Public dataset URL form: `https://d280bqjc.apicdn.sanity.io/data/query/production?query=*` (judges can hit this with any GROQ, no token required).
2. To reproduce or re-verify this yourself (from `apps/studio`): `npx sanity dataset visibility set production public`, then confirm with `npx sanity dataset list`.
3. Note that a *public dataset* is still separate from write access — creating/editing decisions through the app still requires the project-scoped `SANITY_AUTH_TOKEN` described below; only reads are open.

### Context MCP endpoints (for judges who want to drive the agent directly)

Both endpoints are live:

```
# GROQ-mode (live dataset, structured)
https://api.sanity.io/v1/context/organizations/ou5ydq271/mcp/quicksilver-agent

# Knowledge Base mode (compiled index, 9 cited entries built from the
# evidence + policy documents, with one contradiction — parameter drift
# vs. mechanical failure — flagged by Sanity's own detection and left
# unresolved by design)
https://api.sanity.io/v1/context/organizations/ou5ydq271/mcp/quicksilver-knowledge-base
```

Both are wired into the agent (`packages/agent/src/mcp.ts` connects to
both and merges their tool sets) and verified end-to-end via
`npm run verify:mcp` — including a real `knowledge_base_read` call
against the live KB.

Both require a bearer token (org-scoped, **Context Viewer** permission)
that is not published here. You don't need one to evaluate the project:
the live deployment runs the same agent against both endpoints on every
plan, and the dataset itself is public.

---

## How to run locally

```bash
git clone https://github.com/nuerainc/quicksilver-sanity-challenge.git
cd quicksilver-sanity-challenge
npm install

# .env at the project root — fill in:
#   NEXT_PUBLIC_SANITY_PROJECT_ID=d280bqjc
#   NEXT_PUBLIC_SANITY_DATASET=production
#   SANITY_ORG_ID=ou5ydq271
#   SANITY_AUTH_TOKEN=<project-scoped Editor token>
#   SANITY_CONTEXT_TOKEN=<org-scoped Context Viewer token>   # for MCP (both endpoints)
#   SANITY_CONTEXT_KB_MCP_URL=https://api.sanity.io/v1/context/organizations/ou5ydq271/mcp/quicksilver-knowledge-base   # optional: adds KB-mode
#   AZURE_RESOURCE_NAME=<resource>     # Azure OpenAI / Foundry (deployments: qs-planner,
#   AZURE_API_KEY=<key>                #   qs-reviewer, qs-router, qs-executor)
#   -- or direct provider keys instead of Azure --
#   OPENAI_API_KEY=sk-...
#   ANTHROPIC_API_KEY=sk-ant-...       # optional, for Sonnet 5 reviewer
#   GOOGLE_GENERATIVE_AI_API_KEY=...  # optional, for Gemini 3.8 Flash

# Deploy schema (GROQ mode in Sanity Context MCP requires this)
npm run schema:deploy

# Push the demo dataset
npm run seed

# (Or push only the process definitions the kernel runs)
npm run seed:processes

# Turn on the process engine (decision status changes authorized by the
# kernel against the Decision Lifecycle process definition in Sanity):
#   QUICKSILVER_PROCESS_ENGINE=on   in .env

# Smoke test the dataset integrity
npm run smoke

# Verify Context MCP connection
npm run verify:mcp

# Verify the LLM (each role responds; planner/reviewer do tools + structured output)
npm run verify:llm

# Run the kernel tests (authorization + process engine: 39 tests)
npm run kernel:test

# Run the agent tests (model config + strict-schema guards: 13 tests)
npm run agent:test

# Live end-to-end test (Resume after a broken process definition; Retry after
# a rollback that fails). Passed 44/44 against production on Sep 23, 2026.
# It writes to the dataset and briefly breaks the Decision Lifecycle, so it
# needs SANITY_AUTH_TOKEN and a deployment you control with
# QUICKSILVER_PROCESS_ENGINE=on and QUICKSILVER_ALLOW_FAULT_INJECTION=on
# (off in production). Point it with QUICKSILVER_E2E_BASE_URL; add
# -- --cleanup to delete what it created.
npm run e2e:live

# Start the Studio (localhost:3333)
npm run dev:studio

# Start Quicksilver (localhost:3000)
npm run dev:web
```

---

## Demo video

The live deployment above (https://quicksilver-seven.vercel.app) already
satisfies the "working demo or deployed project" requirement — judges can
click through it directly with no setup. A recorded walkthrough is
optional polish: see [`docs/DEMO-SCRIPT.md`](./docs/DEMO-SCRIPT.md) for
the 3-minute script if recorded before Oct 4.

---

## What we built

Ten document types make up the company model:

- `organization` — root doc
- `department` — units with leader, members, objectives
- `entity` — the unified human/agent/system/contractor primitive
- `capability` — what can be done, by whom, at what risk
- `policy` — rules with priority, supersedes, approval requirements
- `objective` — goal with constraints and budget
- `workflow` — an executable process definition (shown in Studio as "Process definition"): states, transitions, structured guards, run by the kernel
- `evidence` — claim with confidence and explicit `contradicts[]`
- `decision` — auditable artifact: question, evidence, policy checks, risk, status
- `metric` — measurable state with baseline + direction (closed-loop support)

The **Quicksilver Kernel** is a deterministic TypeScript library that:

- checks capability (does the actor have it AND is it granted)
- checks authority (which policies apply, which are superseded, which conflict)
- computes risk (deterministic, tiered: capability base risk + impact tier + irreversibility + high uncertainty, clamped 0–5)
- routes to approval gate (autonomous / request-approval / reject)
- runs process definitions stored in Sanity (`packages/kernel/src/process.ts`):
  validates them (reachability, dead ends, guard shape), evaluates
  structured guards with no string evaluation and fail-closed on missing
  facts, authorizes every decision status change, requires a human where
  the definition says so, and stamps the definition's version and `_rev`
  in the decision's process history. Behind `QUICKSILVER_PROCESS_ENGINE=on`.

The **LLM proposes, the kernel authorizes**. Never the other way around.
And the kernel's own processes are content, not code.

The **AI SDK 6 agent harness** uses `@ai-sdk/mcp` with role-based model
configuration. Two roles run live on every plan:

- **planner** — proposes the plan and candidate actions (in production: Azure deployment `qs-planner`; direct-provider default `gpt-5.6-sol`)
- **reviewer** — independent, advisory second opinion on each action (Azure `qs-reviewer`; direct default `claude-sonnet-5`)

`router` and `executor` roles are configured (`packages/agent/src/models.ts`)
and checked by `npm run verify:llm`, but nothing calls them at runtime yet:
execution is simulated.

The agent reads the company model through Sanity Context MCP (GROQ and
Knowledge Base modes). The API routes read the kernel's facts and the
process definition directly with `@sanity/client`, and all writes go
through `@sanity/client` mutations (Context MCP is read-only).

## What we deliberately did NOT build

- Real production control
- Multi-tenant architecture
- Auth complexity (single-user demo)
- Multiple specialized agents (one primary agent + reviewer)
- CRM, HR, payroll, billing — full ERP

That's future Quicksilver. Competition Quicksilver proves the operating-system
abstraction, end-to-end, with one vertical slice.
