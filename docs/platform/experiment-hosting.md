# Experiment hosting (P-026)

Genesis experiments often need a page: a landing page, an offer, a signup
form's replacement. This is the contract for hosting those pages and taking
them down when the experiment ends. It is built contract-first: the model, the
checks, the stores and the routes exist and are tested, and the one deploy
adapter that ships writes files to a directory. It **deploys nothing and serves
nothing**. A real target is a new adapter, chosen later (Azure is the chosen
host; no adapter exists yet).

Nothing here charges, spends or moves money. What a host costs belongs in the
ledger as compute, recorded through the usual money route.

## Turning it on

Hosting needs a Genesis run, because it uses the run's review gate and its
experiments. It is off unless `QUICKSILVER_HOSTING_DIR` is set; that directory
is where the file adapter writes `<tenant>/<site>/live/` for a **separate**
static server to serve. Never serve it from the API's own origin: a hosted page
must not share an origin with the API. Release history is kept next to the
Genesis data (`<dir>/<tenant>/hosting/<site>/`).

## What a site is

A site is a set of static files published in numbered releases.

- **Releases are immutable.** Files and digest are fixed; a change is a new
  version. The digest is a sha256 over the sorted file list.
- **History is append-only.** Every create, stage, publish, supersede and
  teardown is an event on the site, with who and when. A stored site's events
  only grow.
- **Rollback** is publishing an older version again; it is recorded as one.
- **Teardown is final.** A torn-down site accepts nothing more and its id is not
  reusable.

## Static only

A release must contain `index.html`; at most 60 files, 1 MiB each, 5 MiB total;
`html`, `css`, `txt`, `png`, `jpg`, `webp` and `ico` only. No scripts, SVG,
frames, objects, forms, `<base>`, meta refresh, inline event handlers or
`javascript:` links, and no external loads from CSS. Images must really be
images. This is a lint that refuses the obvious, not a sanitizer.

## Routes

| Route | Who | What |
|---|---|---|
| `GET /api/hosting/sites` | `decision:read` | Sites and their releases |
| `POST /api/hosting/sites` `{ id, title, experimentId? }` | provider or proposer (an agent may) | Create a site, optionally tied to an experiment |
| `GET /api/hosting/sites/:id` | `decision:read` | One site with its event history |
| `POST /api/hosting/sites/:id/releases` `{ files, note? }` | provider or proposer | Stage a release. A record only; reports which pages still need a review |
| `POST /api/hosting/sites/:id/releases/:version/publish` | a human provider | Make it live |
| `POST /api/hosting/sites/:id/teardown` `{ reason }` | a human provider | Take the site down for good |
| `POST /api/hosting/reconcile` | a human provider | Tear down sites whose experiment ended |

Files are `{ path, text }` for html, css and txt, and `{ path, base64 }` for images.

## What stands between a release and the public

Publishing is the only step that touches the deploy adapter. In order:

1. A human does it. Staging is a record, and an agent can stage but never publish.
2. Every HTML and text file has a passing review of its **exact content** under
   the run's WAES policy, the same gate as any customer-facing text, and the
   reviewer is not whoever staged it. CSS and images are not reviewed.
3. A site tied to an experiment can only go live while that experiment has not
   ended (a draft, running or held experiment counts as not ended).
4. The stored files still match the release digest.

A failed deploy changes nothing and can be retried. A failed teardown leaves
the site recorded as active.

## When an experiment ends

When an evaluation or a human decision ends an experiment (killed, scaled or
completed), the Genesis route tells hosting and the sites tied to that
experiment come down, recorded as torn down by `kernel`. A failure there is
swallowed so the verdict still stands, and `reconcile` finds anything missed.
Sites not tied to an experiment are never touched by this.

## Known gaps (v1)

A real deploy target (Azure App Service, Vercel or a static host), custom
domains, apps and services (only static sites), a Sanity-backed store (file-only
like the pending queue), a console panel, and live evidence.
