# Nuera Quicksilver naming and runtime boundaries

This document records the canonical names for the cognitive subsystem and maps
them to the current Quicksilver repository.

## Canonical hierarchy

- **Nuera Quicksilver** is the complete cognitive subsystem: kernel, agents,
  Quicksilver Engine, routing, safety, memory, workflows, domain kernels, and
  enterprise extensions.
- **NQC Kernel** means Nuera Quicksilver Cognitive Kernel. It is the final
  authority for safety and execution decisions.
- **Nuera Quicksilver Agents** are worker agents. They propose plans and
  perform bounded work under NQC Kernel controls.
- **Quicksilver Engine** is the evaluation engine integrated with NQC Kernel,
  evolved from our Quicksilver Sanity Challenge submission
  ([nuerainc/quicksilver-sanity-challenge](https://github.com/nuerainc/quicksilver-sanity-challenge)).
  It produces reasoning-quality, grounding, hallucination-risk, brittleness,
  failure-exemplar, and diagnostic signals.

## Current implementation mapping

| Canonical component | Repository implementation |
|---|---|
| Nuera Quicksilver | This repository and its `apps/` and `packages/` workspaces |
| NQC Kernel | `packages/kernel`; deterministic authority plus `evaluateAndAuthorize()` |
| Nuera Quicksilver Agents | `packages/agent`; planner and advisory reviewer today |
| Quicksilver Engine | `packages/kernel/src/engine`; deterministic output diagnostics |
| Workflow authority | Kernel process engine and Decision Lifecycle in Sanity |
| Tool-use validation | `validateToolRequest()` in the kernel; callers must validate before dispatch |

The evaluator uses observable signals and does not ingest private chain-of-
thought. Its scores are deterministic diagnostics, not a claim of semantic
proof. Evaluation may escalate an otherwise authorized action for human review;
it cannot reverse a kernel rejection.

Routing optimization, governed long-term memory, domain-specific kernels, and
additional worker agents remain planned layers. They must remain subordinate to
NQC Kernel policy and must not independently authorize execution.

## Product layers

The [product definition](NUERA-QUICKSILVER-PRODUCT.md) arranges these
components in layers:

| Layer | Components |
|---|---|
| Foundation: platform runtime | Durable runs, triggers, tool and agent registries, governed memory, routing, SDKs |
| Layer 1: NQC Kernel loop | NQC Kernel, Quicksilver Engine, Decision Lifecycle, supervisor approval, RBAC |
| Layer 2: intent loop | Intent resolution and the decision graph (planned) |
| Layer 3: playbook loops | Playbooks built from process definitions and workflow graphs, run by Nuera Quicksilver Agents (planned) |
