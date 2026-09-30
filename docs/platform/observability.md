# Observability: workflow monitoring, traces, and alerts

The web console has two operations views: `/monitoring` summarizes recent
workflow executions and `/monitoring/traces` presents trace spans and alert
signals for web queries, plans, decisions, and read-only workflow runs. These
views complement, rather than replace, host Prometheus metrics and JSON logs.

## Data and access

`GET /api/monitoring/workflows` requires `workflow:read`; `GET
/api/monitoring/traces` requires `audit:read` and accepts an optional `limit`
from 1 to 500 (default 200). Both APIs derive tenant scope from server
configuration; callers cannot provide a tenant identifier.

Trace spans use an explicit metadata allowlist. They can contain trace/span
IDs, source and span kind, status, timing, requesting principal, agent/model/tool
IDs, token counts, optional estimated cost, workflow/decision references, and
the NQC safety decision. They never persist prompts, model outputs, tool
arguments, private reasoning, raw errors, or credentials. Writes are
idempotent, and telemetry storage failure does not turn a successful business
request into a failure; the response reports whether spans were persisted.

Token usage comes from the model provider response; missing counts remain
unknown. Cost is a blended estimate from an explicitly configured measured
model profile and remains null without that rate. It is not provider billing.

The workflow dashboard shows counts and a success rate for the sampled records,
plus median duration, workflow count, and a filterable run table. The trace view
filters recent spans by kind and metadata and evaluates configurable in-app
alerts for tool failures, safety blocks/escalations, run failure rates, and
estimated cost budgets. Alerts do not send external notifications. Both views
label their data as bounded samples, not lifetime totals.

## Current limits

- The workflow view is capped at the latest 100 execution records; the trace
  view is capped at 500 spans. Neither view has pagination.
- It covers web workflow executions stored by the publication layer; it does
  not aggregate the host queue, schedules, webhooks, or provider metrics.
- Tracing currently instruments the web query/plan/workflow paths; host runtime
  distributed traces, external alert delivery, and retention/deletion controls
  remain unimplemented.
- Live workflow runs remain read-only and tool dispatch remains disabled.

See the [hosted runtime](hosted-runtime.md) for the existing JSON logs and
Prometheus metrics, and the [workflow publication lifecycle](workflow-publication.md)
for how execution metadata is persisted.
