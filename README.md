# Quicksilver

> **An Autonomous Company Operating System.**
> Structured organizational knowledge → agent reasoning → deterministic authority → recorded decision → state update.

Submitted to the **Sanity Challenge (Sept 18 – Oct 4, 2026)**: Path One (*Ship an Agent That Queries Real Content*) and Path Two (*Vibe-Code Something Strange*).

---

## The thesis

A chatbot reads your documents. **Quicksilver reasons over your company.**

The difference is structural: an LLM with access to ordinary documents answers questions. An LLM with access to a structured **company model** — entities, capabilities, policies, evidence, objectives, workflows — can determine *what the company should do*, propose a course of action, route it through a deterministic authority kernel, and record the result as state.

```
CEO: "Reduce production downtime by 20%."
              ↓
       QUICKSILVER
              ↓
   Sanity Context (MCP, read-only)
              ↓
   Structured company model (GROQ + Knowledge Base)
              ↓
   Candidate plan (planner model)
              ↓
   Independent review (reviewer model)
              ↓
   Quicksilver Kernel (capability + authority + risk + approval)
              ↓
        APPROVAL GATE
        /         \
   autonomous     human
        \         /
         \       /
          state update
```

---

## Repo layout

```
quicksilver/
├── apps/
│   ├── web/          # Next.js 15 + AI SDK 6 — Quicksilver UI + agent runtime
│   └── studio/       # Sanity Studio — schema authoring + content editing
├── packages/
│   ├── kernel/       # Deterministic authority: capability, authority, risk, approval
│   └── agent/        # Model roles + MCP bindings + prompts
├── ARCHITECTURE.md
└── README.md
```

---

## Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Next.js 15 (App Router) + TypeScript | Server actions for agent calls, streaming UI |
| Agent harness | AI SDK 6 (`@ai-sdk/mcp`) | First-class MCP, role-based model config, tool calls |
| Structured store | Sanity Studio + Content Lake | Schema + GROQ, competition-aligned |
| Read path | Sanity Context MCP (hosted, read-only) | GROQ mode for structured, Knowledge Base mode for provenance |
| Write path | Next.js server actions → Sanity HTTP API | Simpler than wiring two MCP clients; Context MCP is read-only |
| Model — planner | `gpt-5.6-sol` (default) | Strongest reasoning; bake-off candidate: `gemini-3.8-flash`, `claude-sonnet-5` |
| Model — reviewer | `claude-sonnet-5` | Independent second opinion, near-Opus at Sonnet cost |
| Model — router | `gpt-5.6-luna` | Cheap classification/intent routing |
| Styling | Tailwind | Boring and fast |
| Deploy | Vercel | Lowest-friction deployment for Next.js |

Model IDs are **configuration**, not architecture. Swapping is a one-line change per role.

On **Azure OpenAI / Foundry** (auto-selected when `AZURE_API_KEY` and `AZURE_RESOURCE_NAME` are set) each role maps to a *deployment name* — by default `qs-planner`, `qs-reviewer`, `qs-router`, `qs-executor` — overridable per role with `QUICKSILVER_<ROLE>_MODEL` or globally with `AZURE_DEPLOYMENT`. Run `npm run setup:azure` (needs the Azure CLI and `az login`) to create the resource and the four deployments and write `AZURE_RESOURCE_NAME` / `AZURE_API_KEY` into `.env`, then `npm run verify:llm` to confirm each deployment responds, supports tool calling, and accepts the plan schema.

---

## Quickstart (planned)

```bash
# Install deps at root
npm install

# Run Studio (localhost:3333)
npm run dev:studio

# Run Quicksilver UI (localhost:3000)
npm run dev:web

# Deploy schema (required for Context MCP GROQ mode)
npm run schema:deploy
```

See `.env.example` for required environment variables. **Never commit `.env.local`** — it holds real tokens.

## Sanity setup (current state)

| Field | Value |
|---|---|
| Project URL | https://www.sanity.io/organizations/ou5ydq271/project/d280bqjc |
| Org ID | `ou5ydq271` |
| Project ID | `d280bqjc` |

To get the agent running, you'll need to do this in the Sanity dashboard **once** before Day 6:

1. **Enable Context** on the org — Manage → Labs → Context (it's a beta opt-in).
2. **Create an org-scoped API token** with the `Context Viewer` grant — Manage → API → Tokens (organization scope). Put this in `.env.local` as `SANITY_CONTEXT_TOKEN`.
3. **Create a Context MCP endpoint** in the Context app — pick GROQ mode (live dataset) for the primary read path. Optionally create a second KB-mode endpoint later (one endpoint = one mode).
4. **Deploy the schema** with `npm run schema:deploy` — without a deployed schema, the Context MCP GROQ endpoint refuses connections with error `-32004`.

Model credentials go in the same root `.env` (the web app reads it too): `AZURE_RESOURCE_NAME` + `AZURE_API_KEY` for Azure, or `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY` for direct providers.

---

## Submissions

- **Path One**: *Quicksilver — An Autonomous Company Operating System.* Watch it think.
- **Path Two**: *Quicksilver — The Company That Operates Itself.* Watch it operate.

One codebase. Two narratives. Two posts.

---

## License

MIT — see [LICENSE](./LICENSE).