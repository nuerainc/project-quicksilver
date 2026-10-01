# Hosted runtime (single tenant)

`@quicksilver/host` is one process that runs everything the web app can't:
the governed worker pool, cron schedules, signed webhooks, a management API,
the secrets vault, structured logs and Prometheus metrics. It serves exactly
one tenant. Multi-tenant hosting and SSO come before the 0.9.0 release
candidate.

The host adds no authority of its own. It wires existing kernel components
together (`WorkflowRunQueue`, `WorkflowRunWorker`, `CronScheduler`,
`WebhookTrigger`, `AccessController`) and adds authentication, limits and
observability around them.

### Tenant-scoped queue workers

Each host now binds its `WorkflowRunQueue` to the tenant in its host config.
That scope is enforced for enqueue, claim, read, cancellation, completion,
lease recovery, dead-letter listing, redrive, authorization lifecycle, and
queue statistics. The run-store contract tests two tenant-bound queues over
the same memory, file, and Postgres adapter; each can only claim and mutate
its own tenant's runs. A shared Postgres run store can therefore support
separate tenant host processes without one worker claiming another tenant's
run.

This is a queue isolation foundation, not a multi-tenant Quicksilver service:
each host still serves one tenant, and other company, publication, schedule,
task, audit, and domain stores are not yet provisioned as one integrated
multi-tenant control plane. Do not route multiple tenants through one host
until those stores and their cross-tenant tests are complete.

## Run it

```bash
cp deploy/quicksilver.host.example.json quicksilver.host.json   # edit
npm run host -- vault keygen            # put the output in QUICKSILVER_VAULT_KEY
npm run host -- check                   # validate config and environment
npm run host                            # start
```

### On your own computer (Windows, macOS or Linux)

The simplest setup: runs are kept in a local file and nothing is exposed to
the network.

```bash
cp deploy/quicksilver.local.example.json quicksilver.host.json   # repo root; gitignored
npm run host -- check                    # validate config and .env
npm run host -- run daily-brief          # run the brief once, right now
npm run host                             # start; Ctrl+C to stop
```

- The host reads the repo's `.env` (model keys, `SANITY_CONTEXT_*`,
  `NEXT_PUBLIC_SANITY_PROJECT_ID`, `SANITY_WRITE_TOKEN`), so each step
  evaluation is stored in Sanity like the web app's.
- Without a `tenantId` in the config, the host uses `QUICKSILVER_TENANT_ID`
  (default `default`), the same tenant as the web app.
- Runs are kept in `data/runs.jsonl` (gitignored) and survive restarts.
- Schedules are in UTC. `0 14 * * 1-5` is 8:00 in Mountain Daylight Time
  (7:00 after the switch to standard time) on weekdays. A slot missed while
  the computer was off runs when the host starts again, if it is less than an
  hour late.
