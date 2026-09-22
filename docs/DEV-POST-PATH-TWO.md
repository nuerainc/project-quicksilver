<!--
DEV.to submission post -- Path Two ("Vibe-Code Something Strange").
Paste this into DEV's Path Two submission template (dev.to/new, using the
challenge's prefilled Path Two template). Required tag: #sanitychallenge.
-->

# Quicksilver: The Company That Operates Itself

**I built a company that runs itself. A scope-disciplined solo build. Three judges.**

`Company → State → Intent → Decision → Action → State`

That loop is the whole product. Everything else — schema, kernel, agent,
MCP wiring, UI — exists to make the loop honest. If the loop can be faked
with a chatbot, Quicksilver doesn't need to exist.

## What I Built

Quicksilver is an Autonomous Company Operating System. You give it an
objective ("Reduce production downtime by 20%"); it answers with a plan,
asks for approval when the plan crosses a risk threshold, executes the
approved action against a measurable metric, observes the result, and —
if the metric drifts the wrong way — proposes a rollback and flags the
underlying cause.

The shape isn't a chatbot. It isn't a workflow engine. It's the
**operating layer** for a fictional company called Northforge
Manufacturing, sitting on a structured model with ten interconnected
document types, a deterministic authorization kernel, and an LLM agent
that knows its place: the kernel authorizes; the agent proposes.

The company model — organizations, departments, humans, agents, robots,
capabilities, policies, evidence, objectives, decisions, metrics — is
all structured content in Sanity. Ten document types, a Studio schema
that ships in the repo, 52 seed docs covering a manufacturing scenario
deliberately engineered with a policy conflict and contradicting evidence
so the agent has *real* things to reason over. A second layer sits on
top of the same evidence/policy docs: a Sanity Knowledge Base, built and
served through its own Context MCP endpoint, whose own
contradiction-detection pass flags the central conflict for review — not
something I had to build myself.

The kernel is plain TypeScript. Capability check, authority check, risk
computation, approval gate. Hard blocks reject. Soft concerns escalate.
The LLM never gets to authorize; the kernel is authoritative. An
independent reviewer model runs alongside it as a second opinion — never
a gate, purely advisory, and visually kept separate in the UI so it's
never mistaken for the kernel's own output.

The UI is operating-console, not chatbot-landing. It opens on a single
CEO-intent box, not a multi-objective dashboard — that's a deliberate
scope cut, not an oversight. You type an objective, see the proposed
plan, see the kernel's reasoning on each candidate action, see policies
and evidence cited, click Approve or Reject. After approval, you can
simulate execution, observe the metric, and propose a rollback if
needed. All without leaving the page.

## Demo

**Live, deployed, click-through: https://quicksilver-seven.vercel.app**

No login required — the CEO intent box comes pre-filled. Click **SEND TO
QUICKSILVER** and scroll past the Plan narrative to **DECISIONS**: four
candidate actions, each with its own dashed **INDEPENDENT REVIEW** block
sitting below the kernel's risk/authority fields. Short on time? Skip
straight to the **fourth card** ("Plan a staged firmware update…") — its
review throws a live ⚠️ policy flag in red, catching that the proposal
never confirms alignment with Operations Policy 17. Nothing about that
flag is scripted; it's the reviewer model actually finding the gap
against structured data. Then: approve, execute (simulated), watch the
metric move.

## Code

Repo: https://github.com/nuerainc/quicksilver-sanity-challenge (public, MIT licensed)

| Layer | Choice |
|---|---|
| Runtime | Next.js 15, TypeScript, Tailwind |
| Knowledge substrate | Sanity Studio + Content Lake + Context MCP + Knowledge Bases |
| Agent | AI SDK 6 + `@ai-sdk/mcp` + multi-model ensemble (`gpt-5.6-sol`, `claude-sonnet-5`, `gpt-5.6-luna`, `gemini-3.8-flash`) |
| Authority | Quicksilver Kernel (deterministic TypeScript, no LLM) |

## My Build Process

The shortest path from "I want a company that operates itself" to a
running demo was: lock the schema first, ship a kernel next, wire Sanity
Context MCP, ship an AI SDK agent that uses the MCP tools, build a
deterministic authority flow with policy-conflict surfacing, build the
approval UI as one component, then close the loop with simulated
execution and rollback. Once the core loop worked end-to-end against
live Azure and Sanity infrastructure, I went back for two more passes:
adding a real Knowledge Base as a second Context MCP mode (rather than
leaving `knowledge_base_read` as a prompt-only reference nothing ever
called), and wiring the independent reviewer into the live decision path
instead of leaving it exercised only by a standalone health check.

What I deliberately **didn't** build, and why:
- A multi-objective dashboard. One CEO-intent box, one plan, one decision
  at a time. A grid of "active objectives" is a bigger UI than a
  three-judge demo needs.
