<div align="center">

# ⚡ Nuera Quicksilver

### Enterprise cognitive and automation subsystem for Nuera RDL

**NQC Kernel governs. Quicksilver Engine evaluates. Nuera Quicksilver Agents do the work.**

[![Legacy challenge demo](https://img.shields.io/badge/live_demo-quicksilver--seven.vercel.app-000000?style=for-the-badge&logo=vercel&logoColor=white)](https://quicksilver-seven.vercel.app)
[![Sanity Challenge 2026](https://img.shields.io/badge/Sanity_Challenge-2026-F03E2F?style=for-the-badge&logo=sanity&logoColor=white)](https://dev.to/challenges)

![Next.js 15](https://img.shields.io/badge/Next.js-15-000000?logo=nextdotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Sanity](https://img.shields.io/badge/Sanity-Content_Lake_%2B_Context_MCP-F03E2F?logo=sanity&logoColor=white)
![AI SDK 6](https://img.shields.io/badge/AI_SDK-6-000000?logo=vercel&logoColor=white)
![Kernel tests](https://img.shields.io/badge/kernel_tests-39%2F39-2EA043)
![Agent tests](https://img.shields.io/badge/agent_tests-13%2F13-2EA043)
![Live e2e](https://img.shields.io/badge/live_e2e-44%2F44-2EA043)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

[**Legacy challenge demo**](https://quicksilver-seven.vercel.app) ·
[**Legacy decision log**](https://quicksilver-seven.vercel.app/decisions) ·
[**Legacy challenge Studio**](https://qkslvr.sanity.studio) ·
[**Path One post**](./docs/DEV-POST-PATH-ONE.md) ·
[**Path Two post**](./docs/DEV-POST-PATH-TWO.md) ·
[**Build log**](./BUILD-LOG.md)

</div>
> **Current build status:** This repository preserves the tested Sanity Challenge foundation. NQC evaluation and governance, tool contracts, a draft workflow builder, and an in-process graph runner are implemented foundations. Quicksilver Engine also provides a bounded, provider-neutral final-answer stress harness for multi-step arithmetic and logic traps; it does not request or retain private chain-of-thought. The editor visualizes graph connections and exposes agent retry and handler timeout settings. The runner supports opt-in bounded concurrency for independent low/moderate-impact agent steps; the read-only query route caps this at three. The read-only query worker uses a shared governed-agent contract and returns its full NQC evaluation response. Workflow drafts autosave locally, support validated JSON import/export, and can run an opt-in read-only query-agent path through NQC evaluation. Workflow tools remain blocked; shared storage and hosted execution are not implemented. An internal TypeScript SDK and a dependency-free Python SDK/CLI foundation now cover workflow validation, safe preview, and opt-in read-only runs; neither is published as a stable public API. Accounts/RBAC, secrets vault, hosted execution, Go SDK, observability, and marketplace remain unimplemented.
>
> Canonical product docs: [Documentation index](./docs/README.md) · [NQC Kernel](./docs/nqc/README.md) · [Platform](./docs/platform/README.md) · [Spec coverage](./docs/NUERA-QUICKSILVER-SPEC-COVERAGE.md) · [Roadmap](./docs/NUERA-QUICKSILVER-ROADMAP.md)

<p align="center">
  <a href="https://quicksilver-seven.vercel.app"><img src="docs/images/console.png" alt="The Quicksilver console: a CEO intent box pre-filled with 'Reduce production downtime by 20% over the next 30 days without increasing OPEX.' and a Send to Quicksilver button" width="760"></a>
</p>

---

Give Nuera Quicksilver an objective like *"Reduce production downtime by 20% without increasing OPEX."* A **Nuera Quicksilver Agent** reads a structured company model stored in Sanity and proposes a plan. The **NQC Kernel** applies the deterministic Quicksilver Engine evaluation and then decides what may happen. Each proposed action is auto-approved, sent to a human, or hard-blocked. Every step is recorded as an auditable decision in Sanity.

> **Nuera Quicksilver Agents propose. The NQC Kernel authorizes. The company's playbook is content, and the kernel runs it.**

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

    Kernel{"⚖️ NQC Kernel<br/>capability · authority<br/>risk · approval · evaluation"}
    Proc --> Kernel

    Kernel -- "risk ≤ 2, no conflicts" --> Auto["✅ Auto-approved"]
    Kernel -- "needs a human" --> UI["👤 Approval UI"]
    Kernel -- "hard block" --> Rej["⛔ Rejected"]

    Auto --> Exec["▶️ Execute (simulated)<br/>→ observe metric"]
    UI --> Exec
    Exec -- "metric moved the wrong way" --> RB["↩️ Rollback<br/>(always human)"]
    Exec --> Log[("📜 Decision record<br/>+ process history")]
    RB --> Log
```

## Why it isn't "just RAG"

A keyword search finds *"Engineering approval is required for parameter changes."* Quicksilver works out things a search can't, and it's clear about which part does what: the **kernel** is deterministic code, the **agent** is the LLM reading Sanity.

| Question | Worked out by |
|---|---|
| Does this actor actually **hold the capability**, and is it granted? | Kernel, from `entity` → `capability` references |
| Which policies **apply**, which are **superseded**, which **conflict**? | Kernel: policy scope + `supersedes[]`; two live policies in the same scope are flagged as a conflict |
| Does any evidence **contradict** the plan, and how confidently? | Agent, from `evidence.contradicts[]` + confidence (GROQ) and the Knowledge Base's own contradiction detection |
| How **risky** is it: base risk, impact, reversibility, uncertainty? | Kernel, a deterministic formula, 0–5 |
| Who has to approve, and **what can happen next**? | Kernel, running the Decision Lifecycle process stored in Sanity |

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
- **Illegal jumps are refused** with a plain-English reason. Approve, reject and rollback always need a human click; the kernel and executor can never take them. (The demo has no login, so anyone using the app is that human.)
- **Every step is stamped** with the definition's version and `_rev`, so you can see exactly which rules were in force.
- **A broken definition stops the line.** If a state is unreachable or a guard is malformed, the kernel moves nothing rather than bypassing its own playbook.
- **Optimistic locking**: two simultaneous approvals give exactly one success and one clean `409`.

## Try it in 60 seconds

1. Open **[quicksilver-seven.vercel.app](https://quicksilver-seven.vercel.app)**. There's no login, and the objective is pre-filled.
2. Click **Send to Quicksilver**. A real plan takes about a minute.
3. Scroll to **Decisions**. Each card shows the kernel's risk and verdict and a **Process** line (where it is, what can happen next). Click **Show reasoning & evidence** for the policies, evidence and the dashed **Independent review** from the reviewer model.
4. **Approve** a card, **Execute** it (simulated) and **Observe** the metric. If it moves the wrong way, **propose a rollback**.
5. Open the **[Decision log](https://quicksilver-seven.vercel.app/decisions)** to see every transition, who took it (kernel, human or executor) and when.

## Proven live, not just in tests

| Check | Result |
|---|---|
| Kernel unit tests: authorization, risk calibration, process engine | **39 / 39** |
| Agent tests: model config, strict-schema guards for every model schema | **13 / 13** |
| Live governance stress test on production: lanes, races, prompt injection, a broken definition | **17 / 17** |
| Automated live e2e (`npm run e2e:live`): Resume after a broken definition, Retry after a failed rollback | **44 / 44** |

The two live runs were made against Decision Lifecycle v2; v3 changed only which guard catches decisions routed to a human.

The stress test found real bugs: a risk formula that scored nearly everything 5/5, a failed rollback that could strand a decision, and a strict-schema error on the query route. Each one is fixed and written up in the [build log](./BUILD-LOG.md).

## Stack

| Layer | Choice |
|---|---|
| App | Next.js 15 (App Router), TypeScript, Tailwind, deployed on Vercel |
| Content & state | Existing challenge dataset is preserved as the regression baseline; the dedicated Nuera Quicksilver project is pending configuration |
| Agent read path | Sanity **Context MCP**, in both GROQ mode (live dataset) and Knowledge Base mode (cited, with contradiction detection) |
| Agent harness | AI SDK 6 + `@ai-sdk/mcp`, role-based models (planner + independent reviewer; Azure OpenAI in production) |
| Authority | **NQC Kernel**: deterministic TypeScript with no LLM, fail-closed |
| Evaluation | **Quicksilver Engine**: deterministic grounding, tool-failure, and brittleness signals |
| Worker agents | **Nuera Quicksilver Agents**: planner, advisory reviewer, and query agent; kernel manifests gate registered tasks, with the NQC Kernel retaining action authority |
| Write path | `@sanity/client` mutations with `ifRevisionId` optimistic locking |
| Workflow authoring | Draft graph builder, browser-local autosave, validated JSON import/export, validation API, separate `automationWorkflow` schema, safe preview, and opt-in read-only query-agent run through NQC; tools blocked, safe data-only conditions, not shared or hosted |
| Developer SDK | Internal TypeScript client for workflow validation; not yet published |
| Python SDK/CLI | Internal Python client and `qs` CLI for validation, safe preview, and gated read-only runs; not published |

## Repository layout

```
quicksilver/
├── apps/
│   ├── web/            Next.js app: CEO console, Decision log, API routes
│   │   └── app/api/    plan · query · decisions/[id]/{action,execute,observe,rollback,resume}
│   └── studio/         Nuera Quicksilver Studio: core schemas, graph schema, guarded seed scripts
├── packages/
│   ├── kernel/         Deterministic authority + process engine (no LLM)
│   ├── agent/          Planner, reviewer, query agent, MCP bindings, model roles
│   ├── sdk/            Internal TypeScript API client
│   └── sdk-python/     Internal Python SDK and `qs` CLI foundation
├── docs/               Canonical NQC/platform docs plus historical challenge writeups
├── ARCHITECTURE.md     Design and data model
├── SUBMISSION.md       Challenge details, Sanity project info, how to run
└── BUILD-LOG.md        Day-by-day build history across every environment
```

## Run it locally

```bash
npm install
cp .env.example .env
# Set the dedicated project in the root .env and apps/studio/.env.
# Fill the new project's API token and Context MCP endpoints in the root .env.
npm run dev:studio
npm run dev:web
```

The dedicated Sanity project is `f87t11g1`, and local project IDs now point to
it. Schema deployment and seed writes remain pending until a new project-scoped API token is configured and the schema is
deployed. Set
`QUICKSILVER_PROCESS_ENGINE=on` to run the existing Decision Lifecycle process
engine from the configured project.
## How it was built

Quicksilver was built for the **[Sanity Challenge](https://dev.to/challenges)** (Sept 18 – Oct 4, 2026) and entered in both paths from one codebase:

- **Path One**, *Ship an Agent That Queries Real Content*: [Quicksilver: An Autonomous Company Operating System](./docs/DEV-POST-PATH-ONE.md)
- **Path Two**, *Vibe-Code Something Strange*: [Quicksilver: The Company That Operates Itself](./docs/DEV-POST-PATH-TWO.md)

**MiniMax Agent** built the architecture through hardening. **Claude Code** (via Cowork) added the Knowledge Base integration, the live reviewer, the deployment, the process engine and the live testing. The manual work was done in **VS Code**. All of it is in one unified [build log](./BUILD-LOG.md), including every real error and how it was fixed.

## License

[MIT](./LICENSE) © 2026 J.B.T. Beebe
