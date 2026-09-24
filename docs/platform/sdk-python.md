# Python SDK and CLI foundation

`packages/sdk-python` contains an internal, dependency-free synchronous Python
client for the Nuera Quicksilver workflow API and a small `qs` command-line
interface. It is a development foundation; it is not published to PyPI and
does not imply that the workflow API is generally available.

## Install from this repository

From the repository root:

```bash
python -m pip install ./packages/sdk-python
```

## Client

```python
from nuera_quicksilver_sdk import QuicksilverClient

client = QuicksilverClient("http://localhost:3000")
graph = {"nodes": [], "edges": []}

validation = client.validate_workflow(graph)
preview = client.preview_workflow(graph)
```

The client requires HTTPS except for localhost, accepts an optional request
timeout and headers, and supports an injectable transport for embedding. It
checks the API response shape before returning typed dataclasses. HTTP and
contract errors raise `QuicksilverApiError`.

The optional `run_read_only_workflow(graph, input)` call sends a workflow to
`/api/workflows/run`. The server feature flag
`QUICKSILVER_WORKFLOW_LIVE_RUNS=on` must be enabled. The endpoint currently
supports only bounded, read-only query-agent steps and keeps tool dispatch
blocked. Do not expose this unauthenticated endpoint publicly; authentication,
authorization, and rate limiting are still required before that deployment.

## CLI

Set the API base URL once (PowerShell):

```bash
$env:QUICKSILVER_API_URL = "http://localhost:3000"
```

Then validate or safely preview a workflow JSON file:

```bash
qs validate workflow.json
qs preview workflow.json
qs run workflow.json --input "Summarize the workflow request"
```

`run` is the same opt-in read-only path as the client method. All commands
print JSON; validation failures, blocked runs, API errors, and malformed
responses return a non-zero exit code. The CLI accepts a graph object directly
or an envelope such as `{"graph": {"nodes": [], "edges": []}}`.

## Current limits

- Internal source install only; no package publishing or stable public API
  commitment.
- No Python async client, workflow authoring, retries, or persistence layer.
- The CLI does not manage credentials; use environment configuration and
  avoid placing secrets in workflow files or command history.
- Go SDK and broader agent creation APIs remain future work.
