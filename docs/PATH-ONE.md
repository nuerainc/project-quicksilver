> **Historical record: Sanity Challenge submission.** This document belongs to
> **Quicksilver**, our Sanity Challenge 2026 entry, which lives at
> [nuerainc/quicksilver-sanity-challenge](https://github.com/nuerainc/quicksilver-sanity-challenge).
> A copy is kept here because Nuera Quicksilver was inspired by that submission.
> It does not describe this repository, and the live demo it mentions is the
> challenge deployment, not a deployment of Nuera Quicksilver.

> **Superseded.** This was an early draft. The posts to publish are
> [`DEV-POST-PATH-ONE.md`](./DEV-POST-PATH-ONE.md); the repo overview is the
> [README](../README.md). Kept for the build history.

# Path One post — *Quicksilver: An Autonomous Company Operating System*

> Path: **Ship an Agent That Queries Real Content**

---

## Headline

**A chatbot reads your documents. Quicksilver reasons over your company.**

## Tagline for the cover image

`Structured organizational knowledge → agent reasoning → deterministic authority → recorded decision → state update`

---

## Body

Most AI business tools answer questions about your company by searching
documents. They find mentions. They confabulate when nothing matches.
**Quicksilver is different**: it asks the agent to query a *structured model*
of the company — entities, capabilities, policies, evidence, objectives,
workflows — and then runs the proposed action through a deterministic
authorization kernel before any state changes.

The shape of the company comes from Sanity. Ten document types carry it:
`organization`, `department`, `entity` (one abstraction for humans,
agents, robots, systems, and contractors — same shape, same reasoning),
`capability`, `policy`, `objective`, `workflow`, `evidence`, `decision`,
`metric`. The schema is in the repo at `apps/studio/schemas/`.

The agent reads through Sanity Context MCP — two separate endpoints,
since one endpoint serves one mode. The GROQ-mode endpoint exposes
`groq_query`, `schema_explorer`, and `array_field_reader` over the live
dataset. A second, KB-mode endpoint serves a real Sanity Knowledge Base
built from the `evidence` and `policy` documents (with `contradicts[]`
unfolded so the target claim's text and confidence are inlined, not
just linked) via `knowledge_base_read`. Sanity's own build pipeline
grouped that content into cited entries and flagged the central
parameter-drift-vs-mechanical-failure conflict as a pending contradiction
for review — that detection is a platform feature, not something
Quicksilver had to build. The agent's tool set merges both endpoints
(`packages/agent/src/mcp.ts`), and `npm run verify:mcp` exercises both
live. No keyword search. No fabricated IDs. Every fact the agent cites
is a real Sanity document.

The kernel is plain TypeScript. No LLM inside it. The LLM proposes a
candidate action; the kernel decides whether the actor has the
capability, which policies apply, how the risk stacks up, and whether
the action is allowed to execute autonomously, requires human approval,
or is hard-blocked. Hard blocks (no capability granted, no evidence
available) reject. Soft concerns (policy conflicts, low evidence
confidence) escalate to approval. Risk above the org-defined threshold
always escalates.

Models are role-based. The planner is `gpt-5.6-sol` (or
`gemini-3.8-flash` after a bake-off — Google's positioning of 3.8 Flash
as "engineered for autonomous agents and complex enterprise workflows"
makes it a serious candidate). The reviewer is `claude-sonnet-5`, which
flags concerns independently. Neither reviewer nor planner is allowed
to authorize. The kernel is authoritative.

## What the demo proves

Drop in the seed objective: *"Reduce production downtime by 20% over the
next 30 days without increasing OPEX."* The agent decomposes it,
identifies the relevant policies (Operations Policy 17 and Emergency
Policy 4, both in scope `production.parameter_changes`), and proposes
adjusting a CNC controller parameter by 5%. The kernel's authority
check surfaces the conflict (same scope, priority 5 vs. priority 7) and
the historical-incident evidence that contradicts the parameter-adjustment
hypothesis (confidence 0.92). Risk lands at 5 of 5. Reversibility is
partial. The recommendation routes to **human approval**.

Approve, execute (simulated), observe a metric moved 32 → 25.6 hours
per week, and close the loop. The decision record — what was proposed,
what evidence applied, what policies conflicted, what risk level, who
approved, what was executed — is persisted as a `decision` doc in
Sanity. Auditable. Inspectable.

## Why Path One specifically

The judging asks: *could this just have been keyword search?* No. A
keyword search finds "Engineering approval is required for parameter
changes." It does not find:

- whether the policy applies (vs. is superseded, expired, or
  out-of-scope)
- whether the actor has the capability in the company model
- whether the actor is on the approval list for this policy
- whether a higher-priority policy conflicts
- whether evidence contradicts the recommendation at confidence 0.92
- what the rollback procedure is
- whether the action is reversible
- who else is required on the approval chain

Quicksilver surfaces all of that *because* the data is structured.
Stripping the structure leaves a chatbot. Keeping it leaves an
operating system.

## Stack

| Layer | Choice |
|---|---|
| Runtime | Next.js 15, TypeScript, Tailwind |
| Knowledge substrate | Sanity Studio + Content Lake + Context MCP + Knowledge Bases |
| Agent harness | AI SDK 6 + `@ai-sdk/mcp` |
| Models | `gpt-5.6-sol`, `claude-sonnet-5`, `gpt-5.6-luna`, `gemini-3.8-flash` (role-based) |
| Authority | Quicksilver Kernel (deterministic TypeScript, no LLM) |
| Write path | `@sanity/client` against the Sanity HTTP API |

## Testing access

No login required for the app or the dataset — Quicksilver has no auth
layer. The deployed Sanity Studio needs a Sanity login.

## Repo

https://github.com/nuerainc/quicksilver-sanity-challenge — source,
schema, kernel tests, smoke test, and README. See `SUBMISSION.md` for
the project ID and the public dataset details.

## Links

- Project URL: https://www.sanity.io/organizations/ou5ydq271/project/d280bqjc
- Repo: https://github.com/nuerainc/quicksilver-sanity-challenge
- Demo video: (filled in at submission)
