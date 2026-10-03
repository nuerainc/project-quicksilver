# v1.0.0 external access and credential checklist

This checklist separates credentials from the code and operational evidence
required to close P-001–P-123. The repository does not contain secret values;
do not paste credentials into chat, tickets, source files, or pull requests.
Enter them only in the target provider's secret manager or a protected local
`.env` file. The current local environment has not been inspected for secret
values, so this document does not claim that any credential is present.

## Obtain first: live Sanity and model evaluation

| Priority | Credential or access | Used for | Requirements / notes |
|---|---|---|---|
| 1 | Dedicated Quicksilver Sanity project `f87t11g1`, private `production` dataset; `SANITY_READ_TOKEN` (Viewer), `SANITY_WRITE_TOKEN` (Editor) | Web decisions, evaluations, audit, live decision loop; P-014, P-045, P-081, P-121 | `NEXT_PUBLIC_SANITY_PROJECT_ID` / `NEXT_PUBLIC_SANITY_DATASET` and separate Studio `SANITY_STUDIO_PROJECT_ID` / `SANITY_STUDIO_DATASET` are identifiers/configuration, not credentials. Keep the public Sanity Challenge project and dataset separate. Do not use its tokens. `SANITY_AUTH_TOKEN` is a legacy combined-token fallback and should be retired after split tokens are installed. |
| 2 | Dedicated project Context MCP URL/token: `SANITY_CONTEXT_MCP_URL`, `SANITY_CONTEXT_TOKEN`; optional `SANITY_CONTEXT_KB_MCP_URL`, `SANITY_CONTEXT_KB_TOKEN`, `SANITY_KNOWLEDGE_BASE_ID` | Company-grounded query and business-specialist agents; P-017, P-045, P-072 | Endpoints and KB must read only `f87t11g1` / `production`; never reuse the Challenge endpoint or KB. Repo docs report the dedicated endpoints are ready; enter the service token in each required runtime. KB token may override the shared context token. |
| 3 | One supported LLM provider account and key | WAES, planner/reviewer, query, specialist agents, operational evaluation; P-017, P-045, P-072 | Choose one route: Azure (`AZURE_API_KEY`, `AZURE_RESOURCE_NAME`, a deployed model and optional `AZURE_API_VERSION`), OpenAI (`OPENAI_API_KEY`), Anthropic (`ANTHROPIC_API_KEY`), or Google (`GOOGLE_GENERATIVE_AI_API_KEY`). Local Ollama needs a running service/model at `OLLAMA_BASE_URL`, not a hosted key. `QUICKSILVER_MODEL_MODE` and per-role model selectors are configuration, not credentials. Record provider data-use/no-training terms separately for P-029. |
| 4 | Sanity schema deployment authorization (`SANITY_DEPLOY_TOKEN`) or an owner Sanity CLI login | Deploy schemas and Studio to the dedicated project; P-121 | Use a separate Deploy Studio/Schema token with only required deploy grants, or deploy interactively with owner login. Do not give schema-deploy grants to the app's write token. |

## Hosting and pilot operations

