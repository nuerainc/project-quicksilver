# Operator memory (M8 part 2)

The Operator keeps two distinct stores under `.qs-memory/`:

- `memory.json` is the governed memory book: short notes, user profile facts,
  provenance, expiry, and its metadata audit history.
- `runs/` and `recall.sqlite` are the session archive and full-text index.
  Exporting a memory book does not export or delete archived transcripts.

## Write and review rules

Human-stated profile values become active immediately and cannot be replaced
or forgotten by the agent. Agent-inferred profile values remain pending until a
person approves them. Agent notes become active immediately. New values reject
common credential, private-key, government-ID, and payment-card patterns; each
entry is limited to 500 characters and at most 3,650 retention days. The
default retention is 365 days.

Replacing an inferred note preserves the old version as superseded, links both
versions, and excludes the old value from the active prompt snapshot. Snapshots
include the memory ID, source citation, provenance hash, confidence, and expiry.
The agent sees active, unexpired entries only. Expiry redacts the text while
retaining the content digest and metadata event. A legal hold blocks removal
and expiry purge until a reviewer releases it.

## Audit, effectiveness, backup, and restore

Every memory lifecycle event is appended to a SHA-256 hash chain. Event records
contain IDs, actors, timestamps, outcomes, and content digests, but not memory
text. On reopen, the store verifies event sequencing, chain links, memory
content hashes, and provenance hashes. This detects accidental edits and
unsophisticated tampering. It is not a signature or protection from a
privileged writer who can rewrite the file and recompute the chain.

`MemoryBook.recordEffectiveness(id, outcome, reviewerId)` records one explicit
`useful`, `stale`, or `harmful` signal per reviewer and memory version. Counts
are derived from verified audit events on read. The method is an internal
storage API: callers must authenticate and authorize reviewers before calling
it. There is not yet a product review surface.

`MemoryBook.exportData()` creates an integrity-checked portable bundle. It
contains plaintext memory and must be protected as sensitive data. The digest
detects accidental edits; it is not an authenticity signature. Restore verifies
the bundle, content policy, provenance, and creation-event binding, and only
imports into an empty book. It appends a restore event after the imported audit
head rather than replacing an existing memory book.

```ts
const backup = await source.exportData()
await target.restore(backup, authorizedReviewerId)
```

These methods do not implement encryption-at-rest, access control, tenant or
domain labels, cross-process locking, or authorized export/restore endpoints.
Per-person memory storage currently derives a directory from a sanitized
person ID; colliding sanitized IDs and migration to collision-safe namespaces
must be resolved before multi-tenant hosting. P-018 remains partial until those
gaps and explicit source-decision validation are closed.

Regression coverage is in `packages/operator/src/operator.test.ts` under the
`memory:` cases. Run it with:

```sh
node --experimental-strip-types --no-warnings --test packages/operator/src/operator.test.ts
```
