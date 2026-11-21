# hosting breakpoint

## what is deployed right now

| piece | where | cost |
|---|---|---|
| website | cloudflare pages, <https://breakpoint-41x.pages.dev> | free |
| api | cloudflare worker `breakpoint-api`, <https://breakpoint-api.nadellasripad11.workers.dev> | free tier |
| database | cloudflare d1 `breakpoint-db` (sqlite in the cloud) | free tier |
| scheduling engine | bundled into the website (rescue, the challenge) **and** running in the worker (saved schedules) | n/a |

the worker is the same hono app and the same engine as the node server (`src/app.ts`); only the entry point (`src/worker.ts`) and the database
layer (`src/store/d1.ts`) differ. the whole api test suite also runs against the d1 store: `npm run test:d1`.

live checks that passed after deploying: the 15-step smoke test (`BASE_URL=... npm run smoke`), a 600-event `.ics` import in about 300 ms that re-imports idempotently, and notion refusing a fake token with a clear message (`BASE_URL=... node scripts/live-check.ts`).

## what works without any sign-in

* **.ics import**: yes, as a guest.
* **google calendar and apple calendar by link**: yes, as a guest (no oauth app, no google verification; see setup-connectors.md section 0).
* **notion**: yes, as a guest: by pasting a token, or with "log in with notion" once you have added a public integration (setup-connectors.md 3a). the user pastes a read-only integration token; it is stored encrypted and deleted when they disconnect or their guest sandbox expires (24 hours).
* **rescue my day** and **can you save this day?**: yes. they run in the browser. "my schedule" inside rescue reads the visitor's own imported schedule from the api.
* **google sign-in (oauth)**: optional, and needs a google oauth client plus google's verification for public use (below). not needed for google calendar: the link method works today.

## redeploying

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

`cf:deploy` pins `wrangler@4.50.0` on purpose. with wrangler 4.165 the upload worked but the last step (switching on the workers.dev address) failed with "this worker does not exist" (code 10007) on this account; 4.50.0 completes it. try a newer one later if you like.

the site reads the api address from `.env.production` (`VITE_API_URL`) when it is built. the api reads its settings from `server/wrangler.jsonc` (public values) and worker secrets (private values). set or change a secret with:

```powershell
cd server
"the-value" | npx --yes wrangler@4.50.0 secret put NAME
```

`TOKEN_ENC_KEY` (encrypts stored tokens) is already set. it was generated at random and has not been shown anywhere. if you ever rotate it, tokens stored under the old key become unreadable and those users simply reconnect.

## notion (what you do)

no server setup is needed. in the site: **get started -> notion**, then paste a token.

1. open <https://www.notion.so/profile/integrations> and create a new **internal** integration.
2. under *capabilities*, tick **read content** and nothing else.
3. copy the *internal integration secret*.
4. in notion, open your task database -> **•••** -> **connections** -> add the integration (notion only lets an integration see databases that were shared with it).
5. paste the token in the site, pick the database, preview, import.

## google sign-in with oauth (optional: only if you ever want it)

1. <https://console.cloud.google.com/> -> new project -> enable the **google calendar api**.
2. oauth consent screen -> external -> scopes `openid`, `email`, `profile`, `.../auth/calendar.readonly`. while in *testing*, add your own account as a test user (google expires refresh tokens after 7 days in testing).
3. credentials -> oauth client id -> web application -> authorized redirect uris:
   * `https://breakpoint-api.nadellasripad11.workers.dev/api/auth/google/callback`
   * `https://breakpoint-api.nadellasripad11.workers.dev/api/connections/google/callback`
4. give the worker the two values (they are secrets, never put them in the website or in git):
   ```powershell
   cd server
   "CLIENT_ID" | npx --yes wrangler@4.50.0 secret put GOOGLE_CLIENT_ID
   "CLIENT_SECRET" | npx --yes wrangler@4.50.0 secret put GOOGLE_CLIENT_SECRET
   ```
5. nothing else: `/api/capabilities` turns `google` on by itself and the site's google option starts working.

## should we use supabase instead of google? no, not now. here is why.

"instead of google" mixes two different jobs:

* **google sign-in** (who you are). supabase auth could replace this.
* **google calendar import** (reading someone's calendar). supabase **cannot** replace this. reading a google calendar always needs google's own oauth consent for `calendar.readonly` and a google cloud oauth client, whatever you use for login. supabase's "google provider" is the same google cloud client underneath, and it only hands you google's tokens at sign-in time; you would have to catch and store the refresh token yourself, which is exactly what this api already does, tested.

and you do not need sign-in for the demo any more: `.ics` and notion work as guests, and rescue and the challenge run in the browser.

what switching would cost, for no gain you need this week:

* replacing the database means rewriting the store for postgres and re-verifying all 110 tests. d1 already gives you a free hosted database on the platform you use.
* replacing sign-in means a new token-verification path plus tests. magic-link email on supabase's built-in mailer is limited to a handful of emails per hour, so a judging crowd would need custom smtp anyway; github or google login each need their own provider app.

**when supabase would be the right call**: after the hackathon, if you want real long-lived accounts (email or github login), a dashboard to browse your data, and row-level security. the smallest safe way to add it, keeping everything else:

1. create a supabase project. *authentication -> providers*: enable github (create an oauth app on github with callback `https://<project-ref>.supabase.co/auth/v1/callback`) and/or email (then add custom smtp, e.g. resend).
2. add an endpoint `POST /api/auth/supabase` that verifies the supabase access token with `jose` against `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`, maps its `sub` and email to a breakpoint user, and starts our normal session (about 60 lines plus tests; the guest-to-account merge already exists).
3. in the site, use `supabase-js` `signInWithOAuth`, then send the access token to that endpoint.
4. keep the data in d1, and keep google only for the calendar connector.

say the word and i will build that.

## limits to know

* **workers free plan**: 100,000 requests a day, and a small per-request cpu allowance and a cap on queries per request. imports are written as 3 queries however many events there are (that is why a 600-event import works), and the heaviest engine call i tried (200 chaos scenarios) ran fine. if you ever see error 1102 ("cpu limit exceeded") that is the plan limit; workers paid ($5 a month) lifts it.
* **rate limiting** is in memory per worker instance, so it is best-effort. for real abuse protection add a cloudflare rate-limiting rule in the dashboard.
* **preview urls are off** (`preview_urls: false`) so only the real address serves the api.
* **cors** allows only the origins in `APP_ORIGINS`. if you add a custom domain for the site, add it there (comma separated) and redeploy.
* the website and api are on different sites, so browsers block third-party cookies. the site keeps its session token in `sessionStorage` and sends it as a bearer token (documented in frontend.md); this is already how it works.

## running it on a normal node host instead

anything with node 24 and a persistent disk works: `npm start` with `server/.env` (see `.env.example`). the worker is just a different front door to the same code.
