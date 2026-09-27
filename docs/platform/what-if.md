# What-if engine (M7 part 3): estimates, never decisions

The what-if engine answers "what could happen if…" questions from the
records Quicksilver already keeps: the money ledger, experiments and the
Onboard shadow logs. It lives in `packages/kernel/src/simulation/`
(`@quicksilver/kernel/simulation`), and `npm run whatif` runs it on the host.

**Every result is an estimate, not a decision.** Nothing in the engine
authorizes an action, spends money, applies a verdict, grants autonomy or
writes a file. Decisions still go through the kernel (`authorize()`), the
experiment rules (`evaluateExperiment` / `applyEvaluation`), the founder's
plan approval and the provider's grants in the intent ledger. An estimate can
inform those decisions. It never replaces them.

## Rules the engine keeps

- **Deterministic.** Every simulation takes a seed and uses its own seeded
  generator (mulberry32). The same inputs and seed give the same numbers on
  any machine. Library code never calls `Math.random`.
- **Honest about its inputs.** Every output lists its assumptions and its
  sample size: runs, seed and how much history it used.
- **Says when history is too short.** Cash estimates from fewer than 3
  periods, and experiment odds from fewer than 3 observed changes, are
  flagged "too short to say much".
- **No invented numbers.** With no money history, `simulateCash` refuses. It
  runs only if you pass explicit assumed distributions, and then every result
  is labeled "assumed, not from history".
- **Unknown outcomes are never assumed good.** Counterfactuals use only
  recorded verdicts and outcomes. Anything not recorded stays unknown and is
  counted as unknown.
- **No new dependencies.**

## The tools

### 1. Monte Carlo cash: `simulateCash`

**Question:** "Given how money has actually moved, where could our cash be
over the next N periods, and how likely is it to fall below the reserve floor
or run out?"

- The money ledger is cut into periods (default 30 days, counted back from
  the latest entry). For each period, revenue is money in and cost is
  capital used (spend + compute − refunds), the same as `MoneyTotals`.
- Each run builds a possible future one period at a time by drawing whole
  historical periods at random. This is a block bootstrap: a period's
  revenue and cost stay paired, so a busy month's higher costs come with its
  higher revenue. `blockLength` (default 1) draws runs of consecutive
  periods.
- Planned spends (`plannedSpendsUsd`, one amount per future period) and
  shocks (see scenarios) are applied on top.
- For each future period it reports:
  - cash percentiles (p5, p25, p50, p75, p95)
  - the chance that cash has fallen below the reserve floor by then
  - the chance that cash has fallen below zero by then
  - median revenue
  - median return on capital (revenue ÷ capital used, summed from the first
    future period)

**Assumptions:** past periods are treated as interchangeable, so trends,
growth and seasonality are not modeled. Only what is in the ledger counts:
money not recorded there is invisible to the engine.

### 2. Experiment outcome odds: `simulateExperiment`

**Question:** "If the metric keeps moving the way it has, how likely is this
experiment to end at kill, hold, continue or scale, and to go over budget?"

- It needs at least 2 measurements. With fewer, it says there is not enough
  to go on.
- Future measurements come at the average gap between past ones, until the
  end date. Each adds a change drawn from the observed changes between
  consecutive measurements, plus optional normal noise (`noise`, in metric
  units).
- Every step is judged by `evaluateExperiment` itself, with the thresholds
  fixed when the experiment started, so the estimate cannot disagree with the
  real verdict logic. Kill and over-budget end a run, because they apply on
  their own. Otherwise the last verdict is the outcome.
- Spend: the experiment's daily spend so far, from the ledger, is resampled
  for the days left. The chance of going over budget assumes spending
  continues at that pace to the end date.

### 3. Stress scenarios: `generateScenarios`

A small, fixed library of named scenarios. Each one is data (a name, the
shocks, and the numbers it was built from) that `simulateCash` accepts:

