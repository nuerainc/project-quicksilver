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
| 3. Skills | SKILL.md (open standard) loading, skills written by the agent after a solved task and held for approval, outcome scores per skill | |
| 4. Channels | One gateway: email, SMS, Telegram, Slack, Discord first; pairing codes, deny-by-default allowlists, one memory across channels; outbound messages through the kernel and WAES | |
| 5. Automation | Schedules described in plain language (compiled to the existing cron triggers), delivery to any channel, per-automation cost, pause on failure | |
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
