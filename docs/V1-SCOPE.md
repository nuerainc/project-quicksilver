# Nuera Quicksilver 1.0 scope decision

**Baseline choice: literal baseline — selected by the product owner on 2026-09-29.**  
**Product owner:** Brodi (per the NQC Kernel specification).  
**Decision owner for product, security, operations, data, and finance:** Brodi.
**Scope:** P-001–P-121 are required for v1.0.0, per the product owner's
decision. P-122 and P-123 were added afterward and still need an explicit
release classification. Operational decisions and release evidence remain in
progress.

The product owner selected the literal baseline. This records the decision; it
does not claim the requirements are implemented or waive any requirement. The
full authoritative enterprise specification remains the M9/1.0.0 target under
the [M8–M9 enterprise plan](M8-M9-ENTERPRISE-PLAN.md).

## Release rule

Complete every requirement P-001–P-121 for v1.0.0, including all P-017–P-031
platform-baseline capabilities. P-122 and P-123 are active usability
requirements; their release classification must be explicitly recorded before
Gate 0 closes. No requirement may be silently deferred or marked not applicable
without the product owner's rationale, replacement behavior, owner, and
acceptance evidence.

Implementation order remains risk-based: SDKs, workflow authoring, hosted
runtime, identity and secrets, monitoring, and governed extensions are all
required. Marketplace distribution breadth follows a working, secured runtime
and signed extension lifecycle; it remains in the M9 scope.

## Required baseline and product scope

Every P-001–P-121 row in the [parity tests](platform/parity-tests.md) is
required before 1.0.0. This includes the P-017–P-031 platform baseline,
Genesis, Onboard, Operate, WAES, provenance, finance, and their required
integrations. This scope record does not assert that any missing path is
implemented; current evidence is in [spec coverage](NUERA-QUICKSILVER-SPEC-COVERAGE.md).
The dedicated Quicksilver Sanity project stays separate from the public Sanity
Challenge project and its challenge dataset.

## Required owner decisions

Brodi is currently the decision owner across all domains; this does not waive
independent human approval or reviewer-separation rules for runtime actions.

| Decision | Recommended default | Status |
|---|---|---|
| P-001–P-121 release scope | All P-001–P-121 are v1.0.0 requirements | **Selected by product owner** |
| P-122 and P-123 release scope | Explicitly classify the added usability requirements before Gate 0 closes | Open |
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
- [x] P-001–P-121 are included in v1.0.0 per the product owner's decision.
- [ ] Classify P-122 and P-123 for v1.0.0; document acceptance evidence.
- [x] Product, security, operations, data, and finance decision owner is Brodi.
- [ ] Runtime, provider, data-class, WAES, and replica decisions are recorded.
- [ ] `V1-ACCEPTANCE.md` maps every in-scope item to automated and operational
      evidence.

The baseline choice is approved. Gate 0 remains open until the remaining scope
classification, operational decisions, named owners, and acceptance evidence
are completed. No claim is made that a required capability is complete merely
because the scope decision is recorded.
