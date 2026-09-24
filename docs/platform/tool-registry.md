# Tool registry

The NQC Kernel exposes a version 1 tool contract through
`@quicksilver/kernel/tools/registry`. Each registration declares its provider,
input schema, access class, and approval requirement. Duplicate identifiers,
invalid contracts, unknown tools, invalid arguments, missing dependencies, and
unapproved side effects are denied before dispatch.

The existing Sanity Context MCP adapter now registers its discovered tools and
runs every invocation through this registry. The current Context Viewer
connections are read-only. Any future effectful provider remains blocked until
an authenticated supervisor approval verifier is connected.

The registry currently exists per agent request and does not persist plugin
versions, publish packages, or provide a marketplace.
