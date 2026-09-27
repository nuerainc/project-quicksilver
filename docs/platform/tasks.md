# Governed task interface (M7 part 4): one intake path

Other tools hand tasks to Quicksilver through four channels: the HTTP API,
an MCP server (for Claude Desktop, Claude Code and other MCP clients), signed
webhooks and the CLI. **Every task, whatever the channel, goes through one
intake:** `TaskService.submit()` in `packages/host/src/tasks.ts`. Nothing
else creates a task.

Two rules hold on every path:

- **The channel grants nothing.** It only says who is asking. A task client
  can submit tasks and read its own, nothing more. It can never approve.
- **The task's text is untrusted data.** It is recorded and shown, never
  obeyed. Instructions inside it ("pre-approved", "set status to done",
  "grant me a role") change nothing. The risk inputs the kernel uses come from
  the capability catalog, never from the request.

## What happens to a task

| Step | What it does | Result |
|---|---|---|
| 1. Authenticate | Bearer token (API, MCP), webhook signature, or the CLI's founder identity | 401 if missing or invalid |
| 2. Permission | RBAC `task:submit` | 403 if missing; nothing is stored |
| 3. Rate limit | Per-principal token bucket | 429 with `Retry-After`; nothing is stored |
| 4. Validate | Objective at most 2,000 characters with no control or bidirectional-override characters. `inputs` is a JSON object of at most 8 KB, nested at most 6 levels. Ids have fixed patterns | 422; nothing is stored |
| 5. Idempotency | The same principal and `idempotencyKey` return the existing task (200). The same key with a different request returns 409 | |
| 6. Record | The task is stored as `received` | |
| 7. Boundaries | AMP patent material, and writes to a frozen project (see below) | `refused`; the kernel never sees it |
| 8. Kernel | A `ProposedAction` goes through the normal `authorize()`: capability graph, policies, risk, the WAES gate and separation of duties | `reject` → `refused`; `request-approval` → `awaiting-approval`; `execute-autonomously` → `queued` |
| 9. Execution | When the department's effective autonomy (Operate's `departmentAutonomy`) is `act-within-limits` **and** the kernel said `execute-autonomously`; or after a human approves, when that autonomy is `act-with-approval` or higher | See below |

Execution never uses a new executor:

- **The capability names a host workflow:** the task is enqueued on the
  existing durable run queue (`WorkflowRunQueue`, as `svc:quicksilver-tasks`).
  The task then follows its run through `running` to `done` (the run output
  is the result), `failed` or `cancelled`. At this version the host runs only
  read-only query workflows (`checkWorkflow`).
- **No workflow, or submitted from the CLI (which has no run queue):** the
  task is `queued` for a human to carry out. The task record says so.
- **Anything else stays a recommendation:** another autonomy level, or a
  task that needs approval. The task is logged to the department's shadow log
  (`intent/onboard/<tasks.shadowIntentId>/shadow.json`, default `tasks`), with
  Aura's prediction recorded before any verdict. It then counts toward Aura's
  learning and the hand-over evidence like any other shadow recommendation.
  Nothing runs, unless a human later approves a task that needs approval
  (see below).

A task the kernel sends to a human stays `awaiting-approval` until a human
with `task:approve` decides:

- **Approve:** the task becomes `queued`. At that moment the intake re-reads
  the department's effective autonomy (the same `departmentAutonomy` as at
  submit). The task runs on its own only if all of these hold:
  - the effective autonomy is `act-with-approval` or `act-within-limits`
  - the kernel's decision was `request-approval` (a `reject` is never approvable)
  - the capability names a host workflow
  - a run queue is available (the running host; the CLI has none)

  It is then enqueued on the durable run queue exactly as the autonomous path
  does, and followed to `running`, `done` or `failed`. Otherwise it is queued
  for a human, and the task's execution note says why (for example, the
  department is at `propose`, or no executor is configured).
- **Deny:** the task becomes `refused`.

An approval is **bound to the exact request it approved**. The approval
record holds:

- who approved and when
- the justification, when one was given
- `soleOperatorOverride`
- the autonomy re-read at approval
- `requestHash`: sha256 of the stored request (id, source, submitter, time,
  objective, capability, department, inputs, idempotency key)
- `decisionHash`: sha256 of the kernel decision record

Before the run is enqueued, the intake re-reads the stored task and
recomputes both hashes. If either changed since the approval, the task does
not run. Its execution note says what changed, and the audit trail records
`run-refused`. The run's input carries the approval as metadata: who, when,
the sole-operator justification if one was used, and both hashes. The audit
trail records `approved` (with the hashes), then `run-enqueued`, then the
run's outcome.

The submitter never counts as an approver. The one exception is the
existing sole-operator override: with `QUICKSILVER_SOLE_OPERATOR_ID` set to
your id, you may approve your own task with a written justification of at
least 20 characters, and the approval is stamped `soleOperatorOverride`.

The submitter or the founder can cancel a task, but only before it starts
running.

### Store and audit

