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

**Context MCP endpoints must belong to this project.** The challenge build
used `…/mcp/quicksilver-agent` and `…/mcp/quicksilver-knowledge-base`. If
those agent contexts live in the challenge project, agents read challenge data
while decisions and evaluations are written here. Create agent contexts (and a
knowledge base) inside `f87t11g1` under new names, for example
`nuera-quicksilver-agent` and `nuera-quicksilver-kb`, and point the
`SANITY_CONTEXT_*` variables at them.

The app and Studio are pointed at the dedicated project locally. The reviewed
starter seed has been written to the new private dataset: 53 documents across
the nine Quicksilver content types. No Challenge data was copied or modified.
Schema deployment and Context MCP configuration remain pending. The local
Studio dev server also needs its Vite dependency scan resolved before it can be
opened in a browser from this environment.
