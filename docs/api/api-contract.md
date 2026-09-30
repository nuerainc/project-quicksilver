# Nuera Quicksilver HTTP API contract

The machine-readable contract is [openapi.json](openapi.json) (OpenAPI 3.1.0). Its `info.version` is `0.4.0`, matching the repository release line. This is a **pre-1.0 contract**, not a stable API promise. The version does not assert that every route shape has been fully captured.

## Compatibility policy

Before 1.0.0, route paths and methods are kept in sync with the checked-in OpenAPI file, but request/response shape changes may be breaking and may ship in a minor or patch release. The path/method drift test runs as part of the web regression suite. A 1.0.0 stability promise requires an explicit release decision, complete route schemas, documented error behavior, and a compatibility review; this contract alone does not make that promise.

## Behavior confirmed by current implementation

The business overview uses authenticated `GET /api/dashboard/overview` for
decision, metric, and experiment records and `GET /api/monitoring/workflows`
for recent run metadata. The ledger summary is isolated at
`GET /api/dashboard/finance` and requires the supervisor-only `finance:read`
permission. It reports recorded ledger totals, not a reconciled bank balance
or live processor feed.

- **Authentication:** all API route handlers are covered by the route authorization regression test. They require a bearer credential: a registered principal token, or the configured interim shared-supervisor credential on routes that permit it. Invalid/missing credentials are rejected before request data or side effects are processed. `/api/whoami` also requires a valid credential and returns identity/permissions without granting access.
- **Authorization and tenant:** route permissions are defined in `apps/web/lib/route-guard.ts`; decision routes use their dedicated guard. Principal authorization is evaluated for `QUICKSILVER_TENANT_ID` (default `default`) and fails closed for a tenant mismatch. The caller cannot select the tenant by sending a request-body field. Exact route permissions are maintained in code, not duplicated here as a second policy source.
- **Errors:** common auth refusals use JSON and currently include 401 (unauthenticated), 403 (forbidden), 429 (rate limited), or 503 (authorization/audit service unavailable). Validation and domain failures vary by handler. The OpenAPI `Error` schema describes observed common fields, not a guarantee that every error includes each field.
- **Decision approval review precondition:** `POST /api/decisions/{id}/action` with `action: "approve"` must include the `expectedActionFingerprint` returned with the decision in the plan response. The console shows this value under the collapsed “Approval basis” disclosure and echoes it on approval. The server recomputes the current action fingerprint and returns 409 if it is missing, stale, or the policy snapshot has changed; refresh the plan and review the new action before retrying. This protects the action review boundary but does not make the pre-1.0 API schema stable.
- **Rate limits:** route classes and configuration are in `route-guard.ts`. Model routes use `QUICKSILVER_WEB_RATE_LIMIT_MODEL` (default burst 5, 10 per minute); write routes use `QUICKSILVER_WEB_RATE_LIMIT_WRITE` (default burst 30, 60 per minute). The in-memory token buckets are per principal and per server process/instance, not globally shared. 429 responses include `Retry-After` seconds. Unclassified read-only routes have no web guard rate limit.
- **Workflow versions:** publication/diff routes expose version-oriented workflow operations. This document does not promise a cross-release representation format or an ETag/revision protocol.
- **Agent catalog lifecycle:** the contract captures the validated request fields for draft creation, submission, review, publication, and rollback-draft creation, plus the observed catalog/version response shapes. Definitions use the `nuera-quicksilver:<name>` ID form. A created draft and rollback draft return 201; subsequent lifecycle operations return their agent definition. The contract reflects the handler’s validation and return values; it does not promise idempotency or stable revision/conditional-update semantics.

## Not specified or not guaranteed yet

Route-specific schemas remain incomplete for workflow publication, decision, planning, query, and monitoring operations; those still use explicitly marked generic JSON placeholders. The agent catalog lifecycle and workflow graph validation, simulation, and live-run paths now have concrete schemas. Workflow graph semantic rules remain governed by the kernel validator and live-run response details still vary with runtime outcomes. Error status details beyond confirmed auth/rate-limit and documented route cases, pagination conventions, retry safety, idempotency keys, conditional requests, revision conflict semantics, and SDK compatibility are not uniformly specified. Clients must not infer idempotency or stable revision semantics from the existence of workflow version/diff routes. These remain contract work, not guarantees.

`openapi.json` intentionally lists the current exported HTTP methods and reusable common schemas. It is not a claim of complete behavioral/API stability. Update it alongside every route addition/removal/method change; the regression test fails if the method/path inventory diverges.
