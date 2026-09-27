# Threat model

This is the security threat model for Nuera Quicksilver as the code stands on
2026-09-27 (repository version 0.4.0, with M4 to M7 built and waiting on their
evidence). Every mitigation below names the code that provides it and, where one
exists, the test that proves it. A claim without a test says so.

It is a working document, not a certification. Reread it at each milestone and
before any change in exposure (a public address, a second user, a customer).
The pass/fail list for the release gates is in [parity tests](parity-tests.md).

## Findings needing a fix

These are real defects, not hardening ideas. Each is small. F-1, F-2 and F-3
are **fixed** in commit `30b085e` on `work/security-fixes`; each row names the
tests that prove the fix.

| # | Severity | Where | What is wrong | Suggested fix |
|---|---|---|---|---|
| F-1 | Medium | `packages/kernel/src/triggers/webhook.ts`, lines 196–206 (`WebhookTrigger.receive`) | The signature covers `${timestamp}.${rawBody}` but not `X-Quicksilver-Delivery`. When a signature has already been seen and the request carries a delivery id, the code falls through to the idempotent enqueue, but the idempotency key is built from the **new** delivery id. Anyone who captures one signed delivery can replay it inside the ±5-minute window with a different delivery id and get a second run (or, for a task webhook, a second task). Checked with a scratch test outside the repo: the same signed body sent with delivery ids `evt_1` then `evt_attacker` returned 202 and 202, and the queue held 2 runs. The existing test `Webhook: a replayed signature without a delivery id is refused` only covers the no-header case. | Remember the delivery id with the signature in the replay cache (`remember(key, expiresAt, deliveryId)`), and return 409 when a seen signature arrives with a different delivery id. Or add a `v2` scheme that signs `${timestamp}.${deliveryId}.${rawBody}`. Add a test for the swapped-id replay, for both the run and the `deliver` (task) paths. **Fixed in `30b085e`:** the replay cache keeps the delivery id each signature was first seen with; a seen signature with a different delivery id, or with one added or dropped, is refused with 409 and nothing is enqueued or delivered. The exact resend (same signature, same delivery id) keeps its idempotent outcome. Senders must vary the body or timestamp per delivery (the same secret, second and body give the same signature). Tests: `triggers.test.ts` "ReplayCache: the first binding is kept and returned; a later one never overwrites it", "Webhook: a seen signature with a swapped delivery id is refused (F-1, run path)", "Webhook: a seen signature with a swapped delivery id never reaches the deliver sink (F-1, task path)". |
| F-2 | Medium (High once execution has real effects) | `apps/web/app/api/decisions/[id]/execute/route.ts`, line 142 (`POST`); also `observe/route.ts` line 33 and `resume/route.ts` line 40 | The execute route checks that a risky decision carries a bound supervisor approval, but it never authenticates the caller. RBAC defines `decision:execute` (held by `supervisor`), and nothing checks it. Anyone who can reach the web app can execute any approved decision at a time of their choosing, and can execute a decision that needs no approval (the process engine auto-approves low-risk ones) with no human involved at all. Execution is simulated today: it writes the decision's status, an `executionAudit` and a `metric` document. `observe` and `resume` also write with no caller check. | Call `verifySupervisorCredential(req, 'decision:execute')` before any read or write in `execute`, and record the principal as the executor in `executionAudit`. Require at least a valid principal (`decision:read` or `decision:propose`) for `observe` and `resume`. Add route tests for 401 and 403. **Fixed in `30b085e`:** `execute` runs the supervisor credential check with `decision:execute` (human only) before any read or write and records the principal as `executionAudit.executorId`; `observe` and `resume` require a principal with `decision:read` or `decision:propose`. The check is the pure helper `checkDecisionRouteCaller` in `apps/web/lib/nqc-approval.ts`. Tests (run by `seed:test`): `apps/web/lib/decision-route-auth.test.ts` "Decision routes: execute without a credential is 401 (F-2)", "Decision routes: execute with the wrong permission, a non-human or another tenant is 403 (F-2)", "Decision routes: execute by a human supervisor succeeds and names the executor (F-2)", "Decision routes: observe and resume need a principal with decision:read or decision:propose (F-2)", "Decision routes: without principals only the shared supervisor token is accepted; unconfigured fails closed". |
| F-3 | Low | `packages/host/src/intent-api.ts`, line 137 (`POST /api/intents/:id/answers`) | The answer is recorded with actor `{ id, kind: 'human' }` and provenance `HUMAN_SPECIFIED` whatever the principal's real kind. RBAC keeps `intent:provide` from agents but not from service principals, so a service principal configured with `intent-provider` would write values that the graph then treats as a human's own words, which only a human may change. The `dismiss` route next to it passes the real kind. | Refuse non-human principals with 403 (as the verdict, money and review routes do), or pass `principal.kind` and let `applyBeliefUpdate` refuse. Add a test with a service principal. **Fixed in `30b085e`:** non-human principals get 403 before anything is read or recorded. Test: `intent-api.test.ts` "a service principal cannot answer intent questions, even with intent-provider (F-3)". |

## 1. Scope and assumptions

**In scope**

- The single-tenant host (`packages/host`) as it runs today (M2): on the
  founder's computer, API on `127.0.0.1:8787` (local example config), file
  stores under `data/`, the secrets vault, the console at `/console`.
- Always-on hosting as documented for M5 ([always-on hosting](always-on-hosting.md)):
  Render or a VPS behind Caddy, Postgres run store, a public address for
  payment webhooks. Not deployed yet; treated as the next exposure.
- The web app (`apps/web`): the objective console, `/api/plan`, `/api/query`,
  the decision routes and the workflow routes.
- The task interface ([tasks](tasks.md)): HTTP API, the stdio MCP server,
  signed webhooks and the CLI.
- Sanity project `f87t11g1` (private `production` dataset). The legacy
  challenge project `d280bqjc` and its Context MCP endpoints are refused by
  the web app, the host stores and the agent package.
- Azure OpenAI models reached through `@quicksilver/agent`.
- The kernel, Aura, the playbooks (Onboard, Genesis, Operate) and their
  stores.

**Out of scope**

- The paused Sanity Challenge instance (synthetic, never connected to
  company data).
- The model provider's own security and the security of the founder's
  operating system, beyond the assumptions below.
- Physical attacks and legal process.

**Assumptions**

- One human operates the business today: the founder, configured as the
  sole operator where separation of duties allows it.
- The founder's OS account is trusted. Whoever can act as that account can
  read `.env`, the vault key and every file store, and can run the CLIs,
  which act as the founder without a token (see check 5 in section 4).
- Tokens are generated by the repository's tools (`npm run principal:token`,
  `npm run tasks -- client add`): 32 random bytes, stored only as SHA-256
  digests.
- Nothing moves money. The Genesis and Operate routes record money that has
  already moved; every response says `executed: false`.
- Tool steps are always blocked at run time on the host. The only agent that
  runs unattended is the read-only query agent.

## 2. Assets