| Name | Shocks |
|---|---|
| `revenue-10`, `revenue-25`, `revenue-50` | revenue × 0.9, 0.75 or 0.5 in every period |
| `cost-spike` | cost × 1.5 in the first period (skipped if history shows no cost) |
| `lost-largest-customer` | revenue minus the largest customer's average revenue per period. Skipped unless revenue entries name a `counterparty`. The money ledger has no such field today, so this is normally skipped, and the tool says why. |
| `delayed-payment` | half of the first period's revenue arrives one period late |
| `experiment-fails:<id>` | for each running or held experiment, the rest of its budget is spent in the first period and it earns nothing: any revenue the ledger attributes to it (averaged per period) is removed too |

A scenario the inputs can't support is skipped with the reason. It is never
filled in with made-up numbers.

### 4. Counterfactual autonomy: `counterfactualAutonomy` and `counterfactualKernel`

**Question:** "If this department had been allowed to act on its own from the
moment the hand-over rules were first met, what would have happened?"

- Judged recommendations are replayed in the order they were judged. The
  rules are the `shadowReport` rules: enough judged, enough agreement
  (accepted + ½ modified), and no bad outcome among non-rejected
  recommendations. Only outcomes recorded by that moment count.
- From that moment, a recommendation proposed later would have run without
  the owner only if the kernel said `execute-autonomously`. Anything else
  still goes to a human.
- For those actions, it counts:
  - how many would have run alone
  - how many the owner actually rejected or modified (these would have been
    wrong)
  - how many were never judged (unknown)
  - how many had a bad outcome
- An outcome is known only for accepted recommendations. For a modified or
  rejected one, the recorded outcome is of what the owner did instead.
  Unknown outcomes stay unknown.
- The same replay runs on a small grid of rules (minJudged 10, 20 or 30 ×
  minAgreement 0.7, 0.8 or 0.9), with your own rules marked.
- It assumes hand-over, once met, stays. Revoking it after a bad outcome is
  not modeled.

`counterfactualKernel` compares the kernel's own call with the owner's
verdict:

| Kernel's call | Owner's verdict | Counted as |
|---|---|---|
| `execute-autonomously` | accepted | match |
| `reject` | rejected | match |
| `execute-autonomously` | rejected or modified | too loose |
| `reject` | accepted or modified | too strict |
| `request-approval` | any | escalated (neither a match nor a miss) |

The match rate is matches ÷ (judged − escalated).

## How to read percentiles

- **p50 (the median):** half the simulated futures ended above this and half
  below. It is not a forecast.
- **p25 to p75:** the middle half of the runs.
- **p5 to p95:** 90% of the runs. p5 is a bad but not the worst case: one run
  in twenty did worse.
- **Probabilities** are shares of runs. A 3% chance of running out of cash
  means 60 of 2,000 runs did. With little history, that number comes from
  drawing the same few periods again and again, so it can look more precise
  than it is. Read the warnings.

## Commands

```
npm run whatif -- cash --cash 4200                          # Operate, 6 periods, 2,000 runs, seed 1
npm run whatif -- cash --run genesis                        # Genesis: weekly periods; start cash = budget + net
npm run whatif -- cash --cash 4200 --horizon 12 --runs 5000 --seed 7
npm run whatif -- cash --cash 4200 --scenario revenue-25
npm run whatif -- scenarios [--run genesis]
npm run whatif -- experiment <experimentId> [--run genesis] [--noise 0.5]
npm run whatif -- autonomy [--department collections]
```

- `cash` and `scenarios` read the matching money ledger:
  - `data/operate/<runId>/ledger.json`
  - `data/genesis/<runId>/ledger.json`, or Sanity with
    `QUICKSILVER_GENESIS_STORE=sanity`

  The run ids come from `deploy/operate/operate-nuera.json` and
  `deploy/genesis/genesis-500.json`.
- For Operate, the reserve floor and period length come from the config.
  Without `--cash`, start cash is the cash on hand recorded at the latest
  approved plan plus the ledger's net since then. With no approved plan,
  `--cash` is required. The ledger does not know your bank balance.
- `--period-days`, `--reserve` and `--block` override the defaults.
- `experiment` reads the run's `experiments.json`.
- `autonomy` reads every `data/intent/onboard/*/shadow.json` and uses the
  Operate config's `handOver` rules (default 20 judged at 80%).
- Every output says "estimate" and prints the seed, the number of runs and
  the history size (the counterfactuals have no sampling, so they say so).
  None of these commands writes anything.
