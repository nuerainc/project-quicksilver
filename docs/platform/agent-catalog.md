# Governed agent definition catalog

The first agent-management slice is a tenant-scoped catalog of **declarative
manifests**. It lists the built-in registry and published Sanity definitions,
and provides draft → review → publish lifecycle routes plus an operator page
at `/agents`. Sanity stores immutable versions, integrity digests, independent
review metadata, a compare-and-swap active-version head, and append-only audit
records.

## Contract and safety boundary

An agent definition contains a stable `nuera-quicksilver:` ID, version,
`propose` or `review` authority, supported task types, maximum impact, and an
evaluation requirement. The kernel validator is shared with the in-process
registry. Built-in IDs cannot be replaced. Publishing requires three distinct
human identities for author, reviewer, and publisher. Agents cannot perform
these lifecycle actions. A published definition is metadata only: it is not
loaded into the runtime, does not grant approval authority, and cannot install
or execute a plugin.

Routes are `GET /api/agents/catalog`, `GET /api/agents/definitions?agentId=…`,
and authenticated POST routes under `/api/agents/{drafts,drafts/submit,review,publish}`.
They use dedicated `agent:read`, `agent:write`, `agent:review`, and
`agent:publish` grants. The built-in viewer/auditor/agent-worker roles can read;
developers can author; human supervisors can review and publish. Agent
principals cannot hold review or publish authority, and publishing enforces
separation of duties. Catalog writes use the dedicated private Quicksilver
Sanity project configuration and never the public challenge dataset.

Rollback is a controlled new-version workflow. A developer can copy an archived
version into a new draft; the catalog verifies the source digest and active
publication head, records the source version and digest, and leaves the draft
subject to the ordinary independent review and publication gates. It never
reactivates or edits archived content in place.

## Current limits

- No user-supplied executable code, dynamic plugins, deployment, or runtime
  registration is supported.
- No dedicated archive endpoint or editable draft revision endpoint yet; create
  a new immutable version to change a definition.
- Existing active definitions continue to run only where the runtime already
  uses built-in agents. The catalog does not change dispatch behavior.
- Catalog definitions remain metadata-only. Runtime integration must continue
  to require a registered handler and NQC dispatch authorization; publication
  by itself does not create executable behavior.
