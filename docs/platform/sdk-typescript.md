# TypeScript SDK foundation

The private workspace package `@nuera/quicksilver-sdk` currently provides a
typed client for workflow graph validation, safe preview, and opt-in read-only
workflow runs. It requires an HTTPS API URL outside localhost, supports an
injected `fetch` for custom runtimes, accepts an `AbortSignal`, validates
response shapes, and reports structured HTTP errors. Read-only runs use the
existing `query` agent, return the full NQC evaluation contract including
routing and governed memory proposals, and require the server flag and
credentials described in the [workflow guide](workflow-graphs.md).

This is an internal SDK foundation, not a published package. Authentication,
agent creation, and broader hosted-run APIs depend on the platform identity and
authorization design. The internal Python client and `qs` CLI are documented
in the [Python SDK guide](sdk-python.md); a Go client remains future work.