- The API listens on `127.0.0.1:8787` only. `http.host` defaults to
  `127.0.0.1` when the config omits it; listening on every interface needs an
  explicit `"http": { "host": "0.0.0.0" }` (the container example sets it,
  behind Compose's `127.0.0.1` port mapping or Caddy). Webhooks need a public
  address, so the local example has none.

With Docker and Postgres:

```bash
cp deploy/quicksilver.host.example.json deploy/quicksilver.host.json
docker compose -f deploy/docker-compose.yml up -d --build
```

| Variable | Purpose |
|---|---|
| `QUICKSILVER_HOST_CONFIG` | Path to the host config (default `quicksilver.host.json`) |
| `QUICKSILVER_PRINCIPALS` | Bearer-token principals, same format as the web app. Every principal must belong to the host's tenant or the host refuses to start |
| `QUICKSILVER_VAULT_KEY` | 32-byte vault master key (name set by `vault.keyEnv`) |
| `DATABASE_URL` | Postgres URL when `store.kind` is `postgres` (name set by `store.urlEnv`) |
| `QUICKSILVER_LOG_LEVEL` | Overrides `log.level` |
| Model provider keys and `SANITY_CONTEXT_MCP_URL` / `SANITY_CONTEXT_TOKEN` | Enable the read-only query agent. Without them, agent steps fail closed |
| `NEXT_PUBLIC_SANITY_PROJECT_ID` and `SANITY_WRITE_TOKEN` | Store each step evaluation as an `evaluationRecord` document (and the Sanity shadow, Genesis and task stores when chosen). The legacy challenge project is refused. See [Sanity tokens](#sanity-tokens-read-and-write) |
| `SANITY_READ_TOKEN` | Read-only Sanity paths (none in the host today; the web app's decision log uses it) |

### Sanity tokens: read and write

Every Sanity client in the repository is created in one helper per app or
package (`apps/web/lib/sanity-client.ts`, `packages/host/src/sanity-client.ts`,
`apps/studio/lib/sanity-client.ts`), and each asks for either read or write
access (threat model A-7):

| Access | Variable | Sanity role | Used by |
|---|---|---|---|
| read | `SANITY_READ_TOKEN` | Viewer | The web decision log page; `npm run smoke`; the dataset export in `npm run reset:history` |
| write | `SANITY_WRITE_TOKEN` | Editor | `/api/plan`, the decision routes, evaluation records (web and host), the host's Sanity stores, `npm run seed`, `seed:processes`, `reset:history`, `e2e:live` |

Until both are set, each falls back to the old combined `SANITY_AUTH_TOKEN`
and prints a warning once per process naming the missing variable (never the
token). A read path never borrows the write token, and a write path never
borrows the read token. `SANITY_DATASET_PUBLIC=on` lets read paths use no
token at all, only if the founder has made the dataset public (it is private
today; leave this unset). Schema deploys keep their own `SANITY_DEPLOY_TOKEN`
or a `sanity login` session. `npm test` checks that no other file creates a
Sanity client or reads these variables (`sanity-tokens.test.ts`).

**Founder action:** in [sanity.io/manage](https://sanity.io/manage), project
→ API → Tokens, create a **Viewer** token and set it as `SANITY_READ_TOKEN`,
and an **Editor** token and set it as `SANITY_WRITE_TOKEN`, in the root `.env`
and in every hosting environment (Vercel, Render). Once both are set
everywhere and the app runs without the fallback warning, delete the old
combined token in sanity.io/manage and remove `SANITY_AUTH_TOKEN`.

**Founder decision (not changed from code):** anyone with an Editor token, or
with an Editor role in Studio, can write an `approvalRecord`, `approvedBy`, a
policy or a capability directly, bypassing every route; Studio's read-only
schemas are a user-interface setting, not access control. Review who holds
Editor (or higher) on the project in sanity.io/manage → Members and reduce it
to the people and processes that must write. Signing approval records with a
host-held key (threat model B-6) is the code fix that follows.

`SIGTERM` stops intake, stops the scheduler and waits for in-flight runs
(up to 60 s, then aborts them). A second signal aborts immediately.

## Configuration

The config file holds structure only. It never holds a credential:

- Webhook secrets are references: `vault:<name>` or `env:<NAME>`. An `env:`
  reference also accepts `<NAME>_PREVIOUS` during rotation. An inline secret
  is a startup error.
- The database URL and vault key are named environment variables.
- Human tokens come from `QUICKSILVER_PRINCIPALS`.

Startup validation fails with every problem listed. It checks:

- one tenant for all principals, schedules and webhooks;
- trigger identities (`services`) that hold **only** the `trigger` role;
- cron syntax, workflow references and graph validity;
- the **execution policy**: agent steps must be the read-only query agent, at
  most `maxAgentSteps` of them, never high or critical impact.

Tool steps are allowed in a graph but are **always blocked at run time**. The
run ends `blocked` and nothing is dispatched. Effectful tools arrive with the
playbook milestone, behind verified supervisor approval.

A missing webhook secret stops startup. The host never serves an endpoint it
can't verify.

## Management API

Every `/api` route needs `Authorization: Bearer <token>` and is authorized by
the kernel's RBAC. Denials are logged and, for run actions, written to the
run's event history.

The route table in `packages/host/src/routes.ts` is the list below in code:
`dispatch()` matches it first, so an `/api` path it does not list is a 404
before any handler runs, and each route's permission (at least one of those
listed) is checked centrally before its handler, which keeps its own finer
checks (humans only, the submitter, separation of duties). `host-routes.test.ts`
walks the table and asserts 401 without a token and 403 for a principal
without the permission on every route, except the reviewed public routes:
`/healthz` and `/readyz` (probes, no data), `/` and `/console` (a static page
with no data that must load before sign-in), and `POST /webhooks/:id`
(authenticated by its HMAC signature). `GET /api/whoami` needs any valid
principal and grants nothing.

### Rate limits

Per-principal token buckets (threat model A-5), set under `http.rateLimits`
in the host config; the table marks which class each route is in:

| Class | Default | Routes |
|---|---|---|
| `write` | burst 60, then 120 a minute | Every route that changes state: task cancel/approve/deny, intent answers and dismissals, the intent ledger, shadow recommendations, verdicts and outcomes, the decision journal, every Genesis write, run cancel, secrets, reload |
| `model` | burst 10, then 20 a minute | Routes that call a model or enqueue a run that does: `POST /api/intents`, `POST /api/shadow/:id/generate`, `POST /api/runs`, `POST /api/runs/:id/redrive` |
| `webhook` | burst 60, then 120 a minute, **per endpoint** | `POST /webhooks/:id`, counted before the signature is checked; override one endpoint with `webhooks[].rateLimit` |
| tasks | burst 10, then 30 a minute (`tasks.rateLimit`) | `POST /api/tasks`, per client |

```json
"http": { "rateLimits": { "write": { "burst": 60, "perMinute": 120 }, "model": { "burst": 10, "perMinute": 20 }, "webhook": { "burst": 60, "perMinute": 120 } } }
```

A refused request gets `429` with `Retry-After` (whole seconds) and
`{ error, code: "rate-limited", retryAfterSeconds }`. A caller refused with
401 or 403 spends nothing. Buckets are in memory: they reset when the host
restarts, and one host per tenant is the supported shape. Because the webhook
bucket is counted before verification, a flood of forged deliveries can use
up an endpoint's budget and delay real ones (senders retry on 429); limit
per source address at the proxy (Caddy) as well when an endpoint is public.
All buckets share one implementation with the web app (`TokenBucketLimiter`
in `@quicksilver/kernel/rate-limit`).

**The web app's limits** use the same buckets, per principal:
`QUICKSILVER_WEB_RATE_LIMIT_MODEL` (default `5/10`: burst 5, then 10 a
minute) for `/api/plan`, `/api/query` and `/api/workflows/run`, and
`QUICKSILVER_WEB_RATE_LIMIT_WRITE` (default `30/60`) for the decision routes.
On Vercel the web app runs as many serverless instances, each with its own
in-memory buckets that reset on a cold start, so these limits are **per
instance, not global**: they stop one caller from bursting through one
instance, not a determined caller spread across instances. No datastore was
added for a shared count; if one is ever needed, put the limit at the edge
(Vercel's firewall rate limiting) rather than in the app.

| Route | Permission | Notes |
|---|---|---|
| `GET /healthz` | none | Liveness |
| `GET /readyz` | none | Store reachable and host started |
| `GET /metrics` | `audit:read` | Public only with `http.metricsPublic: true` on a private network |
| `POST /webhooks/:id` | HMAC signature | Same contract as [triggers](triggers.md) |
| `GET /api/whoami` | any principal | Grants nothing |
| `GET /api/runs?status=&workflow=&limit=` | `run:read` | Summaries, newest first |
| `POST /api/runs` | `run:enqueue` | `{ workflow, input, idempotencyKey?, priority? }`. Only configured workflows; arbitrary graphs are refused |
| `GET /api/runs/:id` | `run:read` | Result and event history |
| `POST /api/runs/:id/cancel` | `run:cancel` | `{ reason? }` |
| `POST /api/runs/:id/redrive` | `run:redrive` | `{ reason }` of 10+ characters; supervisors only |
| `GET /api/dead-letters` | `run:read` | |
| `GET /api/stats`, `/api/schedules`, `/api/webhooks`, `/api/workflows` | `run:read` / `workflow:read` | No secrets in any listing |
| `GET /api/secrets` | `secret:use` or `secret:read` | Names, versions, dates; never values |
| `PUT /api/secrets/:name` | `secret:write` | `{ value, description?, graceMs? }`. Rotates and reloads affected webhooks |
| `POST /api/admin/reload-secrets` | `tenant:admin` | Re-read webhook secrets |
| `GET /api/genesis` | `decision:read` | Genesis run: config summary, blockers (vault names checked against the host's own vault), money totals, experiments with their current evaluation, playbook facts, ledger verification |
| `POST /api/genesis/experiments` `{ definition }` | `intent:provide` or `decision:propose` | Drafts an `ExperimentDefinition`; `proposedBy` is always the caller |
| `POST /api/genesis/experiments/:id/start` | `intent:provide`, humans only | Fixes the thresholds; refused (409) while any blocker exists |
| `POST /api/genesis/experiments/:id/measurements` `{ value, source }` | `intent:provide` or `decision:propose` | Records a measurement with its source |
| `POST /api/genesis/experiments/:id/evaluate` | `decision:read` | Kill, continue, expiry and over-budget are applied by the kernel; scale and hold are returned as awaiting a decision |
| `POST /api/genesis/experiments/:id/decide` `{ note? }` | `intent:provide`, humans only | Applies the current verdict (scale, hold, or any other) as the founder |
| `POST /api/genesis/money` `{ kind, amountUsd, category, description, source: { type, ref }, experimentId?, confirm? }` | `intent:provide`, humans only | **Records** money that already moved; never moves money. Spend and compute go through `decideSpend`: reject → 422 with reasons; founder decision without `confirm: true` → 409 with reasons |

No API route returns a secret value.

## Secrets vault

`SecretsVault` stores secrets in one file, encrypted with AES-256-GCM under
the master key from the environment. The key is never written to disk.

- **Integrity:** each version has its own nonce and authentication tag. The
  tenant, secret name and version are bound as associated data, so a
  ciphertext copied to another name or edited on disk fails to decrypt.
- **Wrong key or wrong tenant:** the vault refuses to open.
- **Permissions:** `secret:use` resolves a value for the runtime,
  `secret:read` reveals it to a human, and `secret:write` creates, rotates or
  disables. Agents can never hold `secret:read` or `secret:write`.
- **Rotation:** a new version becomes active. The previous one stays valid for
  a grace period (default 24 hours), so webhook senders can switch without
  downtime. At most 10 versions are kept.
- **Audit:** every operation, allowed or denied, is logged with the principal.
  Values never are.
- **Writes** are atomic (temp file, then rename) with mode `0600`.

CLI, acting as a named tenant admin (`cli:<os user>`):

```bash
npm run host -- vault list
printf '%s' "$NEW_SECRET" | npm run host -- vault put inbound-webhook
npm run host -- vault disable inbound-webhook
```

Back up the vault file and the master key separately. Losing the key makes
the vault unreadable. That is the point.

## Logs

One JSON object per line on stdout: `time`, `level`, `msg`, `service`,
`tenantId`, plus event fields such as `runId`, `workflowId`, `status`,
`scheduleId` and `endpointId`. Redaction happens before anything is written:

- values under sensitive keys (`token`, `secret`, `password`,
  `authorization`, `apiKey`, …); `*Digest` fields stay visible;
- credential-shaped strings (`qs_…`, `whsec_…`, `sk-…`, `Bearer …`);
- every secret value the host resolved from the vault or environment.

Main events: `host started`, `run finished`, `step evaluated`,
`tool step blocked`, `schedule slot enqueued` or `refused`,
`webhook delivery accepted` or `refused`, `vault access`, `access denied`,
`evaluation audit write failed`.

## Metrics

Prometheus text format at `/metrics`:

| Metric | Type | Labels |
|---|---|---|
| `quicksilver_runs_finished_total` | counter | `status`, `workflow` |
| `quicksilver_run_duration_seconds` | histogram | `workflow` |
| `quicksilver_queue_runs` | gauge | `status` (refreshed on each scrape) |
| `quicksilver_webhook_deliveries_total` | counter | `endpoint`, `status` |
| `quicksilver_schedule_enqueues_total` | counter | `schedule`, `outcome` |
| `quicksilver_evaluations_total` | counter | `decision` (ALLOW, ESCALATE, BLOCK) |
| `quicksilver_vault_access_total` | counter | `operation`, `outcome` |
| `quicksilver_http_requests_total` | counter | `route`, `status` |
| `quicksilver_up` | gauge | |

Label sets are bounded per metric, so a bad caller can't grow memory without
limit.

## Not yet built

- SSO/OIDC sessions and multi-tenant hosting (before 0.9.0).
- The task intake store and Task MCP client registry now label records with a
  tenant ID and filter reads, lists, idempotency, authentication, and revocation
  by the host's configured tenant. Cross-tenant behavior is covered for shared
  memory/file stores and concurrent client-registry updates. Hosts still serve
  exactly one tenant each; these boundaries do not make the full hosted control
  plane multi-tenant. Existing task/client files without tenant IDs require an
  explicit, reviewed migration before those files are reused.
- A shared webhook replay cache for several host replicas. One host per
  tenant is the supported shape at this version. The Postgres store already
  keeps runs safe across processes.
- Traces and dashboards. Logs and metrics are the M2 baseline.
- Effectful tool execution (playbook milestone).

## Aura intent API (M3)

The host serves the Aura intent entry point and the intent ledger. With a file
run store they are kept next to it under `intent/`; otherwise they are held in
memory.

| Route | Permission | Does |
|---|---|---|
| `POST /api/intents` `{ objective, mode?, autonomyDepth? }` | `intent:provide` | Parses the objective into an intent graph and returns the top questions |
| `GET /api/intents`, `GET /api/intents/:id` | `decision:read` | Lists intents, or returns one with its graph |
| `POST /api/intents/:id/answers` `{ variableId, answer }` | `intent:provide` | Records the answer as the provider's own (`HUMAN_SPECIFIED`, with the quote) and returns the next questions |
| `GET /api/intent-ledger/:company` | `decision:read` | Returns the ledger, its verification result, and the current state |
| `POST /api/intent-ledger/:company` `{ change, reason? }` | `intent:provide` or `intent:rules`, checked by Aura | Appends one change under the provider operating rules |

- Give the founder's principal the `intent-provider` role in
  `QUICKSILVER_PRINCIPALS`. Give an admin the `intent-admin` role.
- By default objectives are read with the rule-based parser.
  `QUICKSILVER_INTENT_PARSER=model` uses the production parser (the model with the autonomy guard; see the Aura
  README), which needs a model provider.
- Nothing here proposes or executes an action.

## Genesis run API (M5)

The Genesis routes above are on when the run config exists
(`QUICKSILVER_GENESIS_CONFIG`, default `deploy/genesis/genesis-500.json`) and
is valid. Data sits next to the intent stores under `genesis/<runId>/`
(`ledger.json`, `experiments.json`, `run.json`), the same layout as
`npm run genesis`, or in `QUICKSILVER_GENESIS_DIR`. Without a file store and
without that variable it is held in memory. Writes are serialized per run.
Every response carries `executed: false`. See [genesis-run.md](genesis-run.md).
