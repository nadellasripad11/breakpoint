# setting up the connectors

the onboarding "connect" step talks to this api. three connectors exist, and all of them are **read-only copies**:
nothing is ever written back to google, notion or your file.

| connector | needs | works without any setup? |
|---|---|---|
| **.ics file** | nothing | yes, even for guests |
| **google calendar (link)** | the calendar's "secret address in ical format" | **yes**: no sign-in, no google cloud project, no verification |
| **apple calendar (link)** | an icloud "public calendar" link (or an exported .ics) | **yes** |
| **notion** | a read-only integration token (no sign-in: a guest sandbox is enough) | yes |
| **google sign-in + calendar (oauth)** | a google oauth client on the api server, **and google's app verification for public use** | no (optional) |

the site asks the server what it can do (`GET /api/capabilities`) and shows plain explanations when something is off.

---

## 0 · google and apple calendars without any approval (use this)

google makes you verify an app before the public can use `calendar.readonly` sign-in, so breakpoint does not depend on it. both calendars can be imported from a link the user already controls:

* **google**: google calendar on a computer -> *settings* -> the calendar under *settings for my calendars* -> *integrate calendar* -> copy **secret address in ical format** -> paste it in breakpoint. resetting that link in the same page cuts off access.
* **apple**: in the calendar app (or icloud.com), open the calendar's sharing options -> turn on **public calendar** -> copy the link -> paste it in breakpoint. turn public calendar off again afterwards if you like.

how the server treats these links (`src/calendar/link.ts`, tested in `test/calendarLink.test.ts`): it is the only place the server fetches a url a user typed, so it is deliberately narrow.

* https only (`webcal://` is converted), only `calendar.google.com` for google and `*.icloud.com` for apple; no ip addresses, no ports, no usernames in the url; look-alike hosts are refused.
* every redirect is re-checked against the same list (at most 3), so a redirect cannot lead somewhere else. get only, no cookies or credentials sent, 10 second timeout, 6 mb cap.
* the link is **used once and never stored, logged or echoed back**: it is a secret, because anyone holding it can read that calendar. (the test dumps every database table and proves the secret is in none of them.)
* events that ended more than 30 days ago are left out (a calendar feed holds every event ever); recurring series are kept. re-importing the same link updates items instead of duplicating them.

**why not apple's "sign in" or caldav?** apple has no oauth for calendars. the only other route is caldav with an *app-specific password*, which cannot be limited to read-only or to calendars (it also opens mail and contacts) and would mean breakpoint holding your apple credentials. that breaks the "read-only, explicit, minimal" rule, so it is intentionally not offered.

---

## 1 · try everything with no credentials (the simulator)

```powershell
cd server
npm run sim            # API + a pretend Google + a pretend Notion on http://localhost:8787
```
```powershell
# in another terminal, in the project root
npm run dev            # http://localhost:5173  (the root .env.development already points at :8787)
```

click **get started**, then try each connector:

* **google**: sign in as "sam student" on the simulated consent page, allow read-only access, pick a calendar. the simulator speaks the same protocol as the real thing (code + pkce, rs256-signed id tokens, `calendarList`, `events`), so nothing changes when you swap in real credentials.
* **notion**: paste the token the simulator prints (`secret_sim_notion_token_0123456789`).
* **safety checks**: press *cancel* on the consent page to see the refusal message. tick the "also grant gmail access" box to simulate google granting too much: breakpoint refuses, stores nothing and revokes the grant.

the simulator uses an in-memory database (everything vanishes when you stop it) and a fake identity. it is for development only.

---

## 2 · google sign-in and calendar with oauth (optional)

**what needs google's verification and what does not.** signing in with google only asks for your name and email (non-sensitive), which should not trigger google's unverified-app warning. reading the calendar (`calendar.readonly`) is the sensitive part: until the app is verified, that one screen shows "google hasn't verified this app" and the app is capped at 100 users. so the plan that removes the most friction without waiting for google is: turn on google sign-in (real accounts that persist), let the calendar permission work for you and a small group, and keep the private-link import as the path that works for everyone.

quick path:
1. <https://console.cloud.google.com/> -> new project -> **apis & services -> library** -> enable the **google calendar api**.
2. **oauth consent screen** -> external -> app name breakpoint, your email as support and developer contact, homepage `https://breakpoint-41x.pages.dev`, privacy `https://breakpoint-41x.pages.dev/privacy`, terms `https://breakpoint-41x.pages.dev/terms`. scopes: `openid`, `email`, `profile`, `.../auth/calendar.readonly`. then **publish app** (so it is not limited to listed test users).
3. **credentials -> create credentials -> oauth client id -> web application**, with the two redirect uris listed in the next section.
4. from `server/`, give the api the two values (each command asks you to paste):
   ```powershell
   npx --yes wrangler@4.50.0 secret put GOOGLE_CLIENT_ID
   ```
   ```powershell
   npx --yes wrangler@4.50.0 secret put GOOGLE_CLIENT_SECRET
   ```
5. the site notices by itself (`google: true` in `/api/capabilities`): the google option now starts with sign-in, and "use a private link instead" is one tap away.


