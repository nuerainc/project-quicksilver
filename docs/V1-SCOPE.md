# Nuera Quicksilver 1.0 scope decision

**Baseline choice: literal baseline — selected by the product owner on 2026-09-29.**  
**Product owner:** Brodi (per the NQC Kernel specification).  
**Scope classification and remaining owners/evidence:** still in progress.

The product owner selected the literal baseline. This records the decision; it
does not claim the requirements are implemented or waive any requirement. The
full authoritative enterprise specification remains the M9/1.0.0 target under
the [M8–M9 enterprise plan](M8-M9-ENTERPRISE-PLAN.md).

## Release rule

Build every platform-baseline capability P-017–P-031 before 1.0.0, as defined
by `V1-PLAN.md`. Complete all other applicable parity requirements and all
capabilities in the authoritative enterprise specification by M9. No baseline
capability is reduced to a mode-critical subset. Any `not applicable`
classification outside the literal P-017–P-031 commitment still needs the
product owner's explicit rationale, replacement behavior, owner, and evidence;
no requirement is silently deferred.

Implementation order remains risk-based: SDKs, workflow authoring, hosted
runtime, identity and secrets, monitoring, and governed extensions are all
required. Marketplace distribution breadth follows a working, secured runtime
and signed extension lifecycle; it remains in the M9 scope.

## Required baseline and product scope

Every P-017–P-031 platform domain listed in the [parity tests](platform/parity-tests.md)
is required before 1.0.0. Genesis, Onboard, Operate, WAES, provenance, finance,
and their required integrations also remain part of the product definition and
M8–M9 delivery contract. This scope record does not assert that any missing
path is implemented; current evidence is in [spec coverage](NUERA-QUICKSILVER-SPEC-COVERAGE.md).
The dedicated Quicksilver Sanity project stays separate from the public Sanity
Challenge project and its challenge dataset.

## Required owner decisions

| Decision | Proposed owner | Status |
|---|---|---|
| Literal baseline vs. mode-critical baseline | Product owner, Brodi | **Literal baseline selected 2026-09-29** |
| Exact Genesis, Onboard, and Operate pilot scenarios | Product / operations | Pending definition |
| Security owner and P0 acceptance | Security owner (name TBD) | Pending |
| Data classes, retention, provider settings | Data owner (name TBD) | Pending |
| Finance ledger and spend controls | Finance owner (name TBD) | Pending |
| Node, browsers, database, deployment and model providers | Product / operations | Pending |
| WAES service vs. manual founder review | Product / safety owner | Pending |
| One host replica vs. multi-replica requirements | Operations / security | Pending |

## Gate 0 completion checklist

- [x] Product owner selects literal baseline (2026-09-29).
- [ ] Exact pilot scenarios and supported connectors/channels are listed.
- [ ] Every P-001–P-121 is classified `v1`, `post-v1`, or `not applicable`
      with an owner, rationale, replacement behavior, and evidence.
- [ ] Product, security, operations, data, and finance owners are named.
- [ ] Runtime, provider, data-class, WAES, and replica decisions are recorded.
- [ ] `V1-ACCEPTANCE.md` maps every in-scope item to automated and operational
      evidence.

The baseline choice is approved. Gate 0 remains open until the remaining scope
classification, operational decisions, named owners, and acceptance evidence
are completed. No claim is made that a required capability is complete merely
because the scope decision is recorded.
