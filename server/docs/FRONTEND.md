# Frontend integration

The landing page and onboarding (in the repo root) talk to this API with `client/breakpoint-client.js`. It has no dependencies.
**This is already wired up in the site:** `src/api.js` (session + schedule helpers), `src/connect.js` (the connector sheet) and `src/onboarding.js` use it, and `server/docs/SETUP-CONNECTORS.md` explains the credentials. The rest of this page describes the same flow for anyone building another frontend.

```js
import { BreakpointApi, onboardingToPreferences } from './api.js';
export const api = new BreakpointApi({ baseUrl: import.meta.env.VITE_API_URL });   // e.g. http://localhost:8787
```

## 1 · Choose how sessions travel

| Setup | What to do |
|---|---|
| **Same site** (app `https://app.example.com`, API `https://api.example.com`) | Cookie mode, the default. Set `COOKIE_DOMAIN=.example.com`, `COOKIE_SECURE=true`, `APP_ORIGINS=https://app.example.com`. The browser keeps an **HttpOnly** cookie that JavaScript cannot read. This is the most secure option. |
| **Different sites** (Cloudflare Pages `*.pages.dev` + API elsewhere) | Browsers block third-party cookies, so use **token mode**: `new BreakpointApi({ baseUrl, token: sessionStorage.getItem('bp'), onToken: t => t ? sessionStorage.setItem('bp', t) : sessionStorage.removeItem('bp') })`. Prefer `sessionStorage` over `localStorage`; keep the site free of third-party scripts. `APP_ORIGINS` must list the Pages URL. |
| **Local dev** | API `http://localhost:8787`, Vite `http://localhost:5173` (already allowed by default). `localhost` ports are the same site, so cookies just work. |

The client always sends `X-Breakpoint-Client: 1` (the CSRF guard) and `credentials: 'include'`.
Google sign-in returns through the API and redirects back to the app. Call `await api.completeSignIn()` once on every page load: if the URL carries
`#bp_code=...` (a single-use code valid for 2 minutes) it is exchanged for a session token and the URL is cleaned. This works in both modes and is what makes a
frontend on a different site (Cloudflare Pages) work without third-party cookies. Failures arrive as `?auth_error=<code>`.

## 2 · The landing page ("Try Breakpoint", no login)

```js
const demo = await api.demoSchedule(Intl.DateTimeFormat().resolvedOptions().timeZone);
const bp = await api.engine('breaking-point', demo.try.breakingPoint);
bp.result.cascade.tolerableMinutes;        // 30  → "your plan tolerates 30 minutes"
bp.result.cascade.explanation;             // ready-to-show sentence
const sim = await api.engine('simulate', { ...demo.try.simulate });   // Butterfly Effect: sim.result.outcomes / .conflicts
const fut = await api.engine('futures', demo.try.futures);            // the three "ways forward" cards: fut.result.futures
```
The three "Three ways forward" cards on the landing page map to `result.futures[i].strategy`:
`protect_priorities` ("Protect priorities"), `maximize_completion` ("Preserve the most tasks"), `minimize_changes` ("Minimize changes").
Use `fut.result.recommended` for the pre-selected card and render `futures[i].items` as the mini timelines (`status`: `kept` / `moved` / `locked`; `deferred[]` shown as the hatched gap).

## 3 · "Get started" → onboarding

| Screen | Call |
|---|---|
| **Welcome** | When it opens, `await api.guest(tz)`. The user now has a sandbox session and a demo schedule (`demoScheduleId`). |
| **Connect** | *Google Calendar*: if the user is a guest, `location.href = await api.googleSignInUrl('/onboarding?step=connect')` (they keep their schedule), then show a plain consent step ("Breakpoint will get **read-only** access to your calendar; it can never change it") and on "Allow", `location.href = await api.googleConnectUrl('/onboarding?step=connect')`. Back in the app: `const [conn] = await api.listConnections()`, `const cals = await api.googleCalendars(conn.id)`, then `api.importGoogle(scheduleId, { connectionId: conn.id, calendarId, from, to })`. <br>*Notion*: ask for an integration token (create the integration with **Read content** only), `api.connectNotion(token)`, `api.notionDatabases(id)`, `api.importNotion(scheduleId, { connectionId, databaseId, mapping })`. <br>*Import .ics*: `const text = await file.text(); const preview = await api.importIcs(scheduleId, text, { dryRun: true });` show `preview.preview`, then `api.importIcs(scheduleId, text)`. <br>*Start from scratch*: `api.createSchedule({ name, timezone })`. |
| **Customize** | `api.setPreferences(scheduleId, onboardingToPreferences({ priorities, flexibility, timezone }))`. `priorities` is the ordered list of selected ids (`['school','fitness']`: first gets priority 5, then 4, ...). `flexibility` is the slider index 0/1/2 → `fixed`/`balanced`/`flexible`. |
| **Done** | Navigate to the app with `scheduleId`. The first screen can call `api.plan(id, { date })`, then `api.breakingPoint(id, { date }, { weakLinks: true })`. |

Imported items are **read-only copies**: the user edits them in Breakpoint (`api.updateItem`), and nothing is ever written back to Google, Notion or the file.

## 4 · The app screens

```js
const window = { date: '2026-11-20' };
const plan  = await api.plan(id, window);                                        // timeline rows: plan.items (start, end, locked, priority…)
const sim   = await api.simulate(id, window, [{ type: 'overrun', targetId, minutes: 45 }]);   // "After a 45-min delay" row
sim.result.outcomes.forEach(o => draw(o.simulated, o.status, o.fragments));      // shifted / conflict bars; hatched alert = o.conflicts
const bp    = await api.breakingPoint(id, window, { probe: { type: 'overrun', targetId }, mode: 'both' });   // the slider: cascade.tolerableMinutes
const fut   = await api.futures(id, window, disruptions);                         // "Three ways forward"
const chaos = await api.chaos(id, window, { scenarios: 200, seed: 1 });          // "your schedule survives 71% of realistic disruptions"
const fort  = await api.fortify(id, window);                                      // "Fortify my day" suggestions (proposal only)
```
Show what the engine tells you:
- **Conflicts** carry a `severity` and a human `message`; show critical first.
- **`deferred[]`** tasks are not removed: show them as "waiting for your decision". Adopting a plan that defers anything needs the user to confirm each one (`acceptDeferrals`).
- **`feasible: false`** → render `diagnosis.summary`, the `reasons`, and the `suggestions` as one-click choices (they are descriptions; apply them with `updateItem`).
- **`explanation[]`** on a future/fortify result is ready-made copy for the plan card.

Apply a plan the user likes: `api.adopt(id, { window, source: { kind: 'future', strategy, disruptions }, acceptDeferrals })` creates a **new** schedule (`result.schedule.id`); the original is untouched, so "undo" is simply switching back.

## 5 · Errors and states

```js
try { await api.simulate(...) } catch (e) {
  if (e.code === 'unauthenticated') await api.guest(tz);        // session expired: start a new guest session or sign in
  else if (e.code === 'rate_limited') showToast(e.message);       // retry after e.details / Retry-After
  else if (e.code === 'validation_error') showFieldErrors(e.details);   // [{ path, message }]
  else showToast(e.message);                                      // messages are written for people
}
```
Quote `e.requestId` when reporting a problem; it appears in the server log.

## 6 · Environment

`.env` in the frontend: `VITE_API_URL=http://localhost:8787`. In production set it to the API's https URL and add the frontend origin to the API's `APP_ORIGINS`.
