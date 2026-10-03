# Nuera Quicksilver HTTP API contract

The machine-readable contract is [openapi.json](openapi.json) (OpenAPI 3.1.0). Its `info.version` is `0.4.0`, matching the repository release line. This is a **pre-1.0 contract**, not a stable API promise. Every operation now declares a named success schema, but the version does not assert that those shapes are frozen.

## Compatibility and versioning policy (pre-1.0)

- **Where the version lives.** `info.version` in `openapi.json` is the only API version. It is the repository release line (`0.4.0`). There is no version in the URL, no version header, and no content negotiation; a client cannot ask for an older shape.
- **What a release may change.** Before 1.0.0, route paths and methods are kept in sync with the checked-in OpenAPI file, but request and response shapes may change incompatibly in a minor or patch release. That includes renaming or removing a field, tightening validation, changing a status code, and changing which error a condition produces.
- **What is enforced.** The web regression suite (`apps/web/lib/app-routes.test.ts`) fails when the exported method and path inventory drifts from `openapi.json`, when an operation ID is missing, when a write operation lacks a request body schema, when a local `$ref` does not resolve, and when any operation's success response is the generic placeholder. It does not compare response schemas against live handler output, so a schema can still lag the code; the handler is authoritative and the schema should be corrected in the same change.
- **Optional and nullable fields.** Where a code path omits a field, the schema leaves it out of `required` (for example the `process` object on decision responses, which exists only when the process engine ran). Clients must tolerate absent optional fields and must ignore fields they do not know: response objects are not closed to additions, so additive fields can appear in any release.
- **Machine-readable changes.** There is no changelog of API changes separate from the repository history. Review the diff of `docs/api/openapi.json` between releases.
- **Not promised.** A 1.0.0 stability promise, a deprecation window, and an SDK compatibility policy do not exist. Whether and when to make the 1.0.0 promise is a product-owner decision; this document does not make it and nothing here should be read as implying it. Publishing a 1.0.0 contract would additionally need a compatibility review of every schema and a decision on the error-code and conflict gaps listed at the end of this file.

## Authentication, tenancy and rate limits

- **Authentication:** all API route handlers are covered by the route authorization regression test. They require a bearer credential (a registered principal token, or the configured interim shared-supervisor credential on routes that permit it) or a revocable browser-session cookie. Invalid or missing credentials are rejected before request data or side effects are processed. `/api/whoami` also requires a valid credential and returns identity and permissions without granting access.
- **Authorization and tenant:** route permissions are defined in `apps/web/lib/route-guard.ts`; decision routes use their dedicated guard. Principal authorization is evaluated for `QUICKSILVER_TENANT_ID` (default `default`) and fails closed for a tenant mismatch. The caller cannot select the tenant by sending a request-body field. Exact route permissions are maintained in code, not duplicated here as a second policy source.
- **Rate limits:** route classes and configuration are in `route-guard.ts`. Model routes (`/api/plan`, `/api/query`, `/api/chat`, `/api/agents/run`, live workflow runs) use `QUICKSILVER_WEB_RATE_LIMIT_MODEL` (default burst 5, 10 per minute); write routes (the decision write routes and the workflow and agent lifecycle writes) use `QUICKSILVER_WEB_RATE_LIMIT_WRITE` (default burst 30, 60 per minute). The in-memory token buckets are per principal and per server process or instance, not globally shared. Unclassified read-only routes have no web guard rate limit.

## Errors

Errors are JSON objects with an `error` string. That is the only field present on every error. Other fields appear on some responses:

| Field | Where it appears |
| --- | --- |
| `code` | Refusals from the shared route guard (`unauthenticated`, `forbidden`, `unavailable`, `rate-limited`, `principal-kind-unavailable`). Not present on the decision routes' own auth refusals or on handler-level errors. |
| `needs` | 403 from the shared route guard: the permissions the route requires. |
| `retryAfterSeconds` | 429 body. The same value is in the `Retry-After` header. |
| `issues` | Some 400 and 422 validation failures: the schema issues (decision routes) or the graph validator's errors (workflow routes). |
| `process` | Decision lifecycle 409 refusals: the engine status, and for a refused transition the `from`, `to` and `reasons`. |
| `reasons`, `conflicts`, `soleOperatorOverride` | The separation-of-duties 403 on decision approval. |
| `detail` | 500 from the decision routes, plan and query: the error class name only, never provider or database text. |
| `telemetry` | 500 from plan, query and workflow run: the trace id and whether spans were written. |
| `activeVersion` | 409 from a live workflow run that pinned a version that is not the active one. |

The `Error` schema in `openapi.json` describes these as optional properties and allows additional ones. The `error` text is for people; match on the status code and, where present, `code`, not on message wording, which may change.

### Status codes