| Asset | Where it lives | Why it matters |
|---|---|---|
| Money ledger (Genesis, Operate) | `data/genesis/<runId>/ledger.json`, `data/operate/<runId>/ledger.json`, or `moneyEntry` documents in Sanity | The 1.0.0 evidence requires every dollar to be traceable. Hash-chained (`packages/kernel/src/playbooks/economics.ts`, `appendMoney`, `verifyMoneyLedger`) |
| Payment-account secrets | Names only in `deploy/genesis/genesis-500.json` and `deploy/operate/operate-nuera.json` (`prerequisites.paymentAccounts`); values only in the vault | Card and payment access once Genesis starts |
| The secrets vault | One file (`vault.path`, for example `/data/vault.json`), AES-256-GCM; master key in `QUICKSILVER_VAULT_KEY` | Holds webhook signing secrets and, later, payment credentials |
| Intent ledger | `data/intent/ledger/<company>.intent-ledger.jsonl` or `intentLedgerEntry` documents | The founder's goals, weights, autonomy grants and hand-overs. Hash-chained; optional Ed25519 signatures (not enabled on the host) |
| Decision records and audit | Sanity `decision` documents (approval records, execution audits), `evaluationRecord` documents, run event logs, task audit trails | Accountability: who asked, who proposed, who approved, what ran |
| Policies and capabilities (the company model) | Sanity `policy`, `capability`, `entity` documents; `deploy/tasks/catalog.json` | They decide what the kernel allows |
| Shadow logs and the decision journal | `data/intent/onboard/<intentId>/shadow.json`, `learner.json`, `data/intent/decisions.jsonl`, `pending.json` | The founder's own judgments and reasons: personal business data, and the evidence for hand-over |
| Task client tokens | `data/tasks/clients.json` (digests only, mode 0600); the token itself sits in each client's config | A client token submits tasks and reads that client's results |
| Human principal tokens | `QUICKSILVER_PRINCIPALS` (digests only) | Approval, money recording, intent |
| Sanity tokens | `SANITY_AUTH_TOKEN` (Editor on the dataset), `SANITY_CONTEXT_TOKEN` (org-level Context Viewer), `SANITY_DEPLOY_TOKEN` (schema deploy) in `.env` | Editor can write every document, including approval records and policies |
| Model API keys | `AZURE_API_KEY` and related variables in `.env` | Cost; access to the provider account |
| IP boundary material | AMP patent material (never connected until PPA Rev 4.2 is filed); Forkling (frozen, read-only) | Premature disclosure of AMP harms the patent position; a write to Forkling breaks its freeze |

## 3. Actors and trust boundaries

```mermaid
flowchart LR
  subgraph TB1["TB1: the founder's computer (OS account is the root of trust)"]
    F([Founder: browser and CLIs])
    C["Host console /console"]
    H["Host process<br/>kernel, queue, worker, vault, API"]
    D[("data/: runs, intent, shadow,<br/>genesis, operate, tasks, vault file")]
    E[(".env: model keys, Sanity tokens,<br/>vault key, principals")]
    W["Web app (Next.js)<br/>/api/plan, /api/decisions"]
    M["MCP server (stdio)<br/>one client token"]
  end
  TC([Task clients: scripts, MCP hosts such as Claude])
  WS([Webhook senders])
  SUP([Supervisors and auditors])
  subgraph TB2["TB2: Sanity f87t11g1"]
    S[("private dataset")]
  end
  subgraph TB3["TB3: model provider"]
    A[("Azure OpenAI")]
  end
  subgraph TB4["TB4: future always-on host"]
    R["Render or VPS + Caddy<br/>Postgres, /data volume"]
  end
  F --> C --> H
  F --> W
  F -. "CLI acts as founder,<br/>no token" .-> D
  H --> D
  H -. reads .-> E
  W -. reads .-> E
  TC -- "bearer token" --> H
  TC --> M -- "bearer token" --> H
  WS -- "HMAC signature" --> H
  SUP -- "bearer token" --> W
  H -- "Editor token" --> S
  W -- "Editor token" --> S
  H -- "prompts with company data" --> A
  W -- "prompts with company data" --> A
  A -. "untrusted output (TB5)" .-> H
  A -. "untrusted output (TB5)" .-> W
  R -. "same code, public address" .- H
```

| Actor | Trust | Identity | What it can do |
|---|---|---|---|
| Founder (human) | Trusted | Human principal in `QUICKSILVER_PRINCIPALS` (`intent-provider`, often also `supervisor`); the OS account for CLIs | States intent, approves, records money, judges shadow recommendations, hands over departments. Configured as sole operator where needed |
| Supervisors and auditors | Trusted for their role | Human principals with `supervisor` or `auditor` | Approve, execute, roll back, redrive (supervisor); read audit (auditor) |
| Task clients | Semi-trusted service | Service principal `client:<name>` with only `task-client` | Submit tasks, read and cancel their own |
| Trigger services | Semi-trusted service | Service principal with only `trigger` | Enqueue configured runs, submit tasks through a task webhook |
| Agents and LLMs | Untrusted output | Registered agent ids (`nuera-quicksilver:*`); agent principals never hold authority | Propose. Their output is data |
| Webhook senders | Untrusted until verified | Endpoint HMAC secret | One delivery per signed request |
| Sanity | Trusted storage, shared credential | Editor and Viewer tokens | Stores the company model, decisions, evaluation records, optional Aura and Genesis records |
| Model provider | Trusted processor of prompts | API key | Receives prompts, returns completions |
| Local machine and OS | Root of trust at M2 | The founder's account | Everything |
| Future hosting provider | Trusted operator of the box | Platform account | Holds the `/data` volume, environment secrets and the database |

Trust boundaries:

- **TB1** the OS account. Everything inside it is equally trusted today.
- **TB2** host and web app to Sanity. One Editor token per process: Sanity
  sees the server, not the human.
- **TB3** host and web app to the model provider. Company data leaves the
  machine in prompts.
- **TB4** always-on hosting. The same code with a public address.
- **TB5** model output back into the system. Model output never carries
  authority; the kernel re-derives every decision.
- The network edge of the host (bearer tokens, HMAC) and of the web app
  (mostly none; see T-28; the decision execute, observe and resume routes require a principal since F-2 was fixed).

## 4. Answers to the specific checks

