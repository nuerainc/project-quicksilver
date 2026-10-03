# Usability plan

Status: plan, not built. Written 2026-10-03 after a code audit of the web app and chat. It has
not been checked against real users; the first step below is to watch one.

## Principles

1. **The chat is the only place to talk to an agent.** Every other page works like a normal app:
   lists, detail pages, buttons. Agent results appear on those pages; agents are started from chat.
2. **The chat reads everything you can see, and writes nothing.** Approving, rejecting, executing,
   publishing and rolling back stay buttons a person presses (with separation of duties).
3. **Show what needs you, derived not stored.** One "attention" list answers "what should I look at
   now?" for every surface. An item disappears when it is dealt with. There is no read state.
4. **Say when we could not check.** If a source of attention items fails to load, the list says so.
   It never shows "nothing needs you" when it simply could not look.
5. **Do not hide a limit behind a click.** If you may not do something, the control says why before
   you press it.

## The attention list

One function turns the current state and the signed-in person's permissions into a list of things
that need that person. Each item has a stable id, a kind, a severity, a one-line reason, a link
and the time it started needing attention.

| Source | Item | Shown to | Link |
|---|---|---|---|
| Decisions | Waiting for your approval (not one you requested) | `decision:approve` | decision |
| Decisions | Approved, waiting to be executed | `decision:execute` | decision |
| Decisions | Executed, metric not yet observed | `decision:read` | decision |
| Decisions | Rollback proposed, waiting for approval | `decision:approve` | decision |
| Decisions | Your plan was refused (with the near-miss: what would change it) | requester | decision |
| Decisions | Execution failed | requester, `decision:execute` | decision |
| Decisions | Policy changed since it was planned, so it cannot be approved as is | requester, approver | decision |
| Workflows | A run failed | `workflow:read` | run |
| Workflows | A draft is waiting for review or publishing | `workflow:publish` | workflow |
| Agents | A definition is waiting for review or publishing | `agent:review`, `agent:publish` | catalog |
| Traces | An alert: cost, failures, blocked calls | `audit:read` | traces |
| Memory | A behaviour-changing memory waits for a supervisor | supervisor | (new page) |
| Host (later) | An approved action is stuck in `executing` and needs a person to resolve it | approver | action |
| Host (later) | Genesis: pending payment, commerce proposal, review | `finance:read` | genesis |
| Setup (admins) | No model provider, no OIDC users, a connector not connected | admin | settings |

Rules:

- Only items **you can act on** count toward the badge. Items you can only look at appear in a
  second, quieter group.
- A source that fails shows as "Could not check decisions" with a retry, and the badge shows a
  dot instead of a number. A silent zero is a bug.
- Order: severity, then age. The same list feeds every surface.

Surfaces, in the order they are built:

1. **Header bell** with a count and a dropdown. Polls about once a minute and when the tab
   regains focus. It is polling, not real time, and the dropdown says "Checked 12 s ago".
2. **Overview card**: "Needs your attention", the same list in full.
3. **Chat**: a `get_attention` tool, so "what needs me?" works, and the empty chat suggests
   "3 decisions are waiting for you" instead of fixed examples.
4. **Page banners**: a decision that is stale or refused says so at the top of its own page.
5. **Digest by email** (later). Sending is an outward effect, so it goes through the approved-actions
   path to a recipient allow-list, and needs a recipient list and an explicit go-ahead.

Other uses of the same list: a "waiting on" view for what you are blocking in someone else's
work, and an admin view of who has been waiting longest. Both are filters on the same data.

## Work packages

Each is its own PR, with tests and a rendered check (phone and desktop screenshots, as for the
mobile pass) before it is marked ready. "Rec" refers to the 13 recommendations from the review.

### A. Attention engine (small-medium)

- `apps/web/lib/attention.ts`: pure function from data and permissions to items. Unit tested with
  fixtures for every row of the table above, including "source failed".
- `GET /api/inbox` (`decision:read`): gathers sources through the existing read routes' loaders,
  filters by what the caller may act on, returns items and a per-source status.
- Chat tool `get_attention`. OpenAPI entry with a real schema. Doc.
- Done when: a viewer sees no approval items, an approver sees only decisions they did not
  request, and a failing source shows as unchecked.

