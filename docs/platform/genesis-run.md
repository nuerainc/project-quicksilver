# Genesis run (M5): a configured budget, duration and category scope

Genesis shows that Quicksilver can start something from nothing under
governance. It is reused across many ventures with different budgets and
durations, so no single dollar figure or time window is a product-wide hard
ceiling; each run sets its own budget, duration, and allowed/prohibited
categories before it starts, enforced by experiments whose thresholds are
set before they start, and every dollar in a hash-chained ledger.
`deploy/genesis/genesis-500.json` ($500, 30 days, digital only) is the
out-of-the-box convenience/demo config a run can start from, overridable via
`QUICKSILVER_GENESIS_CONFIG`.

**Status:** everything that can be built without the run itself is built.
The run cannot start until:

- the founder approves an entity path (Nuera RDL is a working name, not an
  incorporated entity), and
- the payment accounts named in the config are in the host vault.

`genesisBlockers()` lists what is missing, and `npm run genesis -- check`
prints it.

## Pieces

| Piece | Where | What it enforces |
|---|---|---|
| Economic playbook | `deploy/playbooks/genesis.json` | observe → hypothesize → experiment → measure → update beliefs → allocate → expand, modify or kill |
| Run config | `deploy/genesis/genesis-500.json` (the default; overridable per-run) | $500 budget (compute included), 30 days, digital only, allowed and prohibited categories, spend limits, prerequisites |
| `experiment` | `packages/kernel/src/playbooks/economics.ts` | Hypothesis, metric, kill/hold/scale thresholds, budget and duration fixed when a human starts it (digest pinned); measurements need a source |
| Money ledger | same file | Spend, compute, revenue and refunds, each with a source, in a hash chain. **Compute is capital.** |
| Spend risk scale | same file | Risk is based on each spend's share of what is **left**: ≤2% → 1, ≤5% → 2, ≤10% → 3, ≤25% → 4, more → 5 |
| Spend decisions | `packages/kernel/src/playbooks/genesis.ts` | Refused: prohibited or unlisted category, over budget, over the daily cap, over the experiment's budget. Founder decides: above $10, risk above 2, or outside an experiment. Otherwise it may go ahead |
| WAES gate | `packages/kernel/src/waes.ts`, `authorize()` | A customer-facing action is **hard-blocked** unless a review passed this exact content, from a reviewer other than the proposer. Until WAES runs as a service, that review may be a manual founder review (see below) |
| Content reviews | `packages/host/src/genesis-reviews.ts`, `genesis-store.ts` | Manual founder reviews of the exact customer-facing text, append-only, always labeled manual |

## Who decides what

| Decision | Who |
|---|---|
| Start an experiment (commits money) | The founder |
| Kill, when the metric falls to the kill threshold, the experiment runs over budget or time runs out | Automatic: stopping never needs permission |
| Continue | Automatic |
| Hold, then modify | The founder |
| Scale, then expand | The founder, because it spends more |
| Stop the whole run | The founder, from any stage |

## Commands

```bash
npm run genesis -- check                                  # config, playbook, blockers
npm run genesis -- experiment draft <file.json>           # an ExperimentDefinition
npm run genesis -- experiment start <experimentId>        # you, fixes the thresholds
npm run genesis -- measure <experimentId> <value> "<source>"
npm run genesis -- evaluate <experimentId>                # kill/continue apply; scale and hold wait for you
npm run genesis -- decide <experimentId>                  # you apply a scale or hold verdict
npm run genesis -- spend <amount> <category> "<what>" [--experiment <id>] --source receipt:<ref>
npm run genesis -- compute <amount> "<what>" --source provider-usage:<ref>
npm run genesis -- revenue <amount> "<what>" --source payment-processor:<ref>
npm run genesis -- status
npm run genesis -- review <file-or-"text"> --channel <c> [--experiment <id>] pass|revise|block ["note"]
npm run genesis -- reviews                                # every content review, manual ones labeled
npm run genesis -- check-content <file-or-"text"> [--proposer <actorId>]
```

Data lives in `data/genesis/` (gitignored) unless you choose Sanity (see Persistence). `spend` records nothing the kernel
refuses. When the founder must decide, you confirm the spend with `--confirm`.
The command only records money that has already moved: it never moves money
itself.

## Manual founder review of customer-facing text

The WAES evaluation suites do not run as a service yet. Until they do, the
founder approves customer-facing text (a landing page, an email, an ad)
himself. The record says so plainly: it is a **manual founder review, not a
WAES evaluation**.

- `npm run genesis -- review offer.txt --channel landing-page pass "note"`
  reads the file (or, when no such file exists, takes the argument as the
  text), and records your decision on that exact text. It prints the content
  digest and the reviewId. Nothing is sent or published.
