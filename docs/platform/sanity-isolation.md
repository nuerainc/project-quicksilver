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
4. Deploy the Studio schema using a credential with Sanity's required
   `deployStudio` and `deploySchema` grants. The current API tokens can write
   dataset content, but Sanity rejected schema deployment for lack of those
   grants. Do not replace the content token with a broader role without
   explicitly reviewing its access.

The app and Studio are pointed at the dedicated project locally. The reviewed
starter seed has been written to the new private dataset: 53 documents across
the nine Quicksilver content types. No Challenge data was copied or modified.
Schema deployment and Context MCP configuration remain pending. The local
Studio dev server also needs its Vite dependency scan resolved before it can be
opened in a browser from this environment.
