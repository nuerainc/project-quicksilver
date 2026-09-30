# Go SDK foundation

`packages/sdk-go` is a dependency-free Go client for the workflow API. It
currently supports:

- workflow graph validation;
- no-model, no-tools workflow simulation;
- an opt-in live path for read-only query-agent workflows.

The client requires HTTPS outside loopback, supports caller-provided HTTP
clients and request headers, bounds request and response sizes, returns
structured API errors, and checks that run responses report the expected mode
with external effects disabled. Read-only runs also require evaluation data in
the response.

The SDK does not configure credentials, enable live runs, or broaden server
permissions. The live endpoint still depends on the server's
`QUICKSILVER_WORKFLOW_LIVE_RUNS=on` setting and configured model and Sanity
Context MCP credentials. Tool dispatch remains disabled on these workflow
endpoints.

This is an internal foundation, not a published package or stable API. CI runs
`go vet ./...` and `go build ./...`; request/response contract tests,
compatibility guarantees, publishing, and a local harness remain future work.
See the [Go module README](../../packages/sdk-go/README.md) for a usage example.
