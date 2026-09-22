# Quicksilver — Sanity Challenge Submission

> An Autonomous Company Operating System that turns a company's structure,
> rules, capabilities, objectives, and current state into a machine-readable
> operating model that AI agents can reason over and act against.

---

## Paths

| Path | Title | Post draft |
|---|---|---|
| **Path One** — *Ship an Agent That Queries Real Content* | Quicksilver: An Autonomous Company Operating System | [`docs/PATH-ONE.md`](./docs/PATH-ONE.md) |
| **Path Two** — *Vibe-Code Something Strange* | Quicksilver: The Company That Operates Itself | [`docs/PATH-TWO.md`](./docs/PATH-TWO.md) |

Same codebase, two distinct narratives. Two separate DEV posts required.

---

## Required Sanity Information

| Field | Value |
|---|---|
| Project URL | https://www.sanity.io/organizations/ou5ydq271/project/d280bqjc |
| Organization ID | `ou5ydq271` |
| Project ID | `d280bqjc` |
| Dataset (default) | `production` |
| Public dataset access | [See instructions below](#making-the-dataset-public-for-judges) |

### Making the dataset public for judges

The judging criteria explicitly call out that judges will inspect the
dataset directly. To make `d280bqjc/production` readable without auth:

1. In your terminal: `npx sanity@latest dataset visibility set production public`
2. Confirm with: `npx sanity@latest dataset list` — should show `visibility: public`
3. In Sanity Manage → API → Tokens, ensure your read-only token has **Viewer** scope on the project (the seed loader uses it via `SANITY_AUTH_TOKEN`).
4. Public dataset URL form: `https://d280bqjc.apicdn.sanity.io/data/query/production?query=*` (judges can hit this with any GROQ).

### Context MCP endpoints (for judges who want to drive the agent directly)

Once enabled in the dashboard:

```
# GROQ-mode (live dataset, structured)
https://api.sanity.io/v1/context/organizations/ou5ydq271/mcp/<your-endpoint-name>

# Knowledge Base mode (compiled index — separate endpoint)
https://api.sanity.io/v1/context/organizations/ou5ydq271/mcp/<your-kb-endpoint-name>
```

Token (org-scoped, **Context Viewer** permission):
The submission window is short; rotate the test token and reissue a clean
one before Oct 4 if you want judges to drive the agent. Otherwise, the
included demo video shows the full flow.

---

## How to run locally

```bash
git clone <this-repo>
cd quicksilver
npm install

# .env at the project root — fill in:
#   NEXT_PUBLIC_SANITY_PROJECT_ID=d280bqjc
#   NEXT_PUBLIC_SANITY_DATASET=production
#   SANITY_ORG_ID=ou5ydq271
#   SANITY_AUTH_TOKEN=<project-scoped Editor token>
#   SANITY_CONTEXT_TOKEN=<org-scoped Context Viewer token>   # for MCP
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

# Smoke test the dataset integrity
npm run smoke

# Verify Context MCP connection
npm run verify:mcp

# Verify the LLM (each role responds; planner/reviewer do tools + structured output)
npm run verify:llm

# Run the kernel tests (the deterministic authorization layer)
npm run kernel:test

# Start the Studio (localhost:3333)
npm run dev:studio

# Start Quicksilver (localhost:3000)
npm run dev:web
```

---

## Demo video

See [`docs/DEMO-SCRIPT.md`](./docs/DEMO-SCRIPT.md) for the 3-minute script.
Recording to do before Oct 4.

---

## What we built

Ten document types make up the company model:

- `organization` — root doc
- `department` — units with leader, members, objectives
- `entity` — the unified human/agent/system/contractor primitive
- `capability` — what can be done, by whom, at what risk
- `policy` — rules with priority, supersedes, approval requirements
- `objective` — goal with constraints and budget
- `workflow` — state machine: states, transitions, rollback
- `evidence` — claim with confidence and explicit `contradicts[]`
- `decision` — auditable artifact: question, evidence, policy checks, risk, status
- `metric` — measurable state with baseline + direction (closed-loop support)

The **Quicksilver Kernel** is a deterministic TypeScript library that:

- checks capability (does the actor have it AND is it granted)
- checks authority (which policies apply, which are superseded, which conflict)
- computes risk (deterministic formula clamped 0–5)
- routes to approval gate (autonomous / request-approval / reject)

The **LLM proposes, the kernel authorizes**. Never the other way around.

The **AI SDK 6 agent harness** uses `@ai-sdk/mcp` with role-based model
configuration:

- **planner**: `gpt-5.6-sol` (or `gemini-3.8-flash` after bake-off)
- **reviewer**: `claude-sonnet-5`
- **router**: `gpt-5.6-luna`
- **executor**: `gemini-3.8-flash`

All reads go through Sanity Context MCP; all writes go through
`@sanity/client` mutations against the HTTP API (Context MCP is read-only).

## What we deliberately did NOT build

- Real production control
- Multi-tenant architecture
- Auth complexity (single-user demo)
- Multiple specialized agents (one primary agent + reviewer)
- CRM, HR, payroll, billing — full ERP

That's future Quicksilver. Competition Quicksilver proves the operating-system
abstraction, end-to-end, with one vertical slice.
