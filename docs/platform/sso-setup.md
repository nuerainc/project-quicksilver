# Single sign-on (P-108)

The sign-in flow is implemented and tested: authorization code with PKCE, a
nonce and a state bound to the browser, an ID token verified against the
issuer's signing keys, and a server-side session that stores only a digest of
its token. What it needs is an app registration at an identity provider and six
settings. This page has the checklist for **Google** (the least setup: any Google
account works) and for **Microsoft Entra ID**; any OIDC provider works the same way.

Two rules of the design to know up front:

- **Roles never come from the identity provider.** A person's roles are the ones
  an owner writes into `QUICKSILVER_OIDC_USERS`, matched on the exact issuer and
  subject. A token cannot grant itself a role.
- **HTTPS only.** The issuer and callback must be HTTPS, so the first test runs
  on the deployed site, not on localhost.

## 1. Register the app

### Google

1. https://console.cloud.google.com → project dropdown → **New project**, `Quicksilver`.
2. **APIs & Services → OAuth consent screen** (newer layout: **Google Auth Platform → Get started**):
   app name `Quicksilver`, your support and contact email, audience **External**.
   Under **Audience → Test users**, add every Google address that will sign in.
   Leave the app in **Testing**: only listed test users can sign in. Google shows
   a "hasn't verified this app" warning; choose **Advanced → Continue**.
3. **Clients** (or **Credentials → Create credentials → OAuth client ID**):
   type **Web application**, authorized redirect URI
   `https://<production-web-address>/api/auth/oidc/callback` (exact, and the
   production domain: previews have other addresses).
4. Copy the **Client ID** and the **Client secret** (the secret may be shown only at creation).

Issuer for step 2: `https://accounts.google.com`. A Google subject is a stable
number for the person, the same in every app. Anyone with a Google account can
authenticate to Google; only the subjects on your allowlist get in.

### Microsoft Entra ID (admin center)

1. **Entra ID → App registrations → New registration.**
2. Name `Quicksilver`; supported account types **Accounts in this organizational
   directory only (single tenant)**.
3. Redirect URI: platform **Web**, `https://<production-web-address>/api/auth/oidc/callback`.
   It must match `OIDC_REDIRECT_URI` exactly, and it must be the production
   domain: preview deployments have different addresses.
4. From **Overview**, note the **Application (client) ID** and **Directory (tenant) ID**.
5. **Certificates & secrets → New client secret.** Copy the **Value** at once (it
   is shown once). Note its expiry: when it lapses, sign-in stops until a new
   secret is set. Put a reminder in a calendar.

## 2. Set the environment (Vercel project → Settings → Environment Variables)

Set these for the **Production** environment only, then redeploy.

| Variable | Value |
|---|---|
| `OIDC_ISSUER` | Google: `https://accounts.google.com`. Entra: `https://login.microsoftonline.com/<directory-id>/v2.0` |
| `OIDC_CLIENT_ID` | Google: the Client ID. Entra: the Application (client) ID |
| `OIDC_CLIENT_SECRET` | the client secret (Entra: the secret **Value**); mark it Sensitive. At least 8 characters |
| `OIDC_REDIRECT_URI` | the exact callback URL from step 1 |
| `QUICKSILVER_TENANT_ID` | Only if it is already set: leave it as it is. If it is not set the web app uses the tenant `default`; do **not** add it just for sign-in, because data already saved under `default` would no longer be found |
| `QUICKSILVER_OIDC_USERS` | the allowlist (step 3) |

Never put the client secret in a chat, a ticket or the repository.

## 3. The allowlist, and finding your subject

`QUICKSILVER_OIDC_USERS` is a JSON array, one row per person:

```json
[
  { "issuer": "<the same value as OIDC_ISSUER>",
    "subject": "<the person's subject>",
    "tenantId": "<the value of QUICKSILVER_TENANT_ID, or default if it is not set>",
    "principalId": "entity-founder",
    "roles": ["viewer"],
    "displayName": "Founder" }
]
```

A person's **subject** is not shown in either console (and Entra gives each app
its own subject per person). To find yours:

1. Set `QUICKSILVER_OIDC_USERS` to any valid row (for example one for a made-up
   subject) so the allowlist parses, and redeploy.
2. Sign in once. You are refused, by design, and sent back with `?auth=failed`.
3. In **Vercel → the project → Logs**, search for `[oidc] login refused`. The line
   names the verified `issuer` and `subject` and a reason (`unmapped` or
   `misconfigured`). It contains nothing else: no token, code or secret.
4. Put that subject in your row, redeploy, and sign in again.

Start with `["viewer"]` for the first successful login, then raise roles once
you have seen it work. Built-in roles include `viewer`, `operator`, `developer`,
`supervisor`, `auditor`, `tenant-admin` and `intent-provider`; the founder
typically holds `intent-provider` and `supervisor`.

## 4. Check it

- `GET /api/auth/session` returns your principal when signed in.
- Removing your row and redeploying revokes access without waiting for the
  session to expire.
- `/api/auth/logout` revokes the server-side session.

## Not covered yet

A console control to start sign-in, evidence that the session store persists
across a deploy, and a recorded live callback test: P-108 stays partial until
those exist.
