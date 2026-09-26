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
- **Impact (`scoreImpact`, scorer v2).**
  `uncertainty × importance × (1 + leverage)`.
  - Uncertainty is `1 − confidence`.
  - Leverage is `0.5 × Σ importance` of the variables that rely on this one
    (an edge `from → to` means `from` relies on `to`), discounted 0.8 per
    extra hop and capped at 1. The root objective is left out, since
    everything relies on it.
  - It is deterministic, and every score comes with its arithmetic.
  - `IMPACT_SCORER_VERSION` is bumped whenever the formula or the mode slots
    change, so human rankings collected against one version are never reused
    silently against another.

## Intent ledger

`ledger.ts` implements the provider operating rules from the revised charter.
A company's intent is an append-only log; `replay(ledger)` rebuilds the
current state, and `replay(ledger, { seq })` rebuilds it as of any earlier
entry.

| Who | May change | Kernel permission |
|---|---|---|
| Intent provider (person, group or organization) | Goals and their horizons, their **own** weights and autonomy per goal, customer commitments, the decision rule | `intent:provide` |
| Admin | The decision rule and the admin list only; no input into intent unless also recorded as a provider | `intent:rules` |
| Agent | Nothing | — |

- **Horizons.** `week`, `quarter`, `year` or `enduring`.
  - A goal may only serve longer-horizon goals.
  - Short-term goals lapse at `expiresAt` unless renewed.
  - Goal ids may not start with `rule.`, because the law and WAES are
    system constraints, not provider intent.
- **Every change is kept.** Each entry records who made the change, in which
  role, when, the change itself, the value it replaced, and an optional
  reason.
- **Tamper-evident.** Entries are chained by SHA-256 and can be signed with
  Ed25519. `verifyLedger` detects any edit, removal or reordering.
- **Decisions keep their context.** `intentInForce` returns the ledger head,
  rule and weights in force at a moment, and a decision stores them.
  Later changes never rewrite the past.
- **Decision rules.** `resolvePositions` combines providers' positions under
  the rule in force:
  - `majority`: more than 50% of authority.
  - `veto`: holders can block, and a silent holder is asked.
  - `final-say`: that provider decides.
  - With no rule set, any disagreement escalates to all providers.
- **Who the providers are** changes only by the sole provider or the
  provider with the final say.
- **Reversals are reported, never blocked.** `weightReversals` lists weights
  moved back and forth within a window.

## Persistence

`store.ts` saves the ledger and graphs. All ledger stores are append-only: an
existing entry is never replaced. `loadLedger` checks the chain (and
signatures, when a public key is given) on every load, and refuses a ledger
that was edited outside Aura (`LedgerIntegrityError`).

| Store | Where | Notes |
|---|---|---|
| `MemoryLedgerStore` | In process | Tests and short runs |
| `FileLedgerStore` | `<dir>/<company>.intent-ledger.jsonl` | The local host; the file is created readable by its owner only |
| `SanityLedgerStore` | `intentLedgerEntry` documents | Ids `intent-ledger.<company>.<seq>` contain a dot, so they stay out of unauthenticated reads. Writes use `createIfNotExists`, so a racing second writer gets `LedgerConflictError` |

- `recordChange(store, companyId, actor, change)` loads the ledger, applies
  the provider rules, and stores the new entry.
- `toSanityIntentGraph` and `fromSanityIntentGraph` map graphs to the
  `intentGraph` document type (id `intent-graph.<id>`).
- Both Studio schemas are read-only in Studio: Aura is the only writer.

## Intent profile (calibration)

`eval/intent-profile-v1.json` holds 36 quick two-option items. Each measures
one of six dimensions:

- short vs long term
- safe vs bold
- reputation vs revenue
- customer vs company interest
- decide yourself vs ask me
- relationships vs efficiency

Each dimension has 5 items, plus one reworded repeat with the options swapped,
placed at least 12 questions later. The provider says whether they lean
slightly or clearly, and lists their red lines at the end.

`scoreProfile` gives each dimension:

- a score from −1 to +1 and a plain reading, for example "Long term (clear)"
- agreement across its items
- whether its repeated pair agreed
- a confidence out of 10: `10 × (0.25 + 0.75 × one-sidedness) × share answered`. One-sidedness is 0 for an even split and 1 when all answers agree. A disagreeing pair caps it at 3; an unanswered pair takes off 20%

Answering "a" every time shows up as inconsistency. Honesty and legality are
never items; they are fixed limits. The profile seeds the provider's weights.
The 38 choice scenarios then check whether Aura can predict the provider's
choices from it. Dimensions are added in later versions only where they
explain scenarios Aura got wrong.

## Choice predictor (frozen v1)

`eval/choice-predictor-v1.json` maps each scenario option to the profile
dimensions it expresses. It was committed on 2026-09-26, before any scenario
answers existed, and a test pins its content hash, so changing it means
releasing a v2, never a silent edit.

- `predictChoice` scores each option: fit = Σ weight × profile score ×
  confidence/10, signed toward the option's pole.
- Every action also counts as "decide yourself", and "ask" as "ask me first".
- 25 of the 38 scenarios are covered. On the other 13 the predictor abstains,
  and the headline number counts each abstention as a miss.

```bash
npm run aura:choices -- --profile profile-answers.json --choices scenario-answers.json --detail
```

## Entry point

```ts
import { createIntent } from '@quicksilver/aura'
const { graph, questions, report } = await createIntent('I have $500 and want to start a business in 30 days', { requestedBy: 'entity-founder' })
```

- Stated values become `HUMAN_SPECIFIED`, with the quote.
- The mode (Genesis, Onboard or Operate) is inferred from a cue and explained,
  or asked about when the text gives no cue.
