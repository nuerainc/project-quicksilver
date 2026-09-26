# @quicksilver/aura — the intent layer (Quicksilver Layer 2)

Pre-charter prototype. Aura becomes 0.1.0 when its charter is approved; until
then this package is versioned 0.0.0 and is built toward Quicksilver M3 (0.4.0).

Aura turns a plain-language objective into a **decision graph** with
provenance on every value, ranks what is still unknown by impact, and asks the
few questions that matter most. **Aura has no authority.** It never proposes
or executes an action; the NQC Kernel gates everything.

## Model

| Layer | Provenance | Where it comes from | Who may change it |
|---|---|---|---|
| Value | `HUMAN_SPECIFIED` | What the human wrote or answered, with the quote | Only a human, by restating it |
| Value | `SYSTEM_CONSTRAINT` | A policy or WAES criterion (for example, every action passes the NQC Kernel; customer-facing proposals need WAES review) | Nobody here; change the policy through the kernel |
| Context | `OBSERVED` | Evidence or an observation (ledger, metrics, documents) | A newer observation |
| Context | `AGENT_INFERRED` | An agent's inference, with an explanation and a non-agent source | Agents, through the memory governor |
| Interaction | — | The intent entry point and targeted questions | — |

Variables have a kind (`goal`, `constraint`, `metric`, `assumption`,
`unknown`), a confidence and an importance (both 0–1). Edges say which
variables depend on, constrain or inform which.

## Rules enforced in code

- **Tagging (`validateVariable`, `validateIntentGraph`).** Every variable has
  provenance.
  - Human values carry the human source, and system constraints carry their
    policy or WAES source; both have confidence 1.
  - Inferences need an explanation, at least one non-agent source, and
    confidence below 1.
  - The graph has no duplicate ids, no dangling edges and no cycles.
- **Belief updates (`applyBeliefUpdate`).**
  - Agents can't overwrite human values or system constraints.
  - An inference can't replace an observation.
  - Every accepted change passes the NQC memory governor, which refuses
    credentials and personal or payment data, and is appended to the graph's
    history.
  - Updates never mutate the input graph.
- **Impact (`scoreImpact`).**
  `uncertainty × stakes × (1 + 0.1 × dependents, capped at 0.5)`.
  - Stakes are the highest importance among the variable and everything that
    depends on it, discounted 0.8 per hop.
  - It is deterministic, and every score comes with its arithmetic.

## Entry point

```ts
import { createIntent } from '@quicksilver/aura'
const { graph, questions, report } = await createIntent('I have $500 and want to start a business in 30 days', { requestedBy: 'entity-founder' })
```

- Stated values become `HUMAN_SPECIFIED`, with the quote.
- The mode (Genesis, Onboard or Operate) is inferred from a cue and explained,
  or asked about when the text gives no cue.
- Slots the mode needs but the text doesn't give become open unknowns, ranked
  by impact. The top three become the questions.

## Parsers and evaluation

| Parser | Where | Notes |
|---|---|---|
| Rule-based baseline | `parseObjectiveBaseline` | Literal text only, never guesses; the fallback when no model is configured |
| Model-based | `@quicksilver/agent/intent` (`parseObjectiveWithModel`) | Agent `nuera-quicksilver:intent`, low impact only. Every value needs a quote found in the text, or it is dropped. |

`eval/objectives.json` holds 52 labeled objectives. An objective counts as
correct only when every field matches. The charter's 0.4.0 target is ≥ 90%.

```bash
npm run aura:eval                          # baseline: 42/52 (80.8%) on 2026-09-26
npm run aura:eval:model -- --misses        # model parser on Azure (reads .env)
npm run aura:test
```

## Charter success criteria (0.4.0) and status

| Criterion | Status |
|---|---|
| ≥ 90% parsing accuracy | Baseline 80.8%; the model parser is measured on Azure |
| 100% provenance tagging | Enforced by validation; true on all 52 labeled objectives |
| 0 unsupported inferences | Enforced by validation; 0 on all 52 |
| ≥ 80% top-3 agreement on impact ranking | Needs human rankings for the labeled set (to do) |
| All inferred values explained | Enforced by validation |
| Tests pass | `npm run aura:test` |

Not yet built: Studio schemas for `intent` and `graphVariable`, the web entry
point, persisting graphs, and human rankings for the impact criterion.
