# Genesis experiment research trajectories (P-031 foundation)

Genesis has an owner-reviewed exporter for turning decided experiment history
into structured quantitative trajectories. It supports outcome analysis and
training of decision/calibration models without exporting customer-facing copy
or private reasoning. It does not execute experiments or send data to a model
provider.

Run it from the project root:

```powershell
npm run genesis -- research export --confirm-privacy-review --note "Reviewed the structured research fields for this export."
```

The command requires the configured Genesis owner and an explicit privacy
review confirmation with a short note. It verifies the money-ledger hash chain
and experiment definition digests before projecting the data. Only experiments
with at least one recorded decision are included. The digest-bound JSON dataset
is written under `data/research/` with a content-derived filename; this directory
is local research data and must remain excluded from source control unless the
owner intentionally publishes a separately reviewed dataset.

The dataset retains coarse metric-direction signals (`kill`, `hold`, `continue`,
`scale`), elapsed days, decision/authority category, standardized content
review outcomes, experiment status, duration, and spend/revenue ratios. It omits
hypotheses, metric labels and IDs, raw measurement values, measurement sources,
transaction descriptions and references, free-text decisions/review notes,
reviewer identities within samples, and private reasoning. Unknown content
review channels collapse to `other`. The source ledger, experiment set, reviews,
and privacy note are represented by digests; a verifier checks the dataset
digest before downstream use.

Regression coverage in `packages/host/src/genesis-research.test.ts` verifies the
projection fields, free-text and source-reference exclusion, ledger tamper
refusal, owner/privacy gates, undecided-experiment exclusion, digest integrity,
and the CLI's private output path.

## Remaining P-031 work

This is a foundation, not full parity. P-031 still needs bounded batch-run
orchestration, trajectory export across observable workflow inputs/tools/
outputs/evaluations/approvals/outcomes, and a reviewed import that consumes
research results as priors in Genesis. Live data-use approval and operational
evidence are separate acceptance requirements.
