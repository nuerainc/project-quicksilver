# Authorization decision audit

Quicksilver records allow and deny decisions made by the web API and the host's kernel `AccessController`.

## Web API

The web API appends an `authorizationDecisionAudit` document to its dedicated Sanity project before it uses the authorization result. Records contain the tenant, route, required permissions, actor ID when authenticated, outcome, HTTP status, decision code, and timestamp. They do not contain bearer tokens, token digests, or request bodies. A failed write returns `503` and blocks the protected operation. The Studio schema is read-only in the editing UI; only the service's create operation is used by the app.

The deployment needs the dedicated project's `NEXT_PUBLIC_SANITY_PROJECT_ID` and `SANITY_WRITE_TOKEN`. The existing project safety check continues to reject the public Sanity Challenge dataset.

## Host and CLI

The host appends each kernel access decision to a JSONL file and synchronously flushes it before returning the decision. The file records the full RBAC decision, including permission, actor, tenant, resource identifiers, decision time, and refusal reasons. An allowed decision becomes a denial if the audit append fails.

The host derives the audit filename beside the configured vault file, or beside a file-backed run store. For memory-backed stores without a vault, set `QUICKSILVER_AUTHORIZATION_AUDIT_PATH`. Production deployments must place the audit file and its `.head` checkpoint on durable storage. Run only one host writer against a given path. Host startup verifies the sequence, hash chain, and head checkpoint; detected edits or truncation stop startup.

## Verification and limits

`FileAuthorizationAuditStore` tests exercise restart replay, tampering, truncation, and failed-sink denial. Web audit tests exercise immutable document creation, allow/deny persistence, and fail-closed behavior. These controls provide an application audit trail; they do not establish regulatory compliance, protect against a privileged operator replacing both the JSONL file and checkpoint, or encrypt host audit records at rest.
