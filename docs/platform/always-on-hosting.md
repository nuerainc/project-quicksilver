# Always-on hosting (M5)

M2 runs the host on the founder's computer. That is enough for the Onboard
pilot. The Genesis run needs the host up day and night, because payment
providers send webhooks to a public address. These templates are ready. None
is deployed yet: that waits on the entity decision and the payment accounts.

## Choose one

| Option | Files | Good for | Rough cost |
|---|---|---|---|
| Render (managed) | `deploy/render.yaml` | Least operations work; managed Postgres, TLS and restarts | A starter web service, a small Postgres and a 1 GB disk; check Render's current prices |
| Any small VPS | `deploy/docker-compose.yml` + `deploy/docker-compose.public.yml` | Full control; Caddy handles TLS | A small VPS |
| Founder's computer (today) | `deploy/quicksilver.local.example.json` | Onboard pilot | None; no public webhooks |

Hosting is compute, so its cost is **capital** in the Genesis money ledger
(`kind: compute`, `category: hosting`), charged against the $500 budget.

## Render

1. In Render, create a Blueprint from this repository with the blueprint
   path `deploy/render.yaml`. The service has `autoDeploy: false`, so
   nothing deploys until you choose to.
2. Add the host config as a **secret file** named `quicksilver.host.json`.
   Start from `deploy/quicksilver.host.example.json` and set
   `http.host: "0.0.0.0"`, `http.port: 8787` and `store.kind: "postgres"`.
3. Enter each `sync: false` value in the dashboard. Generate the vault key
   locally (`npm run host -- vault keygen`) and paste it there; it never
   enters the repository.
4. Deploy. Check `/healthz` and `/readyz`, then `GET /api/whoami` with your
   token.
5. Payment webhooks go to `https://<service>.onrender.com/webhooks/<id>`.
   Their signing secrets live in the vault (`vault:<name>`).

## VPS with Docker

```bash
cp deploy/quicksilver.host.example.json deploy/quicksilver.host.json   # edit
export QUICKSILVER_DOMAIN=host.example.com      # DNS A record → the server
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.public.yml up -d --build
```

Caddy gets and renews the certificate. The host is reachable only through
Caddy. The file store and vault live in the `hostdata` volume, and runs live
in Postgres.

## Before going public

- **Principals:** keep human tokens in `QUICKSILVER_PRINCIPALS`, and give
  agents the `agent-worker` role only.
- **Metrics:** leave `http.metricsPublic` off. Metrics then need `audit:read`.
- **Backups:** back up the Postgres database, the `/data` volume (vault file,
  intent data, money ledger) and the vault key, each separately.
- **Console:** `/console` is served when the intent API is on. It holds no
  data, and every call uses the viewer's own token.
- **Boundaries:**
  - The legacy Sanity project and the Challenge endpoints stay refused.
  - The public Sanity Challenge instance stays synthetic.
  - AMP materials are never connected.