- Real production control. The demo is safe; a real CNC would not be.
- Multi-tenant architecture. Single user, one demo path.
- Auth complexity. Single-user demo, no signup.
- CRM, HR, payroll, billing. ERP is the trap. The trap costs you the
  contest.
- A "general-purpose autonomous agent marketplace." That's a different
  product.
- Many specialized agents (CEO Agent, COO Agent, CFO Agent, …). Sounds
  impressive, drowns the demo in orchestration complexity. One primary
  agent + reviewer + deterministic kernel is enough.

The thing I'm proudest of: the policy conflict (Operations Policy 17 vs.
Emergency Policy 4, both in scope `production.parameter_changes`) and the
contradicting evidence (Historical Incident #17 says the underlying
cause is mechanical, not parameter drift) are *encoded into the seed
data*. The agent doesn't encounter a fake conflict for the demo; it
encounters a real conflict the kernel has to adjudicate — and, separately,
that Sanity's own Knowledge Base build pipeline finds and flags on its
own.

The second thing I'm proud of, in a messier way: this build surfaced
real bugs along the way and I kept the evidence rather than quietly
fixing and forgetting them — a `knowledge_base_read` call that failed
until I introspected its actual JSON Schema instead of guessing its
argument shape, and a kernel edge case where a mid-range risk score
could show "execute autonomously" and "requires human approval" at the
same time, caught during a cleanup pass and fixed with a regression test
that pins the correct behavior down. "Vibe-coded" doesn't mean untested.

**Bonus: Sanity Workflows.** The `decision` document's real-world status
lifecycle (awaiting approval → approved/rejected → executed) is a natural
fit for Sanity's own Workflows plugin, so it's wired in as a lightweight,
purely additive curation layer: `sanity-plugin-workflow`, configured with
a four-state board (Awaiting Approval → Approved / Rejected → Executed)
scoped to the `decision` type, deployed live to the project's Studio at
[qkslvr.sanity.studio](https://qkslvr.sanity.studio/) where the board
renders cleanly as its own tool tab. It tracks its own metadata document
per decision and never touches the kernel-driven `status` field the app
actually reads — a second, editorial view a human reviewer opts individual
decisions into, sitting entirely alongside the app's own approve/reject
buttons rather than replacing them.

**The strangest part: the company's playbook is content, and the kernel
runs it.** Late in the build, the `workflow` document type stopped being
a description and became executable. A process definition in Sanity
declares states, transitions, and structured guards (`{ fact, op, value }`,
never a string the kernel evaluates). The kernel validates it (no
unreachable states, no dead ends, no malformed guards), then authorizes
every decision's status change against it. That covers auto-approval for
low-risk actions, human-only approve/reject/rollback, and plain-English
refusals for illegal jumps. Each step is stamped with the definition's
version and revision. The autonomy ceiling ("never auto-approve above
risk 2") is a number an editor can change in Studio. If someone breaks
the definition, the kernel stops moving decisions rather than bypassing
it. The same file is the Sanity seed and the test fixture, so the 19
process-engine tests exercise exactly what's in Content Lake.

## Sanity Project Details (Required)

| Field | Value |
|---|---|
| Project URL | https://www.sanity.io/organizations/ou5ydq271/project/d280bqjc |
| Organization ID | `ou5ydq271` |
| Project ID | `d280bqjc` |
| Dataset | `production` — **public**, no auth required to read |
| Public dataset query | `https://d280bqjc.apicdn.sanity.io/data/query/production?query=*` |
| Testing access | No login required — Quicksilver has no auth layer; the app, Studio, and dataset are all open. |

## Agent Session (optional but encouraged)

Three environments touched this build, back to back, and the full
day-by-day account — every real error, the rationale behind every
recurring decision, and exactly where each one handed off to the next —
is in one unified log:
[`BUILD-LOG.md`](https://github.com/nuerainc/quicksilver-sanity-challenge/blob/main/BUILD-LOG.md).
Short version: **MiniMax Agent** built the whole thing from scratch across
a 16-day plan compressed into its first ~14 days — schema lock, seed data
with the deliberate policy conflict baked in, kernel, agent harness, the
full approval UI, submission drafts — real errors and all (an ERESOLVE
peer-dependency fight over Sanity 5.x needing React 19 not 18,
`generateObject` not accepting `tools` so the code moved to
`generateText` with `experimental_output`, a free-inference pivot when
the OpenAI budget didn't exist). **VS Code**, manual only, no AI agent,
ran underneath both phases wherever a real terminal command or a real
secret had to be typed by a human. **Claude Code** (via Cowork) picked
the repo up from there for the hardening pass covered in "My Build
Process" above — plus a live Vercel deployment, a second real bug caught
in production, the Sanity Workflows bonus, and this write-up itself.

---

#sanitychallenge #buildinpublic #ai #typescript