> not needed any more: section 0 covers google calendar. oauth is only worth it if you want users to sign in with google and have breakpoint keep a long-lived read-only connection. google requires **app verification** for the sensitive `calendar.readonly` scope before the general public can use it without a warning screen; until then the app is limited to 100 users (and, in *testing*, only listed test users, with refresh tokens that expire after 7 days).


1. open <https://console.cloud.google.com/>, create a project, and enable the **google calendar api**.
2. **oauth consent screen** -> external. add the scopes `openid`, `email`, `profile` and `https://www.googleapis.com/auth/calendar.readonly` (that last one is the only calendar permission breakpoint ever asks for). while the app is in **testing**, add your own google account under *test users*.
3. **credentials -> create credentials -> oauth client id -> web application.** under *authorized redirect uris* add both (replace the host with your `API_URL`):
   * `http://localhost:8787/api/auth/google/callback` (sign-in)
   * `http://localhost:8787/api/connections/google/callback` (calendar connection)
4. copy the client id and secret into `server/.env` (copy `.env.example` first). **they belong on the server only**, never in the website or in git:
   ```
   GOOGLE_CLIENT_ID=...apps.googleusercontent.com
   GOOGLE_CLIENT_SECRET=...
   APP_ORIGINS=http://localhost:5173
   API_URL=http://localhost:8787
   ```
5. `npm start` (it loads `.env` automatically) and run `npm run dev` in the project root.

good to know:

* while a google app is in **testing**, google expires refresh tokens after **7 days**. breakpoint then asks the user to reconnect ("google needs you to reconnect").
* `calendar.readonly` is a *sensitive* scope. letting anyone beyond your test users connect requires google's app verification. for a hackathon demo, test users are enough.
* the first entry in `APP_ORIGINS` is where google sends people back to, so list the site you actually use first.

## 3a · "log in with notion" (no pasting a token)

> shortcut for giving the api the two values: from `server/`, run `npm run secrets:notion` (or `npm run secrets:google`). it asks you to paste each one.

this needs a notion **public** integration. notion does not review these, so there is no approval to wait for. once it is set up, connecting notion is two clicks and notion itself asks which pages and databases to share.

1. <https://www.notion.so/profile/integrations> -> **new integration** -> type **public**.
2. fill in what it asks for:
   * name: breakpoint
   * website: `https://breakpoint-41x.pages.dev`
   * privacy policy: `https://breakpoint-41x.pages.dev/privacy`
   * terms of use: `https://breakpoint-41x.pages.dev/terms`
   * redirect uris: `https://breakpoint-api.nadellasripad11.workers.dev/api/connections/notion/callback` (add `http://localhost:8787/api/connections/notion/callback` too if you run it locally)
   * capabilities: **read content** only (no insert, no update)
3. copy the *oauth client id* and *oauth client secret*, and give them to the api (from `server/`; each command asks you to paste the value):
   ```powershell
   npx --yes wrangler@4.50.0 secret put NOTION_CLIENT_ID
   ```
   ```powershell
   npx --yes wrangler@4.50.0 secret put NOTION_CLIENT_SECRET
   ```
4. `GET /api/capabilities` now shows `notionLogin: true` and the site's notion option becomes "log in with notion". pasting a token stays available as a fallback.

## 3 · real notion

no server setup is needed (notion connects with a token the user pastes, not oauth).

1. <https://www.notion.so/profile/integrations> -> **new integration** (type: internal).
2. under **capabilities** tick **read content** and nothing else.
3. copy the *internal integration secret*.
4. open your task database in notion -> **•••** -> **connections** -> add the integration. (notion only lets an integration see databases that were shared with it.)
5. in breakpoint: get started -> notion -> paste the token.

the token is stored encrypted (aes-256-gcm, key from `TOKEN_ENC_KEY`) and is only used to read the database you pick. removing the integration in notion revokes it there too.

---

## 4 · putting it online

the api is hosted on a cloudflare worker with d1 and the site is on cloudflare pages. how it is set up, how to redeploy, how to add google credentials to the hosted api, and the limits to know are all in [hosting.md](HOSTING.md).

---

## 5 · what the user sees (and what each message means)

| situation | what the sheet says |
|---|---|
| no `VITE_API_URL` in the build | a toast: connectors switch on once the server is connected. the flow carries on. |
| api unreachable | a toast: couldn't reach the server, nothing imported. the flow carries on. |
| google not configured on the api | "google calendar isn't switched on here yet", with a button to import an .ics instead. |
| guest picks google | "sign in to connect…" (sign-in shares only name + email). anything already added comes along. |
| guest picks notion | straight to the token step: no sign-in needed. the token is stored encrypted and deleted with the guest sandbox (24 h) or on disconnect. |
| signed in, not connected | "allow read-only access": lists what breakpoint can and cannot do, then google's own consent screen. |
| user presses cancel at google | "you chose not to share, so nothing was connected." |
| google grants more than asked | refused, nothing stored, grant revoked: "google offered more access than breakpoint asked for." |
| token stale | "google needs you to reconnect" / "notion no longer accepts that token." |

redirect convention: the site sends google back to `/?ob=google` (or `ob=notion`); on load it sees `?ob=`, `?connected=google`, `?auth_error=` or `?connect_error=`, reopens the onboarding on the connect step and shows the right sheet. the url is cleaned straight away.