### B. Front door and basics (medium)  — Rec 1, 2, 3, 4, 5

- **Rec 1**: `/sign-in` page. The organisation account is the main button; pasting a token moves
  under "Advanced". Every page redirects a signed-out visitor there. Add a status endpoint so a
  signed-out visit makes no 401 in the console.
- **Rec 2**: controls carry the permission they need. A control you cannot use is disabled with
  the reason. The chat's Plan mode is disabled with the reason when you lack `decision:propose`.
- **Rec 3**: error, not-found and loading pages; retry buttons on every failed load; "Updated
  3 min ago" on data pages; fix the empty `/decisions` call to action (it opens the chat).
- **Rec 4**: remove the pre-filled downtime objective, the seeded demo sign-ins and the demo banner
  from the real flow. Demo mode keeps them behind its own switch.
- **Rec 5 and step 2 of the chat plan**: `/decisions` becomes the approvals inbox with status tabs,
  sort, paging (the query currently has no limit), a link to one decision, the why panel, and the
  approve, reject, execute, observe and rollback buttons. Overview goes into the navigation.
- Header bell and overview card (surfaces 1 and 2).
- Done when: a person with the approver role can find, understand and approve a decision without
  opening the planning page.

### C. Agents only in chat (medium)  — step 3, Rec 6, 7

- Remove "Create plan" from `/planning` and send people to the chat; remove the workflow "Run"
  buttons and offer the same from chat; `/agents` stays a catalog and review screen.
  `/planning` redirects to `/decisions` once nothing is left on it.
- Published catalog agents become runnable from chat (today only the seven built-in specialists
  are).
- **Rec 6**: the chat knows the page it is opened from ("Explain this decision"), has a stop
  button and retry, and keeps the conversation when closed.
- **Rec 7**: the near-miss list gets "Try again with this change", which pre-fills the chat.
- Done when: no page has a control that calls a model, and the chat can start every agent action
  that used to live on a page.
- Needs your decision before it starts: whether `/planning` is deleted or kept as a redirect.

### D. Clearer words and progress (small-medium)  — Rec 8, 9

- **Rec 8**: planning shows its steps (planner, kernel, reviewer) as they finish instead of one
  spinner. This needs the plan route to report progress; the first version streams step names.
- **Rec 9**: a glossary tooltip on NQC, WAES, fingerprint and policy snapshot; risk 0 to 5 also as
  a word and a colour, never colour alone.

### E. Your account and the audit trail (small-medium)  — Rec 10, 11

- **Rec 10**: a page for you: name, roles, what you can do, sign-out, theme.
- **Rec 11**: download the audit trail for a decision or a date range, as JSON and as a
  readable page. This is the evidence an outside reviewer would ask for.

### F. Mobile, consistency, workflows (medium)  — Rec 12, 13

- **Rec 12**: bottom bar reaches Planning/Decisions and Agents; no text under 11px; one page
  layout and one set of styles; target sizes checked again.
- **Rec 13**: workflow starter templates; undo and redo in the editor.

## Order and what blocks what

1. Merge the open PRs first: memory (#52), OIDC sign-in (#53), chat reads the app (#54).
2. A, then B (B uses A for the bell and card).
3. C after B, because it removes the controls B replaces.
4. D, E and F can go in any order after B.

## Before building: watch one person

Thirty minutes with one real person trying to get a plan approved, narrated aloud, will show where
this plan is wrong faster than more reading of the code. Do this before B, while A is being built.

## Not in this plan

- Real-time push. The bell polls; real time needs a server push channel the serverless web app
  does not have.
- Email and push alerts (needs recipients, credentials and a go-ahead).
- The host's approved actions, Genesis, hosting and media in the web app. The web app does not talk
  to the host; connecting them is its own project.
- The recorded end-to-end run of an approved action, which still needs a real recipient, a second
  approver and credentials.

## How we will know it worked

- A new approver finds and approves a decision with no help (watch one).
- No page has a control that calls a model.
- A source that cannot be checked is visible every time; no test passes with a silent zero.
- Every control you cannot use says why before you press it.
