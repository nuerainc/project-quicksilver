# Triggers: schedules and signed webhooks

`@quicksilver/kernel/triggers` starts workflow runs from a cron schedule or
from a signed HTTP webhook. Both go through `WorkflowRunQueue.enqueue`, so
every run triggered this way gets the same admission checks, idempotency,
backpressure and RBAC as any other run. Each trigger should act as a
**service principal that holds only the `trigger` role**. That role can
start runs and do nothing else.

## Cron schedules

```ts
import { CronScheduler } from '@quicksilver/kernel/triggers'

const scheduler = new CronScheduler({ queue })
scheduler.add({
  id: 'nightly-ops-report', tenantId: 'acme', cron: '0 2 * * *', graph,
  input: { report: 'ops' },
  principal: { id: 'svc:scheduler', kind: 'service', tenantId: 'acme', roles: ['trigger'] },
})
scheduler.start()      // polls every 30 s; scheduler.stop() for shutdown
```

- **Syntax:** 5 fields, in UTC. It supports lists, ranges and steps,
  day-of-week 0–7, and `@hourly`, `@daily`, `@weekly`, `@monthly` and
  `@yearly`. When both day fields are set, a day matches if either one does
  (the standard Vixie cron rule). A date that can never occur (such as
  February 31) never fires.
- **No duplicate runs:** each slot is enqueued with the idempotency key
  `schedule:<id>:<UTC minute>`. Restarts, overlapping ticks and several
  scheduler replicas can't create two runs for the same slot. The run input
  gets `scheduledFor` added.
- **No stampede after an outage:** a tick enqueues only the *most recent*
  missed slot, and only if it's inside `catchUpWindowMs` (1 hour by default).
- **Retries:** a slot rejected by backpressure is retried on the next tick. A
  slot refused by RBAC or graph validation is not retried.

## Signed webhooks

```ts
import { WebhookTrigger, generateWebhookSecret } from '@quicksilver/kernel/triggers'

const webhooks = new WebhookTrigger({
  queue,
  endpoints: [{
    id: 'erp-orders', tenantId: 'acme', graph,
    secrets: [process.env.ERP_WEBHOOK_SECRET!],       // ≥ 32 chars; add a second during rotation
    principal: { id: 'svc:erp-webhook', kind: 'service', tenantId: 'acme', roles: ['trigger'] },
  }],
})

// Next.js route handler: app/api/triggers/webhooks/[id]/route.ts
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return webhooks.handle(request, (await params).id)
}
```

**Sender contract.** Sign `${timestamp}.${rawBody}` with HMAC-SHA256 using
the endpoint secret, then send these headers:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-Quicksilver-Timestamp` | Unix seconds |
| `X-Quicksilver-Signature` | `v1=<hex>`. Send several, comma-separated, while rotating secrets |
| `X-Quicksilver-Delivery` | A unique id per event (recommended) |

`signWebhook(secret, timestamp, body)` produces the signature value.

**Checks, in order:** the endpoint exists and is enabled (404) → body size
(413) → content type (415) → timestamp within ±5 minutes and a
constant-time signature match against any current secret (401, with the
same message for every failure) → valid JSON (400) → replay check → enqueue.

**Idempotency and replays**

- With `X-Quicksilver-Delivery`, the run's idempotency key is
  `webhook:<endpoint>:<delivery>`. A sender retry, even one re-signed later,
  returns the same run with **200**, and the first delivery returns **202**.
- Without a delivery id, reusing the exact same signature is refused with
  **409**. Senders should always include a delivery id.
- The in-memory replay cache works for a single process. With several
  replicas, pass a shared `ReplayCache`. The delivery id plus a shared run
  store already prevents duplicate runs across replicas.

**Queue outcomes:** RBAC refusal → 403. Backpressure → 429, which tells the
sender to retry. Invalid workflow graph → 422.

## Not yet built

- A hosted process that runs the scheduler, webhook routes and workers from
  configuration, plus a management API for schedules and endpoints.
- Storing endpoint secrets in a secrets vault (for now they come from
  environment variables).
- A shared replay cache backed by Postgres or Redis.
- Event-bus and filesystem triggers.