| Status | Meaning | Where it comes from |
| --- | --- | --- |
| 400 | The request is malformed: invalid JSON, a field fails validation, a query parameter is out of range, or (for an approve) `expectedActionFingerprint` is missing. | Every route that takes input. Decision action bodies are strict: an unknown field such as `approvedBy` is a 400. `POST /api/decisions/{id}/execute` also returns 400 when the decision is not `approved` and the process engine is off. |
| 401 | No valid credential, or the browser session is missing, expired or revoked. | Every route. |
| 403 | The caller is authenticated but not allowed: missing permission (`needs` lists it), a non-human principal on a human-only action (execute, supervisor actions), a tenant mismatch, an approver blocked by separation of duties, a supervisor not authorized by every applicable policy, or fault injection requested while disabled. | Every route; the reason is in `error`. |
| 404 | The decision, workflow version or agent definition does not exist for this tenant. | `/api/decisions/{id}` and its action routes; `workflows/diff`, `drafts/submit`, `review`, `publish`, `rollback`; agent lifecycle routes. A workflow `publications` or `executions` listing for an unknown workflow id returns an empty result, not 404. |
| 409 | A state or concurrency conflict: the resource is not in a state that allows the action, or it changed since it was read. See below. | Decision write routes; workflow and agent lifecycle writes; `workflows/diff` and `publications` when a stored version fails its integrity check; live workflow run with a stale pinned version. |
| 413 | The body exceeds 256 KiB. | Workflow and agent lifecycle writes, workflow validate, simulate and run. |
| 422 | The body is well formed but the content cannot run: an invalid workflow graph, or a live run that exceeds the query-agent step limit, uses an unsupported agent or declares a high or critical impact. | `POST /api/workflows/run` only. The lifecycle writes report an invalid graph as 400. |
| 429 | The per-principal rate limit was exceeded. `Retry-After` and `retryAfterSeconds` give the wait in seconds. | Model and write routes (see above). |
| 500 | The handler failed: a datastore or provider error, or required server configuration (Sanity project id, model provider) is absent. The message is generic; detail stays in server logs. | Any route that touches the datastore or a model. |
| 503 | A dependency the request needs is unavailable: authorization or audit storage, browser-session storage, the read data source, or a disabled or unconfigured feature (live workflow runs). | Every route can return it. |

### 409 conflicts

A 409 always means "do not blindly retry the same request": re-read the resource and decide again.

- **Decision actions** (`POST /api/decisions/{id}/action`). Approving requires `expectedActionFingerprint`, the `sha256:` value returned as `approvalFingerprint` in the plan response for that decision. The server recomputes the fingerprint from the decision's stored action, risk level, approval requirement and policy snapshot and returns 409 when the supplied value is stale or does not match, when a policy the decision used is missing, when the live policy versions differ from the snapshot recorded at plan time, or when the kernel blocked the decision. Other 409 causes: the decision is not in a state that accepts the action (with the process engine on, the lifecycle refuses the transition and the body carries `process.reasons`; with it off, only `awaiting-approval` and `proposed` decisions accept an action), the process definition is invalid, and the decision's document revision changed between the server's read and its write ("This decision changed while you were acting on it"). The revision check is internal: callers cannot send a revision or `If-Match` value, so a revision conflict is detected but cannot be targeted. A missing fingerprint is a 400, not a 409.
- **Decision execute, resume and rollback.** 409 covers a failed approval gate on execute (no current supervisor approval for this exact action and policy version, kernel block, changed policy, recorded approver no longer an active human or no longer authorized), a lifecycle transition that is not allowed from the current state (including executing a decision that is already executed, resuming one that has left the initial state, and rolling back a decision that is not eligible), an invalid process definition, a missing process engine for resume, and an internal revision conflict.
- **Workflow publication** (`workflows/drafts`, `drafts/submit`, `review`, `publish`, `rollback`). Versions are immutable and digest-verified; these rules are enforced by the server:
  - a draft whose `workflowId` and `graph.version` already exist is a 409;
  - only a `draft` can be submitted, only a version `in-review` can be reviewed, and a version can be reviewed once;
  - the author cannot review or publish their own version, and the reviewer cannot publish the version they reviewed;
  - publishing needs a reviewed version, and a version that is already published is a 409;
  - a rollback target must be a previously reviewed, deprecated version, and its author and reviewer cannot publish the rollback;
  - lifecycle actions require a signed-in human; an agent or service principal gets 409;
  - publication head and active-version metadata that disagree, or stored content that fails its digest check, are a 409;
  - publishing and rollback make the head and version changes in one datastore transaction, so a version is never active without the head pointing at it, and the previous active version is deprecated in the same transaction.
