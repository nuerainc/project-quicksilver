# Chat assistant

The chat panel is the one place a person talks to an agent. Its **Ask** mode is a read-only
assistant (`nuera-quicksilver:assistant`) that answers questions about the app and the company.
**Plan** and **Work** are separate, and they only propose.

## What it can read

It reads as the person asking, through the app's own routes (`apps/web/lib/chat-app-fetch.ts`):

| Tool | Reads | Needs |
|---|---|---|
| `get_my_access` | who you are and what you may do | signed in |
| `list_decisions`, `get_decision` | decisions, and the kernel's explanation of why | `decision:read` |
| `get_business_overview` | counts, metrics, experiments | `decision:read` |
| `get_finance_summary` | recorded money-ledger totals | `finance:read` |
| `get_workflow_activity`, `list_workflow_versions`, `get_workflow_runs` | workflow runs and versions | `workflow:read` |
| `get_trace_summary` | model and tool traces, alerts, cost | `audit:read` |
| `list_agent_catalog` | governed agent definitions | `agent:read` |
| `list_company_entities` | people, agents, teams | `decision:read` |

Company-model questions go through the Sanity Context tools, as before.

## How it is kept to what you can see

- Each tool runs the real route handler in the same process, with only your `Authorization`
  header and session cookie. The route's permission check, audit record and data shaping apply.
  No network request is made.
- A refused read comes back as "not available to you, you need X". The assistant is told to
  say so and not to look for another way.
- The tool list is fixed (`packages/agent/src/app-tools.ts`). Every tool is a `get_` or `list_`
  over one fixed GET path, with ids checked against a pattern. There is no tool that approves,
  rejects, executes, publishes, rolls back or writes. Those are buttons on the pages, pressed by a
  person, with separation of duties.
- Links in an answer are limited to pages of the app; anything else is dropped.
- Every call is a model route: rate limited, evaluated by the NQC engine, and recorded as an
  evaluation record and trace spans (`/monitoring/traces`).

## Not covered yet

- It cannot read the host's approved actions, Genesis experiments, hosting or media; the web app
  does not talk to the host.
- It does not stream, and a conversation is kept only in the open panel.
- Whether the Sanity dataset behind the company-model tools includes decision documents is not
  assumed: decisions come from the app tools.