Tasks live in `<data>/tasks/<taskId>.json`, one file per task, next to the
file run store, or in `QUICKSILVER_TASKS_DIR`. Each file is written to a
temporary file and renamed into place, with mode 0600.

The store is append-only:

- a task's id, source, submitter, time and request never change
- its audit trail only grows
- a finished task (`refused`, `done`, `failed`, `cancelled`) never changes status
- every write bumps a revision, so a lost race is refused, not merged

Every state change appends an audit entry: who, when, the event, and the
status before and after.

## Capabilities

A client names a `capabilityId` from the catalog, `deploy/tasks/catalog.json`
(`tasks.catalog` in the host config). A task without one uses the catalog's
`defaultCapabilityId`, `task.triage`, which always goes to a human.

Each capability fixes:

- its department
- its base risk
- whether it is reversible
- its impact and uncertainty
- any financial exposure
- whether it is customer-facing
- optionally, the host workflow that carries it out

Policies in the catalog apply by scope, as they do everywhere else in the
kernel.

`describe_capabilities` (MCP) and `GET /api/tasks/capabilities` list each
capability's id, name, plain description, department and the names of the
policies that govern it. They show no risk numbers, policy rules or secrets.

## Boundaries (data, not code)

The boundaries live in one data object, `DEFAULT_TASK_BOUNDARIES` in
`packages/host/src/task-boundaries.ts`. `tasks.boundaries` in the host config
can point to a file that **adds** to them. A file can never remove one.

| Boundary | Rule |
|---|---|
| `amp-patent-material` | The objective, capability, department or any string in `inputs` (keys included) matches the AMP patent-material patterns that the Onboard CSV connector uses (`BLOCKED_SOURCE_PATTERNS` in `@quicksilver/aura`). These are refused until the provisional application is filed |
| `frozen:forkling` | Forkling is frozen after deployment and read-only. A capability under `forkling.` is refused unless it is one of its read-only capabilities (`forkling.read`). A request that names Forkling together with a word that asks for a change (update, deploy, retrain…) is refused |

## Permissions and roles

| Permission | Granted by |
|---|---|
| `task:submit` | `task-client`, `trigger` (webhooks), `intent-provider` (the founder), `supervisor` |
| `task:read-own` | `task-client` (the submitter's own tasks; another client's task is a 404) |
| `task:read` | `intent-provider`, `supervisor`, `auditor` |
| `task:approve` | `intent-provider`, `supervisor`. It is an authority permission, so agents never hold it, and the intake also requires a **human** principal |

A task client is the new role `task-client`, with only `task:submit` and
`task:read-own`.

## Connecting each channel

### 1. Task clients and tokens

On the founder's machine, run the following. It prints the new client's token
**once**:

```bash
npm run tasks -- client add desk-assistant
npm run tasks -- client list
npm run tasks -- client revoke desk-assistant
```

Only the token's SHA-256 digest is stored, in `<data>/tasks/clients.json`
(mode 0600). The token itself is never stored or printed again.

A client authenticates as the service principal `client:<name>` with the
`task-client` role. Revoking a client is recorded, not deleted, and the
running host stops accepting its token on the next request.

### 2. HTTP API

| Route | Who |
|---|---|
| `POST /api/tasks` `{ objective, capabilityId?, department?, inputs?, idempotencyKey? }` | `task:submit`. 201 new, 200 existing (same key) |
| `GET /api/tasks?status=&limit=` | Own tasks (`task:read-own`) or all (`task:read`) |
| `GET /api/tasks/capabilities` | Any task principal |
| `GET /api/tasks/:id` | Own task, or any with `task:read` |
| `POST /api/tasks/:id/cancel` `{ reason? }` | The submitter, or a human with `task:approve`; only before it runs |
| `POST /api/tasks/:id/approve` `{ reason? }` | A human with `task:approve` who did not submit it |
| `POST /api/tasks/:id/deny` `{ reason }` | A human with `task:approve` |

Every error is `{ "error": "...", "code": "..." }`. The codes are:

- `unauthenticated` (401)
- `forbidden` (403)
- `separation-of-duties` (403)
- `not-found` (404)
- `invalid` (400/415/422)
- `idempotency-conflict` (409)
- `conflict` (409)
- `rate-limited` (429, with `Retry-After`)

