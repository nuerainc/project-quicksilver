# Nuera Quicksilver glossary

## Aura
The intent and provenance layer. Aura turns a human objective into a decision graph, identifies unknowns, asks targeted questions, and records where values came from. Aura does not grant authority.

## Agent manifest
A versioned registration describing an agent identity, supported task, and allowed impact. A manifest permits dispatch; it does not approve or execute work.

## Decision graph
The structured representation of an objective, its variables, dependencies, unknowns, evidence, and proposed actions.

## Evaluation record
The persisted, inspectable result of Quicksilver Engine/NQC evaluation. It contains observable signals such as grounding, tool failures, uncertainty, and brittleness; it is not private model reasoning.

## Genesis
The operating mode that starts with a mostly empty business graph and uses bounded, paid-signal experiments to discover a viable business. Spending and customer-facing actions remain governed.

## NQC Kernel
The deterministic authority layer: Nuera Quicksilver Cognitive Kernel. It checks capabilities, policies, evidence, risk, identity, approvals, workflow transitions, and tool contracts. It is the final authority for what may happen.

## Onboard
The operating mode that connects an existing business, imports observations, back-tests recommendations, runs in shadow mode, and gradually earns autonomy by department.

## Operate
The steady-state operating mode for a validated business. It optimizes, reinvests, and runs bounded experiments within the kernel's governance rules.

## Playbook
Versioned business process content that combines lifecycle stages with workflow graphs. Playbooks are data, not executable code, and every action they propose still passes through the NQC Kernel.

## Provenance
The origin of a value in the decision graph. Current tags include `HUMAN_SPECIFIED`, `OBSERVED`, `AGENT_INFERRED`, and `SYSTEM_CONSTRAINT`.

## Quicksilver Engine
The deterministic evaluation layer that scores observable properties of an agent result, including grounding, missing references, tool failures, uncertainty, and brittleness. Evaluation can make a decision stricter, never looser.

## Shadow mode
A recommendation-only mode. An agent proposes and the kernel evaluates as if autonomy had been granted, but no side effect is executed. A human supplies the verdict and the result can train Aura's predictor.

## WAES
Wellbeing-Aligned Evaluation System. The planned/reinforced review gate for offers, claims, and customer-facing messages. A failed or missing review blocks the corresponding content from shipping.

## Worker runtime
The durable run queue and worker system in `@quicksilver/kernel/runtime`. It supports admission validation, idempotency, backpressure, leases, cancellation, retries, dead letters, and memory/file/PostgreSQL stores.
