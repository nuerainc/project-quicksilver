# Nuera Quicksilver Python SDK

Internal, dependency-free Python client for workflow validation, safe preview,
and opt-in read-only query-agent runs.

```bash
python -m pip install -e packages/sdk-python
qs --api-url http://localhost:3000 validate workflow.json
qs --api-url http://localhost:3000 preview workflow.json
qs --api-url http://localhost:3000 run workflow.json --input "Summarize this request"
```

Set `QUICKSILVER_API_URL` to avoid repeating `--api-url`. The live run endpoint
requires the server's `QUICKSILVER_WORKFLOW_LIVE_RUNS=on` flag, model
credentials, and Sanity Context MCP credentials. It currently supports only
read-only query-agent steps; tools remain blocked. Do not enable live runs on a
public deployment before authentication and rate limiting are available.

The SDK accepts custom request headers for deployments with an API gateway,
but this repository does not yet implement user authentication or RBAC.
