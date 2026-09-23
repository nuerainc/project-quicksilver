# Quicksilver demo — 3-minute script

> Record against the live deployment, https://quicksilver-seven.vercel.app
> (or `npm run dev:web` locally). The planner reasons fresh on every run, so
> card wording and numbers vary: narrate what is on screen, not this script.
> Scripted for screen-recording; voiceover optional.

---

## 0:00–0:20 — Cold open

> "Most AI business assistants know your documents. Quicksilver knows your company."

- Show https://quicksilver-seven.vercel.app with the default state.
- Pan across the homepage header.

## 0:20–0:50 — The objective

> "I give Quicksilver one objective."

- Type the objective into the CEO intent box:
  *"Reduce production downtime by 20% over the next 30 days without increasing OPEX."*
- Click **Send to Quicksilver**.

## 0:50–1:20 — Plan reveal

> "Quicksilver queries the structured company model. It uses Sanity Context MCP — schema-aware, Knowledge-Base aware. It doesn't search for the answer. It reasons over a model of the company."

- Show the plan section: `reasoning` text and the listed `required capabilities`.

## 1:20–1:50 — The killer moment

> "The agent found two potentially applicable policies. Watch."

- Pan to the Decision card with a policy conflict (usually the controller
  parameter change). It will look something like:

  ```
  Policy conflict detected:
    Operations Policy 17   "Approval required for parameter changes."
    Emergency Policy 4      "Automatic changes permitted under emergency conditions."
    Current incident status:  NOT classified as emergency.
  ```

> "Risk 5 of 5, and the change isn't reversible without a controlled rollback. So the kernel routes it to a human."

- Point at the **Process** line: *Decision Lifecycle · Awaiting human approval (via route-to-human)*.
- If a card arrived **Auto-approved by the kernel** (risk ≤ 2), point at it too: the autonomous lane, governed by a number in a Sanity document.

## 1:50–2:10 — Approve

> "The CEO can approve. Watch the state change."

- Click **Approve**. Notice the status flips to `approved` and the buttons swap.
- Show the disposition banner.

## 2:10–2:40 — Execute + observe

> "Execute the change. Quicksilver simulates it against a metric."

- Click **Execute (simulated)**.
- Click **Observe metric**.
- Show the observation panel: baseline vs. new value and the % change.
- If it moved the wrong way, click **Propose rollback**: rollbacks always go to a human.
- Open **Decision log →** to show the full process history (kernel, human, executor).

## 2:40–3:00 — Cut

> "The agent didn't search for an answer. It reasoned over a model of the company."

- Hard cut.

---

## Backup scenes (use only if main flow breaks)

- If the rollback path triggers instead of improvement (~30% seeded chance): re-run the demo with a different `_id` seed or refresh state. Use the rollback demo as the main if the kill-shot lands on it.
- If MCP isn't set up yet, point the camera at `Sanity Manage` and show the Context MCP endpoint configuration panel (proves the integration is real, not mocked).

## Cut-tracks to capture ahead of submission

If you record it once and want extra footage:

1. **Studio fly-through** — the 18 entities in tree view (proves scale)
2. **Open `decision-cnc2-param`** in Studio — the seeded audit record visible
3. **Sanity Manage → Context** panel showing the endpoint config
4. **Schema deploy log** showing all 10 types
5. **Kernel tests passing** (`npm run kernel:test`) — visual proof
