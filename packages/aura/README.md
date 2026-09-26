# @quicksilver/aura — the intent layer (Quicksilver Layer 2)

**Aura 0.1.0.** The Aura charter is approved; the approval was recorded on
2026-09-26 ([charter](https://claude.ai/code/artifact/9ce0d270-06a7-4ec1-b678-e3318b48de7b)).
Each Aura milestone raises the minor version. The charter's success criteria
below are Aura's bar for 0.4.0. Quicksilver M3 (Quicksilver 0.4.0) shipped
on its built features and does not wait on them.

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
| Intent provider (person, group or organization) | Goals and their horizons, their **own** weights and autonomy per goal, their **own** decision principles, customer commitments, the decision rule | `intent:provide` |
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
- **Decision principles** are how one provider wants choices made, in their
  own words ("When two goals conflict, take the smaller or test version
  first"). They are intent, not rules: the decision rule combines several
  providers' positions, while a principle says how this provider decides.
  - `principle.set` `{ principle: { id, text (1–500), appliesTo?, examples? } }`
    and `principle.retire` `{ principleId, reason? }`.
  - Only providers may set or retire them, and only their own; admins and
    agents cannot.
  - `replay(...).principles` holds the active ones, each with `setBy`,
    `setAt` and provenance `HUMAN_SPECIFIED`. Retired and reworded versions
    stay in the ledger history (`previous`).
  - `npm run onboard -- principles import <export.json> <companyId>` records
    the confirmed and edited principles from the principles page's export and
    skips rejected ones. Unchanged principles are left alone, so re-importing
    is safe; changed text is a new, tracked entry. `principles list
    <companyId>` shows the active ones. Code: `principles.ts`.
  - The shadow-stage agent is given them when the host has
    `QUICKSILVER_COMPANY_ID` set.

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

### Predictor v1 result (2026-09-26): 6/38 (15.8%), below chance

The founder answered all 38 scenarios, 37 of them marked "sure", after v1
was frozen and pushed. v1 scored 6/38 overall and 6/25 (24%) on the
scenarios it covers, both at or below chance. The misses show two design
flaws and one missing ingredient:

- **Compromise options can never win.** A linear sum of dimension scores
  always favors an extreme option. The founder chose the middle-ground
  option in 9 of the 25 covered scenarios (a labeled sponsorship, a small
  pop-up instead of a loan, a premium tier that keeps small-farm prices, a
  3-month test with a stop point).
- **Practical fixes score zero.** An option expressing no profile dimension
  ("export the records, then cancel") could never win. The founder chose one
  6 times.
- **Hard requirements come first.** The founder's notes ("it needs to work",
  "it's limited to 15", "do it right") show stated requirements eliminating
  options before any trade-off is weighed.
- "Ask" was chosen twice, both times when other people's data or authority
  was involved.

**Exploratory re-scoring (after seeing the answers; not a claim):**

- Other profile-based rules score the same, 6/38: least sacrifice (maximize
  the worst dimension) and least regret. The same holds with the customer
  dimension removed.
- "Always pick a" scores 15/38.
- Mapping the founder's scenario choices back onto the profile dimensions
  shows they diverge from the profile. The profile's one strong reading
  (company interest, 10/10) points the other way in the scenarios
  (customer-friendly choices). Horizon and reputation lean long-term and
  revenue where the profile said balanced.
- The profile, as measured by abstract policy items, does not transfer to
  concrete situations. The next profile version should measure in context
  (for example, commercial terms vs treatment of a specific customer).

**Held-back dimensions, mapped (exploratory):**

- Six of the eight held-back dimensions can be read secondarily from
  existing profile items. Speed vs quality, for example, comes from the
  training, roof, mediocre-product and own-name items.
- With all 12 dimensions, readings from the profile only and held-back
  dimensions also tagged on the scenarios, the score rises from 6/38 to
  **11/38 (28.9%)**, barely above chance.
- A leave-one-out upper bound, which learns each dimension from the other
  37 answers, also reaches only 11/38. Weights on option tags top out here,
  whatever the profile says.
- The strongest leaning the scenarios reveal is **quality over speed**. The
  profile's secondary reading agrees, so it is the first candidate for
  profile v2. Focus agrees too. Growth and scale point the other way.
- A predictor needs more than weights: requirements as filters, recognizing
  a compromise option, and preferring the fix that solves the problem.

The only blind check left on these answers is the model:
`npm run aura:choices:model` gives the Azure model the scenarios with and
without the profile, never the answers.

### Blind model test result (2026-09-26): 60.5% with the profile, 63.2% without

Run by the founder on Azure (`qs-planner`):

| Arm | Agreement | Versus chance (25%) |
|---|---|---|
| Profile readings in the prompt | **23/38 (60.5%)** | 2.4× |
| No profile | **24/38 (63.2%)** | 2.5× |

- **Blindness:** the model never saw the answers. The prompt was written
  after they existed, by an author who had seen the earlier analyses, but
  it contains no pattern taken from them. It is the most blind result on
  this set, not a pre-registered one.
- **The strongest predictor so far.** It is 4× the frozen v1 and above the
  exploratory learner (42–53%).
- **It passes the 2× chance bar but not the 70% bar.** The charter needs
  both, so the criterion is still not met.
- **The profile did not help.** Adding it cost one scenario. This is the
  third sign (after v1 and the learner's prior) that the six-dimension
  readings do not carry over to concrete choices.
- **Misses shared by both arms:** 10 of them (cs-01, 03, 07, 10, 15, 17,
  20, 22, 31, 32), mostly in the *implied*, *ambiguity*, *drift* and
  *autonomy* categories.
  - A general model misreads what this founder leaves unsaid.
  - It also misreads when this founder would rather act than be asked.
  - That is what learning from the provider's own verdicts is meant to fix.

**Next method (to be frozen before a fresh test):** the model's pick becomes
the starting point, and the learner adjusts it from the provider's own
choices. The model's choice is one feature, alongside `compromise`, `ask`
and per-category terms. The combination is scored predict-then-learn on
fresh scenarios and on pilot verdicts, never on these 38.

v1 stays recorded as failed; it is not retuned. v2 changes the method:
requirements eliminate options first, then the least-sacrifice option wins
(no goal badly sacrificed), with extremes only for strong profile leans. It
will be frozen before it is tested on a fresh scenario set, since these 38
are now seen. The founder's raw answers are kept out of the repository.

### Learning predictor (`src/learn.ts`, exploratory)

v1 was fixed: it read the profile once and never changed. The learning
predictor starts from the profile and updates after every choice the
provider makes: scenario answers now, shadow-mode verdicts in the pilot.

- **Model:** a multinomial logit over the options of one decision. It uses
  these features:
  - each dimension's signed load
  - `ask`
  - `compromise` (the option takes a partial position)
  - `practical` (the option expresses no trade-off)
- **Update:** after each choice, one gradient step on the log-likelihood,
  pulled back toward the profile prior so one answer never swings it.
- **Measure:** `prequential` predicts each decision *before* learning from
  it, so every scored prediction was made without its answer.

Results on the founder's 38 answers (2026-09-26):

| Order | With profile prior | No prior |
|---|---|---|
| Scenario order | 16/38 (42.1%) | 18/38 (47.4%) |
| Reverse order | 17/38 | 17/38 |
| Interleaved | 19/38 (50.0%) | 20/38 (52.6%) |

- Every ordering beats the frozen v1 (15.8%) and chance (25%).
- The largest learned weight is **compromise (+1.14)**. **Ask** turns
  negative (−0.46): the founder rarely chooses to be asked.
- Starting from the profile did not help. This matches the finding that
  the profile's readings did not carry over to the scenarios.

**Why this is not a claim:**

- The features (`compromise`, `practical`) were designed after seeing
  these answers.
- The learning rate and prior strength were not tuned, but they were not
  pre-registered either.
- The real test is fresh scenarios or pilot verdicts, scored the same
  predict-then-learn way.

**Governance:** learned weights are Aura's inference about a provider, never
provider-stated intent. They are kept in their own record, shown to the
provider with their evidence, and never overwrite weights in the intent
ledger.

## Choice predictor v2 (frozen 2026-09-26)

`eval/choice-predictor-v2.json` fixes the method, and `eval/choice-scenarios-v2.json`
holds 30 fresh scenarios (`cs2-01` to `cs2-30`) in all nine categories, three
or four each. Both were committed before any answers or model picks for them
existed. A test pins the spec's content hash, so any change is a v3, never a
silent edit.

**Method (`src/predict-v2.ts`).** The blind model's pick is the starting
point, and the learner adjusts it from the provider's own choices.

- A multinomial logit over the options (`src/learn.ts`) with these features:
  - `model`: 1 on the option the model picked
  - `compromise`: the option is annotated as a middle position
  - `practical`: an action that expresses no trade-off
  - `ask`, plus `cat.<category>.ask`: a per-category ask tendency
  - `dim.<dimension>`: the option's signed dimension loads
- The model pick comes from the no-profile arm, which never sees any
  answers. A model error gives no pick, and the `model` feature is then 0.
- `prequentialV2` predicts each decision before learning its answer, in
  scenario order. Nothing in this package calls a model.
- Ties go to the earliest of a, b, c, ask.

**Why the prior is `model` = 1.5, everything else 0.**

- With four options, 1.5 gives the model's pick a starting probability of
  0.60. That matches the blind model's measured agreement on the 38 set-v1
  scenarios (60.5–63.2%), the only input used to set it.
- The model's pick is therefore the prediction until there is evidence
  against it. A provider who consistently overrides it toward a compromise
  is followed after about three such answers (tested on synthetic data).
- The profile readings are not used as a prior. They did not carry over to
  concrete choices in set v1.
- The learning rate (0.5) and prior strength (0.1) are the learner's
  existing defaults, not tuned.

**Scoring rule.** Prequential accuracy over all 30 fresh scenarios, against
the charter target: at least 70% and at least 2× chance (25%). It is
reported with the per-category breakdown, and with the model's pick alone
for reference. Nothing is claimed until all 30 are answered.

**How to run.**

1. The founder answers the 30 fresh scenarios in a page (to be built), blind.
2. Generate the model's blind picks on Azure. The model sees the scenarios
   only, never any answers:
   ```bash
   npm run aura:choices:model -- --set v2 --picks-out data/aura/v2-picks.json
   ```
3. Score offline:
   ```bash
   npm run aura:choices:v2 -- data/aura/scenario-answers-v2.json data/aura/v2-picks.json [--detail]
   ```

Both files hold one person's data and stay out of the repository. The same
combiner is meant to be scored the same way on pilot verdicts.

### v2 result (2026-09-26): 10/30 (33.3%), not met

The founder answered all 30 fresh scenarios and ran the blind picks on Azure
(`qs-planner`, no-profile arm).

| Measure | Result |
|---|---|
| **Predictor v2, predict-then-learn (the frozen test)** | **10/30 = 33.3%**, 1.33× chance (25%). Target ≥ 70% and ≥ 2× chance: **not met** |
| Model pick alone (reference) | 7/30 = 23.3%, at chance |
| By category (v2) | drift 3/3, tradeoff 2/3, unstated-constraint 2/3; implied 1/4, autonomy 1/4, collective 1/3; conflict, ambiguity and spirit 0 each |

Findings, stated plainly:

- **The method failed its frozen test.** It is recorded as it ran, not retuned.
- **The model result did not replicate.** On set 1 the same model, with no
  profile, matched 24/38 (63.2%). On set 2 it matched 7/30, at chance.
  - Both samples are small, so each figure is uncertain.
  - Even so, a gap this large means the 63% cannot be treated as the model's
    general ability to predict this founder.
- **The learner moved in the right direction but too slowly.** It cut the
  model's weight from 1.5 to 0.42 and added 3 correct choices over the model
  alone. With 30 answers it could not catch up.
  - It learned: toward compromise (+0.40) and bolder, longer-term options
    (risk +0.61, horizon +0.55); away from "ask" (−0.72); and away from the
    options tagged customer-first (−0.76).
  - These are Aura's inferences, never provider intent.
- **Exploratory only (after seeing the answers):**
  - The founder chose the option marked "c" in 14 of 30 scenarios; the
    model rarely picked it.
  - Where a scenario had an option flagged as a compromise (22 of 30), he
    chose it in 12.
  - "Ask" was chosen 3 times; Aura never predicted those correctly.

**What this means for the method:** a general model plus 30 answers is not
enough to predict one person's choices. The next test comes from far more
decisions per provider, in the real context they are made in: shadow-mode
verdicts during the Onboard pilot, scored the same predict-then-learn way.
Any new scenario set is written by someone who has not seen this founder's
answers, and the method is frozen before it is answered.

## Learning choices from the provider's own decisions (in-context, frozen 2026-09-26)

v1 read a profile, and v2 added a small learner on hand-made features;
neither learned enough. This method learns from the provider's own
decisions:

- The model is shown the provider's decisions on the **other** scenario set:
  the situation, the options, what they chose, and their own note.
- It then predicts this set without seeing this set's answers.
- It runs both ways: set 1 as examples to predict set 2, and set 2 to
  predict set 1.
- The "none" arm (no examples) runs alongside in the same run as a
  baseline. The model's own results varied a lot between the two sets
  (63% and 23%).

```bash
npm run aura:choices:model -- --set v2 --examples data/aura/scenario-answers.json --choices data/aura/scenario-answers-v2.json --detail
npm run aura:choices:model -- --set v1 --examples data/aura/scenario-answers-v2.json --choices data/aura/scenario-answers.json --detail
```

**Honesty notes:**

- Both sets were answered before this method existed, and I (the designer)
  have seen both.
- The prompt is fixed here, before any run. It contains no pattern taken
  from the answers, only the instruction to learn from the examples.
- A result counts as evidence, not proof. The clean test is new decisions,
  such as pilot verdicts, with all earlier decisions as examples.
- Offline check, same data (cross-set warm start of the v2 learner, no
  model): set 2 went from 11/30 cold to 13/30 after learning on set 1.

### Stated principles arms (frozen 2026-09-26 before any run)

`--principles <export.json>` gives the model the provider's confirmed and
edited decision principles (rejected ones are dropped):

- **rules**: the principles only.
- **rules+examples** (with `--examples`): the principles, then the earlier
  decisions from the other set.
- The system prompt for both adds that these are the provider's own stated
  principles, which take priority over general common sense, and that the
  examples show how the provider applied them.
- The existing arms (none, profile, examples) keep their frozen prompts byte
  for byte. All prompts are in `packages/agent/src/choice-prompts.ts`, and
  `choice-prompts.test.ts` pins them.

```bash
npm run aura:choices:model -- --set v2 --principles data/aura/principles.json --choices data/aura/scenario-answers-v2.json --detail
npm run aura:choices:model -- --set v2 --principles data/aura/principles.json --examples data/aura/scenario-answers.json --choices data/aura/scenario-answers-v2.json --detail
```

**Honesty note:** the principles are drafted from the provider's answers on
both sets, then confirmed in their words. Any set they were drafted from is
not held out. The clean test is new decisions.

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

## Charter success criteria (Aura 0.4.0) and status

| Criterion | Status |
|---|---|
| Choice agreement ≥ 70% and ≥ 2× chance on a fresh set, method frozen first, scored predict-then-learn (primary; charter revision 1, 2026-09-26) | **Not met.** Frozen predictor v1: 6/38 (15.8%). Blind model test: 24/38 (63.2%) without the profile, 23/38 (60.5%) with it; passes 2× chance, misses 70%. Frozen predictor v2 (model plus learner) on 30 fresh scenarios: 10/30 (33.3%); the model alone 7/30 (23.3%). Next: shadow-mode verdicts in the pilot |
| ≥ 90% parsing accuracy | **Met on the held-out set:** model parser 27/30 (90.0%) on Azure, 2026-09-26. Confirm on a larger fresh set |
| 100% provenance tagging | Enforced by validation; true on all 52 labeled objectives |
| 0 unsupported inferences | Enforced by validation; 0 on all 52 |
| Question quality ≥ 80%: Aura's top-3 questions answered rather than dismissed, in real use (charter revision 2) | Measured from the pilot. The earlier offline ranking test (56.3% vs scorer v2) was retired |
| All inferred values explained | Enforced by validation |
| Tests pass | `npm run aura:test` |

The web entry point is the host console (`/console`), built 2026-09-26.

## Question quality in real use (charter revision 2, 2026-09-26)

The founder retired the offline ranking exercise: ranking lists of
questions by hand is too easy to get wrong. Question quality is now measured
as questions are actually asked:

- **Answer:** answering one of Aura's open questions records its rank in
  Aura's impact order at that moment.
- **Dismiss:** "not worth asking" records the same rank, and the question
  leaves the queue:
  - `npm run onboard -- dismiss <intentId> <variableId>`
  - `POST /api/intents/:id/dismiss`
  - the console's **Not worth asking** button
- **Quality** is the share of Aura's first three questions (ranks 1–3) that
  the provider answered rather than dismissed. The target is 80%, unchanged.
  - It shows in `npm run onboard -- status` and in `GET /api/intents`.
  - Only a human provider's actions count, and the record is append-only
    (`questionFeedback` on the intent graph).

The frozen v3 predictions below stay in the repository as a record. That
test was retired before any ranking was collected, so it has no result.

## Learned question order (per provider, 2026-09-26)

The fixed scorer asks every provider the same questions in the same order.
The learned order (`src/rank-learn.ts`) learns one provider's order:

- **From rankings:** pairwise logistic regression on each ranking (1st >
  2nd > 3rd > the rest). Features: the question's slot, the slot within the
  mode, and the slot given what the objective already states.
- **From real use:** "not worth asking" pushes that question below the
  others. An answer gives a weak push up.
- **Scope:** it only reorders questions. The weights are Aura's inference
  (`ranker.json` next to the intent data), never provider intent.

Honest accuracy, always on objectives the learner did not train on
(`npm run aura:rank -- cv`; founder rankings from sets v1 and v3, 62 objectives):

| Test | Learned | Fixed scorer v4 | Chance |
|---|---|---|---|
| Leave-one-out, all | **75.3%** | 66.1% | 62.1% |
| Leave-one-out, existing businesses (onboard) | **84.4%** | 74.4% | 64.5% |
| Leave-one-out, new businesses (genesis) | 66.7% | 58.3% | 59.8% |
| Trained on set v3, tested on set v1 | **74.0%** (onboard 82.2%) | 68.8% | 63.0% |
| Trained on set v1, tested on set v3 | 61.1% (onboard 73.3%) | not comparable (v4 was fitted to v3) | 61.2% |

- **Onboard (existing businesses):** the founder's order is consistent and
  learnable. "Where are the records?" comes first in 29 of 30. The learned
  order clears the 80% bar on held-out objectives.
- **Genesis (new businesses):** his first question varies (goal, hours,
  time, budget or skills), and nothing in the objective text predicts which.
  The learned order is only a little better than chance there. More context
  would be needed, such as what he is trying to protect.

To use it: `npm run aura:rank -- train --out data/intent/ranker.json`. The
onboard commands and the local host read that file, and every answer or
dismissal updates it. Real-use question quality (revision 2) is the check.

## Fresh impact-ranking test for scorer v3 (frozen 2026-09-26; retired, not run)

Scorer v3 (implied intent) was never tested on rankings it had not seen. The
fresh test works like this:

- **The set** (`eval/impact-ranking-set-v3.json`) has 30 objectives no one
  has ranked: 7 held-out parsing objectives and 23 new ones, all with more
  than three open questions.
  - Objectives were kept or excluded only on parser output. Excluded were
    those with three or fewer open questions (any ranking agrees trivially),
    plus two the rule-based parser misread as new businesses.
  - A finding along the way: when the mode is unknown, Aura asks only the
    mode question, so most unclear objectives produce a single question.
- **Aura's rankings are frozen first.** They are in
  `eval/impact-predictions-v3.json`, committed before the founder ranks. A
  test pins the file's hash and checks that scorer v3 still reproduces it.
- **Chance:** 61.2%. **Target:** 80% top-3 agreement, the same as before.
- **Run it:** `npm run aura:agreement -- --set v3 [--detail]` once
  `eval/impact-rankings-v3.json` holds the founder's rankings.

### v3 result (ranked 2026-09-26, after revision 2): 56.7%, below chance

The founder ranked all 30 anyway, against Aura's picks frozen beforehand.
`npm run aura:agreement -- --set v3 --detail` shows the detail.

| Measure | Result |
|---|---|
| Top-3 agreement, scorer v3 | **17/30 average = 56.7%** (chance 61.2%, target 80%): not met |
| Identical top three | 5/30 |

This is supporting evidence, not the charter measure (revision 2 moved that to real use). Two patterns stand out:

- **Existing businesses:** the founder put *where the records are*
  (`data_sources`) first in 10 of 12 objectives. Aura never had it in its
  top three and led with business type, even when the text named the
  business ("I own a boutique").
- **New businesses:** Aura led with risk tolerance every time. The founder
  never put it first; he led with the goal (success metric), weekly hours,
  timeframe or budget.

**Scorer v4 (2026-09-26), fitted to these rankings:**

- Existing businesses ask where the records are first.
- New businesses rank time and hours above risk.
- Many more business types are recognized: boutique, gym, car wash,
  roastery, campground and others, plus "our …" with modifiers.

Scored on the same 30 rankings, v4 reaches 65.4% against its own chance
rate of 64.1%. That score is fitted and exploratory, and barely above
chance: fixed importance weights do not capture how the founder orders
questions. Whether v4 asks better questions will show in real-use question
quality, which is what revision 2 measures.

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
