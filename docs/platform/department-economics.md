# Department economics proposals (P-071 foundation)

Operate can turn verified unit-economics observations into a deterministic,
reviewable proposal to spawn, fund, shrink, retire, or maintain a department.
The proposal path is advisory: it does not create or mutate a Sanity Department
record and it never transfers money. Founder approval records intent. The
founder may then apply the approved structure through P-095's dedicated-Sanity
executor, which atomically updates versioned department status/budget metadata
and appends an immutable audit record. No funds move and no external tool is
dispatched.

## Proposal inputs

Create a JSON file containing exactly `policy` and `candidates`, then run:

```powershell
npm run operate -- departments propose .\department-economics.json
```

`policy` is owner-authored and versioned. It includes `schemaVersion: 1`,
`playbookId`, `version`, `owner`, the minimum qualifying periods for spawn,
funding, and retirement, and the return-multiple thresholds for spawn, funding,
shrinking, and retirement. The owner must match the founder configured for the
Operate workspace. Thresholds have no hidden defaults.

Each `candidates` entry contains `departmentId`, `status` (`candidate` or
`active`), `qualifyingPeriods`, `netContributionUsd`, `capitalUsedUsd`,
`currentBudgetUsd`, `proposedBudgetUsd`, and `evidenceRefs`. The evidence refs
must resolve to entries in the verified Operate ledger or experiment records.
The return multiple is derived from net contribution divided by fully loaded
capital, which includes compute. Candidates are evaluated in department-ID
order so allocation against an approved capital ceiling is deterministic.

Example:

```json
{
  "policy": {
    "schemaVersion": 1,
    "playbookId": "operate",
    "version": 1,
    "owner": "entity-founder",
    "minimumPeriodsForSpawn": 2,
    "minimumPeriodsForFund": 2,
    "minimumPeriodsForRetirement": 3,
    "spawnReturnMultiple": 1.5,
    "fundReturnMultiple": 1.25,
    "shrinkBelowReturnMultiple": 0.8,
    "retireBelowReturnMultiple": 0.2
  },
  "candidates": [
    {
      "departmentId": "market-intelligence",
      "status": "candidate",
      "qualifyingPeriods": 3,
      "netContributionUsd": 180,
      "capitalUsedUsd": 100,
      "currentBudgetUsd": 0,
      "proposedBudgetUsd": 50,
      "evidenceRefs": ["ledger:1", "experiment:pricing-test"]
    }
  ]
}
```

The kernel binds the policy snapshot, evidence references, capital limit,
proposals, and proposer/time into a digest. Proposals are persisted by the
Operate store. A proposal requires a founder decision with a written note;
the founder cannot be the proposer. Decide each actionable item explicitly by
passing proposal IDs to `--approve` or `--reject`:

Every claimed qualifying period must have a distinct evidence reference. The
current contract does not yet normalize department attribution or prove that
each reference represents a separate accounting period; treat that as a known
evidence gap, not as a verified unit-economics history.

```powershell
npm run operate -- departments decide <portfolio-proposal-id> `
  --approve <proposal-id> --reject <another-proposal-id> `
  --note "Reviewed against the approved ledger evidence."
```

Decision records bind the portfolio digest. Agent principals cannot approve,
repeated decisions are refused, and approval records intent only. A proposal
created under an older approved capital plan must be regenerated.

After recording founder approval, apply it with:

```powershell
npm run operate -- departments apply <portfolio-proposal-id>
```

The command requires the configured human founder, the exact persisted
proposal/approval pair, current approved-plan headroom, and a dedicated Nuera
Sanity write client. It fails closed if these checks fail. It writes only the
department record and its digest-bound execution audit in a single synchronous
Sanity transaction. A retry verifies existing audit records and is idempotent.
The public Sanity Challenge project is refused. Applying the record does not
transfer/disburse capital; approved budgets are internal metadata.

## Current boundary

Kernel and Operate CLI regression tests cover all four structural proposal
actions, maintain/no-op cases, thresholds, evidence/sample gates, capital
ceilings, digest verification, persistence, and founder approval. Executor
regression tests cover atomic application and its refusal paths. P-071 remains
partial because department attribution and independent accounting-period
evidence are not established, and live ledger/pilot evidence is outstanding.
P-095 remains partial because general effectful workflow/tool execution and
live deployment evidence are not implemented. Dedicated Sanity credentials are
required to apply changes to the production Nuera dataset; tests use an isolated
fake client and do not claim a live integration run.