- Each record holds the reviewId, `kind: manual`, the content digest, the
  reviewed text itself, the verdict (pass, revise or block), the reviewer
  (you, a human), when, the note, the channel and optionally the experiment.
  It names `components: ["MANUAL-FOUNDER-REVIEW"]`, the only component a
  manual review may name, and a marker no WAES review may carry.
- Records are append-only. A new decision is a new record, and the latest
  decision on the same text decides. Changed text has a different digest, so
  it has no review until you review it.
- `check-content <file-or-"text">` shows whether that exact text passes the
  gate right now, and says when the pass rests on a manual review. It exits
  with 1 when the text is blocked.

The kernel treats a manual review like a WAES review in three ways: it must
cover the exact content (digest), it must pass, and the reviewer must not be
the actor proposing the action (so the founder's review unlocks text an
agent proposes, never text he proposes himself). Two things are added:

- The reviewer must be a human (`reviewerKind: human`); a service or agent
  cannot record a manual review.
- Manual reviews count only when the run config says
  `"waesManualReviewAllowed": true`. Otherwise the gate fact is
  `manual-not-allowed` and the action stays blocked. The default is off;
  `deploy/genesis/genesis-500.json` turns it on for now. `waesRequired`
  stays `true`.

A pass sets the facts `waes.review: pass` **and** `waes.reviewKind: manual`,
so every decision record built from those facts shows the pass was manual.

When WAES runs as a service, set `waesManualReviewAllowed` to `false` (or
remove it). Manual records stay in the history, but no longer unlock
anything.

## Persistence

By default the run's records are files under `data/genesis/<runId>/`
(`QUICKSILVER_GENESIS_DIR` changes the parent): `ledger.json`,
`experiments.json`, `run.json` and `reviews.json`. This is the layout earlier versions wrote,
so existing data still loads. Every write is atomic.

Set `QUICKSILVER_GENESIS_STORE=sanity` to keep them in Sanity instead. The
command needs `NEXT_PUBLIC_SANITY_PROJECT_ID`, `NEXT_PUBLIC_SANITY_DATASET`
and `SANITY_WRITE_TOKEN` (legacy fallback: `SANITY_AUTH_TOKEN`) in its environment, and refuses the legacy challenge
project. The run's start is then the first experiment's start.

| Document type | One per | Id | Rules |
|---|---|---|---|
| `moneyEntry` | ledger entry | `money-entry.<runId>.<seq>` | Append-only. A seq that is already taken, or an entry that does not follow the last one, is refused as a conflict. Every load verifies the hash chain and stops if it does not verify. |
| `experimentRecord` | experiment | `experiment-record.<runId>.<experimentId>` | The definition and digest are fixed once the experiment leaves draft. The start is set once. Measurements and decisions are only added. A racing writer loses on the revision check. |
| `contentReview` | content review | `content-review.<runId>.<reviewId>` | Append-only (`createIfNotExists`). A reviewId that is already taken by a different record is refused as a conflict. The digest must match the stored text; a manual review must name a human reviewer. |

The file stores enforce the same rules. All three types are read-only in
Studio. After pulling, deploy the schema with `npm run schema:deploy -- --login`.

## On the host

The host serves the same commands over HTTP, on the same data files
(`data/genesis/<runId>/`), so the CLI and the host see one ledger. The
console (`/console`) has a **Genesis run** section built on these routes.

| Route | Who | Same as |
|---|---|---|
| `GET /api/genesis` | `decision:read` | `check` + `status`: blockers, totals, experiments, facts, ledger verification |
| `POST /api/genesis/experiments` `{ definition }` | `intent:provide` or `decision:propose` | `experiment draft` |
| `POST /api/genesis/experiments/:id/start` | the founder (`intent:provide`, human) | `experiment start`; 409 with the blockers while any exist |
| `POST /api/genesis/experiments/:id/measurements` `{ value, source }` | `intent:provide` or `decision:propose` | `measure` |
| `POST /api/genesis/experiments/:id/evaluate` | `decision:read` | `evaluate`: kill, continue, expiry and over-budget apply as the kernel; scale and hold come back as `awaitingDecision` |
| `POST /api/genesis/experiments/:id/decide` `{ note? }` | the founder | `decide` |
| `POST /api/genesis/money` `{ kind, amountUsd, category, description, source: { type, ref }, experimentId?, confirm? }` | the founder | `spend` / `compute` / `revenue` / `refund`. Refused spends → 422 with reasons; a founder decision without `confirm: true` → 409 with reasons |
| `GET /api/genesis/pending-payments` | `decision:read` | Payments a Stripe webhook reported: `pending` rows, the 50 newest `decided`, and `autoRecord` |
| `POST /api/genesis/pending-payments/:id/confirm` `{ note? }` | the founder (`intent:provide`, human) | Records the payment as `revenue` (source `payment-processor`, ref = PaymentIntent id) with the caller as recorder. 404 unknown id, 409 already decided or already in the ledger |
| `POST /api/genesis/pending-payments/:id/reject` `{ note? }` | the founder | Marks the row rejected; records nothing |
| `POST /api/genesis/reviews` `{ text, channel, verdict, note?, experimentId? }` | the founder (`intent:provide`, human) | `review`: always recorded as a manual founder review with the caller as reviewer, whatever the body says. `GET /api/genesis` returns the 20 newest as `reviews` and the counts as `reviewSummary` (`waes` and `manual` apart) |

