# Genesis run (M5): $500, 30 days, digital only

Genesis shows that Quicksilver can start something from nothing under
governance. It has a small, fixed budget, experiments whose thresholds are
set before they start, and every dollar in a hash-chained ledger.

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
| Run config | `deploy/genesis/genesis-500.json` | $500 budget (compute included), 30 days, digital only, allowed and prohibited categories, spend limits, prerequisites |
| `experiment` | `packages/kernel/src/playbooks/economics.ts` | Hypothesis, metric, kill/hold/scale thresholds, budget and duration fixed when a human starts it (digest pinned); measurements need a source |
| Money ledger | same file | Spend, compute, revenue and refunds, each with a source, in a hash chain. **Compute is capital.** |
| Spend risk scale | same file | Risk is based on each spend's share of what is **left**: ≤2% → 1, ≤5% → 2, ≤10% → 3, ≤25% → 4, more → 5 |
| Spend decisions | `packages/kernel/src/playbooks/genesis.ts` | Refused: prohibited or unlisted category, over budget, over the daily cap, over the experiment's budget. Founder decides: above $10, risk above 2, or outside an experiment. Otherwise it may go ahead |
| WAES gate | `packages/kernel/src/waes.ts`, `authorize()` | A customer-facing action is **hard-blocked** unless a WAES review passed this exact content, from a reviewer other than the proposer |

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
```

Data lives in `data/genesis/` (gitignored). `spend` records nothing the kernel
refuses. When the founder must decide, you confirm the spend with `--confirm`.
The command only records money that has already moved: it never moves money
itself.

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

The money route records money that has already moved. Nothing on the host
pays, charges or executes anything; every response says `executed: false`.
Config: `QUICKSILVER_GENESIS_CONFIG` (default `deploy/genesis/genesis-500.json`);
data: next to the intent stores, or `QUICKSILVER_GENESIS_DIR`. The blockers
check payment-account names against the host's own vault.

## What the run reports

- Capital used (compute included), revenue, net, and return on capital
  against the playbook metric: kill below 0.1, hold at 0.5, scale at 1.0.
- For each experiment: its hypothesis, thresholds, measurements with sources,
  each verdict, and who applied it.
- Each WAES review of customer-facing content.
- Every founder decision.

A loss is a valid result. What is judged is whether every decision followed
the fixed rules and every dollar can be traced.
