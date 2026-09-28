# Contributing to Nuera Quicksilver

Thanks for contributing. Nuera Quicksilver is a TypeScript monorepo for a governed automation platform. The repository contains a web console, Sanity Studio, a deterministic kernel, agent adapters, a single-tenant host, and internal SDK foundations.

## Before you start

- Node.js **20 or newer** is required.
- Run commands from the repository root.
- Do not commit `.env`, tokens, vault keys, Sanity credentials, model keys, or generated runtime data.
- The default regression suite does not require Sanity or model credentials.

## Install and verify

```bash
npm ci
npm run verify
```

`npm run verify` runs the credential-free regression suites and TypeScript checks. It does not deploy schemas, seed Sanity, call an LLM provider, or build the Sanity Studio.

For the full workspace build, a configured dedicated Sanity project is required:

```bash
npm run build
```

The web application can build without live credentials. The Studio build requires a valid `SANITY_STUDIO_PROJECT_ID` for the dedicated Nuera Quicksilver project.

## Useful commands

| Command | Purpose | Credentials required |
|---|---|---:|
| `npm run verify` | Regression suites and type checks | No |
| `npm run build` | Build all workspaces | Dedicated Sanity project for Studio |
| `npm run dev:web` | Start the Next.js console | Usually yes for live routes |
| `npm run dev:studio` | Start Sanity Studio | Dedicated Sanity project |
| `npm run schema:deploy` | Deploy Studio schemas | Sanity auth |
| `npm run seed` | Seed the dedicated Sanity dataset | Sanity auth and write token |
| `npm run verify:mcp` | Check Sanity Context MCP | Context MCP credentials |
| `npm run verify:llm` | Check configured model providers | Model credentials |
| `npm run host:test` | Test the hosted runtime | No |
| `npm run e2e:live` | Run the live Sanity end-to-end test | Sanity and model credentials |

Run an individual package suite when iterating:

```bash
npm run kernel:test
npm run agent:test
npm run host:test
npm run aura:test
npm run seed:test
npm run typecheck
```

## Repository boundaries

- `packages/kernel` contains deterministic authorization, risk, process, workflow, NQC evaluation, durable runs, triggers, identity, and simulation. It must not depend on an LLM.
- `packages/agent` contains model configuration, MCP access, prompts, and governed agent workers. Agents propose; they do not authorize or execute privileged actions.
- `packages/host` contains the single-tenant worker process, management API, vault, logs, metrics, and CLI surfaces.
- `packages/aura` contains the intent and provenance layer. It may update agent-inferred beliefs only through governed paths.
- `apps/web` contains the console and API routes.
- `apps/studio` contains Sanity schemas and seed tooling.

## Non-negotiable design rules

1. **Agents propose; the NQC Kernel authorizes.** Never move authority into a prompt, model response, or agent manifest.
2. **Fail closed.** Missing credentials, malformed policy/process data, missing evidence, invalid approvals, and unsafe tool manifests must refuse work rather than guess.
3. **Workflows are data.** Conditions and guards use validated structured data, never evaluated code strings.
4. **Human transitions stay human.** Approval, rejection, rollback, spending, and other sensitive actions require the configured human authority.
5. **Preserve auditability.** Decisions, policy snapshots, action fingerprints, evaluations, and process transitions must remain inspectable.
6. **Do not store private chain-of-thought.** Persist concise decision artifacts, citations, evaluations, and observable outcomes instead.

## Making changes

1. Create a focused branch from `main`.
2. Add or update tests with behavior changes, especially for authorization, identity, tenant isolation, credentials, or route access.
3. Update the relevant canonical documentation when behavior or status changes.
4. Run `npm run verify` before opening a pull request.
5. If the change needs Sanity, a provider, a vault, or public hosting, document the exact operational prerequisite and failure mode.

## Documentation map

- [README](README.md): project overview, current status, setup, and navigation.
- [Product definition](docs/NUERA-QUICKSILVER-PRODUCT.md): target product and modes.
- [Roadmap](docs/NUERA-QUICKSILVER-ROADMAP.md): milestones and gaps.
- [Parity tests](docs/platform/parity-tests.md): release-gate requirements.
- [Glossary](docs/GLOSSARY.md): project terminology.
- [Architecture](ARCHITECTURE.md): current system boundaries and data model.

## Reporting security issues

Do not publish credentials, private datasets, exploit details, or sensitive logs in an issue. Follow the private reporting process described in `SECURITY.md` when available, or contact the repository owner directly.
