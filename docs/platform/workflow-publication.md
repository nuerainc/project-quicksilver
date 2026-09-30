# Workflow publication lifecycle

The workflow builder keeps its editable browser copy local. A person with
`workflow:write` can save a validated graph as a shared, immutable version and
submit it for review. A different human with `workflow:publish` records the
review, and a second publisher releases it. The author cannot review their own
version, and the reviewer cannot publish that version.

## Lifecycle API

Every endpoint requires a per-person credential and is rate-limited on writes.
The server derives actor identity from the authenticated principal; request
bodies cannot select an actor or tenant.

| Endpoint | Permission | Effect |
|---|---|---|
| `GET /api/workflows/publications?workflowId=...` | `workflow:read` | Lists up to 100 tenant-scoped versions and audit events |
| `GET /api/workflows/executions?workflowId=...&limit=25` | `workflow:read` | Lists metadata-only run history (limit 1–100) |
| `GET /api/workflows/diff?workflowId=...&from=1&to=2` | `workflow:read` | Compares verified versions; returns changed fields and safety-sensitive deltas without config values |
| `POST /api/workflows/drafts` | `workflow:write` | Validates and creates a new immutable version |
| `POST /api/workflows/drafts/submit` | `workflow:write` | Moves a draft to review |
| `POST /api/workflows/review` | `workflow:publish` | Records an independent human reviewer and a required 10–500 character rationale in the version and audit log |
| `POST /api/workflows/publish` | `workflow:publish` | Activates the reviewed version and archives the former active version |
| `POST /api/workflows/rollback` | `workflow:publish` | Reactivates a previously reviewed, archived version |

The Sanity documents contain the graph, its canonical digest, lifecycle and
actor metadata. Reviewer rationale is mandatory and appears in the audit
history. The version diff compares node and edge changes and flags changes to
impact, side-effect, evaluation, and supervisor-approval settings without
returning configuration values. A per-workflow head document uses revision-conditional
transactions to serialize releases, so two concurrent publishes cannot leave
two versions active. Audit records are separate append-only documents. Reads
recompute and verify every graph digest before returning a version.

The single-tenant host has its own file-backed publication store today. On
restart it validates graph shape, version/digest bindings, audit references,
and the one-active-version invariant; inconsistent snapshots stop startup.
This detects accidental or partial snapshot corruption, but is not a signed or
tamper-evident audit chain. Host publication state is not yet shared with the
web app's Sanity-backed publication store.

## Storage and limits

All reads and writes use the existing server-only Sanity client. The helper
rejects the public challenge project ID and uses the configured dedicated
Nuera Quicksilver project and tenant (`QUICKSILVER_TENANT_ID`, defaulting to
`default`). No Sanity project, token, or dataset configuration is changed by
this feature.

The new publication head, audit, and execution schemas, plus publication and
review-note fields on `automationWorkflow`, are included in the Studio schema. Deploy those
schemas to the dedicated project before using Sanity Studio to inspect or
operate on publication records. The API itself still applies NQC RBAC and
separation-of-duties checks.

Publication establishes durable version history and an active-version pointer.
The live workflow runner accepts either an editable graph (development path) or
an active published workflow ID. Published runs resolve through the server-side
tenant-scoped head, verify graph integrity, and may pin an explicit version only
when it is still active. Execution history stores the workflow version and
digest, requester, timestamps, duration, and status; it does not store input or
output bodies. Executions are marked succeeded, blocked, or failed. Existing
evaluation records continue to follow the evaluation store's own retention
behavior. If execution-history storage fails, the run
response reports that separately from the workflow result. Tools remain
blocked; scheduled deployment and hosted execution are not part of this slice.