- **Agent publication** (`agents/drafts`, `drafts/submit`, `review`, `publish`, `rollback`). The same author/reviewer separation and human-actor rules apply, plus: built-in agent definitions cannot be replaced (409), only an archived version can be a rollback source, and a datastore conflict while creating a draft, a rollback draft or publishing is reported as 409 ("created concurrently" or "changed concurrently; refresh and retry").
- **Live workflow run.** A request that pins a `version` other than the active published one returns 409 with `activeVersion`.
- **Known gap.** The workflow lifecycle routes and the agent submit and review routes write with a datastore revision check, but a lost race there is not translated: it currently surfaces as a generic 500, not 409. Treat a 500 on these routes as "state unknown": re-read the publications or catalog before retrying. This is not a designed behavior and may change to 409.
- **No conditional requests.** There are no `ETag`, `If-Match` or `If-None-Match` headers anywhere in the API, and no client-supplied revision parameter. Conflict detection is server-side only.

## Pagination and list bounds

Only `GET /api/decisions` is paginated.

- **`GET /api/decisions`.** Query parameters: `status` (up to four of `proposed`, `awaiting-approval`, `approved`, `executed`, `failed`, `rejected`, `rollback-proposed`, `rolled-back`, comma separated), `limit` (whole number 1 to 50, default 25) and `before` (a date-time string of at most 40 characters). Results are ordered newest first by `createdAt` (falling back to the document creation time). The response carries `hasMore`, which is true when at least one more row exists beyond `limit`, and `counts` for every status across all decisions, independent of the filter. To fetch the next page, pass the `createdAt` of the last row received as `before`. There is no opaque cursor and no total count for the filtered set. Because the cursor is a timestamp, decisions created with the identical timestamp as the cursor row can be skipped between pages, and rows created or changed while paging are not reflected consistently; the list is a view, not a snapshot. An out-of-range `limit`, an unknown or extra `status`, or an unparseable `before` is a 400.
- **Unpaginated, fixed bound.** These return at most a fixed number of the newest or first rows and accept no cursor. The server silently truncates; apart from `entities`, the response does not say so.

| Route | Bound |
| --- | --- |
| `GET /api/monitoring/workflows` | `limit` 1 to 100 (default 100), newest first, tenant-wide. |
| `GET /api/monitoring/traces` | `limit` 1 to 500 (default 200), newest spans first. Alerts and totals are computed over the returned sample only. |
| `GET /api/workflows/executions` | Requires `workflowId`; `limit` 1 to 100 (default 25), newest first. |
| `GET /api/workflows/publications` | Requires `workflowId`; the newest 100 versions and the newest 100 audit events. Not adjustable. |
| `GET /api/entities` | The first 500 entities ordered by name; `total` is the full count, so a client can detect truncation by comparing it with `entities.length`. Not adjustable. |
| `GET /api/agents/catalog` | Up to 200 active definitions, 100 awaiting review, 100 drafts and 100 audit events. Not adjustable. |
| `GET /api/agents/definitions` | Requires an agent id; the newest 100 versions and 100 audit events. Not adjustable. |
| `GET /api/inbox` | Draws on the newest 60 decisions and the other sources' own bounded samples. Not adjustable. |
| `GET /api/dashboard/overview` | The latest 8 decisions, metrics and experiments. Not adjustable. |

A malformed or out-of-range `limit` is a 400 on the routes that accept one; it is never silently clamped. A workflow with more than 100 versions or audit events has its older history unreachable through the API today.

## Idempotency and retry safety

There are no idempotency keys and no request IDs. A retried request is a new request. The table says what a repeat does; "safe" means a second identical call cannot cause a second effect, not that it returns the original result.

