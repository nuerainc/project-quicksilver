# Nuera Quicksilver Go SDK

Internal, dependency-free Go client for the workflow API. The current server
supports validation, safe simulation, and an opt-in live path for read-only
query-agent workflows. Tool dispatch and external effects remain disabled on
these endpoints.

```go
package main

import (
	"context"
	"fmt"
	"log"

	quicksilver "github.com/nuerainc/project-quicksilver/packages/sdk-go"
)

func main() {
	client, err := quicksilver.NewClient(quicksilver.ClientOptions{
		BaseURL: "http://localhost:3000",
	})
	if err != nil {
		log.Fatal(err)
	}

	graph := map[string]any{
		"schemaVersion": 1,
		"id":            "example",
		"version":       1,
		"entryNodeId":   "start",
		"nodes": []any{
			map[string]any{"id": "start", "kind": "trigger", "label": "Start"},
		},
		"edges": []any{},
	}
	result, err := client.ValidateWorkflow(context.Background(), graph)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("valid=%t nodes=%d\n", result.Valid, len(result.TopologicalOrder))
}
```

Use an HTTPS URL outside loopback. If the deployment uses an API gateway,
provide its authorization headers through `ClientOptions.Headers`. Live runs
also require the server's `QUICKSILVER_WORKFLOW_LIVE_RUNS=on` flag, model
credentials, and Sanity Context MCP credentials. The SDK does not configure
authentication, enable live runs, or bypass server policy.

This module is an internal foundation, not a published or stable API yet.
