# frontend integration

the landing page and onboarding (in the repo root) talk to this api with `client/breakpoint-client.js`. it has no dependencies.
**this is already wired up in the site:** `src/api.js` (session + schedule helpers), `src/connect.js` (the connector sheet) and `src/onboarding.js` use it, and `server/docs/SETUP-CONNECTORS.md` explains the credentials. the rest of this page describes the same flow for anyone building another frontend.

```js
import { BreakpointApi, onboardingToPreferences } from './api.js';
export const api = new BreakpointApi({ baseUrl: import.meta.env.VITE_API_URL });   // e.g. http://localhost:8787
```

## 1 · choose how sessions travel

| setup | what to do |
|---|---|
| **same site** (app `https://app.example.com`, api `https://api.example.com`) | cookie mode, the default. set `COOKIE_DOMAIN=.example.com`, `COOKIE_SECURE=true`, `APP_ORIGINS=https://app.example.com`. the browser keeps an **httponly** cookie that javascript cannot read. this is the most secure option. |
| **different sites** (cloudflare pages `*.pages.dev` + api elsewhere) | browsers block third-party cookies, so use **token mode**: `new BreakpointApi({ baseUrl, token: sessionStorage.getItem('bp'), onToken: t => t ? sessionStorage.setItem('bp', t) : sessionStorage.removeItem('bp') })`. prefer `sessionStorage` over `localStorage`; keep the site free of third-party scripts. `APP_ORIGINS` must list the pages url. |
| **local dev** | api `http://localhost:8787`, vite `http://localhost:5173` (already allowed by default). `localhost` ports are the same site, so cookies just work. |

the client always sends `X-Breakpoint-Client: 1` (the csrf guard) and `credentials: 'include'`.
google sign-in returns through the api and redirects back to the app. call `await api.completeSignIn()` once on every page load: if the url carries
`#bp_code=...` (a single-use code valid for 2 minutes) it is exchanged for a session token and the url is cleaned. this works in both modes and is what makes a
frontend on a different site (cloudflare pages) work without third-party cookies. failures arrive as `?auth_error=<code>`.

## 2 · the landing page ("try breakpoint", no login)

```js
const demo = await api.demoSchedule(Intl.DateTimeFormat().resolvedOptions().timeZone);
const bp = await api.engine('breaking-point', demo.try.breakingPoint);
bp.result.cascade.tolerableMinutes;        // 30  -> "your plan tolerates 30 minutes"
bp.result.cascade.explanation;             // ready-to-show sentence
const sim = await api.engine('simulate', { ...demo.try.simulate });   // Butterfly Effect: sim.result.outcomes / .conflicts
const fut = await api.engine('futures', demo.try.futures);            // the three "ways forward" cards: fut.result.futures
```
the three "three ways forward" cards on the landing page map to `result.futures[i].strategy`:
`protect_priorities` ("protect priorities"), `maximize_completion` ("preserve the most tasks"), `minimize_changes` ("minimize changes").
use `fut.result.recommended` for the pre-selected card and render `futures[i].items` as the mini timelines (`status`: `kept` / `moved` / `locked`; `deferred[]` shown as the hatched gap).

## 3 · "get started" -> onboarding

| screen | call |
|---|---|
| **welcome** | when it opens, `await api.guest(tz)`. the user now has a sandbox session and a demo schedule (`demoScheduleId`). |
| **connect** | *google calendar*: if the user is a guest, `location.href = await api.googleSignInUrl('/onboarding?step=connect')` (they keep their schedule), then show a plain consent step ("breakpoint will get **read-only** access to your calendar; it can never change it") and on "allow", `location.href = await api.googleConnectUrl('/onboarding?step=connect')`. back in the app: `const [conn] = await api.listConnections()`, `const cals = await api.googleCalendars(conn.id)`, then `api.importGoogle(scheduleId, { connectionId: conn.id, calendarId, from, to })`. <br>*notion*: ask for an integration token (create the integration with **read content** only), `api.connectNotion(token)`, `api.notionDatabases(id)`, `api.importNotion(scheduleId, { connectionId, databaseId, mapping })`. <br>*import .ics*: `const text = await file.text(); const preview = await api.importIcs(scheduleId, text, { dryRun: true });` show `preview.preview`, then `api.importIcs(scheduleId, text)`. <br>*start from scratch*: `api.createSchedule({ name, timezone })`. |
| **customize** | `api.setPreferences(scheduleId, onboardingToPreferences({ priorities, flexibility, timezone }))`. `priorities` is the ordered list of selected ids (`['school','fitness']`: first gets priority 5, then 4, ...). `flexibility` is the slider index 0/1/2 -> `fixed`/`balanced`/`flexible`. |
| **done** | navigate to the app with `scheduleId`. the first screen can call `api.plan(id, { date })`, then `api.breakingPoint(id, { date }, { weakLinks: true })`. |

imported items are **read-only copies**: the user edits them in breakpoint (`api.updateItem`), and nothing is ever written back to google, notion or the file.

## 4 · the app screens

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
show what the engine tells you:
- **conflicts** carry a `severity` and a human `message`; show critical first.
- **`deferred[]`** tasks are not removed: show them as "waiting for your decision". adopting a plan that defers anything needs the user to confirm each one (`acceptDeferrals`).
- **`feasible: false`** -> render `diagnosis.summary`, the `reasons`, and the `suggestions` as one-click choices (they are descriptions; apply them with `updateItem`).
- **`explanation[]`** on a future/fortify result is ready-made copy for the plan card.

apply a plan the user likes: `api.adopt(id, { window, source: { kind: 'future', strategy, disruptions }, acceptDeferrals })` creates a **new** schedule (`result.schedule.id`); the original is untouched, so "undo" is simply switching back.

## 5 · errors and states

```js
try { await api.simulate(...) } catch (e) {
  if (e.code === 'unauthenticated') await api.guest(tz);        // session expired: start a new guest session or sign in
  else if (e.code === 'rate_limited') showToast(e.message);       // retry after e.details / Retry-After
  else if (e.code === 'validation_error') showFieldErrors(e.details);   // [{ path, message }]
  else showToast(e.message);                                      // messages are written for people
}
```
quote `e.requestId` when reporting a problem; it appears in the server log.

## 6 · environment

`.env` in the frontend: `VITE_API_URL=http://localhost:8787`. in production set it to the api's https url and add the frontend origin to the api's `APP_ORIGINS`.