| Operation | Retry behavior |
| --- | --- |
| All `GET` routes | Safe. Read-only. |
| `POST /api/decisions/{id}/observe` | Safe to repeat. It reads the latest metric and, with the process engine on, writes the same `observedDeviation` flag. The answer changes if a newer metric has been recorded. |
| `POST /api/decisions/{id}/action` | A repeat of an approve or reject after it succeeded is refused with 409 (the decision has left `awaiting-approval`), so it cannot approve twice. Because the 409 does not replay the first result, after a timeout read the decision before concluding anything. `request-evidence` is not idempotent: every accepted call prepends another note to the reasoning summary. |
| `POST /api/decisions/{id}/execute` | A repeat after success is refused (409, or 400 when the process engine is off) because the decision is no longer `approved`. The simulated outcome is deterministic per decision id. The decision update, the metric record and (for a rollback decision) the parent update are separate writes, not one transaction: a 500 can leave the decision already `executed` with its metric record missing. Read the decision before retrying. |
| `POST /api/decisions/{id}/resume` | A repeat is refused with 409 once the decision has left its initial state. |
| `POST /api/decisions/{id}/rollback` | With the process engine on, the original decision moves to `rollback-proposed`, so a repeat is refused unless a failed rollback may be retried. With the engine off there is no guard: every call creates another rollback decision (`decision-rollback-<id>-<timestamp>`). Not safe to retry blindly. |
| `POST /api/plan` | Not safe. Every call runs the planner and reviewer models, spends tokens, and persists new decision documents. Retrying after a timeout can leave duplicate pending decisions; list `GET /api/decisions` first. |
| `POST /api/query` | Not side-effect free: each call runs a model and writes an evaluation record and trace spans. The answer is not deterministic. |
| `POST /api/workflows/drafts` | The `workflowId` and `graph.version` come from the body, so a repeat after success is a 409 (already exists), not a duplicate. |
| `POST /api/workflows/drafts/submit`, `review`, `publish`, `rollback` | State-guarded: a repeat after success is a 409 because the version is no longer in the required state (for `rollback`, because the target is now active). No duplicate effect, but no replay of the first response. |
| `POST /api/agents/drafts` and `POST /api/agents/rollback` | Not idempotent: the server assigns the next version number, so a repeat creates another draft version. |
| `POST /api/agents/drafts/submit`, `review`, `publish` | State-guarded in the same way as the workflow lifecycle writes. |
| `POST /api/workflows/run` | Not safe: each call is a new run with a new run id, calls a model, and records an execution. |
| `POST /api/chat`, `POST /api/agents/run` | Not safe to assume repeatable: each call runs a model. They do not execute external actions. |

After any timeout or 5xx on a write, read the resource (decision, publications, catalog) to learn whether it applied, then decide. Do not retry on a 4xx other than 429; for 429, wait `Retry-After` seconds.

## Behavior confirmed by current implementation

The business overview uses authenticated `GET /api/dashboard/overview` for decision, metric, and experiment records and `GET /api/monitoring/workflows` for recent run metadata. The ledger summary is isolated at `GET /api/dashboard/finance` and requires the supervisor-only `finance:read` permission. It reports recorded ledger totals, not a reconciled bank balance or live processor feed.

- **Decision approval review precondition:** `POST /api/decisions/{id}/action` with `action: "approve"` must include the `expectedActionFingerprint` returned with the decision in the plan response. The console shows this value under the collapsed "Approval basis" disclosure and echoes it on approval. See "409 conflicts" for what the server checks. This protects the action review boundary but does not make the pre-1.0 API schema stable.
- **Process engine variants:** the decision write routes have two paths. With `QUICKSILVER_PROCESS_ENGINE=on` and a seeded definition, transitions are authorized by the Decision Lifecycle process definition and responses carry a `process` object; otherwise the legacy path runs and `process` is absent. The response schemas mark the engine-only fields optional for that reason.
- **Workflow versions:** publication and diff routes expose version-oriented workflow operations (`PublishedWorkflowVersion`, `WorkflowVersionDiff`, `WorkflowPublications`). Versions are immutable and carry a digest that is re-verified on every read. This document does not promise a cross-release representation format for stored versions.
- **Agent catalog lifecycle:** the contract captures the validated request fields for draft creation, submission, review, publication, and rollback-draft creation, plus the observed catalog and version response shapes. Definitions use the `nuera-quicksilver:<name>` ID form. A created draft and rollback draft return 201; subsequent lifecycle operations return their agent definition.
- **Telemetry and execution history:** `GET /api/monitoring/traces` and the workflow execution routes return metadata only. Prompts, outputs, tool arguments and secrets are never part of these responses.

## Not specified or not guaranteed yet

- **Stability:** no 1.0.0 promise, deprecation window or SDK compatibility policy exists; see the versioning policy above. These are product-owner decisions.
- **Schema fidelity:** response schemas are written from the handlers but are not verified against live responses by a test. Some kernel-internal structures are described loosely on purpose (the capability graph finding and the risk arithmetic in `/api/plan` are open objects), and the live workflow run response still varies with runtime outcomes.
- **Error contract:** `error` is the only guaranteed error field, and not every route returns `code`. A lost datastore revision race on workflow lifecycle writes returns 500 where 409 would be expected. Error wording is not stable.
- **Conflict semantics:** there is no client-supplied revision, `ETag` or conditional request. The decision fingerprint is the only caller-visible precondition.
- **Pagination:** only `/api/decisions` pages. Other lists truncate silently at the bounds above, and workflow history older than 100 versions is not reachable.
- **Idempotency:** no idempotency keys; retry safety is a by-product of state guards, as listed above, and several writes (plan, agent draft creation, engine-off rollback) are not safe to repeat.
- **Rate limits** are per process, not global.

`openapi.json` intentionally lists the current exported HTTP methods and reusable common schemas. It is not a claim of complete behavioral or API stability. Update it alongside every route addition, removal, or method change; the regression test fails if the method and path inventory diverges.
