# M8: platform parity build

The platform baseline (product definition, section 7; parity tests P-017 to
P-031) is built natively, under the NQC kernel, in the order below. Each part
reuses what M1 to M7 already built; nothing here re-implements it.

## What each part reuses

| Existing piece (built M1 to M7) | Used by M8 for |
|---|---|
| `authorize()`, the capability graph, policies, WAES gate (kernel) | Every `external` operator action (messages, money, publishing) |
| Separation of duties, hash-bound approvals (host tasks) | Operator approvals are bound to the hash of the exact call, the same idea |
| Canonical JSON and digests (kernel runtime) | The operator's hash-chained audit log |
| Durable run queue, worker, retries, dead letters (kernel runtime) | Long and scheduled operator runs (part 5) |
| Cron triggers, webhooks with replay protection (kernel triggers) | Scheduled automations and inbound channel events (parts 4, 5) |
| Task intake: RBAC, rate limits, boundaries, one path for every channel (host) | Every channel hands work to the operator through it (part 4) |
| Principals, RBAC, per-person tokens (kernel identity) | Who may approve, pair a channel or run the operator |
| Secrets vault (host) | Channel bot tokens, provider keys, payment keys |
| Model role registry, AI SDK providers (agent) | The operator's model driver |
| MCP client (agent) and MCP task server (host) | Tool breadth through MCP servers (part 7) |
| Aura intent graph and decision journal | Business memory; the operator adds session memory beside it (part 2) |
| Rate limiter (kernel) | Channel and API limits |

## Parts

| Part | Scope | Status |
|---|---|---|
| 1. Governed tool runtime | Files, shell and code tools; local and Docker sandboxes; command and path policy; approval modes; checkpoints and rollback; hash-chained audit; agent loop whose completion the runtime decides; CLI | Done (`packages/operator`) |
| 2. Memory | Session archive with full-text recall (SQLite FTS5), agent notes and a user profile with provenance (agent profile entries wait for the person; stated entries cannot be overwritten), frozen snapshot per run, project context files loaded as data with rule-changing lines removed | Done (`memory.ts`, 4 tests) |
| 3. Skills | SKILL.md (open standard) with progressive loading; project skills in place; agent proposals and revisions held for review with a diff (active skills never overwritten, replaced versions archived); scanning for refused commands and rule-changing text; import from a folder (hub downloads) held for review; outcome scores (uses, verified, failed) shown to the agent; `--learn <run>` | Done (`skills.ts`, 3 tests) |
| 4. Channels | One gateway (`npm run operator:gateway`): Telegram (long polling), Slack (Socket Mode), Discord (Gateway), SMS (Twilio, signed webhooks), email (signed inbound webhook, HTTP mail API). Deny by default; one-time pairing codes (1 hour, rate-limited); direct messages only; one conversation and one memory per person across channels; approvals in the chat bound to the call's hash (no answer means no); one run per person with a queue; de-duplication and per-person rate limits | Done (`channels/`, 8 tests). Needs the bot accounts and operational evidence |
| 5. Automation | Plain-language schedules ("every weekday at 8am", "mondays at 9:30", "every 15 minutes") compiled to the kernel's cron, in the person's time zone (DST-correct), with a preview of the next runs; once per slot with latest-only catch-up (the kernel scheduler's rule); results delivered to the person's channel; each run gets the previous result so it reports what is new; tokens and dollars per 30 days; self-pausing after 3 failed runs or a provider error, with a message saying why; approvals asked in chat when the gateway runs them (`npm run operator:auto`) | Done (`automations.ts`, 5 tests) |
| 6. Delegation | Isolated subagents with restricted toolsets, parallel fan-out, cost tracking | |
| 7. Web, browser, media | Search and extract, browser automation, image and speech generation, transcription, vision | |
| 8. Hosting and commerce | Sites and pages with version history and teardown per experiment; payments, products, links and orders feeding the Genesis ledger | |
| 9. Interfaces | Streaming HTTP API, terminal UI, desktop shell, voice | |

## Beyond the baseline (already true of part 1)

- **Completion is decided by the runtime, not the model.** Evidence must be
  successful calls from the run, and the run's own checks must pass. A model
  cannot report a failed task as done.
- **External actions always need a person and the kernel.** No approval mode
  removes that, and the kernel's policies, evidence and risk apply first.
- **Approvals bind to the exact call.** A call that changed after approval
  does not run.
- **Every run can be undone** (file checkpoints) **and audited** (hash chain).
