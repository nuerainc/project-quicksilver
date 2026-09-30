# Public web search (P-024 foundation)

The Operator can perform citation-bearing public web searches through the
Brave Search API. The `web_search` tool is registered only when
`BRAVE_SEARCH_API_KEY` is present on the server/CLI environment. The credential
is sent in the `X-Subscription-Token` request header, never placed in the URL,
returned to the model, or included in provider error messages. Configure the
key in the trusted Operator host environment; do not add it to browser code or
the repository.

```dotenv
BRAVE_SEARCH_API_KEY=<server-side key>
```

The provider enforces query and result limits, country/language validation,
bounded request time, run cancellation, HTTP(S)-only citations, and bounded
snippet lengths. Tool output includes title, URL, provider date/site metadata,
and snippet; the Operator audit records the query and returned source URLs.
Search content is explicitly marked as untrusted evidence. The
`deep_research` tool accepts 2–5 distinct research queries, executes them in
parallel under the same per-request timeout and cancellation, deduplicates
citations across queries, and returns query coverage, source groups, and any
failed searches. It produces a traceable evidence packet; the governed agent
must synthesize conclusions and surface source conflicts separately. No page
navigation, form submission, downloads, browser profile access, or logged-in
browser automation is performed by this capability.

Brave API request details: [official web search API reference](https://api-dashboard.search.brave.com/api-reference/web/search/post)
and [authentication guide](https://api-dashboard.search.brave.com/documentation/guides/authentication).

Regression coverage is in `packages/operator/src/web-search.test.ts` and runs
with `npm run operator:test`. The tests use a stub fetch implementation and do
not require live credentials or network access.

P-024 remains **partial**. Deep research still needs source-page retrieval,
durable research reports and an end-user research workflow. Browser
automation, including user-authenticated sites, needs a separately governed
browser runtime, session/credential isolation, explicit action approvals, and
operational evidence. A live search smoke test also requires an owner-provided
Brave API key.
