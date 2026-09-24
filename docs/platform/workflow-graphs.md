# Workflow graph contract

`packages/kernel/src/workflows/graph.ts` defines the version 1 graph contract
for visual workflow authoring. Its validator checks unique identities, trigger
and output structure, branch completeness, reachability, acyclicity, retry and
time limits, condition-expression syntax and references, mandatory evaluation
for agent nodes, evaluator gates, and supervisor approval for high impact or
side-effect steps.

The graph is available through the stateless POST `/api/workflows/validate` endpoint. The browser builder autosaves a versioned draft to local browser storage and supports JSON import/export. Imported drafts are validated before replacing the open draft. Invalid stored drafts are preserved and are not silently replaced. This storage is device- and browser-local; it is not shared, backed up, or server-persisted.

The kernel now includes an in-process `executeWorkflowGraph` runner. It walks
the validated DAG in topological order, follows one condition branch, records
step outcomes, and uses injected agent, tool, evaluator, and approval handlers.
Configured `maxAttempts` now applies to agent-handler failures, with bounded
backoff; tools are never automatically retried because a timeout can leave an
external effect's outcome uncertain. Configured `timeoutMs` bounds each
handler invocation and provides an `AbortSignal` to handlers so providers can
cancel underlying work. A handler must honor the signal for underlying work to
stop promptly. Independent low/moderate-impact agent nodes can run in bounded
parallel batches when the caller sets `maxConcurrentAgents` (1–16); the default
is one. Each agent in a batch receives the same snapshot of outputs from prior
steps, so connect a dependency edge when a step needs another step's result.
Tools and approval-gated/high-impact agents stay serialized. This is request-
local concurrency, not a durable queue or hosted worker pool. The runner has no
network or persistence adapter. The web builder connects to it through a safe
simulation endpoint: agent results are placeholders, conditions
use the data-only expression language, and tools are always stopped before
dispatch. The simulation does not call a model, live evaluator, or approval service. The
existing Decision Lifecycle process engine remains the production decision
path; there is no shared workflow library, publishing, or durable run history.

An opt-in `POST /api/workflows/run` path supports up to three low/moderate-impact
`query` agent steps and allows up to three independent steps to run concurrently.
It invokes the existing read-only Sanity Context MCP
query agent, evaluates each result with NQC, and returns the step trace and
evaluation signals. Conditions use a small data-only expression language:
`$input == "approved"`, `$steps.agent-1.entities exists`, or
`$nqc.agent-1.reasoningScore >= 70`. The evaluator supports scalar comparisons,
`contains`, and `exists`; arbitrary code is never evaluated. Planner agents,
high/critical impact, workflow tools, and effectful actions are rejected or
blocked. The route is off unless `QUICKSILVER_WORKFLOW_LIVE_RUNS=on`; do not
enable it on a public deployment before authentication and rate limiting are
in place.

Before a high-impact or side-effect tool runs, the runner requires a valid
evaluator decision and verified supervisor approval through its injected
handlers. Every tool also needs a positive NQC validation result before it can
reach its execution handler. Missing handlers, invalid decisions, a BLOCK
verdict, or denied approval stop the run before that tool is dispatched.


The Studio now defines a separate `automationWorkflow` document type for versioned graphs. It does not reuse the existing workflow process-definition records.