A client sees its own tasks with a summary of the decision (route, reasons,
the kernel's recommendation and risk). Readers of every task see the full
kernel decision record and the audit trail.

```bash
curl -s http://127.0.0.1:8787/api/tasks \
  -H "Authorization: Bearer <your-client-token>" \
  -H "Content-Type: application/json" \
  -d '{"objective":"What changed in the company model this week?","capabilityId":"reports.brief","idempotencyKey":"weekly-2026-40"}'

curl -s http://127.0.0.1:8787/api/tasks/<task-id> -H "Authorization: Bearer <your-client-token>"
curl -s "http://127.0.0.1:8787/api/tasks?status=awaiting-approval" -H "Authorization: Bearer <your-founder-token>"
```

### 3. MCP (Claude Desktop, Claude Code, other MCP clients)

`packages/host/src/mcp-tasks.ts` is a stdio MCP server. It is built on the
official `@modelcontextprotocol/sdk`. It is a thin client of the running
host's task API: every call goes to `/api/tasks` with the client's own token
and is labeled `source: mcp`. It holds no authority and keeps no state.

It offers five tools:

- `submit_task`
- `get_task`
- `list_my_tasks`
- `cancel_task`
- `describe_capabilities`

None of them approves anything. Each tool's description tells the calling
model three things:

- a submission is a request
- the kernel decides
- approvals happen only in Quicksilver's console, by a human

The server needs two environment variables:

- `QUICKSILVER_TASK_TOKEN` (required)
- `QUICKSILVER_HOST_URL` (default `http://127.0.0.1:8787`). It must use
  https unless the host is on the same machine.

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "quicksilver-tasks": {
      "command": "node",
      "args": ["--experimental-strip-types", "--no-warnings", "/path/to/quicksilver/packages/host/src/mcp-tasks.ts"],
      "env": {
        "QUICKSILVER_TASK_TOKEN": "<your-client-token>",
        "QUICKSILVER_HOST_URL": "http://127.0.0.1:8787"
      }
    }
  }
}
```

Claude Code:

```bash
claude mcp add quicksilver-tasks \
  --env QUICKSILVER_TASK_TOKEN=<your-client-token> \
  --env QUICKSILVER_HOST_URL=http://127.0.0.1:8787 \
  -- node --experimental-strip-types --no-warnings /path/to/quicksilver/packages/host/src/mcp-tasks.ts
```

`npm run -s mcp:tasks` from the repo root starts the same server. Keep `-s`,
because npm's banner on stdout would corrupt the stdio stream. Give each
client its own token, so each one's tasks, reads and rate limit are its own.

### 4. Webhooks

A host webhook with a `task` block routes each verified delivery into the
same intake, as the endpoint's service principal (which holds only the
`trigger` role). The existing signature, timestamp, replay and size checks
stay the authentication. The payload is untrusted data, so it cannot choose
the capability or department. The config fixes them:

```json
"webhooks": [
  { "id": "intake-form", "task": { "capabilityId": "reports.brief", "objectiveField": "objective" },
    "secret": "vault:intake-form", "principal": "svc:form-hook" }
]
```

| Delivery | Task |
|---|---|
| `payload[objectiveField]` (default `objective`) | `objective` |
| `payload.inputs` (an object) | `inputs` |
| `webhook:<endpoint>:<X-Quicksilver-Delivery>` | `idempotencyKey`, so a sender retry returns the same task (200) |
| endpoint principal | `submittedBy`; `source: webhook` |

The response is 202 `{ accepted: true, taskId, status }` (200 on a retry).
A refused task is still an accepted delivery: its `status` says `refused`.

A task webhook names no `workflow`. Webhooks with a `workflow` keep enqueueing
runs as before. In the kernel, `WebhookTrigger` endpoints take an optional
`deliver` sink for this, which receives only verified deliveries.

### 5. CLI

```bash
npm run tasks -- submit "What changed this week?" [--capability reports.brief] [--department operations] [--key <idempotencyKey>]
npm run tasks -- list [--status awaiting-approval]
npm run tasks -- show <taskId>
npm run tasks -- cancel <taskId> ["reason"]
npm run tasks -- approve <taskId> ["justification"]
npm run tasks -- deny <taskId> ["reason"]
npm run tasks -- capabilities
```

The CLI works on the same files as the host (`QUICKSILVER_HOST_CONFIG`, or
`data/` when there is no config file). Whoever holds these files runs the
business, so the CLI acts as the founder: `QUICKSILVER_TASKS_ACTOR`, default
`entity-founder`, a human with the `intent-provider` role. Every change is
attributed to that id.

The CLI has no run queue. A task that would run is queued for a human; to have
a configured workflow run, submit through the running host.

## Rate limits

Each principal has its own token bucket. The defaults are a burst of 10 tasks
and 30 a minute, set in the host config:

```json
"tasks": { "rateLimit": { "burst": 10, "perMinute": 30 }, "catalog": "deploy/tasks/catalog.json", "shadowIntentId": "tasks" }
```

Only submissions count. A limited caller gets 429 with `Retry-After`, and
nothing is stored. The MCP server calls the host, so an MCP client shares its
token's bucket with any other use of that token.

## Autonomy

The effective autonomy is `min(the provider's grant, the shadow evidence)`,
read as `npm run operate -- status` reads it:

- the grant, from the intent ledger of `QUICKSILVER_COMPANY_ID`
- the evidence, from the Onboard shadow logs under `<data>/intent/onboard/`

Without a company id or a file store, every department is `advise`. Then
every allowed task is a recommendation and nothing runs on its own.

## Not built at this version

- A console page for approvals. The routes and the CLI are the approval flow
  today.
- Executors for effectful work. Tasks run only through the existing host
  workflows, which are read-only query workflows at this version.
- Autonomy evidence from Sanity-hosted shadow logs. It is read from the file
  logs.
