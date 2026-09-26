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
