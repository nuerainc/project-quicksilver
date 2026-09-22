<!--
DEV.to submission post -- Path One ("Ship an Agent That Queries Real Content").
Paste this into DEV's Path One submission template (dev.to/new, using the
challenge's prefilled Path One template). Required tag: #sanitychallenge.
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

**Processes are content too.** The `workflow` type isn't documentation.
It holds executable *process definitions*: states, transitions, and
structured guards like `kernel.riskLevel lte 2`, never code strings. The
kernel runs them. Every decision moves through a **Decision Lifecycle**
process stored in Sanity. The kernel takes the first automatic transition
whose guard holds (hard block → rejected, low risk → auto-approved,
everything else → a human), refuses illegal jumps with a plain-English
reason, requires a human for approve/reject/rollback, and stamps the
definition's version and `_rev` on every step in the decision's process
history. The company's autonomy ceiling is a number in a Sanity document:
edit it in Studio and the app's behavior follows. An invalid definition
(unreachable state, dead end, malformed guard) stops the kernel moving
anything, rather than being bypassed.

The judging question here is: *could this just have been keyword search?*
No. A keyword search finds "Engineering approval is required for
parameter changes." It doesn't find whether the policy applies vs. is
superseded or expired, whether the actor has the capability in the
company model, whether a higher-priority policy conflicts, whether
evidence contradicts the recommendation at 0.92 confidence, or what the
rollback procedure is. Quicksilver surfaces all of that *because* the
data is structured.

## Demo

**Live, deployed, click-through: https://quicksilver-seven.vercel.app**

No login required — the CEO Intent box comes pre-filled with the seed
objective. Click **SEND TO QUICKSILVER**, then scroll past the Plan
paragraph and the Required Capabilities / Constraints sections to the
four cards under **DECISIONS**. Each one carries a dashed **INDEPENDENT
REVIEW** block, kept visually separate from the kernel's own
risk/authority computation above it. Go straight to the **fourth card**
("Plan a staged firmware update…") if you're short on time — its
independent review throws a real ⚠️ flag in red: the proposal doesn't
specify alignment with Operations Policy 17. That's not scripted for the
demo; it's the reviewer model catching a real policy gap against
structured data, live. From there: approve, execute (simulated), and
observe the metric move.

Each card also carries a **Process** line: *Decision Lifecycle v1 ·
Awaiting human approval (via route-to-human) · Next: Approve (human) ·
Reject (human)*. That is the kernel running a process definition read
from Sanity. A card the kernel rates low-risk (risk ≤ 2) arrives already
approved, marked *"Auto-approved by the kernel."* If a metric moves the
wrong way after execution, you can propose, approve, and execute a
rollback, and the original decision moves to *rolled back*. The
**Decision log** page shows every decision's full process history.

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

Sanity also holds the company's **processes**. The two `workflow`
documents (Decision Lifecycle, Production Parameter Change) are process
definitions with structured guards, edited in Studio like any other
content and read by the kernel on every state change. Round-tripping
them to and from Sanity's typed fields is covered by the kernel's tests,
so what's in Content Lake is exactly what the kernel runs.

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

The full day-by-day build history — every environment, every real error
hit and how it was fixed, the final file inventory, and the exact handoff
points between them — lives in one unified log:
[`BUILD-LOG.md`](https://github.com/nuerainc/quicksilver-sanity-challenge/blob/main/BUILD-LOG.md).
Short version: **MiniMax Agent** built the architecture-through-hardening
pass end to end (schema lock, kernel, agent harness, the full Next.js app,
seed data with the deliberate policy conflict, first submission drafts);
**Claude Code** (via Cowork) then took it the rest of the way — the real
Knowledge Base Context MCP integration, the independent reviewer wired
into the live `/api/plan` route, three real bugs found and fixed (a
kernel risk-tier edge case, and the same strict-JSON-schema mistake made
twice), the live Vercel deployment, the Sanity Workflows bonus, and
the kernel's process engine that runs Sanity-stored process definitions.

---

#sanitychallenge #ai #webdev #typescript
