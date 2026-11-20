# Setting up the connectors

The onboarding "Connect" step talks to this API. Three connectors exist, and all of them are **read-only copies**:
nothing is ever written back to Google, Notion or your file.

| Connector | Needs | Works without any setup? |
|---|---|---|
| **.ics file** | nothing | yes, even for guests |
| **Google Calendar (link)** | the calendar's "Secret address in iCal format" | **yes**: no sign-in, no Google Cloud project, no verification |
| **Apple Calendar (link)** | an iCloud "Public Calendar" link (or an exported .ics) | **yes** |
| **Notion** | a read-only integration token (no sign-in: a guest sandbox is enough) | yes |
| **Google sign-in + Calendar (OAuth)** | a Google OAuth client on the API server, **and Google's app verification for public use** | no (optional) |

The site asks the server what it can do (`GET /api/capabilities`) and shows plain explanations when something is off.

---

## 0 · Google and Apple calendars without any approval (use this)

Google makes you verify an app before the public can use `calendar.readonly` sign-in, so Breakpoint does not depend on it. Both calendars can be imported from a link the user already controls:

* **Google**: Google Calendar on a computer → *Settings* → the calendar under *Settings for my calendars* → *Integrate calendar* → copy **Secret address in iCal format** → paste it in Breakpoint. Resetting that link in the same page cuts off access.
* **Apple**: in the Calendar app (or iCloud.com), open the calendar's sharing options → turn on **Public Calendar** → copy the link → paste it in Breakpoint. Turn Public Calendar off again afterwards if you like.

How the server treats these links (`src/calendar/link.ts`, tested in `test/calendarLink.test.ts`): it is the only place the server fetches a URL a user typed, so it is deliberately narrow.

* https only (`webcal://` is converted), only `calendar.google.com` for Google and `*.icloud.com` for Apple; no IP addresses, no ports, no usernames in the URL; look-alike hosts are refused.
* Every redirect is re-checked against the same list (at most 3), so a redirect cannot lead somewhere else. GET only, no cookies or credentials sent, 10 second timeout, 6 MB cap.
* The link is **used once and never stored, logged or echoed back**: it is a secret, because anyone holding it can read that calendar. (The test dumps every database table and proves the secret is in none of them.)
* Events that ended more than 30 days ago are left out (a calendar feed holds every event ever); recurring series are kept. Re-importing the same link updates items instead of duplicating them.

**Why not Apple's "sign in" or CalDAV?** Apple has no OAuth for calendars. The only other route is CalDAV with an *app-specific password*, which cannot be limited to read-only or to calendars (it also opens Mail and Contacts) and would mean Breakpoint holding your Apple credentials. That breaks the "read-only, explicit, minimal" rule, so it is intentionally not offered.

---

## 1 · Try everything with no credentials (the simulator)

```powershell
cd server
npm run sim            # API + a pretend Google + a pretend Notion on http://localhost:8787
```
```powershell
# in another terminal, in the project root
npm run dev            # http://localhost:5173  (the root .env.development already points at :8787)
```

Click **Get started**, then try each connector:

* **Google**: sign in as "Sam Student" on the simulated consent page, allow read-only access, pick a calendar. The simulator speaks the same protocol as the real thing (code + PKCE, RS256-signed ID tokens, `calendarList`, `events`), so nothing changes when you swap in real credentials.
* **Notion**: paste the token the simulator prints (`secret_sim_notion_token_0123456789`).
* **Safety checks**: press *Cancel* on the consent page to see the refusal message. Tick the "Also grant Gmail access" box to simulate Google granting too much: Breakpoint refuses, stores nothing and revokes the grant.

The simulator uses an in-memory database (everything vanishes when you stop it) and a fake identity. It is for development only.

---

## 2 · Google sign-in and Calendar with OAuth (optional)

**What needs Google's verification and what does not.** Signing in with Google only asks for your name and email (non-sensitive), which should not trigger Google's unverified-app warning. Reading the calendar (`calendar.readonly`) is the sensitive part: until the app is verified, that one screen shows "Google hasn't verified this app" and the app is capped at 100 users. So the plan that removes the most friction without waiting for Google is: turn on Google sign-in (real accounts that persist), let the calendar permission work for you and a small group, and keep the private-link import as the path that works for everyone.

Quick path:
1. <https://console.cloud.google.com/> → new project → **APIs & Services → Library** → enable the **Google Calendar API**.
2. **OAuth consent screen** → External → app name Breakpoint, your email as support and developer contact, homepage `https://breakpoint-41x.pages.dev`, privacy `https://breakpoint-41x.pages.dev/privacy`, terms `https://breakpoint-41x.pages.dev/terms`. Scopes: `openid`, `email`, `profile`, `.../auth/calendar.readonly`. Then **Publish app** (so it is not limited to listed test users).
3. **Credentials → Create credentials → OAuth client ID → Web application**, with the two redirect URIs listed in the next section.
4. From `server/`, give the API the two values (each command asks you to paste):
   ```powershell
   npx --yes wrangler@4.50.0 secret put GOOGLE_CLIENT_ID
   ```
   ```powershell
   npx --yes wrangler@4.50.0 secret put GOOGLE_CLIENT_SECRET
   ```
5. The site notices by itself (`google: true` in `/api/capabilities`): the Google option now starts with sign-in, and "use a private link instead" is one tap away.


