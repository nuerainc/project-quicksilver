# Workflow monitoring dashboard

The web console's `/monitoring` page summarizes the most recent workflow
executions recorded for the configured tenant. It is a first dashboard surface
for workflow operations, not a replacement for host metrics or distributed
tracing.

## Data and access

`GET /api/monitoring/workflows` requires a principal with `workflow:read` and
returns up to 100 execution records, newest first. Tenant scope comes from the
server configuration; callers cannot provide a tenant identifier. The query
selects only run ID, workflow ID/version, digest, requester, outcome, timestamps,
duration, and evaluation count. Workflow input, prompt, model output, and tool
payloads are not read or returned by this endpoint.

The dashboard shows counts and a success rate for the sampled records, plus
median duration, workflow count, and a filterable run table. The sample can be
empty for a tenant without published live runs. Metrics are explicitly labeled
as a recent sample and are not lifetime or time-window aggregates.

## Current limits

- The view is capped at the latest 100 execution records and has no pagination.
- It covers web workflow executions stored by the publication layer; it does
  not aggregate the host queue, schedules, webhooks, or provider metrics.
- It has no distributed traces, model/cost breakdown, alerting, or retention
  controls.
- Live workflow runs remain read-only and tool dispatch remains disabled.

See the [hosted runtime](hosted-runtime.md) for the existing JSON logs and
Prometheus metrics, and the [workflow publication lifecycle](workflow-publication.md)
for how execution metadata is persisted.
