# Nuera Quicksilver Platform

This area documents workflow authoring and execution, SDKs, triggers, identity
and secrets, observability, collaboration, and extensions. These are target
capabilities until connected to implementation and operational evidence. See
the [roadmap](../NUERA-QUICKSILVER-ROADMAP.md).

In the [product definition](../NUERA-QUICKSILVER-PRODUCT.md), this is the
**Foundation** layer. It includes the platform feature baseline (section 7)
that every operating mode depends on.

- [Workflow graph contract](workflow-graphs.md)
- [Durable workflow runs: queue, worker, dead letters](durable-runs.md)
- [Identity and RBAC](identity-rbac.md)
- [Triggers: cron schedules and signed webhooks](triggers.md)
- [Hosted runtime: host process, management API, secrets vault, logs and metrics](hosted-runtime.md)
- [Tool registry](tool-registry.md)
- [Supervisor approval gate](supervisor-approval.md)
- [TypeScript SDK foundation](sdk-typescript.md)
- [Python SDK and CLI foundation](sdk-python.md)
- [Dedicated Sanity project setup](sanity-isolation.md)
- [Operate (M6): autonomy, reinvestment and bounded experiments](operate.md)
- [Kernel depth (M7): policy lineage, supersession, scope nesting and the capability graph](kernel-depth.md)
- [What-if engine (M7): Monte Carlo cash, experiment odds, stress scenarios and shadow-log counterfactuals](what-if.md)
- [Governed task interface (M7): one intake path for API, MCP, webhook and CLI tasks](tasks.md)