> Not needed any more: section 0 covers Google Calendar. OAuth is only worth it if you want users to sign in with Google and have Breakpoint keep a long-lived read-only connection. Google requires **app verification** for the sensitive `calendar.readonly` scope before the general public can use it without a warning screen; until then the app is limited to 100 users (and, in *Testing*, only listed test users, with refresh tokens that expire after 7 days).


1. Open <https://console.cloud.google.com/>, create a project, and enable the **Google Calendar API**.
2. **OAuth consent screen** → External. Add the scopes `openid`, `email`, `profile` and `https://www.googleapis.com/auth/calendar.readonly` (that last one is the only calendar permission Breakpoint ever asks for). While the app is in **Testing**, add your own Google account under *Test users*.
3. **Credentials → Create credentials → OAuth client ID → Web application.** Under *Authorized redirect URIs* add both (replace the host with your `API_URL`):
   * `http://localhost:8787/api/auth/google/callback` (sign-in)
   * `http://localhost:8787/api/connections/google/callback` (calendar connection)
4. Copy the client ID and secret into `server/.env` (copy `.env.example` first). **They belong on the server only**, never in the website or in git:
   ```
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   APP_ORIGINS=http://localhost:5173
   API_URL=http://localhost:8787
   ```
5. `npm start` (it loads `.env` automatically) and run `npm run dev` in the project root.

Good to know:

* While a Google app is in **Testing**, Google expires refresh tokens after **7 days**. Breakpoint then asks the user to reconnect ("Google needs you to reconnect").
* `calendar.readonly` is a *sensitive* scope. Letting anyone beyond your test users connect requires Google's app verification. For a hackathon demo, test users are enough.
* The first entry in `APP_ORIGINS` is where Google sends people back to, so list the site you actually use first.

## 3a · "Log in with Notion" (no pasting a token)

This needs a Notion **public** integration. Notion does not review these, so there is no approval to wait for. Once it is set up, connecting Notion is two clicks and Notion itself asks which pages and databases to share.

1. <https://www.notion.so/profile/integrations> → **New integration** → type **Public**.
2. Fill in what it asks for:
   * name: Breakpoint
   * website: `https://breakpoint-41x.pages.dev`
   * privacy policy: `https://breakpoint-41x.pages.dev/privacy`
   * terms of use: `https://breakpoint-41x.pages.dev/terms`
   * redirect URIs: `https://breakpoint-api.nadellasripad11.workers.dev/api/connections/notion/callback` (add `http://localhost:8787/api/connections/notion/callback` too if you run it locally)
   * capabilities: **Read content** only (no insert, no update)
3. Copy the *OAuth client ID* and *OAuth client secret*, and give them to the API (from `server/`; each command asks you to paste the value):
   ```powershell
   npx --yes wrangler@4.50.0 secret put NOTION_CLIENT_ID
   ```
   ```powershell
   npx --yes wrangler@4.50.0 secret put NOTION_CLIENT_SECRET
   ```
4. `GET /api/capabilities` now shows `notionLogin: true` and the site's Notion option becomes "Log in with Notion". Pasting a token stays available as a fallback.

## 3 · Real Notion

No server setup is needed (Notion connects with a token the user pastes, not OAuth).

1. <https://www.notion.so/profile/integrations> → **New integration** (type: internal).
2. Under **Capabilities** tick **Read content** and nothing else.
3. Copy the *Internal Integration Secret*.
4. Open your task database in Notion → **•••** → **Connections** → add the integration. (Notion only lets an integration see databases that were shared with it.)
5. In Breakpoint: Get started → Notion → paste the token.

The token is stored encrypted (AES-256-GCM, key from `TOKEN_ENC_KEY`) and is only used to read the database you pick. Removing the integration in Notion revokes it there too.

---

## 4 · Putting it online

The API is hosted on a Cloudflare Worker with D1 and the site is on Cloudflare Pages. How it is set up, how to redeploy, how to add Google credentials to the hosted API, and the limits to know are all in [HOSTING.md](HOSTING.md).

---

## 5 · What the user sees (and what each message means)

| Situation | What the sheet says |
|---|---|
| No `VITE_API_URL` in the build | A toast: connectors switch on once the server is connected. The flow carries on. |
| API unreachable | A toast: couldn't reach the server, nothing imported. The flow carries on. |
| Google not configured on the API | "Google Calendar isn't switched on here yet", with a button to import an .ics instead. |
| Guest picks Google | "Sign in to connect…" (sign-in shares only name + email). Anything already added comes along. |
| Guest picks Notion | Straight to the token step: no sign-in needed. The token is stored encrypted and deleted with the guest sandbox (24 h) or on disconnect. |
| Signed in, not connected | "Allow read-only access": lists what Breakpoint can and cannot do, then Google's own consent screen. |
| User presses Cancel at Google | "You chose not to share, so nothing was connected." |
| Google grants more than asked | Refused, nothing stored, grant revoked: "Google offered more access than Breakpoint asked for." |
| Token stale | "Google needs you to reconnect" / "Notion no longer accepts that token." |

Redirect convention: the site sends Google back to `/?ob=google` (or `ob=notion`); on load it sees `?ob=`, `?connected=google`, `?auth_error=` or `?connect_error=`, reopens the onboarding on the Connect step and shows the right sheet. The URL is cleaned straight away.
