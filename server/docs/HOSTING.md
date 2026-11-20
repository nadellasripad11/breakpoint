# Hosting Breakpoint

## What is deployed right now

| Piece | Where | Cost |
|---|---|---|
| Website | Cloudflare Pages, <https://breakpoint-41x.pages.dev> | free |
| API | Cloudflare Worker `breakpoint-api`, <https://breakpoint-api.nadellasripad11.workers.dev> | free tier |
| Database | Cloudflare D1 `breakpoint-db` (SQLite in the cloud) | free tier |
| Scheduling engine | bundled into the website (Rescue, the challenge) **and** running in the Worker (saved schedules) | n/a |

The Worker is the same Hono app and the same engine as the Node server (`src/app.ts`); only the entry point (`src/worker.ts`) and the database
layer (`src/store/d1.ts`) differ. The whole API test suite also runs against the D1 store: `npm run test:d1`.

Live checks that passed after deploying: the 15-step smoke test (`BASE_URL=... npm run smoke`), a 600-event `.ics` import in about 300 ms that re-imports idempotently, and Notion refusing a fake token with a clear message (`BASE_URL=... node scripts/live-check.ts`).

## What works without any sign-in

* **.ics import**: yes, as a guest.
* **Google Calendar and Apple Calendar by link**: yes, as a guest (no OAuth app, no Google verification; see SETUP-CONNECTORS.md section 0).
* **Notion**: yes, as a guest. The user pastes a read-only integration token; it is stored encrypted and deleted when they disconnect or their guest sandbox expires (24 hours).
* **Rescue my day** and **Can you save this day?**: yes. They run in the browser. "My schedule" inside Rescue reads the visitor's own imported schedule from the API.
* **Google sign-in (OAuth)**: optional, and needs a Google OAuth client plus Google's verification for public use (below). Not needed for Google Calendar: the link method works today.

## Redeploying

```powershell
# website (from the project root)
npm run build
cd $env:TEMP; node C:\Users\nadel\breakpoint\node_modules\wrangler\bin\wrangler.js pages deploy C:\Users\nadel\breakpoint\dist --project-name breakpoint --branch main
```
```powershell
# API (from server/)
npm run cf:migrate     # only when a new file appears in server/migrations
npm run cf:deploy
```

`cf:deploy` pins `wrangler@4.50.0` on purpose. With wrangler 4.165 the upload worked but the last step (switching on the workers.dev address) failed with "This Worker does not exist" (code 10007) on this account; 4.50.0 completes it. Try a newer one later if you like.

The site reads the API address from `.env.production` (`VITE_API_URL`) when it is built. The API reads its settings from `server/wrangler.jsonc` (public values) and Worker secrets (private values). Set or change a secret with:

```powershell
cd server
"the-value" | npx --yes wrangler@4.50.0 secret put NAME
```

`TOKEN_ENC_KEY` (encrypts stored tokens) is already set. It was generated at random and has not been shown anywhere. If you ever rotate it, tokens stored under the old key become unreadable and those users simply reconnect.

## Notion (what you do)

No server setup is needed. In the site: **Get started → Notion**, then paste a token.

1. Open <https://www.notion.so/profile/integrations> and create a new **internal** integration.
2. Under *Capabilities*, tick **Read content** and nothing else.
3. Copy the *Internal Integration Secret*.
4. In Notion, open your task database → **•••** → **Connections** → add the integration (Notion only lets an integration see databases that were shared with it).
5. Paste the token in the site, pick the database, preview, import.

## Google sign-in with OAuth (optional: only if you ever want it)

1. <https://console.cloud.google.com/> → new project → enable the **Google Calendar API**.
2. OAuth consent screen → External → scopes `openid`, `email`, `profile`, `.../auth/calendar.readonly`. While in *Testing*, add your own account as a test user (Google expires refresh tokens after 7 days in Testing).
3. Credentials → OAuth client ID → Web application → Authorized redirect URIs:
   * `https://breakpoint-api.nadellasripad11.workers.dev/api/auth/google/callback`
   * `https://breakpoint-api.nadellasripad11.workers.dev/api/connections/google/callback`
4. Give the Worker the two values (they are secrets, never put them in the website or in git):
   ```powershell
   cd server
   "CLIENT_ID" | npx --yes wrangler@4.50.0 secret put GOOGLE_CLIENT_ID
   "CLIENT_SECRET" | npx --yes wrangler@4.50.0 secret put GOOGLE_CLIENT_SECRET
   ```
5. Nothing else: `/api/capabilities` turns `google` on by itself and the site's Google option starts working.

## Should we use Supabase instead of Google? No, not now. Here is why.

"Instead of Google" mixes two different jobs:

* **Google sign-in** (who you are). Supabase Auth could replace this.
* **Google Calendar import** (reading someone's calendar). Supabase **cannot** replace this. Reading a Google Calendar always needs Google's own OAuth consent for `calendar.readonly` and a Google Cloud OAuth client, whatever you use for login. Supabase's "Google provider" is the same Google Cloud client underneath, and it only hands you Google's tokens at sign-in time; you would have to catch and store the refresh token yourself, which is exactly what this API already does, tested.

And you do not need sign-in for the demo any more: `.ics` and Notion work as guests, and Rescue and the challenge run in the browser.

What switching would cost, for no gain you need this week:

* Replacing the database means rewriting the store for Postgres and re-verifying all 110 tests. D1 already gives you a free hosted database on the platform you use.
* Replacing sign-in means a new token-verification path plus tests. Magic-link email on Supabase's built-in mailer is limited to a handful of emails per hour, so a judging crowd would need custom SMTP anyway; GitHub or Google login each need their own provider app.

**When Supabase would be the right call**: after the hackathon, if you want real long-lived accounts (email or GitHub login), a dashboard to browse your data, and row-level security. The smallest safe way to add it, keeping everything else:

1. Create a Supabase project. *Authentication → Providers*: enable GitHub (create an OAuth app on GitHub with callback `https://<project-ref>.supabase.co/auth/v1/callback`) and/or Email (then add custom SMTP, e.g. Resend).
2. Add an endpoint `POST /api/auth/supabase` that verifies the Supabase access token with `jose` against `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`, maps its `sub` and email to a Breakpoint user, and starts our normal session (about 60 lines plus tests; the guest-to-account merge already exists).
3. In the site, use `supabase-js` `signInWithOAuth`, then send the access token to that endpoint.
4. Keep the data in D1, and keep Google only for the Calendar connector.

Say the word and I will build that.

## Limits to know

* **Workers free plan**: 100,000 requests a day, and a small per-request CPU allowance and a cap on queries per request. Imports are written as 3 queries however many events there are (that is why a 600-event import works), and the heaviest engine call I tried (200 chaos scenarios) ran fine. If you ever see error 1102 ("CPU limit exceeded") that is the plan limit; Workers Paid ($5 a month) lifts it.
* **Rate limiting** is in memory per Worker instance, so it is best-effort. For real abuse protection add a Cloudflare rate-limiting rule in the dashboard.
* **Preview URLs are off** (`preview_urls: false`) so only the real address serves the API.
* **CORS** allows only the origins in `APP_ORIGINS`. If you add a custom domain for the site, add it there (comma separated) and redeploy.
* The website and API are on different sites, so browsers block third-party cookies. The site keeps its session token in `sessionStorage` and sends it as a Bearer token (documented in FRONTEND.md); this is already how it works.

## Running it on a normal Node host instead

Anything with Node 24 and a persistent disk works: `npm start` with `server/.env` (see `.env.example`). The Worker is just a different front door to the same code.
