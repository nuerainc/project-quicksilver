# Media (P-025)

One contract for image, video, speech, transcription, diagram and
image-understanding requests, with the controls the plan asks for: moderation,
retention, a cost cap and asset provenance. It is built contract-first. **No
real provider ships.** A vendor is a `MediaProvider` that implements contract
version 1 and is registered in code (`buildMedia` in `packages/host/src/main.ts`).
Until one is, the status route works and every request is refused with "no
provider"; nothing is called.

Nothing here moves money. Cost is tracked against the media budget, and each
result carries a suggested ledger entry (`compute`, source `provider-usage`) for
a human to record through the Genesis money route if it counts against a run.

## Turning it on

Set `QUICKSILVER_MEDIA_CONFIG` to a policy file (see `deploy/media/media.example.json`):

| Field | Meaning |
|---|---|
| `budgetUsd` | Total media spend allowed |
| `autoMaxUsd` | Most a request may cost when it is **not** made by a person (an agent, a service) |
| `maxRequestUsd` | Most a request may cost when a **person** makes it; at least `autoMaxUsd`, at most `budgetUsd` |
| `defaultRetentionDays`, `maxRetentionDays` | How long bytes are kept (30 and 365 by default) |
| `allowedKinds` | Which of the six kinds this host accepts |
| `blockedTerms` | Terms the built-in moderator blocks in inputs and text outputs |

Bytes and provenance live next to the Genesis data (`QUICKSILVER_MEDIA_DIR` overrides).

## The controls

1. **Moderation** runs on the input before any provider is called, and again on
   the output before anything is kept. A moderator that throws blocks the
   request (fail closed). A blocked request is recorded; blocked output is never stored.
2. **Cost cap.** The provider estimates first. A person may run up to
   `maxRequestUsd`, anything else up to `autoMaxUsd`, and nothing may take total
   spend past `budgetUsd`. Simultaneous requests cannot jointly overspend: an
   estimate is reserved before the call. Over the cap, a request is refused and
   recorded, not queued. What the provider reports is what is recorded, even
   above the estimate, and a blocked output still counts because it was paid for.
3. **Retention.** Every asset has an expiry. Past it, or when a human deletes it,
   the bytes go and the provenance stays. Expired assets are purged as a side
   effect of any request, and `POST /api/media/purge` does it on demand.
4. **Provenance.** An append-only, hash-chained event log (created, blocked,
   failed, expired, deleted). A stored asset records its kind, provider, contract
   version, input digest, output digest and size, cost, who asked, and when. The
   prompt and the media are **not** in the log, only digests. `GET /api/media`
   verifies the chain.

Output types are fixed per kind (for example transcription and image
understanding return `text/plain`, diagrams `image/png`); anything else from a
provider is refused and not stored.

## Routes

| Route | Who | What |
|---|---|---|
| `GET /api/media` | `decision:read` | Limits, spend, providers, provenance check |
| `POST /api/media/requests` | provider or proposer | Run one request: `{ kind, input, retentionDays?, experimentId?, provider? }` |
| `GET /api/media/assets`, `/assets/:id` | `decision:read` | Assets and their provenance |
| `GET /api/media/assets/:id/content` | `decision:read` | The bytes: text as text, the rest as base64; 410 once gone |
| `POST /api/media/assets/:id/delete` `{ reason }` | a human provider | Delete the bytes early |
| `POST /api/media/purge` | a human provider | Delete the bytes of everything past its expiry |
| `GET /api/media/provenance` | `decision:read` | Chain check and the latest 200 events |

## Writing a provider

Implement `MediaProvider` from `packages/host/src/media.ts`: `id`, `contractVersion`
(must be 1), `kinds`, `estimateCostUsd(input)` and `run(input, signal)`. The
service validates every input before it reaches you and every output before it
is kept, so a provider only translates. `FakeMediaProvider` is the reference
implementation for tests.

## Known gaps (v1)

A real provider for any kind, a Sanity-backed store (file-only), recording
media cost into the ledger automatically, a console panel, and live evidence.
A host serves one tenant from one process; the running spend total is kept in
that process.
