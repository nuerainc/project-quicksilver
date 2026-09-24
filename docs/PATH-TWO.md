> **Historical record: Sanity Challenge submission.** This document belongs to
> **Quicksilver**, our Sanity Challenge 2026 entry, which lives at
> [nuerainc/quicksilver-sanity-challenge](https://github.com/nuerainc/quicksilver-sanity-challenge).
> A copy is kept here because Nuera Quicksilver was inspired by that submission.
> It does not describe this repository, and the live demo it mentions is the
> challenge deployment, not a deployment of Nuera Quicksilver.

> **Superseded.** This was an early draft. The posts to publish are
> [`DEV-POST-PATH-TWO.md`](./DEV-POST-PATH-TWO.md); the repo overview is the
> [README](../README.md). Kept for the build history.

# Path Two post — *Quicksilver: The Company That Operates Itself*

> Path: **Vibe-Code Something Strange**

---

## Headline

**I built a company that runs itself. A scope-disciplined solo build. Three judges.**

## The line

`Company → State → Intent → Decision → Action → State`

That loop is the whole product. Everything else — schema, kernel, agent,
MCP wiring, UI — exists to make the loop honest. If the loop can be
faked with a chatbot, Quicksilver doesn't need to exist.

---

## Body

Quicksilver is an Autonomous Company Operating System. You give it an
objective ("Reduce production downtime by 20%"); it answers with a
plan, asks for approval when the plan crosses a risk threshold, executes
the approved action against a measurable metric, observes the result,
and — if the metric drifts the wrong way — proposes a rollback and
flags the underlying cause.

The shape isn't a chatbot. It isn't a workflow engine. It's the
**operating layer** for a fictional company called Northforge
Manufacturing, sitting on a structured model with ten interconnected
document types, a deterministic authorization kernel, and an LLM agent
that knows its place: the kernel authorizes; the agent proposes.

## What actually lives in the repo

The company model — organizations, departments, humans, agents, robots,
capabilities, policies, evidence, objectives, decisions, metrics — is
all structured content in Sanity. Ten document types, a Studio schema
that ships in the repo, 53 seed docs covering a manufacturing scenario
deliberately engineered with a policy conflict and contradicting
evidence so the agent has *real* things to reason over. (`metric` docs
aren't part of the seed — they're created at runtime by the closed-loop
execute/observe flow.) A second layer sits on top of the same 12
evidence/policy docs: a Sanity Knowledge Base, built and served through
its own Context MCP endpoint, whose own contradiction-detection pass
flags the parameter-drift-vs-mechanical-failure conflict for review —
not something Quicksilver had to build itself.

The kernel is plain TypeScript. Capability check, authority check,
risk computation, approval gate. Hard blocks reject. Soft concerns
escalate. The LLM never gets to authorize; the kernel is authoritative.

The UI is operating-console, not chatbot-landing. It opens on a single
CEO-intent box, not a multi-objective dashboard — that's a deliberate
scope cut, not an oversight (see "What we deliberately didn't build"
below). You type an objective, see the proposed plan, see the kernel's
reasoning on each candidate action, see policies and evidence cited,
click Approve or Reject. After approval, you can simulate execution,
observe the metric, and propose a rollback if needed. All without
leaving the page.

## Vibe-coding moment

The shortest path from "I want a company that operates itself" to a
running demo was: lock the schema first, ship a kernel next, wire Sanity
Context MCP, ship an AI SDK agent that uses the MCP tools, build a
deterministic authority flow with policy-conflict surfacing, build the
approval UI as one component, then close the loop with simulated
execution and rollback.

What I deliberately **didn't** build, and why:
- A multi-objective dashboard. One CEO-intent box, one plan, one
  decision at a time. A grid of "active objectives" is a bigger UI
  than a three-judge demo needs.
- Real production control. The demo is safe; a real CNC would not be.
- Multi-tenant architecture. Single user, one demo path.
- Auth complexity. Single-user demo, no signup.
- CRM, HR, payroll, billing. ERP is the trap. The trap costs you the
  contest.
- A "general-purpose autonomous agent marketplace." That's a
  different product.
- Many specialized agents (CEO Agent, COO Agent, CFO Agent, …).
  Sounds impressive, drowns the demo in orchestration complexity.
  One primary agent + reviewer + deterministic kernel is enough.

## Why Path Two specifically

Path Two is judged on quality of build process, finish, schema
thoughtfulness, and originality — *not* on which AI features you
wrapped. So I treated it as a single-author, scope-disciplined build:
lock the schema on Day 1, ship something runnable every day, defer the
polish to the last two days, don't add anything the judging criteria
didn't ask for.

The thing I'm proudest of: the policy conflict (Operations Policy 17
vs. Emergency Policy 4, both in scope `production.parameter_changes`)
and the contradicting evidence (Historical Incident #17 says the
underlying cause is mechanical, not parameter drift) are *encoded into
the seed data*. The agent doesn't encounter a fake conflict for the
demo; it encounters a real conflict the kernel has to adjudicate.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Next.js 15, TypeScript, Tailwind |
| Knowledge substrate | Sanity Studio + Content Lake + Context MCP + Knowledge Bases |
| Agent | AI SDK 6 + `@ai-sdk/mcp` + multi-model ensemble (`gpt-5.6-sol`, `claude-sonnet-5`, `gpt-5.6-luna`, `gemini-3.8-flash`) |
| Authority | Quicksilver Kernel (deterministic TypeScript, no LLM) |

## Testing access

No login required for the app or the dataset — Quicksilver has no auth
layer. The deployed Sanity Studio needs a Sanity login.

## Repo & project

- Project: https://www.sanity.io/organizations/ou5ydq271/project/d280bqjc
- Repo: https://github.com/nuerainc/quicksilver-sanity-challenge
- Demo video: (filled in at submission)