| Priority | Credential or access | Used for | Requirements / notes |
|---|---|---|---|
| 5 | Azure subscription/resource-group access (App Service + Azure Database for PostgreSQL Flexible Server, using the founder's Azure free credits); `QUICKSILVER_VAULT_KEY`; encrypted persistent-disk and backup configuration | Always-on host and durable run store; P-014, P-023, P-081, P-089, P-096, P-110 | **Chosen path is Azure, not Render** (see [always-on hosting](always-on-hosting.md)); an Azure deploy template equivalent to `deploy/render.yaml` has not been written yet. Azure Database for PostgreSQL supplies its own connection string; it is not a value Monte needs to construct separately. Keep the host single-tenant for the initial founder pilot. Use separate production secrets; don't import local `.env` wholesale. |
| 6 | Host principals (`QUICKSILVER_PRINCIPALS`) with per-person hashed bearer credentials, plus `QUICKSILVER_TENANT_ID`; interim `NQC_SUPERVISOR_TOKEN`/`NQC_SUPERVISOR_ID` only if necessary | Authenticated host operations and live tests; P-014, P-081, P-121 | Prefer per-person principals with least privilege; the shared supervisor token is transitional. Never send tokens in request bodies. |
| 7 | Vercel deployment access; Azure subscription/resource-group access for the App Service host; HTTPS domain/DNS configuration and public host URL | Public health checks and always-on hosting; P-014 | These are provider-account access and configuration, not API credentials to paste into Quicksilver. The chosen topology is Vercel for the web app and Azure App Service + Azure Database for PostgreSQL for the persistent host. |
| 8 | Generated least-privilege task client token (`QUICKSILVER_TASK_TOKEN`); remote `QUICKSILVER_HOST_URL` must be HTTPS | Quicksilver Tasks MCP clients; P-028 | Generate a distinct client token through `npm run tasks -- client add <name>`. The URL is configuration, not a credential. |
| 9 | Founder-approved company entity, bank/payment account, invoices/receipts and pilot evidence | Genesis, Onboard and Operate operational acceptance; P-081, P-089, P-096 | Credentials alone do not satisfy these rows; dated pilot evidence and dollar-level reconciliation are required. Never use restricted patent or regulated data for this pilot. |
| 10 | Browser E2E base URL (`QUICKSILVER_E2E_BASE_URL`), distinct proposer token (`QUICKSILVER_E2E_REQUESTER_TOKEN`) and human supervisor token (`QUICKSILVER_SUPERVISOR_TOKEN`) | Live Sanity-backed decision-loop run; P-121 | Use test principals scoped to the dedicated tenant and distinct requester/approver identities where possible. The script can fall back to using the supervisor as requester, which invokes sole-operator exception logic. The test needs a safe disposable decision/scenario and documented cleanup/rollback. Fault-injection scenario B needs a separate non-production deployment with `QUICKSILVER_PROCESS_ENGINE=on` and `QUICKSILVER_ALLOW_FAULT_INJECTION=on`; never enable fault injection in production. |

## Credentials for optional provider integrations

These are not all needed to build or test the code locally. First select the
providers to support; then create scoped credentials per integration. Never
share a bank login or an unrestricted account owner key.

| Capability | Credential family already referenced by the repo | Requirement / decision |
|---|---|---|
| Public web search | `BRAVE_SEARCH_API_KEY` | Needed for live search evidence under P-024. |
| Email delivery / inbound webhook | `QUICKSILVER_EMAIL_API_KEY`, `QUICKSILVER_EMAIL_FROM`, `QUICKSILVER_EMAIL_INBOUND_SECRET` | Current email adapter uses Resend; inbound signing secret applies to inbound email. Optional channel under P-022, not a P-088 graph connector. |
| SMS | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `QUICKSILVER_GATEWAY_PUBLIC_URL` | All are required for the current Twilio adapter; optional channel under P-022, not a P-088 graph connector. |
| Slack | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | Only if Slack is enabled; P-022. |
| Discord | `DISCORD_BOT_TOKEN` | Only if Discord is enabled; P-022. |
| Telegram | `TELEGRAM_BOT_TOKEN` | Only if Telegram is enabled; P-022. |
| Bookkeeping, CRM, payments, productivity, office | Provider-specific OAuth client, refresh token, API key, and webhook signing secret | Provider set is not yet selected and live `OBSERVED` graph connectors are not implemented; credentials alone will not close P-088. P-027 commerce/payment execution is also missing (only recording incoming Stripe payments exists); no payment credentials are needed to continue coding. First choose providers and money movement policy; sandbox keys must wait until executor, kernel approval, reconciliation, and safety tests exist. |
| Single sign-on | Choose an OIDC provider and create an app registration with issuer URL (`OIDC_ISSUER`), client ID (`OIDC_CLIENT_ID`), client secret (`OIDC_CLIENT_SECRET`), exact HTTPS callback URL (`OIDC_REDIRECT_URI`), test users, and owner-managed issuer/subject → principal/tenant/roles mappings (`QUICKSILVER_OIDC_USERS`) | The authorization-code/PKCE and server-side session flow is implemented and regression-tested. A live Google sign-in passed on 2026-10-03. P-108 still needs the console SSO entry/control and evidence that sessions survive a later deploy. No separate session secret is needed: Quicksilver generates random session tokens and stores only their digests. Keep role assignments out of IdP claims; Quicksilver uses the explicit owner-managed mapping. Setup checklist for Google and Microsoft Entra ID, including how to find your subject: [SSO setup](sso-setup.md). |
| Stripe payment webhook (P-027, recording only) | Vault secret `genesis-stripe-webhook`: the Stripe endpoint's **webhook signing secret** (`whsec_…`) | Optional. Records Stripe payments that already happened into the Genesis ledger ([setup](genesis-run.md#stripe-payments-into-the-ledger-p-027-recording-only)). Never a Stripe API key: the sink makes no Stripe calls. Restricted to the endpoint's signing secret. |
| Stripe commerce actions (P-027, test mode only) | Vault secret `genesis-stripe-api`: a Stripe **test-mode** key (`rk_test_…` restricted to Products, Prices and Payment Links write, or `sk_test_…`). Without a vault: env `QUICKSILVER_GENESIS_STRIPE_API_KEY`. Never the webhook signing secret. | Optional, off unless the run config sets `commerceMode: "test"`. A live key is refused. See [Genesis run](genesis-run.md#commerce-actions-p-027-test-mode-only). |
| Commerce/payment execution | Payment provider's sandbox credentials, webhook secret, and test merchant account | P-027 is partial: incoming payments are recorded (row above); taking or making payments is still missing. Provider choice and approved money movement policy are product-owner decisions; production keys must wait for executor, kernel approval, reconciliation, and safety testing. |
| Remote/desktop workspace | Cloud account role or machine enrollment credential, plus workspace identity per venture/client | P-023 is partial and remote/desktop control is not implemented. Do not provide a personal workstation password. |

## Owner decisions before asking providers for more access

1. Select the initial pilot entity, payment account, accounting provider, CRM,
   email service, and whether SMS/Slack/Telegram are in the first supported set.
2. Select one OIDC identity provider and confirm whether the first deployment
   remains single-tenant while SSO is being implemented.
3. Confirm which model provider may process founder-owned pilot data and
   document its retention/no-training terms.
4. ~~Confirm whether the Vercel web app plus Render host/Postgres deployment
   remains the desired topology~~ — **decided: Azure.** The host runs on
   Azure App Service (Web App for Containers) with Azure Database for
   PostgreSQL Flexible Server, using the founder's Azure free credits; Vercel
   stays for the web app. Still open: which custom domain to use, and writing
   the Azure deploy template (the `render.yaml` equivalent).

These decisions block operational configuration; they do not block the
continued implementation and automated testing of provider-agnostic code.
