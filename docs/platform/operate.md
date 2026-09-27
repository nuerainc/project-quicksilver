# Operate (M6): run, measure, reinvest

Operate is the steady state of a running business. Quicksilver runs the
departments the provider has handed over and measures the outcomes. Each
period it proposes how to use the surplus, and it runs small, bounded
experiments inside the business. It reuses the pieces Onboard (M4) and
Genesis (M5) already built: the shadow reports, the hash-chained money
ledger, experiments with fixed thresholds, and the spend rules.

**Status:** built. Operation starts after M4's Onboard pilot, which gives the
shadow evidence, and M5's Genesis run, which tests the money rules with real
money. Like Genesis, Operate cannot move money until the founder approves an
entity path and the named payment accounts are in the host vault.
`operateBlockers()` lists what is missing, and `npm run operate -- check`
prints it.

## The one rule for autonomy

> **Effective autonomy = min(the provider's grant, the shadow evidence).**

- **The grant** is the provider's own entry in the Aura intent ledger
  (`npm run onboard -- handover <companyId> <department> <depth>`). The depths
  are Aura's, from least to most: `advise`, `propose`, `act-with-approval`,
  `act-within-limits`. With nothing granted, the department only advises. If
  more than one provider has granted autonomy, the lowest grant applies.
- **The evidence** is the department's Onboard shadow report
  (`data/intent/onboard/*/shadow.json`, judged against `handOver`, default 20
  judged recommendations at 80% agreement and no bad outcomes). Ready evidence
  supports `act-within-limits`. Without it, a department can reach at most
  `act-with-approval`: it may act, but a human approves each action.
- **The grant is the ceiling.** Evidence never raises autonomy above what the
  provider granted. It can only hold a department below the grant, and when it
  does, `status` says why.

In the act stage, a department acts only within its effective autonomy.
Everything else stays a recommendation. Every action still goes through the
kernel, with its approval rules and the WAES gate.

## Pieces

| Piece | Where | What it enforces |
|---|---|---|
| Operate playbook | `deploy/playbooks/operate.json` | A monthly cycle: observe → review → act → measure → reinvest → experiment → observe. The founder can stop from any state. Every agent step names its capability and only proposes |
| Config | `deploy/operate/operate-nuera.json` | Period length, reserve floor, reinvest and experiment shares, experiment cap, spend limits, categories, WAES, hand-over rules, prerequisites |
| Autonomy | `departmentAutonomy()` in `packages/kernel/src/playbooks/operate.ts` | min(grant, evidence), as above |
| Period totals | `periodTotals()`, `operatePeriod()` | Money in [from, to). A period starts where the last approved plan ended, so no money is counted twice |
| Reinvestment plan | `reinvestmentPlan()` | Surplus = revenue − (spend + compute − refunds). The reserve is topped up first, then reinvestment and the experiment pool are split from what remains. Amounts are rounded to cents. **Always `needsFounder: true`** |
| Plan approval | `approvePlan()`; `packages/host/src/operate-store.ts` | Only the founder (the config's `owner`, a human) approves a plan. Plans are appended to `plans.json` and never edited |
| Bounded experiments | `startOperateExperiment()`, `experimentSpendConfig()`, `decideOperateSpend()` | An experiment's budget must fit in what is left of the latest approved pool and be at most `maxExperimentUsd`. Experiment spend goes through Genesis's `decideSpend` against the pool that funds it |
| Playbook facts | `operateFacts()` | `departments.*`, `period.*`, `reinvestment.approved`, `experiment.*` (reusing `genesisFacts`) |

### The reinvestment plan

For a period with surplus S and cash on hand C:

1. Reserve top-up = min(S, max(0, `reserveFloorUsd` − C)).
2. Remainder R = S − top-up.
3. Reinvest = R × `reinvestShare`. Kept = R − reinvest.
4. Experiment pool = min(reinvest × `experimentShare`, `maxExperimentUsd`).

With no surplus, every amount is zero and the plan says so. For Nuera the
config is conservative: reserve floor $1,000, reinvest 50%, experiments 30% of
that, capped at $250.

### Experiment spend in Operate

`decideSpend` used to take a whole `GenesisRunConfig`, which says
`digitalOnly: true`. Operate is not digital-only, so it does not pretend to
be. `decideSpend` now takes a `SpendPolicy`, which holds only the fields it
reads: the category lists and the spend limits. A `GenesisRunConfig` is a
`SpendPolicy`, so Genesis is unchanged. `experimentSpendConfig()` returns the
same shape with `digitalOnly: false`, and its budget is the approved pool
(never more than `maxExperimentUsd`).

- **Experiment spend** is checked against the pool that funded the experiment
  (the latest plan approved before the experiment started). The checks are the
  same as in Genesis: the category lists, the pool, the daily cap (which counts
  only experiment spend), the experiment's own budget, and the $10 and risk-2
  auto limits.
- **Business spend outside an experiment** keeps the category rules and always
  needs the founder.

## Who decides what

| Decision | Who |
|---|---|
| Grant a department autonomy (the ceiling) | The provider, in the intent ledger |
| Whether the evidence supports acting within limits | The shadow report: automatic, and it can only hold a department back |
| Act within a department's effective autonomy | The department, through the kernel |
| Anything beyond it | A recommendation: a human decides |
| Approve the reinvestment plan (capital allocation) | The founder |
| Start an experiment inside the approved pool | The founder |
| Kill an experiment (kill threshold, over budget, time up) | Automatic: stopping never needs permission |
| Scale or modify an experiment | The founder |
| Business spend outside an experiment | The founder |
| Stop Operate | The founder, from any stage |

## Commands

```bash
npm run operate -- check                                  # config, playbook, blockers (entity, payment accounts in the vault)
npm run operate -- status                                 # per department: granted vs effective autonomy, with reasons; period totals; open experiments
npm run operate -- plan --cash <usd>                      # the reinvestment plan for the current period (a proposal)
npm run operate -- approve-plan --cash <usd> ["note"]     # you, the founder: appended to plans.json
npm run operate -- experiment draft <file.json>           # an ExperimentDefinition with playbookId "operate"
npm run operate -- experiment start <experimentId>        # you; must fit in the approved pool
npm run operate -- measure <experimentId> <value> "<source>"
npm run operate -- evaluate <experimentId>                # kill/continue apply; scale and hold wait for you
npm run operate -- decide <experimentId> ["note"]
npm run operate -- spend <amount> <category> "<what>" --source receipt:<ref> [--experiment <id>] [--confirm]
npm run operate -- compute <amount> "<what>" --source provider-usage:<ref> [--experiment <id>] [--confirm]
npm run operate -- revenue <amount> "<what>" --source payment-processor:<ref>
npm run operate -- refund <amount> <category> "<what>" --source <type>:<ref>
```

The money commands work as they do in Genesis. `--source` is required. They
record only money that has already moved, and nothing is executed. A spend
the rules refuse is not recorded. A spend that needs the founder is recorded
only with `--confirm`.

Data lives in `data/operate/<runId>/` (gitignored): `ledger.json` (the
hash-chained money ledger, verified on every load, append-only),
`plans.json` (append-only) and `experiments.json`. Every write goes to a temp
file and is then renamed, with mode 0600.

Environment: `QUICKSILVER_OPERATE_CONFIG` (default
`deploy/operate/operate-nuera.json`), `QUICKSILVER_OPERATE_DIR` (default
`data/operate`), `QUICKSILVER_INTENT_DIR` (default `data/intent`, where the
intent ledger and the Onboard shadow logs are), and
`QUICKSILVER_OPERATE_ACTOR` (default `entity-founder`). The intent-ledger
company is the config's `companyId`.
