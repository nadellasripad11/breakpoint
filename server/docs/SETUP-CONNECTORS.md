# Setting up the connectors

The onboarding "Connect" step talks to this API. Three connectors exist, and all of them are **read-only copies**:
nothing is ever written back to Google, Notion or your file.

| Connector | Needs | Works without any setup? |
|---|---|---|
| **.ics file** | nothing | yes, even for guests |
| **Google Calendar** | a Google OAuth client on the API server | no |
| **Notion** | a read-only integration token (no sign-in: a guest sandbox is enough) | no |

The site asks the server what it can do (`GET /api/capabilities`) and shows plain explanations when something is off.

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

## 2 · Real Google Calendar

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
