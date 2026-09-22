<!--
DEV.to submission post -- Path One ("Ship an Agent That Queries Real Content").
Paste this into DEV's Path One submission template (dev.to/new, using the
challenge's prefilled Path One template) and fill in the two [TODO] spots
before publishing. Required tag: #sanitychallenge.
-->

# Quicksilver: An Autonomous Company Operating System

**A chatbot reads your documents. Quicksilver reasons over your company.**

`Structured organizational knowledge → agent reasoning → deterministic authority → recorded decision → state update`

## What I Built

Most AI business tools answer questions about your company by searching
documents. They find mentions. They confabulate when nothing matches.
Quicksilver is different: it asks the agent to query a *structured model*
of the company — entities, capabilities, policies, evidence, objectives,
workflows — and then runs the proposed action through a deterministic
authorization kernel before any state changes.

The shape of the company comes from Sanity. Ten document types carry it:
`organization`, `department`, `entity` (one abstraction for humans,
agents, robots, systems, and contractors — same shape, same reasoning),
`capability`, `policy`, `objective`, `workflow`, `evidence`, `decision`,
`metric`.

The kernel is plain TypeScript. No LLM inside it. The LLM proposes a
candidate action; the kernel decides whether the actor has the
capability, which policies apply, how the risk stacks up, and whether
the action is allowed to execute autonomously, requires human approval,
or is hard-blocked. An independent reviewer model adds a second opinion
alongside the kernel's own computation — advisory only, it never gets to
authorize or block anything.

Drop in the seed objective, *"Reduce production downtime by 20% over the
next 30 days without increasing OPEX,"* and the agent decomposes it,
identifies the relevant policies (Operations Policy 17 and Emergency
Policy 4, both in scope `production.parameter_changes`), and proposes
adjusting a CNC controller parameter by 5%. The kernel's authority check
surfaces the conflict (same scope, priority 5 vs. priority 7) and the
historical-incident evidence that contradicts the parameter-adjustment
hypothesis (confidence 0.92). Risk computes to 4 of 5. The recommendation
routes to **human approval**. Approve, execute (simulated), observe a
metric move, and close the loop — the full decision record is persisted
as an auditable `decision` doc in Sanity.

The judging question here is: *could this just have been keyword search?*
No. A keyword search finds "Engineering approval is required for
parameter changes." It doesn't find whether the policy applies vs. is
superseded or expired, whether the actor has the capability in the
company model, whether a higher-priority policy conflicts, whether
evidence contradicts the recommendation at 0.92 confidence, or what the
rollback procedure is. Quicksilver surfaces all of that *because* the
data is structured.

## Demo

[TODO: embed the demo video here once recorded — see the repo's
`docs/DEMO-SCRIPT.md` for the walkthrough this follows: submit the seed
objective, watch the plan come back grounded in real Sanity doc IDs,
watch the kernel surface the policy conflict and the independent
reviewer's notes, approve, execute, observe the metric move, and — if
the metric drifts wrong — propose a rollback.]

## Code

Repo: https://github.com/nuerainc/quicksilver-sanity-challenge (public, MIT licensed)

| Layer | Choice |
|---|---|
| Runtime | Next.js 15, TypeScript, Tailwind |
| Knowledge substrate | Sanity Studio + Content Lake + Context MCP + Knowledge Bases |
| Agent harness | AI SDK 6 + `@ai-sdk/mcp` |
| Models | `gpt-5.6-sol` (planner), `claude-sonnet-5` (reviewer), `gpt-5.6-luna` (router), `gemini-3.8-flash` (executor) — role-based |
| Authority | Quicksilver Kernel (deterministic TypeScript, no LLM) |
| Write path | `@sanity/client` against the Sanity HTTP API |

## How I Used Sanity

Sanity isn't a CMS in this build, it's the operating substrate. Ten
document types model the company, and the agent reads through **two
separate Sanity Context MCP endpoints**, since one endpoint serves one
mode:

- **GROQ mode** (`quicksilver-agent`) exposes `groq_query`,
  `schema_explorer`, and `array_field_reader` over the live dataset for
  structured queries against the current state of the company.
- **Knowledge Base mode** (`quicksilver-knowledge-base`) serves a real
  Sanity Knowledge Base built from the `evidence` and `policy` document
  types, with the `contradicts[]` reference field unfolded so a target
  claim's text and confidence are inlined rather than just linked.
  Sanity's own build pipeline organized this into cited entries and —
  unprompted — flagged the central parameter-drift-vs-mechanical-failure
  conflict as a pending contradiction for human review. That detection is
  a platform feature; nothing about it was hand-built.

The agent's tool set merges both endpoints (`packages/agent/src/mcp.ts`,
aliasing the `initial_context` tool name collision between them to
`kb_initial_context`), and `npm run verify:mcp` exercises both live,
including a real `knowledge_base_read` call.

Writes go through `@sanity/client` mutations against the HTTP API
(Context MCP is read-only) — every plan run persists a `decision`
document with the question, the evidence and policies considered, the
kernel's risk/authority computation, and now the independent reviewer's
notes too, so a judge can see *why* a decision was made without exposing
raw LLM scratch space.

## Sanity Project Details (Required)

| Field | Value |
|---|---|
| Project URL | https://www.sanity.io/organizations/ou5ydq271/project/d280bqjc |
| Organization ID | `ou5ydq271` |
| Project ID | `d280bqjc` |
| Dataset | `production` — **public**, no auth required to read |
| Public dataset query | `https://d280bqjc.apicdn.sanity.io/data/query/production?query=*` |
| Context MCP (GROQ mode) | `https://api.sanity.io/v1/context/organizations/ou5ydq271/mcp/quicksilver-agent` |
| Context MCP (Knowledge Base mode) | `https://api.sanity.io/v1/context/organizations/ou5ydq271/mcp/quicksilver-knowledge-base` |
| Testing access | No login required — Quicksilver has no auth layer; the app, Studio, and dataset are all open. |

## Agent Session (optional but encouraged)

[TODO: after uploading via dev.to/agent_sessions/new, embed it here. It's
this session's own Claude Code transcript — a real record of building the
Knowledge Base integration, hitting and fixing a wrong-argument-shape bug
in `knowledge_base_read`, wiring the independent reviewer into the live
`/api/plan` route, and finding/fixing a real kernel bug (a risk-tier edge
case where the recommendation and the approval requirement could
disagree) along the way.]

---

#sanitychallenge #ai #webdev #typescript
