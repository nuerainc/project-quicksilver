# NQC evaluation benchmark plan

**Status: protocol proposal; no comparative performance claim is established.**

The repository has a deterministic NQC signal evaluator and a Quicksilver
Engine final-answer stress harness (`packages/agent/src/benchmark-stress.ts`).
The stress command is useful for repeatable reasoning challenges, but its score
does not measure general semantic correctness, calibrated hallucination risk,
or superiority over another product. This plan defines what evidence is needed
before making those claims.

## Benchmark design

Maintain versioned, labeled cases in the Quicksilver repository. Keep the
private held-out split outside the public Sanity Challenge project and dataset;
never seed benchmark prompts or expected labels into that challenge dataset.
Use the dedicated Nuera Quicksilver Sanity project only if benchmark records
are later persisted there, after its project-scoped credentials and access
controls are configured; never use the challenge project's dataset for this.
Each case contains an ID, task/domain, input, allowed evidence, expected
behavior or rubric, risk tier, and label provenance. Do not collect private
chain-of-thought. Retain only final outputs, citations/evidence references,
observable tool traces, evaluator outputs, and human labels.

Required strata:

- supported answer with sufficient evidence;
- missing or conflicting evidence where abstention/escalation is correct;
- multi-step arithmetic and constraint satisfaction;
- contradictory claims and unsupported factual claims;
- instruction injection and policy conflict;
- read-only tool failure, stale data, and malformed tool results;
- low/moderate/high-impact actions with the expected authorization outcome.

Use an authoring split, a calibration split, and a sealed held-out split. Avoid
near-duplicate prompt leakage across splits. Freeze the dataset version and
labels before evaluating a model, evaluator, routing policy, or prompt change.
Record the commit, evaluator version, model/provider/profile, configuration,
seed, date, and dataset hash for every run.

## Metrics and reporting

Report per-stratum counts and confidence intervals, not only a single aggregate
score:

- task outcome accuracy against labels/rubrics;
- unsupported-claim rate and contradiction detection recall;
- correct abstention/escalation rate and unnecessary escalation rate;
- safety false-allow and false-block counts by impact tier;
- evaluator agreement with independent human labels;
- latency, retries, token/cost estimate, and incomplete cases.

Human labels for high-impact safety outcomes require two independent reviewers
and adjudication for disagreement. Calibration must be measured on a separate
split from tuning. Regression thresholds and acceptable error budgets must be
approved before the holdout is run. Publish a redacted report with dataset and
evaluator versions; do not publish held-out inputs or answers.

## Release and claim gate

- Current seeded stress-suite scores may be described only as results on that
  named suite and exact seed/count/model configuration.
- Do not call reasoning, hallucination, brittleness, or safety scores
  calibrated until they are compared with held-out labels using the metrics
  above.
- Do not claim Quicksilver beats Hermes, Zo.computer, or another system until
  the same task set, tools, model access, time/cost limits, scoring rubric, and
  independent adjudication are used for each system.
- A benchmark result is not operational security, compliance, or production
  readiness evidence.

## Next implementation steps

1. Create a local versioned case schema and a labeled seed set for the strata
   above; keep the held-out labels access-controlled.
2. Add a credential-free evaluator harness and machine-readable JSON report.
3. Add double-labeling and adjudication guidance for safety cases.
4. Run model-backed stress challenges only with explicit provider credentials;
   record cost/latency and never print or persist secrets.
5. Publish the first result only after dataset hashes, split discipline, and
   acceptance thresholds are reviewed.
