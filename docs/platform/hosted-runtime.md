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

## Run it

```bash
cp deploy/quicksilver.host.example.json quicksilver.host.json   # edit
npm run host -- vault keygen            # put the output in QUICKSILVER_VAULT_KEY
npm run host -- check                   # validate config and environment
npm run host                            # start
```

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
| `NEXT_PUBLIC_SANITY_PROJECT_ID` and `SANITY_AUTH_TOKEN` | Store each step evaluation as an `evaluationRecord` document. The legacy challenge project is refused |

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

| Route | Permission | Notes |
|---|---|---|
| `GET /healthz` | none | Liveness |
| `GET /readyz` | none | Store reachable and host started |
| `GET /metrics` | `audit:read` | Public only with `http.metricsPublic: true` on a private network |
| `POST /webhooks/:id` | HMAC signature | Same contract as [triggers](triggers.md) |
| `GET /api/whoami` | any principal | |
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
- A shared webhook replay cache for several host replicas. One host per
  tenant is the supported shape at this version. The Postgres store already
  keeps runs safe across processes.
- Traces and dashboards. Logs and metrics are the M2 baseline.
- Effectful tool execution (playbook milestone).