- Values the text clearly implies are inferred, not asked (`implied.ts`).
  - "We run a feed store" settles the business type, and "we sell hay to
    ranchers" settles the revenue model.
  - They are recorded as `AGENT_INFERRED` at confidence 0.8, with the quote
    and the reason.
  - The same applies to success metrics said in words, data sources to
    connect, and the cadence and scope of recurring work.
- Slots the mode needs but the text doesn't state or imply become open
  unknowns, ranked by impact. The top three become the questions.

## Parsers and evaluation

| Parser | Where | Notes |
|---|---|---|
| Rule-based baseline | `parseObjectiveBaseline` | Literal text only, never guesses; the fallback when no model is configured |
| Model-based | `@quicksilver/agent/intent` (`parseObjectiveWithModel`) | Agent `nuera-quicksilver:intent`, low impact only. Every value needs a quote found in the text, or it is dropped. |
| Combined | `combineParses` / `parseObjectiveCombined` | Each field from the source that is reliable for it (see below). Scored 86.7% on the held-out set |
| **Production** | `guardModelParse` / `parseObjectiveGuarded` | The model's parse with the autonomy guard: the model can never grant acting alone |

The combined parser's rules were fixed on 2026-09-26, before the held-out set
was scored:

- **Money** (budget, revenue goal) comes from the model.
- **Durations and weekly hours** come from the rules.
- **Mode** comes from the rules' literal cue when there is one, otherwise from the model.
- **Constraints** are the union of both.
- **Autonomy:** the model can only make it more restrictive, never grant acting alone.

Sets:

- `eval/objectives.json`: the development set, 52 objectives. The rules were
  improved after its misses were seen, so it no longer supports a claim.
- `eval/objectives-holdout.json`: 30 held-out objectives, committed before
  any parser was scored on them. **The 90% claim is made on this set.**

An objective counts as correct only when every field matches.

```bash
npm run aura:eval                                   # baseline, development set
npm run aura:eval -- --holdout                      # baseline, held-out set
npm run aura:eval:model -- --holdout --misses       # baseline, model and combined on Azure (reads .env)
```

**Held-out result (Azure, 2026-09-26): the charter's 90% target is met.**

| Parser | Correct | Accuracy |
|---|---|---|
| Model (prompt fixed before scoring) | 27/30 | **90.0%** |
| Combined | 26/30 | 86.7% |
| Baseline | 16/30 | 53.3% |

- The combined parser's extra miss came from the rules' mode cue overriding a
  correct model answer.
- The production parser is therefore the model with only the autonomy guard.
  The guard changes nothing on this set: every act-alone objective here was
  literal. It is chosen from two pre-registered candidates, and that choice
  is disclosed here.
- The remaining misses: an onboard vs operate call, a mode read into a bare
  question, and a "don't text patients" read as the customer-contact limit.
- 30 objectives is a small sample. The next check uses a fresh held-out set
  of 50 or more.

Azure run on the development set (2026-09-26, before these fixes): baseline
80.8%, model 71.2%. The model mixed up onboard and operate, read rates
("per month", "weekly") as deadlines, and missed some literal constraints.

## Charter success criteria (0.4.0) and status

| Criterion | Status |
|---|---|
| Choice agreement ≥ 70% and ≥ 2× chance (primary, revised charter) | Founder takes the intent profile (`eval/intent-profile-v1.json`), then Aura predicts the 38 blind scenarios in `eval/choice-scenarios.json` |
| ≥ 90% parsing accuracy | **Met on the held-out set:** model parser 27/30 (90.0%) on Azure, 2026-09-26. Confirm on a larger fresh set |
| 100% provenance tagging | Enforced by validation; true on all 52 labeled objectives |
| 0 unsupported inferences | Enforced by validation; 0 on all 52 |
| ≥ 80% top-3 agreement on impact ranking | **Not met: 56.3%** (chance 63.0%) on 32 objectives vs scorer v2, 2026-09-25. Scorer v3 (implied intent) needs fresh rankings |
| All inferred values explained | Enforced by validation |
| Tests pass | `npm run aura:test` |

Not yet built: the web entry point.

## Human rankings for the impact criterion

- Only objectives with more than three open questions count (32 of 52);
  with three or fewer, every ranking agrees.
- The founder ranks blind: questions are shown in a fixed shuffled order,
  with no scores and no hint of Aura's order.
- Agreement per objective is `|Aura top 3 ∩ human top 3| / 3`; order inside
  the three is not scored. A pick that ties in score with Aura's third
  question also counts, since Aura has no preference among tied questions.
- The report also gives the chance baseline (`3/n` averaged), about 63% on
  this set, so 80% is a real bar.
- The scorer was frozen at v2 before ranking. Changing it afterwards means
  new rankings, not a re-score against the old ones.

### First result (2026-09-25): 56.3%, below chance

`npm run aura:agreement -- --detail` shows two consistent disagreements:

- **Aura asks what the text already implies.** "We run a feed store" and
  "My shop sells used farm equipment" leave `business_type` open, because
  only literal values are extracted, so Aura ranks it first. The founder
  never picked it; he went to data sources and scope.
- **Different priorities for new ventures.** Aura leads with risk tolerance
  and budget; the founder mostly leads with skills, weekly hours and
  timeframe (what the person can actually put in).

The scorer is **not** retuned against these rankings; that would fit the
test to its answers. The finding feeds the charter revision: Aura must model
implied intent, not only literal slots, and the primary measure moves to
choice agreement (`eval/choice-scenarios.json`). Any new scorer version is
checked against fresh, held-out rankings.