| # | Check | Answer | Evidence |
|---|---|---|---|
| 1 | Are all host API routes authenticated and RBAC-checked? | **Yes.** `dispatch()` authenticates every path under `/api` before any route runs, and returns 401 without a valid token. Each route then checks its permission: runs, dead letters, stats, schedules, webhooks and workflows with `this.authorize`; enqueue, cancel and redrive inside `WorkflowRunQueue` (its `access` option); secrets inside the vault; intents, shadow, decisions, Genesis and tasks in their handlers; `POST /api/intent-ledger/:company` inside Aura's `recordChange`. Unauthenticated by design: `/healthz`, `/readyz`, `/console` (a static page, no data), `/webhooks/:id` (HMAC), and `/metrics` only when `metricsPublic` is set. One route is worth knowing: `POST /api/genesis/experiments/:id/evaluate` needs only `decision:read`, yet it can apply a kill or close (stopping never needs permission, by design). | `packages/host/src/host.ts` lines 399–401 (`dispatch`), `authorize`, `require`; `host.test.ts` "health and readiness need no token; the management API does" |
| 2 | Routes without a test for auth failure | 401 is tested explicitly for `/api/runs`, `/metrics`, `/api/genesis`, `/api/decisions`, `/api/tasks`, and a bad webhook signature. **Not tested for 401:** `/api/whoami`, `/api/runs/:id`, `/api/dead-letters`, `/api/stats`, `/api/schedules`, `/api/webhooks`, `/api/workflows`, `/api/secrets` (GET), `/api/intents*`, `/api/intent-ledger/*`, `/api/shadow/*`. **Not tested for 403:** `GET /api/runs/:id`, `/api/dead-letters`, `/api/stats`, `/api/schedules`, `/api/webhooks`, `/api/workflows`, `GET /api/intent-ledger/:company`. The central gate covers them today; the risk is a later regression. **The web app has no tests at all**, so none of its routes has an auth test. | Grep of `401`/`403` assertions in `packages/host/src/*.test.ts`; `apps/web` contains no test files |
| 3 | Is the web app's plan/execute/approval path authenticated, and as whom does it run? | **Partly.** `POST /api/plan` accepts no token: the requester is recorded as `console:anonymous`, and a token, when sent, must be valid (`identifyRequester`). It calls the planner and reviewer models and writes decision documents. With `QUICKSILVER_PROCESS_ENGINE=on`, low-risk decisions are auto-approved by the kernel with no human. Approve, reject, request-evidence and rollback require `verifySupervisorCredential` (a per-person hashed token with `decision:approve` or `decision:rollback`, human, in `QUICKSILVER_TENANT_ID`; or the interim shared `NQC_SUPERVISOR_TOKEN`). Execute requires `decision:execute` (human) and records the executor; observe and resume require a principal with `decision:read` or `decision:propose` (F-2, fixed in `30b085e`). Every Sanity read and write runs as the server's `SANITY_AUTH_TOKEN` (Editor); the human is recorded only in fields (`requestedBy`, `approvedBy`, `approvalRecord.supervisorId`). | `apps/web/lib/nqc-approval.ts` (`identifyRequester`, `verifySupervisorCredential`); `apps/web/app/api/plan/route.ts`; `apps/web/app/api/decisions/[id]/*/route.ts` |
| 4 | Are approvals bound to decision content (hashes) everywhere approvals exist? | **Supervisor approval (web):** yes, partly. The approval stores `decisionActionFingerprint` over decision id, `selectedAction`, policy snapshot digest, risk and `requiredApproval`; execute recomputes it and the live policy snapshot, and checks the approver is still a human allowed by the current policies. Gaps: the server computes the fingerprint when the supervisor clicks, and the client never sends the fingerprint it displayed, so a change between viewing and approving is approved silently; the fingerprint leaves out evidence ids, actor, capability and financial exposure; no test. **Tasks:** yes. `requestHash` and `decisionHash` are stored with the approval and recomputed before enqueue; request fields are immutable in the store. Same caveat that the approver does not echo the hash. **Genesis and Operate money:** the founder's `confirm: true` is part of the same request, and the spend decision is recomputed under the per-run lock, so what is confirmed is what is recorded. But the ledger entry does not record the decision or the confirmation (only the response does). **Genesis `decide`:** not bound: it applies the verdict current at that moment, which can differ from the one the founder saw if a measurement arrived in between. **Experiment start and playbook publishing:** bound by pinned digests. **WAES and manual reviews:** bound to the content digest. **Operate plan approval:** the approved plan's amounts are stored in the record. | `apps/web/lib/nqc-approval.ts` `decisionActionFingerprint`; `execute/route.ts`; `packages/host/src/tasks.ts` `approve`, `runApproved`, `requestHash`, `decisionHash` (test: "a request or decision changed after approval is refused, not run"); `genesis-api.ts` money and `decide`; `playbook.test.ts` "publishing needs a human supervisor who is not the author, and pins the digest"; `genesis-reviews.test.ts` "a manual review is bound to the exact text, marked manual, and made only by a human" |
| 5 | Are append-only stores really append-only against a local attacker? | **No, and they cannot be at M2.** They are files on the founder's disk (mode 0600) or Sanity documents written with the Editor token. Append-only is enforced by the code that writes them (`checkAppendOnly` for tasks, `createIfNotExists` and revision checks for Sanity, chain verification on load), not by the OS or a third party. Anyone who can act as the founder's user can rewrite or delete them. The money and intent ledgers are hash chains **without a key**, so someone who can run the code can recompute a consistent chain after an edit; removing the newest entries leaves a valid chain; the intent ledger supports Ed25519 signatures, but the host never passes a signing key. Shadow logs, the decision journal, task files and review files have no chain at all. The vault is encrypted with AES-256-GCM and authenticated associated data, but its key sits in the same `.env` on the same disk. The CLIs act as the founder with no token: "whoever holds these files runs the business" ([tasks](tasks.md#5-cli)). What this means: the stores are tamper-**evident** against accidents and naive edits, and they make every change attributable in normal use. They are not tamper-**proof** against the founder's own account or malware running as it. | `packages/host/src/tasks.ts` `checkAppendOnly`; `packages/aura/src/store.ts` `loadLedger`; `packages/kernel/src/playbooks/economics.ts` `verifyMoneyLedger`; `packages/aura/src/ledger.ts` `signingKey` (unused by `packages/host/src/main.ts`) |
| 6 | Are secrets ever logged? | **Not by the host's own code paths that were found.** The host logger redacts values under sensitive keys, credential-shaped strings (`qs_…`, `whsec_…`, `sk-…`, `Bearer …`) and every webhook secret it resolved from the vault or environment. Gaps: model keys (Azure keys are not `sk-` shaped) and the Sanity tokens are never registered with `redactValue`, and Sanity tokens do not match the `sk-` pattern, so they are redacted only when they appear under a sensitive key. The host logs provider and store error messages (`request failed`, `evaluation audit write failed`); those do not normally contain keys, but nothing guarantees it. The web app logs whole error objects with `console.error` and returns `err.message` to the caller from `/api/plan` and `/api/query`, with no redaction. Intended one-time prints: `npm run tasks -- client add` (the new token), `npm run host -- vault keygen` (a new master key), `npm run principal:token` (a new token). The grep of logging calls found no other call that prints a token, key or secret field. | `packages/host/src/log.ts` (`redact`, `redactValue`, `CREDENTIAL_VALUE`); `observability.test.ts` "secrets are redacted by key, by credential shape, and by registered value"; `host.ts` `resolveSecret` |
| 7 | Rate limits beyond tasks? | **None.** The only rate limit is the per-principal token bucket on task submission (`TokenBucketLimiter`, burst 10, 30 a minute; in memory, reset on restart). The run queue has backpressure (1,000 queued overall, 100 per tenant, 4 running per tenant), which a webhook sender sees as 429. Nothing limits the routes that call a model (`POST /api/intents` with the model parser, `POST /api/shadow/:id/generate`, `POST /api/runs`), the other host routes, or any web route (`/api/plan`, `/api/query`, `/api/workflows/run`, which are also anonymous). | `packages/host/src/tasks.ts` `TokenBucketLimiter`; `tasks.test.ts` "rate limit: a per-client token bucket, with consistent JSON errors"; `runtime.test.ts` "Queue: global and per-tenant backpressure reject new work instead of growing unbounded" |
| 8 | Webhook signature verification and replay protection | HMAC-SHA256 over `${timestamp}.${rawBody}`, constant-time comparison, ±300 s tolerance, one generic 401 message, at most 5 signatures per header, secrets of 32+ characters, size and content-type checked first, rotation with several secrets. Replay: an in-memory cache refuses a repeated signature without a delivery id (409); with a delivery id, a retry maps to the same run, and a seen signature under a different delivery id is refused (409). **F-1 fixed in `30b085e`.** The replay cache is per process (documented; one host per tenant is the supported shape). A missing webhook secret stops startup. | `packages/kernel/src/triggers/webhook.ts`; `triggers.test.ts` webhook tests; `host.test.ts` "a webhook whose vault secret is missing stops startup (fail closed)" |
| 9 | CSRF and CORS on the host HTTP server | **Host: sound for its model.** No CORS headers are sent, so browsers block cross-origin reads. Authentication is a bearer header only (no cookies), so a cross-site request carries no credential. `readJson` requires `Content-Type: application/json`, so a cross-site form or `text/plain` post gets 415. The console sends `frame-ancestors 'none'`, `connect-src 'self'`, `form-action 'none'` and renders data with `textContent` only. The `Host` header is not checked, so DNS rebinding can reach the unauthenticated routes (health, readiness, the static console), nothing more. **Web app: not sound.** Route handlers parse JSON without checking the content type, and several state-changing routes need no credential, so any page the founder visits can post `text/plain` bodies to `http://localhost:3000/api/plan` (model spend and Sanity writes) or to `execute` for a guessable decision id (`decision-plan-<base36 time>-<n>`). Browser private-network protections may block some of these requests; do not rely on them. | `packages/host/src/host.ts` `readJson`, `CONSOLE_HEADERS`; `shadow-api.test.ts` "the console page is served without data, with a strict content policy"; `apps/web/app/api/plan/route.ts` (`req.json()`) |
| 10 | Request size limits | **Host:** `readBody` enforces the declared length and the streamed length. Defaults: `http.maxBodyBytes` 256 KiB (configurable 1 KiB–4 MiB); task routes, cancel and redrive 16 KiB; `PUT /api/secrets/:name` 80 KB; webhooks the larger of `maxBodyBytes` and 256 KiB, then the endpoint's own limit. `requestTimeout` 30 s, `headersTimeout` 15 s. Run input at most 256 KiB; task objective 2,000 characters, inputs 8 KB and depth 6. **Web:** the workflow routes cap at 256 KiB but read the whole body before counting when no `Content-Length` is sent; `/api/plan` validates the objective (3–2,000 characters) only after `req.json()` has read an unbounded body; `/api/query` has no length limit on `question`; the approval `comment` has no maximum. | `host.ts` `readBody`, `readJson`; `config.ts` (`maxBodyBytes`); `packages/host/src/tasks.ts` `TASK_LIMITS`; `tasks.test.ts` "validation: size and fields"; `apps/web/app/api/query/route.ts` line 23 |
| 11 | Path traversal in ids used for file paths | **None found.** Every id that becomes part of a path is checked against a pattern before `join`: intent graph ids (`GRAPH_ID`, `packages/aura/src/store.ts`), company ids (`COMPANY_ID`), shadow intent ids (`ID`, `shadow-api.ts`), task ids (`TASK_ID`, `tasks.ts`), the Genesis run id (`RUN_ID`, from config). Vault names are keys inside one file. Run ids, experiment ids and recommendation ids are looked up, not joined into paths. GROQ queries are parameterized. The CLIs read any file path the founder passes (`onboard connect`, `genesis review`); that is a trusted input. | Patterns cited; `model-document.test.ts` "Queries are parameterized and project the M7 fields"; `store.test.ts` "Sanity ids keep intent out of public reads and reject unsafe company ids" |
| 12 | Sanity token scope | `SANITY_AUTH_TOKEN` is an Editor token: read and write on every document in the private dataset. The web app and the host stores use it. `SANITY_CONTEXT_TOKEN` is the org-level Context Viewer token used by the agents' MCP calls (read). Schema deploy uses a separate `SANITY_DEPLOY_TOKEN` or the founder's own login. The legacy project is refused in the web app (`getDedicatedSanityProjectId`), the host stores (`LEGACY_CHALLENGE_PROJECT_ID`) and the agent package (legacy endpoint names and knowledge base id). Consequences: whoever holds the Editor token can write `approvalRecord`, `approvedBy`, policies and capabilities directly, bypassing every route; "read-only in Studio" schemas are a Studio UI setting, not access control; the query agent can read any document in the dataset and surface it to whoever runs a query workflow. | [sanity-isolation.md](sanity-isolation.md); `apps/web/lib/sanity-config.ts`; `packages/host/src/sanity-client.ts`; `packages/agent/src/mcp.ts`; `sanity-stores.test.ts` "the legacy challenge project is refused by every Sanity store and by the env config"; `contracts.test.ts` "the paused challenge project's Context MCP endpoints and knowledge base are refused" |
| 13 | Model output schema validation | Every model call asks for structured output against a zod schema (planner, reviewer, query agent, shadow agent, intent parser), with strict schemas (`schemas.test.ts` "Strict output: … lists every property as required"). `executeGovernedAgent` checks the result shape and runs the NQC evaluation on every agent result. The kernel then resolves actor, capability, policies and evidence from Sanity itself; an action whose actor or capability does not resolve gets no decision. Shadow proposals are validated again (`validateProposal`) and citations that are not in the intent graph are dropped. The model intent parser keeps only values whose quote appears in the objective and can never grant autonomy. **Not validated against anything but the schema:** the planner's own risk inputs (`operationalImpact`, `uncertainty`, `reversible`, `financialExposure`), which feed the kernel's risk calculation (T-40). | `packages/agent/src/contracts.ts` `executeGovernedAgent`; `contracts.test.ts` "a governed run with a stub worker returns an NQC evaluation"; `shadow-agent.test.ts` "proposals keep only citations that exist in the graph; uncited proposals are dropped"; `aura.test.ts` "production parser: the model's parse, except it can never grant acting alone" |
| 14 | What happens if the model returns something invalid? | It fails closed everywhere found. Planner: `generateText` throws, `/api/plan` returns 500 and persists nothing (it does return the error message). Reviewer: falls back to "unreviewed"; it is advisory only. Query agent in a workflow: the step fails; a missing or malformed evaluation fails the run. Host agent steps with no provider configured fail closed. Shadow generate: a thrown error is a 502; invalid proposals are refused with reasons and valid ones are still judged by the kernel. Intent parser (model mode): no structured output throws, and the intent is not created. | `workflows.test.ts` "Runtime: missing or malformed evaluator output fails closed"; `host.test.ts` "agent steps fail closed when no model provider is configured"; `shadow-api.test.ts` "the shadow-stage agent proposes; departments it was not asked about are refused" |

## 5. Threats by component (STRIDE)

Residual risk is judged for today's exposure (the founder's computer) unless
the row says otherwise. "Gap" names the action from section 8.

### 5.1 Host HTTP API and console

| ID | STRIDE | Threat | Where | Existing mitigation (code; test) | Residual | Gap / action |
|---|---|---|---|---|---|---|
| T-01 | S | A stolen or guessed bearer token | `host.ts` `authenticate` | 32-byte random tokens, SHA-256 digests only, constant-time comparison over every entry, shared and duplicate tokens refused (`packages/kernel/src/identity/tokens.ts` `StaticTokenIdentityProvider`; `identity.test.ts` "Tokens: only digests are stored; authentication is exact and returns a copy", "Tokens: disabled principals, shared tokens, duplicates, and bad digests are refused"). The console keeps the token in `sessionStorage` for one tab | Low | Tokens never expire and have no rotation schedule; SSO/OIDC is planned before 0.9.0 (B-1) |
| T-02 | E | A principal from another tenant acts on this host | `host.ts` constructor | Refused at startup (`host.test.ts` "the host serves exactly one tenant"); RBAC tenant isolation (`identity.test.ts` "RBAC: tenants are hard boundaries, even for supervisors and admins") | Low | Multi-tenant tests before 0.9.0 (B-14) |
| T-03 | E | A new route forgets its permission check | `host.ts` `dispatch` | Central authentication gate for `/api`; per-route `authorize` | Low | Table-driven 401/403 test over every route (A-9) |
| T-04 | E, T | An operator enqueues an arbitrary or effectful graph | `POST /api/runs` | Only configured workflows; `checkWorkflow` enforces the execution policy; tool steps blocked at run time (`config.test.ts` "checkWorkflow accepts query agents by short or full id and caps agent steps"; `host.test.ts` "tool steps are blocked on the host and never dispatched") | Low | — |
| T-05 | D | Flooding, large bodies, slow clients | All routes | Body limits, `requestTimeout` and `headersTimeout`, queue backpressure, bounded metric labels (`observability.test.ts` "the standard host metric set registers once per registry") | Medium; High when public | Per-principal rate limits on every write and model-calling route (A-5) |
| T-06 | I | Metrics reveal workflow names and volumes | `GET /metrics` | `audit:read` unless `metricsPublic` (`host.test.ts` "metrics need audit:read unless configured public") | Low | Keep `metricsPublic` off when hosted |
| T-07 | I | Error details leak internals | `host.ts` `handle` | Uncaught errors return `{ error: 'Internal error.' }`; details go to the log | Low | — |
| T-08 | S, E | The host listens on every interface | `config.ts` line 156 | The local example sets `127.0.0.1`; Compose publishes on `127.0.0.1` only. A config without `http.host` binds `127.0.0.1`; `0.0.0.0` must be set explicitly (`config.test.ts` "the host binds to loopback by default; a public bind must be explicit (A-4)") | Low | **A-4 fixed in `30b085e`** |
| T-09 | T, I | Script injection in the console steals the token | `packages/host/src/console.html` | CSP with `connect-src 'self'`, `frame-ancestors 'none'`; all data rendered with `textContent` (no `innerHTML`) (`shadow-api.test.ts` "the console page is served without data, with a strict content policy") | Low | CSP still allows inline script; move to a nonce if the page grows |
| T-10 | R | An action cannot be attributed later | Access decisions | Every access decision reaches the audit sink; the host logs denials; run events record actors (`identity.test.ts` "RBAC: every decision reaches the audit sink, and a failing sink changes nothing") | Medium | The access audit is only stdout logs; durable access-audit store (B-2) |

### 5.2 Webhooks and triggers

| ID | STRIDE | Threat | Where | Existing mitigation (code; test) | Residual | Gap / action |
|---|---|---|---|---|---|---|
| T-11 | S | A forged delivery | `webhook.ts` `receive` | HMAC-SHA256, constant time, timestamp window, generic 401 (`triggers.test.ts` "Webhook: bad signatures, wrong secrets, stale or future timestamps are rejected with one generic error") | Low | — |
| T-12 | T, R | A captured delivery is replayed | `webhook.ts` lines 196–206 | Replay cache for repeated signatures without a delivery id, and for a seen signature under a different delivery id (`triggers.test.ts` "Webhook: a replayed signature without a delivery id is refused", "Webhook: a seen signature with a swapped delivery id is refused (F-1, run path)", "Webhook: a seen signature with a swapped delivery id never reaches the deliver sink (F-1, task path)") | Low | **F-1 fixed in `30b085e`** (A-1) |
| T-13 | D | Delivery floods | `/webhooks/:id` | Size limit before verification, cheap 404/401, queue backpressure as 429 (`triggers.test.ts` "Webhook: RBAC and backpressure surface as 403 and 429") | Medium when public | Rate limit per endpoint and per source address at the proxy (A-5) |
| T-14 | E | The payload picks the capability or department | Task webhooks | The host config fixes both (`tasks.test.ts` "webhooks: a signed delivery becomes a task through the same intake; the payload cannot pick the capability") | Low | — |
| T-15 | E | A trigger identity holds more than `trigger` | `config.ts` | Startup refuses it (`config.test.ts` "trigger identities must hold only the trigger role") | Low | — |
| T-16 | I | A webhook secret is written into the config | `config.ts` `SECRET_REF` | Only `vault:` and `env:` references (`config.test.ts` "secrets can only be references, never inline values") | Low | Use `vault:` only for public endpoints (A-6) |
| T-17 | D, S | The host serves an endpoint it cannot verify | `host.ts` `start` | A missing secret stops startup (`host.test.ts` "a webhook whose vault secret is missing stops startup (fail closed)") | Low | — |
| T-18 | T | A cron slot runs twice | `cron.ts` | Idempotency key per slot (`triggers.test.ts` "Scheduler: replicas and restarts never duplicate a slot (idempotency key per slot)") | Low | — |

### 5.3 Task interface (API, MCP, webhook, CLI)

| ID | STRIDE | Threat | Where | Existing mitigation (code; test) | Residual | Gap / action |
|---|---|---|---|---|---|---|
| T-19 | S | A client token leaks from the client's config | `task-clients.ts` | Digest-only storage, one token per client, revocation takes effect on the next request (`tasks.test.ts` "client tokens are stored hashed and shown once (registry and CLI)") | Medium | The token sits in plain text in the MCP host's config file; add expiry and rotation (B-1) |
| T-20 | E | A client (or the model behind it) approves its own task | `tasks.ts` `approve`, `assertDecider` | `task-client` has no `task:approve`; the approver must be human and not the submitter (`tasks.test.ts` "a task client cannot approve, deny, or read another client's tasks; humans approve and the submitter never counts"; `identity.test.ts` "RBAC: task clients may only submit tasks and read their own; the founder decides tasks; agents never do"; `mcp-tasks.test.ts` "the tools: five, none approves, and each says the kernel decides and a human approves in the console") | Low | — |
| T-21 | E | Instructions in the objective or inputs change permissions or status | `tasks.ts` `intake` | Risk inputs come from the catalog; text is data (`tasks.test.ts` "injection text in the objective or inputs changes neither permissions nor status") | Low for authority | Downstream model effects: L-01 |
| T-22 | D | Task floods, or slow reads as the store grows | `tasks.ts` `submit`, `list` | Token bucket per principal (`tasks.test.ts` "rate limit: a per-client token bucket, with consistent JSON errors") | Medium over time | Every idempotent submit and every list reads all task files; add an index (B-12) |
| T-23 | I | A client reads another client's task, or company data through results | `tasks.ts` `get`, `list` | Another client's task is a 404 (`mcp-tasks.test.ts` "MCP carries the client's own authority only: bad tokens fail, other clients' tasks stay hidden") | Medium | A `reports.brief` task returns what the query agent reads from Sanity; the catalog is the only scope control. Classify which capabilities a client may use (B-15) |
| T-24 | T | A task is edited after approval | `tasks.ts` `checkAppendOnly`, `runApproved` | Immutable request fields, append-only audit, hash re-check before the run (`tasks.test.ts` "the file store is append-only, atomic and private", "a request or decision changed after approval is refused, not run") | Low in code; see check 5 for a local attacker | — |
| T-25 | I, E | AMP material enters, or Forkling is changed | `task-boundaries.ts` `checkTaskBoundaries` | Pattern boundaries before the kernel (`tasks.test.ts` "boundaries: AMP patent material and writes to frozen Forkling are refused before the kernel") | Low to Medium | The boundary matches words, so a disguised reference passes it. AMP material is not connected anywhere, which is the real control. Keep it that way until PPA Rev 4.2 is filed |
| T-26 | S, I | The MCP server sends the token over plain HTTP | `mcp-tasks.ts` `checkHostUrl` | https required unless loopback (`mcp-tasks.test.ts` "the stdio server: a real process, token from the environment, stdout only MCP", which asserts `checkHostUrl`) | Low | — |
| T-27 | R | The channel label is spoofed | `host.ts` (`X-Quicksilver-Task-Source`) | The header can only say `api` or `mcp`, and it grants nothing | Low | Do not use `source` as audit evidence of the caller; the principal is |

### 5.4 Web app (`apps/web`)

| ID | STRIDE | Threat | Where | Existing mitigation (code; test) | Residual | Gap / action |
|---|---|---|---|---|---|---|
| T-28 | S, E, D | Anyone who can reach the app creates decisions and spends model money | `/api/plan`, `/api/query`, `/api/workflows/run` | A token, when sent, must be valid; live workflow runs are off unless `QUICKSILVER_WORKFLOW_LIVE_RUNS=on` | Medium locally (Next.js listens on every interface unless started with `-H`); **High** if deployed | Require a principal off loopback, bind to `127.0.0.1`, rate-limit (A-3, A-5) |
| T-29 | E | Unauthenticated execute, observe, resume | `decisions/[id]/*/route.ts` | Risky decisions need a bound supervisor approval before execute; execute requires `decision:execute` (human) and records the executor; observe and resume require `decision:read` or `decision:propose` (`decision-route-auth.test.ts`, all) | Low | **F-2 fixed in `30b085e`** (A-2) |
| T-30 | T | Cross-site request forgery against the anonymous routes | All `POST` routes | None (see check 9) | Medium | Require `application/json` and check `Origin` (A-3) |
| T-31 | S, E | Supervisor approval with a weak credential | `nqc-approval.ts` `verifySupervisorCredential` | Per-person hashed tokens with RBAC and tenant; human only; separation of duties (`separation.test.ts` all); the policy snapshot must be current | Medium | The interim shared `NQC_SUPERVISOR_TOKEN` still works when `QUICKSILVER_PRINCIPALS` is unset; no route tests (A-9); remove the fallback with SSO (B-1) |
| T-32 | D | Unbounded bodies and fields | `/api/query` `question`, approval `comment`, `/api/plan` body | Objective length checked after parsing | Medium | Byte caps before parsing and field maximums (B-11) |
| T-33 | I | Internal error messages returned to callers | `plan/route.ts`, `query/route.ts` (`detail: err.message`) | — | Low | Return a generic message; log the detail with redaction (B-8) |
| T-34 | E | Fault injection or live workflow runs left on in a shared deployment | `execute/route.ts` (`QUICKSILVER_ALLOW_FAULT_INJECTION`), `workflows/run/route.ts` | Both off by default; injected outcomes are stamped `faultInjection`; with `NODE_ENV=production` the host (`main.ts`) and the web app (`instrumentation.ts`) refuse to start with either flag on, and both routes treat the flags as off (`config.test.ts` "development-only switches stop the host in production (A-10)", "the host process refuses to start with a development-only switch on in production (A-10)") | Low | **A-10 fixed in `30b085e`** |

### 5.5 Kernel and approvals

| ID | STRIDE | Threat | Where | Existing mitigation (code; test) | Residual | Gap / action |
|---|---|---|---|---|---|---|
| T-35 | E | An agent approves, executes or reads secrets | `identity/rbac.ts` `AUTHORITY_PERMISSIONS` | Agents never hold authority (`identity.test.ts` "RBAC: agents never gain authority, even if a role would grant it"; `nqc.test.ts` "AgentRegistry: agents can never hold approval authority"; `process.test.ts` "Lifecycle: approving needs a human; an agent is refused with a reason") | Low | — |
| T-36 | T | The action changes between approval and execution | Web fingerprint, task hashes, digests | See check 4 | Medium | The approver echoes the hash they saw; widen the web fingerprint; bind Genesis `decide` (B-3) |
| T-37 | E | A policy is loosened by priority, scope or supersession | `authority.ts`, `approval.ts` `authorize` | Loosening goes to a human; cycles go to a human (`policy-versioning.test.ts` "Scopes: a more specific scope can never silently loosen an ancestor (deny → human)", "Cycle: two live candidates superseding each other route to a human, and neither is picked"; `authority.test.ts` "Structured: priority can never silently loosen a stricter policy") | Low | — |
| T-38 | E | An invalid capability graph grants too much | `capability-graph.ts` | Fail closed for the affected capability; inheritance never grants (`capability-graph.test.ts` "Fail closed: authorize() refuses a capability whose graph is invalid, but not an unrelated one", "Inheritance never grants: holding the parent does not allow the child, nor the child the parent") | Low | — |
| T-39 | R | The sole-operator override hides a conflict | `identity/separation.ts` | A 20+ character justification, stamped on the record (`separation.test.ts` "Separation: a sole operator may override only with a written justification") | Low | — |
| T-40 | E, T | The model sets the risk inputs the kernel uses | `apps/web/app/api/plan/route.ts` (the planner's `operationalImpact`, `uncertainty`, `reversible`, `financialExposure`) | Base risk comes from the capability document; evidence must resolve in Sanity; policies fail closed on missing facts (`authority.test.ts` "Fail-closed conditions: restrictive policy with a missing fact still applies"); the planner run's evaluation can only tighten (`nqc.test.ts` "Upstream escalation: an escalated planner turns ALLOW into human review") | Medium | A planner that reports `financialExposure: 0` sidesteps "Budget 3 fails closed when exposure is unknown". Treat model risk inputs as a floor over catalog values, and a zero exposure as unknown (B-7). The task interface already takes these from the catalog |
| T-41 | E | Low-risk decisions run with no human | Process engine (`QUICKSILVER_PROCESS_ENGINE`) | By design, and only at risk the content allows (`process.test.ts` "Lifecycle: low-risk diagnostics is auto-approved by the kernel, no human click", "Lifecycle: the autonomy ceiling in content beats loosened env thresholds") | Low while execution is simulated | Revisit when execution has effects |

### 5.6 Aura, intent ledger, shadow logs and journal

| ID | STRIDE | Threat | Where | Existing mitigation (code; test) | Residual | Gap / action |
|---|---|---|---|---|---|---|
| T-42 | T | The intent ledger is edited on disk | `aura/src/store.ts` `loadLedger` | Chain verified on every load (`store.test.ts` "a ledger file edited behind Aura's back is refused on load"; `ledger.test.ts` "the ledger is tamper-evident, and signatures prove who kept it") | Medium locally | Unkeyed chain, no signatures on the host, truncation undetected; sign and anchor the head (B-5) |
| T-43 | E | An admin or agent shapes intent | `aura/src/ledger.ts` | Provider rules through kernel RBAC (`ledger.test.ts` "only providers shape intent; admins set rules only; agents do neither"; `intent-api.test.ts` "the intent ledger over HTTP: providers shape intent, admins set rules only, every entry verifies") | Low | — |
| T-44 | S | A service principal's answer is recorded as a human's | `intent-api.ts` (`POST /api/intents/:id/answers`) | Non-human principals get 403 (`intent-api.test.ts` "a service principal cannot answer intent questions, even with intent-provider (F-3)") | Low | **F-3 fixed in `30b085e`** (B-13) |
| T-45 | T | Shadow verdicts or the journal are rewritten | `shadow-api.ts` `FileShadowStore`, `aura/src/decisions.ts` | Append-only in code; Sanity refuses a rewritten verdict (`sanity-stores.test.ts` "a verdict (or outcome) once stored is never rewritten or removed"; `decisions.test.ts` "stores are append-only; the file store survives reloads and refuses duplicate ids"); only humans judge (`shadow.test.ts` "nothing in shadow mode executes, and only a human judges") | Medium locally | No chain on these files; hand-over evidence rests on them. Chain them like the ledgers (B-5) |
| T-46 | I | Credentials or personal data enter memory | `aura/src/belief.ts`, `kernel/src/nqc/memory.ts` | The memory governor refuses them (`aura.test.ts` "beliefs: an inference cannot replace an observation, and the memory governor refuses personal data"; `nqc.test.ts` "Memory: secrets, SSNs, and card numbers are refused") | Low | — |

### 5.7 Money (Genesis and Operate)

| ID | STRIDE | Threat | Where | Existing mitigation (code; test) | Residual | Gap / action |
|---|---|---|---|---|---|---|
| T-47 | T | Ledger entries are altered | `economics.ts` `verifyMoneyLedger` | Chain verified on read; a broken chain stops recording (`genesis-api.test.ts` "the ledger is verified on read, and a broken chain stops further recording"; `sanity-stores.test.ts` "money ledger: an entry edited behind the store's back fails verification on load", "money ledger: a seq that is already taken is a conflict, never an overwrite") | Medium locally | Unkeyed chain and truncation (B-5) |
| T-48 | E | An agent records money or starts an experiment | `genesis-api.ts` `humanOnly` | Human with `intent:provide` only (`genesis-api.test.ts` "permissions: read needs decision:read; drafting takes a provider or an agent; starting and money need a human provider"; `economics.test.ts` "experiments: a human starts them, thresholds are pinned, kill applies on its own, scale needs a human") | Low | — |
| T-49 | R | A founder-confirmed spend is not traceable to its decision | `appendMoney` | The response carries the decision; `recordedBy` is stored | Medium | Store the spend decision and the confirmation in the entry (B-4) |
| T-50 | E | Overspend or a prohibited category | `genesis.ts` `decideSpend` | Refused or sent to the founder (`economics.test.ts` "spend decisions: small experiment spend runs, larger spend asks the founder, prohibited or over-cap is refused"; `operate.test.ts` "spend: experiment spend is refused over the pool; business spend always needs the founder") | Low | — |
| T-51 | T | Money moves outside Quicksilver and is never recorded | Process | Every entry needs a source; nothing moves money | Medium | Reconcile against processor statements (C-3) |
| T-52 | I | Payment credentials exposed | Vault, `genesisBlockers` | Only names in config; blockers check names; the API never returns values (`host.test.ts` "secrets: admins write, values are never returned, rotation keeps the old secret during grace") | Low | — |
| T-53 | T | The founder decides on a verdict that changed | `genesis-api.ts` `decide` | — | Medium | Bind `decide` to the evaluation the founder saw (B-3) |
| T-54 | E | Customer-facing text ships without review | `kernel/src/waes.ts`, `authorize()` | Exact-content digest, reviewer is not the proposer, manual reviews labeled and allowed only by run config (`economics.test.ts` "WAES gate: customer-facing actions are hard-blocked without a passing review of the exact content"; `genesis-reviews.test.ts` "the gate: a manual pass unlocks the exact text only when the run allows it, and never for the reviewer as proposer") | Medium | A manual founder review is not a WAES evaluation; WAES as a service (C-2) |

### 5.8 Vault and secrets

| ID | STRIDE | Threat | Where | Existing mitigation (code; test) | Residual | Gap / action |
|---|---|---|---|---|---|---|
| T-55 | I | The vault file leaks (backup, copy) | `vault.ts` `SecretsVault` | AES-256-GCM; tenant, name and version as associated data; wrong key or tamper fails closed (`vault.test.ts` "values are encrypted at rest and round-trip for authorized principals", "the vault fails closed on a wrong key, another tenant, tampering, or a disabled secret") | Low alone; **High** if the key leaks with it | The key sits in `.env` on the same disk; keep key and file apart; OS keychain or KMS (A-6, C-1) |
| T-56 | E | An agent reads secrets | `vault.ts` | RBAC; agents cannot hold `secret:read` or `secret:write` (`vault.test.ts` "RBAC: viewers, agents and other tenants are refused; every access is audited without values") | Low | — |
| T-57 | I | Keys appear in logs | `log.ts` | See check 6 | Medium | Register model and Sanity keys; add their shapes; redact the web app's logs (B-8) |
| T-58 | I | `.env` files baked into the host image | `.dockerignore` | Root `.env` and `.env.*` excluded; the image runs as the `node` user | Low to Medium | `.dockerignore` patterns are root-relative, so a nested `.env` (for example `apps/studio/.env`) is copied; use `**/.env` and `**/.env.*` (B-10) |

### 5.9 Persistence and Sanity

| ID | STRIDE | Threat | Where | Existing mitigation (code; test) | Residual | Gap / action |
|---|---|---|---|---|---|---|
| T-59 | T, E | Approval records or policies forged through the Editor token or Studio | Sanity dataset | The execute route re-checks the approval's fingerprint, the approver's entity type and the current policies | Medium; **High** when hosted | Anyone with Editor rights can write a matching `approvalRecord`. Sign approval records with a host-held key (B-6); separate tokens and review Studio roles (A-7) |
| T-60 | I | The legacy challenge project is read or written | Web, host, agent | Refused in all three (tests in check 12) | Low | — |
| T-61 | I | The query agent surfaces any document | Context Viewer token | Read-only; evaluation records the requester | Medium | Scope what query workflows and task clients may read (B-15) |
| T-62 | I, T | The run database is reachable | Compose, Render | Private network; Render `ipAllowList: []`; password from the environment | Low | — |

### 5.10 Local machine, hosting and supply chain

| ID | STRIDE | Threat | Where | Existing mitigation | Residual | Gap / action |
|---|---|---|---|---|---|---|
| T-63 | E, T, I | Malware or another person using the founder's account | TB1 | Files mode 0600; secrets outside git (`.gitignore`) | **High** if the machine is compromised; accepted for M2 | Full-disk encryption, a separate OS account for the host, offline backups (A-6) |
| T-64 | E | The hosting provider or its dashboard is compromised | TB4 | `autoDeploy: false`; secrets as `sync: false`; no secret in the repository | Medium when hosted | Strong account security on the platform; vault key held apart from the `/data` volume (A-6) |
| T-65 | E | A vulnerable dependency runs in a process | npm tree | See section 7 | Low for the host runtime | B-9, B-10 |
| T-66 | E | The host image carries tooling it does not need | `deploy/Dockerfile.host` (`npm ci` of the whole workspace) | Runs as `node` | Low | Install only the host workspace's production dependencies (B-10) |

## 6. LLM-specific threats

| ID | Threat | Where it could happen | Existing mitigation (code; test) | Residual | Gap / action |
|---|---|---|---|---|---|
| L-01 | Prompt injection through task text | A task's objective becomes the query agent's `question` (`tasks.ts` `execute`); tasks logged to the shadow log flow into Aura's examples | The task text grants nothing (`tasks.test.ts` "injection text in the objective or inputs changes neither permissions nor status"); the query agent is read-only and evaluated; tool steps are blocked | Medium | The injected question can steer what the agent reads and returns to the client (T-23). Keep task-reachable workflows read-only; scope their data (B-15) |
| L-02 | Injection through documents and connector data | The CSV connector's descriptions and categories enter the intent graph as `OBSERVED` values, which the shadow agent reads | Values are parsed as numbers and short labels; observations go through the governed updater and never touch stated values (`onboard.test.ts` "observations enter the graph as OBSERVED, through the governed updater, without touching stated values"); proposals must cite graph facts | Low to Medium | Mark connector text as data in the shadow agent's prompt (it already marks prior step output as "data, not instructions" in the web workflow route) |
| L-03 | Injection through Sanity content read by the planner and query agent | `groq_query`, `knowledge_base_read` through Context MCP | The kernel re-resolves every reference and decides; the reviewer is advisory; the planner's evaluation can only tighten | Medium | T-40: model-chosen risk inputs (B-7) |
| L-04 | Injection through MCP, in both directions | Task results go back to the calling model; tool descriptions steer the caller | Tool descriptions state that submitting is a request and that approval happens only in the console; results are JSON; no tool approves (`mcp-tasks.test.ts` "the tools: five, none approves, and each says the kernel decides and a human approves in the console") | Medium on the client's side | Results carry text from Sanity and the query model into the client's context. That risk sits with the MCP host; document it for each client |
| L-05 | Model output treated as authority | Planner, shadow agent, intent parser, Aura predictions | The kernel is the only authority; evaluation only tightens; the intent parser cannot grant autonomy (`aura.test.ts` "combined parser: money from the model, durations from the rules, constraints unioned, autonomy never granted by the model"); hand-over is the founder's own ledger entry | Low, except T-40 | B-7 |
| L-06 | Data exfiltration through model calls | Prompts carry the intent graph, the founder's principles, decision journal examples, Sanity content, task text | Keys travel only in request headers; the memory governor keeps credentials out of stored memory; AMP material is never connected | Medium | Nothing removes personal or confidential data from prompts. Decide what classes of data may go to the provider and review the provider's data-handling terms (B-15, founder decision) |
| L-07 | Overreliance on Aura's predictions | The 5-minute verdict routine; the running baseline | Predictions are sealed before the verdict and scored predict-then-learn (`sealed.test.ts` "a pending decision resolves into a journal decision only with a valid choice and a reason"; `shadow-api.test.ts` "only a human judges; verdicts train Aura and predictions are scored before each verdict"); the baseline is labeled a baseline; Aura grants nothing | Medium (human automation bias) | Aura's choice agreement is below its 70% target (best fresh result 33.3%; the blind 63.2% did not replicate). Never pre-select a verdict in the console, and show the running accuracy next to any prediction the founder sees |
| L-08 | Invalid or malformed model output | Every model call | Fails closed (check 14) | Low | — |
| L-09 | Model cost exhaustion | Anonymous web routes; host model routes | Tasks are rate-limited; compute is recorded as capital when the founder records it | Medium | Rate limits (A-5); meter model spend automatically before Genesis starts |
| L-10 | An agent reaches a tool with side effects | Workflow runner, tool registry | Tools blocked on the host and in live web runs; side-effect tools need evaluation and verified approval (`workflows.test.ts` "Runtime: a denied or missing approval means the side-effect tool never runs"; `nqc.test.ts` "ToolRegistry: approval ids are ignored for tools that do not need them and verified for those that do") | Low | Revisit with the first effectful executor |

## 7. Dependency advisories (`npm audit`, 2026-09-27)

`npm audit --omit=dev --json` and `npm audit --json` returned the same
result: 14 packages, **6 high, 8 moderate, 0 critical**. npm counts them all as
production dependencies because the workspace packages list their parents
under `dependencies`. What matters is which process loads them:

- **Host runtime** (`packages/host`, `kernel`, `aura`, `agent`): **no
  advisories.** The agent package uses `ai` 6.0.287 and `undici` 6.28.1,
  which are outside the flagged ranges.
- **Web app** (`apps/web`): `ai` 5.0.262 is a direct dependency that no file in
  `apps/web` imports (the app reaches models through `@quicksilver/agent`). It
  drags in the flagged `@ai-sdk/gateway`, `@ai-sdk/provider-utils` and
  `undici` 5.29.0. `next` 15.5.25 bundles `postcss` 8.4.31.
- **Studio and CLI tooling** (`apps/studio`): `sanity` and its CLI chain run
  only when the founder runs Studio or deploys a schema. They are also copied
  into the host image, which installs the whole workspace.

| Package | Severity | Installed | Reached through | Runtime or tooling | Fix available | Recommendation |
|---|---|---|---|---|---|---|
| `undici` | High | 5.29.0 | `apps/web` → `ai@5` → `@ai-sdk/provider-utils@3` | Web runtime, but only through the unused `ai@5` | Yes | Remove `ai` from `apps/web/package.json` (B-9) |
| `@ai-sdk/provider-utils` | Moderate | 3.0.37 | `apps/web` → `ai@5` | Same | Yes | Same |
| `@ai-sdk/gateway` | Moderate | 2.0.154 | `apps/web` → `ai@5` | Same | Yes | Same |
| `ai` | Moderate | 5.0.262 | `apps/web` (direct) | Same | Yes | Same |
| `postcss` | High | 8.4.31 (bundled in `next`) | `apps/web` → `next` | Web build (CSS processing of the app's own styles) | Only through `next` 16.3.6 (major) | Low exposure: it processes first-party CSS at build time. Plan the Next 16 upgrade before any public web deployment (B-9) |
| `next` | Moderate | 15.5.25 | `apps/web` (direct) | Web runtime and build (advisory is through `postcss`) | 16.3.6 (major) | Same |
| `@sanity/cli` | High | 6.7.2 | `apps/studio` → `sanity` | Studio tooling | Yes | Update `sanity` to a release with the fixed chain, in its own reviewed change (B-9). Do not run `npm audit fix` blindly |
| `@sanity/runtime-cli` | High | 15.2.1 | `@sanity/cli` | Studio tooling | Yes | Same |
| `adm-zip` | High | 0.5.18 | `@sanity/runtime-cli` | Studio tooling (archive extraction: memory exhaustion, symlink overwrite) | Yes | Same; never extract archives from untrusted sources with the Sanity CLI until updated |
| `js-yaml` | High | 3.13.1 | `@sanity/cli` → `@vercel/frameworks` | Studio tooling (prototype pollution, CPU exhaustion on crafted YAML) | Yes | Same |
| `@vercel/frameworks` | Moderate | 3.21.1 | `@sanity/cli` | Studio tooling | Yes | Same |
| `sanity` | Moderate | 5.31.2 | `apps/studio` (direct) | Studio tooling | Yes | Same |
| `typeid-js` | Moderate | (nested) | `@sanity/cli` | Studio tooling | Yes | Same |
| `uuid` | Moderate | (nested in `typeid-js`) | `typeid-js` | Studio tooling | Yes | Same |

Also: build the host image with only the host workspace's production
dependencies, so Studio tooling is not in it at all (B-10). Rerun both audits
monthly and at every milestone (C-5).

## 8. Prioritized actions

Owner type: **code** (a change in this repository), **founder decision**, or
**ops** (configuration, accounts, machines). Effort: **S** (under a day),
**M** (a few days), **L** (a week or more).

### P0: before any hosting or public exposure

| ID | Action | Owner | Effort |
|---|---|---|---|
| A-1 | **Fixed in `30b085e`.** Fix F-1: bind the delivery id to the signature in the replay check; test the swapped-id replay for runs and tasks. Tests: see F-1 | code | S |
| A-2 | **Fixed in `30b085e`.** Fix F-2: authenticate `execute` with `decision:execute` and record the executor; require a principal for `observe` and `resume`. Tests: see F-2 | code | S |
| A-3 | Web app: require a valid principal on `/api/plan`, `/api/query` and `/api/workflows/*` when not bound to loopback; start `next` with `-H 127.0.0.1` locally; refuse bodies that are not `application/json` and check `Origin` on state-changing routes | code | M |
| A-4 | **Fixed in `30b085e`.** Host: default `http.host` to `127.0.0.1`; a public bind must be set explicitly. Tests: `config.test.ts` "the host binds to loopback by default; a public bind must be explicit (A-4)", "defaults are filled for a minimal config" | code | S |
| A-5 | Per-principal rate limits on every write and every model-calling route of the host and web app, and per-endpoint limits for webhooks (at the proxy is fine) | code | M |
| A-6 | Hosting secrets: vault key, principals and model keys as platform secrets, never in the image or on the `/data` volume; webhook secrets as `vault:` references only; back up the vault file and its key separately; full-disk encryption on the founder's computer | ops | S |
| A-7 | Sanity: separate tokens for reading and writing, Editor only where a process writes; review who can edit in Studio; record that Studio's read-only schemas are not access control | founder decision + ops | S |
| A-8 | Keep AMP material unconnected and Forkling read-only (already true); confirm before each new connector | founder decision | S |
| A-9 | Tests: one table-driven 401/403 test over every host route, and the first route tests for the web app's decision routes | code | M |
| A-10 | **Fixed in `30b085e`.** Refuse to start with `QUICKSILVER_ALLOW_FAULT_INJECTION` or `QUICKSILVER_WORKFLOW_LIVE_RUNS` on when `NODE_ENV=production`. The host and the web app both refuse; the web routes also treat both as off in production. Tests: `config.test.ts` "development-only switches stop the host in production (A-10)", "the host process refuses to start with a development-only switch on in production (A-10)" | code | S |

### P1: before 0.9.0

| ID | Action | Owner | Effort |
|---|---|---|---|
| B-1 | SSO/OIDC sign-in and sessions behind the `IdentityProvider` port (already planned before 0.9.0); token expiry and rotation for task clients; retire the shared `NQC_SUPERVISOR_TOKEN` | code | L |
| B-2 | A durable, append-only access-audit store (denials and authority actions) | code | M |
| B-3 | Approvals echo the hash the approver saw: web fingerprint (and add evidence ids, actor, capability, exposure), task hashes, and the Genesis and Operate `decide` verdict with its evaluation; refuse a mismatch | code | M |
| B-4 | Money entries store the spend decision (recommendation, reasons, risk) and the founder's confirmation | code | S |
| B-5 | Sign intent-ledger entries on the host (Ed25519, key in the vault); chain the shadow logs and decision journal; anchor ledger heads outside the machine so truncation is detectable | code | M |
| B-6 | Sign approval records with a host-held key and verify at execute, so an Editor token alone cannot forge one | code | M |
| B-7 | Treat the planner's risk inputs as a floor over catalog or capability values; a missing or zero exposure counts as unknown | code | M |
| B-8 | Register model and Sanity keys with `redactValue` at startup; add their shapes to `CREDENTIAL_VALUE`; stop returning `err.message` from web routes and redact web logs | code | S |
| B-9 | Dependencies: remove `ai` from `apps/web`; update `sanity`; plan the Next 16 upgrade | code | S to M |
| B-10 | Host image: install only the host workspace's production dependencies; `**/.env` and `**/.env.*` in `.dockerignore` | code | S |
| B-11 | Web input limits: byte cap before parsing, `question` at most 2,000 characters, `comment` at most 1,000 | code | S |
| B-12 | Index the task store (idempotency key and submitter) instead of reading every file | code | S |
| B-13 | ~~Fix F-3: humans only on `POST /api/intents/:id/answers`~~ **Fixed in `30b085e`** | code | S |
| B-14 | Multi-tenant hosting with isolation tests (already planned before 0.9.0) | code | L |
| B-15 | Data rules: which data classes may go to the model provider; which capabilities and data each task client may reach; review the provider's data-handling terms | founder decision | S |
| B-16 | A shared webhook replay cache, only if more than one host replica ever runs | code | M |

### P2: later

| ID | Action | Owner | Effort |
|---|---|---|---|
| C-1 | Vault master key in an OS keychain, KMS or HSM | ops + code | M |
| C-2 | WAES as a service; turn off `waesManualReviewAllowed` | code | L |
| C-3 | Reconcile the money ledger against payment-processor statements | code | M |
| C-4 | An outside penetration test before any customer who is not the founder | ops | M |
| C-5 | Monthly `npm audit` review and an SBOM per release | ops | S |
| C-6 | Traces, dashboards and alerts on denials and failed verifications | code | M |
| C-7 | A `Host` header allow-list on the host (DNS rebinding) | code | S |

## 9. How to keep this current

- Update section 4 and the findings table whenever a route, store or
  credential changes.
- A finding moves out of the table only with the commit that fixes it and the
  test that proves it.
- The [parity tests](parity-tests.md) list the security requirements (S rows)
  that the release gates depend on.