The console's Genesis section has a **Review customer-facing text** form and
a list of recent reviews, each labeled "Manual founder review — not a WAES
evaluation".

The money route records money that has already moved. Nothing on the host
pays, charges or executes anything; every response says `executed: false`.
Config: `QUICKSILVER_GENESIS_CONFIG` (default `deploy/genesis/genesis-500.json`);
data: next to the intent stores, or `QUICKSILVER_GENESIS_DIR`. The blockers
check payment-account names against the host's own vault.

## Stripe payments into the ledger (P-027, recording only)

A Stripe webhook can report payments that **already happened** in Stripe, so
revenue does not have to be typed in by hand. This is the same boundary as the
money route: it records money that moved; it never charges, pays, refunds or
transfers anything, holds no Stripe API key, and makes no call to Stripe. The
only secret is the endpoint's **webhook signing secret** (`whsec_…`).

**1. Store the signing secret in the vault** under the name
`genesis-stripe-webhook` (a signing secret, never an API key; it is not a
payment account, so it does not go in `prerequisites.paymentAccounts`):

```sh
printf '%s' "$STRIPE_SIGNING_SECRET" | npm run host -- vault put genesis-stripe-webhook
```

**2. Add the endpoint to the host config:**

```json
"services": [{ "id": "svc:stripe-webhook", "roles": ["trigger"] }],
"webhooks": [{
  "id": "stripe-payments",
  "genesisPayment": true,
  "scheme": "stripe",
  "secret": "vault:genesis-stripe-webhook",
  "principal": "svc:stripe-webhook"
}]
```

`genesisPayment` needs `scheme: "stripe"` and names no `workflow` or `task`.
The host refuses to start if the Genesis run is not configured.

**3. In the Stripe dashboard**, add an endpoint at
`https://<host>/webhooks/stripe-payments` for `payment_intent.succeeded` and
`checkout.session.completed`, and copy its signing secret into step 1.
Rotating the secret: `PUT /api/secrets/genesis-stripe-webhook` (or
`vault put` then `POST /api/admin/reload-secrets`); the previous secret stays
valid for the grace period, like every other webhook.

**What a delivery does.** The kernel checks the `Stripe-Signature` header
(`t=…,v1=…`; same HMAC, five-minute tolerance and replay cache as every
signed webhook) before anything else. Then, by the run config's
`autoRecordPaymentWebhooks`:

| Setting | Result |
|---|---|
| `false` (default) | A pending row, confirmed or rejected by the founder on the routes above. Nothing reaches the ledger without a human. |
| `true` | A `revenue` entry straight away, recorded by the `genesis-stripe-webhook` service. |

One payment is recorded once: the PaymentIntent id is both the pending row's
id and the ledger entry's `source.ref`, so Stripe retries, and the two events
a Checkout payment sends, are no-ops after the first. A payment already
recorded by hand with that `source.ref` is not recorded again.

| Event | Handling |
|---|---|
| `payment_intent.succeeded` | Recorded (`amount_received`) |
| `checkout.session.completed`, paid, with a PaymentIntent | Recorded (`amount_total`); same key as its `payment_intent.succeeded` |
| Unpaid or PaymentIntent-less Checkout sessions, test-mode events, other types | Ignored, 200 (Stripe stops retrying) |
| `charge.refunded` | Ignored, 200. The ledger's `refund` kind means money back to the run (it lowers capital used); a refund to a customer is money out, so it needs a human until the ledger has a kind for it |
| Non-USD, malformed, zero or negative amounts | 422 |
| Invalid run config, broken ledger chain | 503 (Stripe retries later) |

**Known gaps (v1):** the pending queue is file-only
(`<dir>/<tenant>/<runId>/pending-payments.json`); there is no Sanity-backed
pending store yet, so in Sanity mode the queue stays in local files. Customer
refunds, products, prices, payment links and orders are not handled. The
console has no pending-payments panel yet; use the routes.

## What the run reports

- Capital used (compute included), revenue, net, and return on capital
  against the playbook metric: kill below 0.1, hold at 0.5, scale at 1.0.
- For each experiment: its hypothesis, thresholds, measurements with sources,
  each verdict, and who applied it.
- Each review of customer-facing content, with **manual founder reviews
  listed separately from WAES reviews** (`status` prints both counts; the
  API returns `reviewSummary.manual` and `reviewSummary.waes`). A manual
  review is never counted or shown as a WAES run.
- Every founder decision.

A loss is a valid result. What is judged is whether every decision followed
the fixed rules and every dollar can be traced.
