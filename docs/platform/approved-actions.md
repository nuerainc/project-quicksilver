# Approved actions (P-095)

An agent or a person proposes one effectful tool call. A different person reads
exactly what it would do and approves it. Only then does the kernel sign a
single-use authorization and the executor run the tool.

**A tool is a dry run unless you switch it to live.** A dry run records the
decision and a result that says `dryRun: true, executed: false`; nothing is
sent, written or changed. Two tools can be live:

- `notification.send` emails one allowed recipient through Resend. The
  recipient must be on your list (`email.recipients`: exact addresses or
  `@domain`), so it is an operational notice to your own people. It cannot
  reach a customer, which would need a WAES review. Needs `email.from` and the
  API key in the variable named by `email.apiKeyEnv`.
- `webhook.dispatch` sends a JSON POST to an allowed host
  (`webhook.allowedHosts`: exact hostnames, https on the default port, no IP
  addresses), signed with the kernel webhook scheme
  (`x-quicksilver-timestamp` and `x-quicksilver-signature`) using the secret
  in `webhook.secretEnv` (32+ characters). The host is also refused if it
  resolves to a private or reserved address.

Both send the proposal's id as the idempotency key, never follow a redirect,
time out after 10 seconds, and keep secrets out of results and errors. A live
tool needs its settings in the policy file AND its secret in the environment;
with either missing it stays a dry run and the host says so at start. Changing
who may be emailed or which hosts may be called changes the policy in force, so
proposals made before the change cannot be approved afterwards.

There is deliberately no live `sanity.mutate`: a generic "apply this mutation"
tool is too broad to approve safely, and department changes already have their
own narrow executor. `GET /api/actions` shows which tools are `live`.

A proposal whose input can never run (a recipient off the list, a host not
allowed) is refused when proposed, so nobody is asked to approve it.

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

- The live adapters have only been exercised against fakes: no real email or webhook has been sent by this code, so there is no operational evidence.
- Workflow `tool` steps on the hosted runtime are still blocked
  (`TOOL_BLOCKED_REASON`); this is a separate path through proposals, not a
  change to workflows.
- The approver rule has no sole-operator override, unlike decisions.
