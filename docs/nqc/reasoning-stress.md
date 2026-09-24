# Quicksilver Engine reasoning stress harness

`packages/kernel/src/engine/stress.ts` provides deterministic challenge
generation, final-answer scoring, and a provider-neutral runner for a bounded
suite. Version 1 covers multi-step arithmetic, invalid inference, insufficient
information, and contradictory ordering constraints.

The harness requests only the answer to each prompt. It does not ask for,
inspect, or persist private chain-of-thought. The runner accepts an answer
callback and optional `AbortSignal`, runs sequentially to avoid unbounded model
load, and returns aggregate/case diagnostics without retaining model responses
or exposing the answer key.

Run the bounded benchmark manually against a configured role:

```sh
npm run benchmark:stress --workspace @quicksilver/agent -- --role planner --seed 42 --count 12
```

Supported roles are `planner`, `reviewer`, `router`, and `executor`. The
command uses the role's existing model configuration, defaults to 12 cases and
seed 42, and accepts at most 50 cases. It makes one inference request per case;
cloud-provider usage may be billable. It prints aggregate and per-case
diagnostics, but not model responses or answer keys.

The harness remains separate from live agent routes, model performance
profiles, calibration data, and durable benchmark history. Its score is a
deterministic benchmark signal, not proof of general reasoning correctness.
