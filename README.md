<div align="center">

# ⚡ Quicksilver

### An Autonomous Company Operating System

**A chatbot reads your documents. Quicksilver reasons over your company.**

[![Live demo](https://img.shields.io/badge/live_demo-quicksilver--seven.vercel.app-000000?style=for-the-badge&logo=vercel&logoColor=white)](https://quicksilver-seven.vercel.app)
[![Sanity Challenge 2026](https://img.shields.io/badge/Sanity_Challenge-2026-F03E2F?style=for-the-badge&logo=sanity&logoColor=white)](https://dev.to/challenges)

![Next.js 15](https://img.shields.io/badge/Next.js-15-000000?logo=nextdotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Sanity](https://img.shields.io/badge/Sanity-Content_Lake_%2B_Context_MCP-F03E2F?logo=sanity&logoColor=white)
![AI SDK 6](https://img.shields.io/badge/AI_SDK-6-000000?logo=vercel&logoColor=white)
![Kernel tests](https://img.shields.io/badge/kernel_tests-39%2F39-2EA043)
![Agent tests](https://img.shields.io/badge/agent_tests-13%2F13-2EA043)
![Live e2e](https://img.shields.io/badge/live_e2e-44%2F44-2EA043)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

[**Try it live**](https://quicksilver-seven.vercel.app) ·
[**Decision log**](https://quicksilver-seven.vercel.app/decisions) ·
[**Studio**](https://qkslvr.sanity.studio) ·
[**Path One post**](./docs/DEV-POST-PATH-ONE.md) ·
[**Path Two post**](./docs/DEV-POST-PATH-TWO.md) ·
[**Build log**](./BUILD-LOG.md)

</div>

<p align="center">
  <a href="https://quicksilver-seven.vercel.app"><img src="docs/images/console.png" alt="The Quicksilver console: a CEO intent box pre-filled with 'Reduce production downtime by 20% over the next 30 days without increasing OPEX.' and a Send to Quicksilver button" width="760"></a>
</p>

---

Give Quicksilver an objective like *"Reduce production downtime by 20% without increasing OPEX."* An LLM agent reads a **structured model of the company** stored in Sanity (people, agents, capabilities, policies, evidence) and proposes a plan. Then a **deterministic kernel with no LLM inside it** decides what may happen. Each proposed action is auto-approved, sent to a human, or hard-blocked. Every step is recorded as an auditable decision in Sanity.

> **The LLM proposes. The kernel authorizes. The company's playbook is content, and the kernel runs it.**

## How it works

```mermaid
flowchart LR
    CEO(["🎯 CEO objective"]) --> Agent

    subgraph Sanity["Sanity: the operating substrate"]
        Model[("Company model<br/>10 document types")]
        KB[("Knowledge Base<br/>evidence + policies")]
        Proc[("Process definitions<br/>states · transitions · guards")]
    end

    Model -- "Context MCP (GROQ)" --> Agent
    KB -- "Context MCP (KB)" --> Agent

    Agent["🧠 Planner model<br/>proposes actions"] --> Kernel
    Agent --> Reviewer["🔍 Reviewer model<br/>advisory only"]
    Reviewer -.-> UI

    Kernel{"⚖️ Quicksilver Kernel<br/>capability · authority<br/>risk · approval"}
    Proc --> Kernel

    Kernel -- "risk ≤ 2" --> Auto["✅ Auto-approved"]
    Kernel -- "needs a human" --> UI["👤 Approval UI"]
    Kernel -- "hard block" --> Rej["⛔ Rejected"]

    Auto --> Exec["▶️ Execute (simulated)<br/>→ observe metric"]
    UI --> Exec
    Exec -- "metric moved the wrong way" --> RB["↩️ Rollback<br/>(always human)"]
    Exec --> Log[("📜 Decision record<br/>+ process history")]
    RB --> Log
```

## Why it isn't "just RAG"

A keyword search finds *"Engineering approval is required for parameter changes."* Quicksilver's kernel works out things a search can't:

| Question | Answered by |
|---|---|
| Does this actor actually **hold the capability**, and is it granted? | `entity` → `capability` references |
| Which policies **apply**, which are **superseded**, which **conflict** (and at what priority)? | `policy` scope, priority, `supersedes[]` |
| Does any evidence **contradict** the plan, and how confidently? | `evidence.contradicts[]` + confidence |
| How **risky** is it: base risk, impact, reversibility, uncertainty? | Deterministic risk formula, 0–5 |
| Who has to approve, and **what can happen next**? | The Decision Lifecycle process, stored in Sanity |

The seed data includes a real dilemma. Operations Policy 17 and Emergency Policy 4 conflict in the same scope, and a historical incident (confidence 0.92) says the root cause is mechanical, not parameter drift. The agent has to reason through a conflict that is actually in the data, not one staged for the demo.

## The playbook is content

Every decision moves through the **Decision Lifecycle**, a process definition stored as a Sanity document and run by the kernel. It has 8 states and 12 transitions. Its guards are structured data (`{ fact, op, value }`), never code strings.

```mermaid
stateDiagram-v2
    direction LR
    [*] --> proposed
    proposed --> rejected: kernel-reject (hard block)
    proposed --> approved: auto-approve (risk ≤ 2)
    proposed --> awaiting_approval: route-to-human
    awaiting_approval --> awaiting_approval: request-evidence 👤
    awaiting_approval --> approved: approve 👤
    awaiting_approval --> rejected: reject 👤
    approved --> executed: execute-succeeded
    approved --> failed: execute-failed
    executed --> rollback_proposed: propose-rollback 👤
    failed --> rollback_proposed: propose-rollback-after-failure 👤
    rollback_proposed --> rollback_proposed: retry-rollback 👤
    rollback_proposed --> rolled_back: complete-rollback
    rejected --> [*]
    rolled_back --> [*]
```

- **Tighten the autonomy ceiling in Studio** by changing one number, and the next decision follows it, with no redeploy.
- **Illegal jumps are refused** with a plain-English reason. Approve, reject and rollback always need a human.
- **Every step is stamped** with the definition's version and `_rev`, so you can see exactly which rules were in force.
- **A broken definition stops the line.** If a state is unreachable or a guard is malformed, the kernel moves nothing rather than bypassing its own playbook.
- **Optimistic locking**: two simultaneous approvals give exactly one success and one clean `409`.

## Try it in 60 seconds

1. Open **[quicksilver-seven.vercel.app](https://quicksilver-seven.vercel.app)**. There's no login, and the objective is pre-filled.
2. Click **Send to Quicksilver**. A real plan takes about a minute.
3. Scroll to **Decisions**. Each card shows the kernel's risk and verdict, a **Process** line (where it is, what can happen next) and a dashed **Independent review** block.
4. **Approve** a card, **Execute** it (simulated) and **Observe** the metric. If it moves the wrong way, **propose a rollback**.
5. Open the **[Decision log](https://quicksilver-seven.vercel.app/decisions)** to see every transition, who took it (kernel, human or executor) and when.

## Proven live, not just in tests

| Check | Result |
|---|---|
| Kernel unit tests: authorization, risk calibration, process engine | **39 / 39** |
| Agent tests: model config, strict-schema guards for every model schema | **13 / 13** |
| Live governance stress test on production: lanes, races, prompt injection, a broken definition | **17 / 17** |
| Automated live e2e (`npm run e2e:live`): Resume after a broken definition, Retry after a failed rollback | **44 / 44** |

The stress test found real bugs: a risk formula that scored nearly everything 5/5, a failed rollback that could strand a decision, and a strict-schema error on the query route. Each one is fixed and written up in the [build log](./BUILD-LOG.md).

## Stack

| Layer | Choice |
|---|---|
| App | Next.js 15 (App Router), TypeScript, Tailwind, deployed on Vercel |
| Content & state | Sanity Studio + Content Lake: 10 document types, 53 seed documents |
| Agent read path | Sanity **Context MCP**, in both GROQ mode (live dataset) and Knowledge Base mode (cited, with contradiction detection) |
| Agent harness | AI SDK 6 + `@ai-sdk/mcp`, role-based models (planner + independent reviewer; Azure OpenAI in production) |
| Authority | **Quicksilver Kernel**: deterministic TypeScript with no LLM, fail-closed |
| Write path | `@sanity/client` mutations with `ifRevisionId` optimistic locking |
| Studio extras | `sanity-plugin-workflow` board for editorial review of decisions |

## Repository layout

```
quicksilver/
├── apps/
│   ├── web/            Next.js app: CEO console, Decision log, API routes
│   │   └── app/api/    plan · query · decisions/[id]/{action,execute,observe,rollback,resume}
│   └── studio/         Sanity Studio: schemas, seed data, scripts (seed, smoke, e2e, reset)
├── packages/
│   ├── kernel/         Deterministic authority + process engine (no LLM)
│   └── agent/          Planner, reviewer, query agent, MCP bindings, model roles
├── docs/               DEV posts, demo script
├── ARCHITECTURE.md     Design and data model
├── SUBMISSION.md       Challenge details, Sanity project info, how to run
└── BUILD-LOG.md        Day-by-day build history across every environment
```

## Run it locally

```bash
git clone https://github.com/nuerainc/quicksilver-sanity-challenge.git
cd quicksilver-sanity-challenge
npm install
cp .env.example .env        # then fill in Sanity + model credentials

npm run schema:deploy       # deploy the Studio schema (Context MCP needs it)
npm run seed                # push the 53-document demo company
npm run dev:studio          # Studio  → http://localhost:3333
npm run dev:web             # App     → http://localhost:3000
```

```bash
npm run kernel:test         # 39 kernel tests
npm run agent:test          # 13 agent tests
npm run smoke               # dataset integrity
npm run verify:mcp          # both Context MCP endpoints, live
npm run verify:llm          # each model role responds with tools + structured output
```

Set `QUICKSILVER_PROCESS_ENGINE=on` to have the kernel run the Decision Lifecycle stored in Sanity. See [`.env.example`](./.env.example) for every variable and [`SUBMISSION.md`](./SUBMISSION.md) for the full setup, including Azure.

## Sanity project

| | |
|---|---|
| Project ID | `d280bqjc` |
| Dataset | `production`, **public** (query it: `https://d280bqjc.apicdn.sanity.io/data/query/production?query=*`) |
| Studio | https://qkslvr.sanity.studio (needs a Sanity login with project access) |
| Organization | `ou5ydq271` |

## How it was built

Quicksilver was built for the **[Sanity Challenge](https://dev.to/challenges)** (Sept 18 – Oct 4, 2026) and entered in both paths from one codebase:

- **Path One**, *Ship an Agent That Queries Real Content*: [Quicksilver: An Autonomous Company Operating System](./docs/DEV-POST-PATH-ONE.md)
- **Path Two**, *Vibe-Code Something Strange*: [Quicksilver: The Company That Operates Itself](./docs/DEV-POST-PATH-TWO.md)

**MiniMax Agent** built the architecture through hardening. **Claude Code** (via Cowork) added the Knowledge Base integration, the live reviewer, the deployment, the process engine and the live testing. The manual work was done in **VS Code**. All of it is in one unified [build log](./BUILD-LOG.md), including every real error and how it was fixed.

## License

[MIT](./LICENSE) © 2026 Brodi
