# Approved actions (P-095)

An agent or a person proposes one effectful tool call. A different person reads
exactly what it would do and approves it. Only then does the kernel sign a
single-use authorization and the executor run the tool.

**Every tool that ships is a dry run.** Approving an action records the decision
and a result that says `dryRun: true, executed: false`. Nothing is sent, written
or changed. A real adapter (a webhook sender, a notification channel, a Sanity
mutation with its own write credential) is added one provider at a time and
needs its own review; none exists yet.

## Turning it on

Off by default. Set `QUICKSILVER_ACTIONS_CONFIG` to a policy file:

```json
{ "enabledTools": ["notification.send"], "proposalTtlMs": 86400000, "approvalTtlMs": 900000, "maxInputBytes": 16384 }
```

(`deploy/actions/actions.example.json`.) Available tools: `notification.send`,
`webhook.dispatch`, `sanity.mutate`, `sanity.query`. Approval also needs the
authorization key in the variable named by `execution.authorizationKeyEnv`
(default `QUICKSILVER_AUTHORIZATION_KEY`, at least 32 characters); without it
every approval is refused with 503. Proposals are kept next to the Genesis data
(`QUICKSILVER_ACTIONS_DIR` overrides).

## Routes

| Route | Who |
|---|---|
| `GET /api/actions` | `decision:read`: enabled tools, limits, policy snapshot, counts |
| `GET /api/actions/proposals[?status=]`, `GET /api/actions/proposals/:id` | `decision:read` |
| `POST /api/actions/proposals` `{ toolId, input, reason, evidence[] }` | a provider or proposer. Records only. |
| `POST /api/actions/proposals/:id/approve` `{ note? }` | a human who did not propose it. Runs the action at once. |
| `POST /api/actions/proposals/:id/reject` `{ note? }` | a human |
| `POST /api/actions/proposals/:id/resolve` `{ outcome, note }` | a human, for an action whose outcome is unknown |

The proposer and the approver are the authenticated principals. A body that names
one is refused with 400.

## What stands in the way

1. Off unless a policy lists the tools. A tool must also exist on the host.
2. A proposal is a record. It must cite 1 to 10 pieces of evidence; the kernel
   refuses an unevidenced action.
3. Approval is humans-only and never by the proposer.
4. The kernel-signed authorization is bound to this exact call (a digest of tool
   and input), this approval, the evidence count and the policy in force. It
   expires after 60 seconds and is used once.
5. The executor checks all of that against values taken from the stored
   proposal, never from the authorization's own fields.
6. A proposal made under one policy is not run under another (the snapshot
   covers the enabled tools, their contracts and the limits).
7. The proposal is saved as `executing` before the adapter runs. If the host
   stops in between, the outcome is unknown: the action is not repeated, and a
   person settles it with `resolve` and a note saying what they checked at the
   provider.
8. Every attempt, including a refusal, leaves an audit record.

## Not covered yet

- No real adapter, so no real effect and no operational evidence.
- Workflow `tool` steps on the hosted runtime are still blocked
  (`TOOL_BLOCKED_REASON`); this is a separate path through proposals, not a
  change to workflows.
- The approver rule has no sole-operator override, unlike decisions.
