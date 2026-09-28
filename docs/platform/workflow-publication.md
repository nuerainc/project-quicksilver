# Workflow publication lifecycle (M8 foundation)

The kernel now provides a versioned, digest-pinned publication lifecycle for
workflow content in `packages/kernel/src/workflows/publication.ts`.

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

## Verification

`packages/kernel/src/workflows/publication.test.ts` covers invalid and duplicate
drafts, digest pinning, independent review, deprecation, rollback, and audit
ordering. The suite is included in `npm run kernel:test`.

This is the M8 contract foundation. A later host/Sanity adapter must provide
persistent storage, tenant-scoped access checks, and API/UI routes without
weakening the kernel lifecycle.
