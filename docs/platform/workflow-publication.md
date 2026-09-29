# Workflow publication lifecycle (M8 foundation)

The kernel now provides a versioned, digest-pinned publication lifecycle for
workflow content in `packages/kernel/src/workflows/publication.ts`. The
`FileWorkflowPublicationStore` adapter persists tenant/deployment state as a
private JSON snapshot using a temporary file and atomic rename, so published
workflow state survives a host restart.

## Lifecycle

```text
draft → in-review → published → deprecated
                              ↘ rollback → published
```

- **Draft:** a human author creates a graph after kernel graph validation.
- **In review:** the author submits the exact graph for review.
- **Published:** a human with `workflow:publish` publishes only after an
  independent reviewer has recorded approval.
- **Deprecated:** publishing a newer version deprecates the previous published
  version rather than deleting it.
- **Rollback:** a previously reviewed deprecated version can be restored by a
  human publisher; the event is retained in the audit log.

## Safety properties

- Agents and services cannot author, review, publish, or roll back workflow
  versions through this contract.
- An author cannot review their own workflow.
- A reviewer cannot publish the same workflow version.
- Invalid graphs and duplicate workflow versions are refused.
- Every version stores an immutable graph copy and a `sha256:` digest.
- Publication and rollback do not execute a workflow or grant executor
  authority. Runtime admission must still authenticate the caller, enforce
  tenant policy, and pin the run to the published digest.
- Audit entries retain the workflow id, version, actor, timestamp, and digest.
- File-backed snapshots are created with restrictive permissions and never
  expose the workflow store through the runtime executor.

## Verification

`packages/kernel/src/workflows/publication.test.ts` covers invalid and duplicate
drafts, digest pinning, independent review, deprecation, rollback, audit
ordering, and restart persistence. The suite is included in
`npm run kernel:test`.

This is the M8 contract foundation. A later host/Sanity adapter must provide
persistent storage, tenant-scoped access checks, and API/UI routes without
weakening the kernel lifecycle.

## Host API integration

The single-tenant host now exposes the lifecycle through authenticated routes:

| Method | Route | Required permission | Purpose |
|---|---|---|---|
| `GET` | `/api/workflows/:id` | `workflow:read` | Read configured metadata and publication versions |
| `POST` | `/api/workflows/drafts` | `workflow:write` | Create a validated draft |
| `POST` | `/api/workflows/:id/submit-review` | `workflow:write` | Submit the authored version for review |
| `POST` | `/api/workflows/:id/review` | `workflow:publish` | Record independent human review |
| `POST` | `/api/workflows/:id/publish` | `workflow:publish` | Publish the reviewed version |
| `POST` | `/api/workflows/:id/rollback` | `workflow:publish` | Restore a reviewed deprecated version |

The host applies its normal bearer authentication, tenant boundary, route-table
permission floor, rate limits, and JSON body limits before invoking the kernel
store. File-backed hosts use a private `workflow-publications.json` snapshot
next to the configured run store; memory-backed hosts use an in-memory adapter.

## Runtime binding

`POST /api/runs` resolves a published version before falling back to a static
host-config workflow. The queue receives the immutable published graph, so the
durable run record contains its version and graph digest. The admission response
also returns `{ publication: { version, digest } }` for published runs. A later
publication cannot mutate an already-admitted run; it only changes which
published version a subsequent admission resolves.
