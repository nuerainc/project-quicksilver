# Nuera Quicksilver documentation

Nuera Quicksilver (this repository, `nuerainc/project-quicksilver`) was inspired
by Quicksilver, our Sanity Challenge 2026 submission, which lives separately at
[nuerainc/quicksilver-sanity-challenge](https://github.com/nuerainc/quicksilver-sanity-challenge).

- [Product definition](NUERA-QUICKSILVER-PRODUCT.md): what Nuera Quicksilver is being built to become (layers, modes, playbooks, goals)
- [NQC Kernel and Quicksilver Engine](nqc/README.md)
- [Platform architecture](platform/README.md)
- [Implementation roadmap](NUERA-QUICKSILVER-ROADMAP.md)
- [Enterprise specification coverage](NUERA-QUICKSILVER-SPEC-COVERAGE.md)
- [Canonical naming](NUERA-QUICKSILVER-NAMING.md)
- [Glossary](GLOSSARY.md): project terminology and status vocabulary
- [Contributor guide](../CONTRIBUTING.md): setup, verification, boundaries, and design rules
- [Parity tests](platform/parity-tests.md): release-gate requirements and evidence
- [v1.0.0 execution plan](V1-PLAN.md): dependency-aware implementation, pilot, and release gates
- [v1 scope decision](V1-SCOPE.md): approved P-001–P-123 v1.0.0 baseline and remaining operational decisions
- [NQC evaluation benchmark plan](NQC-EVALUATION-BENCHMARK.md): held-out measurement protocol and claim gates
- [authoritative enterprise specification](NUERA-QUICKSILVER-ENTERPRISE-SPEC-v1.md): merged platform target and Supervisor Agent contract
- [M8–M9 enterprise plan](M8-M9-ENTERPRISE-PLAN.md): feature-complete release candidate, hardening, evidence, and 1.0.0 gate
- [M7 release evidence](platform/m7-release-evidence.md): executable acceptance matrix and verification results for all four M7 parts

Copies of the challenge submission, DEV posts, and demo script are kept here as
historical records, each marked with a banner. They do not describe the new platform's current capability
or deployment environment.

For a first contribution, start with the [repository README](../README.md), then
run `npm run verify` and read the [contributor guide](../CONTRIBUTING.md).
