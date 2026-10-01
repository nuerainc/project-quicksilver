# Nuera Quicksilver 1.0 scope decision

**Baseline choice: literal baseline — selected by the product owner on 2026-09-29.**  
**Product owner:** Brodi (per the NQC Kernel specification).  
**Decision owner for product, security, operations, data, and finance:** Brodi.
**Scope:** P-001–P-123 are required for v1.0.0. The product owner explicitly
directed that all parity requirements P-001–P-123 be completed, including the
two later usability requirements. Operational decisions and release evidence
remain in progress.

The product owner selected the literal baseline. This records the decision; it
does not claim the requirements are implemented or waive any requirement. The
full authoritative enterprise specification remains the M9/1.0.0 target under
the [M8–M9 enterprise plan](M8-M9-ENTERPRISE-PLAN.md).

## Release rule

Complete every requirement P-001–P-123 for v1.0.0, including all P-017–P-031
platform-baseline capabilities and the P-122/P-123 usability requirements. No
requirement may be silently deferred or marked not applicable without the
product owner's rationale, replacement behavior, owner, and acceptance
evidence.

Implementation order remains risk-based: SDKs, workflow authoring, hosted
runtime, identity and secrets, monitoring, and governed extensions are all
required. Marketplace distribution breadth follows a working, secured runtime
and signed extension lifecycle; it remains in the M9 scope.

## Required baseline and product scope

Every P-001–P-123 row in the [parity tests](platform/parity-tests.md) is
required before 1.0.0. This includes the P-017–P-031 platform baseline,
Genesis, Onboard, Operate, WAES, provenance, finance, and their required
integrations. This scope record does not assert that any missing path is
implemented; current evidence is in [spec coverage](NUERA-QUICKSILVER-SPEC-COVERAGE.md).
The dedicated Quicksilver Sanity project stays separate from the public Sanity
Challenge project and its challenge dataset.

### Release evidence categories

Automated tests and operational evidence are separate acceptance criteria.
P-014, P-081, P-089, P-096, and P-121 explicitly require deployment, pilot,
or live-system evidence; those five rows remain release blockers until their
specified operational evidence is recorded. P-064–P-066 fall within the
P-001–P-121 ID range but are Aura charter ladder measures. Per the parity
register, they are reported against Aura's own charter and do not gate a Nuera
Quicksilver release. Do not count those Aura measures as substitutes for
Quicksilver tests or operational evidence.

## Required owner decisions

Brodi is currently the decision owner across all domains; this does not waive
independent human approval or reviewer-separation rules for runtime actions.

| Decision | Recommended default | Status |
|---|---|---|
| P-001–P-123 release scope | All P-001–P-123 are v1.0.0 requirements | **Selected by product owner (2026-09-30)** |
| Pilot scenarios | Nuera Onboard; founder-owned, digital-only Genesis microbusiness with $500/30-day limits; Operate on that venture after Genesis handover | Onboard and Genesis are already in the product definition; Operate linkage needs confirmation |
| Deployment | Vercel for `apps/web`; Render for the persistent host and managed Postgres; keep Sanity Studio/project separate | Proposed; not deployed |
| Host replica count | One replica for initial founder pilots; require B-16 shared webhook replay protection before enabling multiple replicas | Proposed |
| Runtime and support matrix | Node 22 (matches CI); PostgreSQL for hosted runs; current stable Chrome, Edge, and Firefox; existing Azure, OpenAI, Anthropic, Google, and explicit local Ollama provider modes | Proposed; browser/provider support needs acceptance evidence |
| WAES/manual review | Require WAES for customer-facing content; allow founder review only as a separately labelled, exact-content manual path during pilots; manual review is never reported as WAES | Product docs already describe this path; confirm policy |
| Data classes and provider handling | Founder-owned pilot business data only after access/security gates; no restricted patent data, raw payment data, secrets in prompts/logs, or regulated data; select providers/configurations that do not train on submitted data; minimize and document retention by data class | Proposed; retention durations and provider terms need confirmation |
| Finance and spend | Keep the defined $500 Genesis cap, 30-day limit, daily caps and pre-set experiment thresholds; reconcile every payment to the ledger | Product-defined; implementation/evidence remains incomplete |
| Release/change policy | SemVer; protected `main`; PR required; Ubuntu + Windows CI and Go checks required; migrations and changelog entries accompany schema/API changes; exceptions recorded here with parity IDs and expiry | Proposed |
| Sanity separation | Dedicated Quicksilver project `f87t11g1`, private `production` dataset; never connect the public Sanity Challenge dataset | Selected in prior setup; credentials/deployment still blocked |

## Gate 0 completion checklist

- [x] Product owner selects literal baseline (2026-09-29).
- [ ] Exact pilot scenarios and supported connectors/channels are listed.
- [x] P-001–P-123 are included in v1.0.0 per the product owner's decision.
- [x] P-122 and P-123 are included in the completion and v1.0.0 acceptance scope by the product owner's explicit direction (2026-09-30).
- [x] Product, security, operations, data, and finance decision owner is Brodi.
- [ ] Runtime, provider, data-class, WAES, and replica decisions are recorded.
- [ ] `V1-ACCEPTANCE.md` maps every in-scope item to automated evidence and,
      where required, operational evidence; P-014/P-081/P-089/P-096/P-121
      remain explicit operational blockers.

The P-001–P-123 baseline is approved. Gate 0 remains open until the remaining
operational decisions, named owners, and acceptance evidence are completed. No
claim is made that a required capability is complete merely because the scope
decision is recorded.

See the [v1 external credential and access checklist](platform/v1-credential-prerequisites.md)
for the provider access needed to unblock live testing and operational evidence.
