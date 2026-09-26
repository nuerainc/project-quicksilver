# Dedicated Sanity project setup

Nuera Quicksilver must use its own Sanity project. The original Challenge
project (`d280bqjc`) remains a protected reference; the Studio, app APIs, and
write scripts reject it.

The dedicated project has been created in the Nuera Ag Tech organization:
`Nuera Quicksilver` (`f87t11g1`). Its `production` dataset is now private. Do
not point any Quicksilver code or credentials at the original Challenge
project.

After the dataset and token are configured:

1. Set `NEXT_PUBLIC_SANITY_PROJECT_ID`, `NEXT_PUBLIC_SANITY_DATASET`, and
   `SANITY_AUTH_TOKEN` in the repo-root `.env` for the app and seed scripts.
2. Set `SANITY_STUDIO_PROJECT_ID` and `SANITY_STUDIO_DATASET` in the Studio's
   environment (`apps/studio/.env` for local CLI use).
3. Create Context MCP endpoints scoped to the new project's dataset and update
   `SANITY_CONTEXT_MCP_URL`, `SANITY_CONTEXT_TOKEN`, and optional KB endpoint
   variables in the root `.env`.
4. Deploy the Studio schema with a credential that has Sanity's
   `deployStudio` and `deploySchema` grants. The app's content token
   (`SANITY_AUTH_TOKEN`, Editor) should not get those grants. Either:
   - create a **Deploy Studio** token for `f87t11g1`, put it in the root
     `.env` as `SANITY_DEPLOY_TOKEN`, and run `npm run schema:deploy`; or
   - run `npx sanity login` and then `npm run schema:deploy -- --login`,
     which ignores every token in `.env` and uses your own session.
   The script prints which file supplied the token (never its value).
   "Unauthorized - Session not found" means the token was revoked or rotated
   and the `.env` value is stale.

**Context MCP endpoints must belong to this project.** On 2026-09-25 a query
confirmed `f87t11g1` held no agent contexts: the endpoints in use
(`…/mcp/quicksilver-agent`, `…/mcp/quicksilver-knowledge-base`, knowledge base
`kbxQPcFbgi6f`) read the challenge project. The agent package now refuses
those names and that knowledge base id, the same way the app refuses project
`d280bqjc`.

To create this project's own endpoints (Sanity Dashboard → Context):

1. Deploy the schema (step 4) **and the Studio**: from `apps/studio`, run
   `npx sanity deploy`. An endpoint with a dataset source reads the schema from
   a deployed Studio. The Nuera Studio is
   https://project-quicksilver.sanity.studio (`appId` is in `sanity.cli.ts`).
2. **GROQ-mode endpoint:** new MCP named `nuera-quicksilver-agent`, source
   dataset `f87t11g1` / `production`. Names can't be changed later.
3. **Knowledge base:** new knowledge base (for example "Nuera Quicksilver
   evidence and policy"), source dataset `f87t11g1` / `production`, limited to
   `evidence` and `policy` documents. Build entries, wait for "Entries up to
   date", and review **Issues** (the seeded contradictions are expected).
4. **KB-mode endpoint:** new MCP named `nuera-quicksilver-kb` with that
   knowledge base as its only source (or `?mode=knowledge_base&knowledgeBases=<kb…id>`).
5. Update the root `.env`: `SANITY_CONTEXT_MCP_URL`,
   `SANITY_CONTEXT_KB_MCP_URL` and `SANITY_KNOWLEDGE_BASE_ID`. The existing
   org-level Context Viewer token (`SANITY_CONTEXT_TOKEN`) still works.
6. Run `npm run verify:mcp`. It must show the new knowledge base id.

The app and Studio are pointed at the dedicated project locally. The reviewed
starter seed has been written to the new private dataset: 53 documents across
the nine Quicksilver content types. No Challenge data was copied or modified.
Schema deployment and Context MCP configuration remain pending. The local
Studio dev server also needs its Vite dependency scan resolved before it can be
opened in a browser from this environment.

**Status (2026-09-25):** done. Endpoints `nuera-quicksilver-agent` (dataset
`f87t11g1`/`production`) and `nuera-quicksilver-kb` (knowledge base
`kbzyKoLrbQiu`, 12 evidence and policy documents; its 2 flagged conflicts are
the seeded contradictions and are left open on purpose). Both report "Ready to
connect". The challenge endpoints were left unchanged.
