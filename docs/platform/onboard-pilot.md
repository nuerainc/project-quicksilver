# Onboard pilot runbook (M4)

The Onboard pilot runs Quicksilver on **Nuera itself**, on the founder's
computer, in **shadow mode**: it reads the business's records, asks about
gaps, back-tests its forecasts, and recommends. **It does not act.** A
department gets autonomy only when the founder grants it in the intent ledger.

Planned for Jan–Feb 2027 (Quicksilver 0.5.0 is released on the pilot's
evidence, not before).

## Boundaries

- **Read-only records.** Export a CSV from the bank or bookkeeping tool; the
  connector never writes back.
- **AMP is excluded.** Files whose names look like AMP patent material
  ("amp", "patent", "ppa", "provisional") are refused until PPA Rev 4.2 is
  filed. Keep AMP costs out of the export, too.
- **Local data.** Everything is written under `data/intent/` in the repo
  folder, which git ignores and the local host's intent API reads.
- The Sanity Challenge instance is not involved.

## Steps

```powershell
# 1. Start the Onboard intent (answers are recorded as yours).
npm run onboard -- start "Onboard Nuera: understand our costs and grant pipeline."
#    → prints the intent id (intent-…) and the first questions

# 2. Connect the ledger export (CSV with Date and Amount, or Debit/Credit, columns).
npm run onboard -- connect <intentId> path\to\ledger-export.csv

# 3. Answer only what Aura still asks.
npm run onboard -- status <intentId>
npm run onboard -- answer <intentId> <variableId> "your answer"

# 4. Back-test forecasts on the business's own history (needs 12+ months).
npm run onboard -- backtest <intentId>

# 5. Shadow mode: log each recommendation, then judge it (and later its outcome).
npm run onboard -- recommend <intentId> collections "Send a reminder on invoice 1042"
npm run onboard -- judge <intentId> rec-1 accepted|modified|rejected "note"
npm run onboard -- outcome <intentId> rec-1 good|neutral|bad "note"

# 6. Check where the playbook stands and which departments are ready.
npm run onboard -- status <intentId>

# 7. Hand over a department (your decision, recorded in the tamper-evident ledger).
npm run onboard -- company nuera "Brodi"
npm run onboard -- handover nuera collections act-with-approval "20 of 21 accepted in shadow mode"
```

## Playbook stages (deploy/playbooks/onboard.json)

| Stage | Moves on when |
|---|---|
| Connect | at least one connector is connected |
| Observe | at least one value is observed |
| Interview | no open questions remain |
| Back-test | passed (6+ months forecast, error ≤ 30%, 70%+ inside the 80% range); a failure goes back to the interview |
| Shadow | 20+ judged recommendations and 80%+ agreement |
| Graduate | **your decision**: hand over, keep shadowing, or stop |

## What the pilot measures

| Metric | Source |
|---|---|
| Back-test accuracy | `backtest` report (error and range coverage) |
| Shadow-mode agreement | share of recommendations you accept (modified counts half), per department |
| Outcomes | bad outcomes on accepted recommendations block hand-over |
| Human interventions | every verdict and hand-over is recorded with who and when |
| Audit completeness | every observed value names its source; every intent change is in the chained ledger |
| Aura verdict prediction | before each verdict, Aura records the chance you will accept. Scored predict-then-learn, this is the first **fresh** test of Aura's choice agreement (target 70%) |

## Shadow mode on the host

The local host serves the same shadow log over its API, so the shadow-stage
agent can propose and you can judge from anywhere the host is reachable.

**Console:** open `http://127.0.0.1:<port>/console` while the host runs
(`npm run host`). Sign in with your bearer token; it is kept only in that
browser tab. From the console you can:

- state objectives
- answer Aura's questions
- ask the shadow agent for proposals
- judge each recommendation
- read a company's **intent ledger** (read-only): whether its hash chain
  verifies, the providers, goals with their horizons, weights and autonomy
  per goal, the decision rule, commitments and the recent entries
- follow the **Genesis run** when the host has one configured: what blocks
  it, capital used (compute included), what is left, revenue, net and return
  on capital, each experiment's thresholds and latest measurement, with
  buttons to start, measure, evaluate and decide, and a form that records
  money that already moved (it shows the kernel's reasons when a spend is
  refused or needs your confirmation). The section is hidden when the host
  has no Genesis run

The page itself holds no data: everything comes from the API, under your
own permissions.

| Route | Who | What |
|---|---|---|
| `GET /api/shadow/:intentId` | `decision:read` | Recommendations, per-department report, playbook facts, Aura's prediction score and learned weights (marked `AGENT_INFERRED`) |
| `POST /api/shadow/:intentId/recommendations` | `intent:provide` or `decision:propose` | Record one proposal by hand |
| `POST /api/shadow/:intentId/generate` | `intent:provide` or `decision:propose` | The shadow-stage agent (`nuera-quicksilver:shadow`) proposes up to 10 actions for the named departments; needs a model provider |
| `POST /api/shadow/:intentId/recommendations/:recId/verdict` | `intent:provide`, humans only | `accepted`, `modified` or `rejected`; trains Aura's verdict learner |
| `POST /api/shadow/:intentId/recommendations/:recId/outcome` | `intent:provide`, humans only | `good`, `neutral` or `bad`, after a verdict |

A proposal carries:

- `department`, `description` and `reversible`
- `operationalImpact` and `uncertainty` (each 0–5)
- `financialExposure` and `customerFacing`, which are optional
- `evidence`: a list of `{id, title, confidence}`

What the host does with each one:

- **Kernel verdict.** The kernel judges every proposal as if that
  department had already been handed over. The verdict records what
  Quicksilver *would* have done:
  - Low-risk, reversible work with evidence shows `execute-autonomously`.
  - Anything without evidence is refused.
  - Large or irreversible exposure goes to a human.
- **Grounding.** The agent must cite facts from the intent graph. Citations
  that aren't in the graph are dropped, and so are proposals left with none.
- **Nothing executes.** Every record stays `executed: false`.

Aura's learner lives in `learner.json` next to `shadow.json`. It is Aura's
inference about you: it never writes to the intent ledger and grants
nothing. Hand-over is still your own `handover` entry.

## Persistence

By default the shadow log and Aura's learner are files: `shadow.json` and
`learner.json` under `<intent>/onboard/<intentId>/`, next to the file run
store (in memory when the run store is not a file store).

Set `QUICKSILVER_SHADOW_STORE=sanity` to keep them in Sanity instead. The
host uses the same project settings as evaluation records
(`NEXT_PUBLIC_SANITY_PROJECT_ID`, `NEXT_PUBLIC_SANITY_DATASET`,
`SANITY_AUTH_TOKEN`) and refuses the legacy challenge project.

Set `QUICKSILVER_COMPANY_ID` to the company id of your intent ledger (the one
created with `npm run onboard -- company`) to give the shadow-stage agent your
confirmed decision principles (`npm run onboard -- principles import`). They
are read from the ledger on every generate, so a retired principle stops
applying at once.

| Document type | One per | Id | Rules |
|---|---|---|---|
| `shadowRecommendation` | recommendation | `shadow-recommendation.<intentId>.<recId>` | Append-only. The verdict and the outcome are each set once; a save that would change or remove them is refused (HTTP 409). A racing writer loses on the revision check. |
| `auraVerdictLearner` | intent | `aura-verdict-learner.<intentId>` | Marked `AGENT_INFERRED`. Updated after each verdict, under the same revision check. |

Both types are read-only in Studio. After pulling, deploy the schema with
`npm run schema:deploy -- --login`.
