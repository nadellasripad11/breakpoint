# breakpoint api reference

base url: `http://localhost:8787` locally. all bodies are json. all times are iso-8601 **with a utc offset**
(`2026-11-20T17:00:00-06:00`); responses use the schedule's timezone. `minutes` / `durationMin` are plain integers.

## conventions

**authentication.** either the `bp_session` cookie (httponly; set by sign-in/guest) or `Authorization: Bearer <token>`.
cookie-authenticated writes must come from an allowed origin or send `X-Breakpoint-Client: 1`.

**errors.** always `{ "error": { "code", "message", "details?", "requestId" } }`.

| status | `code` examples |
|---|---|
| 400 | `validation_error` (`details: [{path, message}]`), `invalid_json`, `csrf`-free input problems |
| 401 | `unauthenticated` |
| 403 | `csrf_blocked`, `guest_not_allowed` |
| 404 | `not_found` (also returned for other people's objects) |
| 409 | `limit_exceeded`, `deferral_not_confirmed`, `no_feasible_plan`, `reconnect_required` |
| 413 | `too_large` |
| 422 | `unknown_target`, `invalid_disruption`, `horizon_too_long`, `unscheduled_item`, `not_ics`, `notion_unauthorized`, ... |
| 429 | `rate_limited` (with `Retry-After`) |
| 500 | `internal_error`; `internal_invariant` = the scheduler refused to return an invalid plan |

**window.** engine endpoints take `window`: `{ "date": "2026-11-20" }` (that local day in the schedule's timezone) or `{ "from": ISO, "to": ISO }` (max 31 days).

**disruptions** (`minutes` is always the size):

```json
{ "type": "overrun",   "targetId": "<item id>", "minutes": 45 }     // takes longer
{ "type": "delay",     "targetId": "<item id>", "minutes": 20 }     // starts later
{ "type": "unexpected","start": ISO, "minutes": 60, "title": "Dentist", "priority": 5 }
{ "type": "lost_time", "minutes": 30, "start": ISO? }               // default: start of the plan
```

**item shape** (create/return):

```json
{ "id": "…", "kind": "event | task | break", "title": "Calculus", "start": ISO|null, "durationMin": 90, "allDay": false,
  "timezone": "America/Chicago", "locked": null, "priority": 1-5|null, "category": "School"|null,
  "deadline": ISO|null, "release": ISO|null, "deferrable": null, "critical": null, "blocking": true,
  "recurrence": { "rrule": "FREQ=WEEKLY;BYDAY=MO,WE", "exdates": [ISO] } | null, "source": "manual|ics|google|notion|demo", "externalId": null }
```
`null` means "use the default": events are locked, tasks flexible; priority comes from the category preference else 3;
tasks below `criticalPriority` (default 4) are deferrable; breaks are never deferrable. tasks may omit `start` (the baseline places them).

**preferences.**

```json
{ "workingHours": { "start": "08:00", "end": "22:00", "days": [0,1,2,3,4,5,6] },
  "protectedBreaks": [{ "id": "lunch", "title": "Lunch", "durationMin": 45, "windowStart": "12:00", "windowEnd": "14:00", "days": [1,2,3,4,5] }],
  "categoryPriority": { "School": 5, "Fitness": 4 },
  "mobility": "fixed | balanced | flexible", "criticalPriority": 4 }
```

## auth

| | |
|---|---|
| `POST /api/auth/guest?tz=` | sandbox session with the demo schedule seeded. returns `{ user, token, expiresAt, demoScheduleId }` and sets the cookie. reuses an existing session. 10/hour per ip. data is deleted after 24h of inactivity. |
| `GET /api/auth/google/start?redirect=/path` | `{ url }` to send the browser to. a signed-in *guest* keeps their schedules. `501 google_not_configured` if not set up. |
| `GET /api/auth/google/callback` | google redirects here; sets the session cookie and redirects to `APP_ORIGIN + redirect#bp_code=<code>`, or `?auth_error=<code>`. |
| `POST /api/auth/exchange` | `{ code }`: trades the single-use `#bp_code` from the sign-in redirect for `{ user, token, expiresAt }` (valid 2 minutes, one use). for frontends on a different site. |
| `POST /api/auth/logout` | ends the session (204). |
| `GET /api/me` | `{ user: { id, email, name, picture, isGuest }, sessionExpiresAt }` |
| `DELETE /api/me` | body `{ "confirm": "delete my account" }`. revokes google access, deletes **everything** (204). |

## schedules and items (auth required)

| | |
|---|---|
| `GET /api/schedules` / `POST /api/schedules` | list / create `{ name, timezone, preferences? }`. guests: 3 schedules max; users: 50. |
| `GET` / `PATCH` / `DELETE /api/schedules/:id` | read / rename (`name`, `timezone`, `preferences`) / delete. |
| `PUT /api/schedules/:id/preferences` | replace the preferences (missing fields get defaults). |
| `GET /api/schedules/:id/items` | stored items. |
| `POST /api/schedules/:id/items` | one item or an array (max 200). events need `start`; breaks need `start` or `release`+`deadline`. |
| `PATCH` / `DELETE /api/schedules/:id/items/:itemId` | edit / remove. |

## the engine on a saved schedule

every endpoint below takes `window` and is **non-destructive**: it reads the schedule, computes, and returns. add `"save": true` to store a history
record (`GET /api/schedules/:id/runs`, `GET /api/runs/:runId`). heavy ones are limited to 20/min per user.

**`POST /api/schedules/:id/plan`** `{ window }` returns the baseline plan after placing unscheduled tasks.
`{ items[], issues[], unscheduled[], warnings[], settings, diagnosis? }`. `issues` are problems *already in your plan* (overlaps, deadline violations); they are reported, never silently fixed.
items that could not be placed appear with `start: null` and in `unscheduled[]` with an explanation.

**`POST /api/schedules/:id/rescue`** (rescue my day) `{ window, disruptions[1..20] }` returns the original, disrupted and repaired schedules side by side, the exact conflicts, the smallest set of changes, re-verified guarantees, a replay and pip's computed explanation. also stateless at `POST /api/engine/rescue`. full description, including what "smallest" means and how it is tested: [rescue.md](RESCUE.md).

**`POST /api/schedules/:id/simulate`** (butterfly effect) `{ window, disruptions[1..20] }`

```json
{ "disruptions": ["\"Practice\" takes 45m longer than planned"],
  "result": {
    "summary": { "survives": false, "criticalCount": 1, "shiftedCount": 2, "maxShiftMinutes": 45,
                 "headline": "\"Project\" would finish at 8:15 PM, 15m after its 8:00 PM deadline." },
    "outcomes": [{ "id", "title", "original": {start,end}|null, "simulated": {start,end}, "fragments": [{start,end}],
                   "shiftMinutes", "status": "unchanged|shifted|conflict|injected", "causedBy", "conflicts": [] }],
    "conflicts": [{ "code": "deadline_missed|locked_overlap|break_lost|overflow|after_hours", "severity": "critical|major|minor", "itemId", "minutes", "message" }],
    "ripple": [{ "from", "to", "minutes", "reason" }] } }
```

**`POST /api/schedules/:id/breaking-point`** `{ window, probe?, mode?: "cascade|recover|both", limitMinutes?, weakLinks? }`
`probe` = `{ type: "lost_time|overrun|delay|unexpected", targetId?, at? }` (default: `lost_time` at the start of the day).

```json
{ "result": {
    "cascade": { "status": "breaks", "tolerableMinutes": 30, "breakingMinutes": 31, "failure": { "conflicts": [] }, "explanation": "If \"Practice\" runs over, the schedule tolerates 30m. At 31m, …" },
    "recover": { "status": "breaks", "tolerableMinutes": 150, "failure": { "diagnosis": {} }, "explanation": "…" } },
  "weakLinks": { "weakest": {}, "minTolerance": 30, "links": [{ "itemId", "title", "overrunTolerance", "delayTolerance", "firstFailure" }] } }
```
`status`: `breaks` | `withstands_limit` | `already_broken` (recover mode: no feasible schedule even without a disruption).

**`POST /api/schedules/:id/futures`** (parallel futures) `{ window, disruptions? }`

```json
{ "result": { "recommended": "minimize_changes", "recommendedReason": "…", "doNothing": { "survives": false },
  "futures": [{ "strategy": "protect_priorities | maximize_completion | minimize_changes", "title", "description", "feasible": true,
      "items": [{ "id", "title", "start", "end", "original", "status": "locked|kept|moved|injected|unchanged", "movedByMinutes" }],
      "deferred": [{ "id", "title", "message" }], "requiresConfirmation": true,
      "metrics": { "placedCount", "keptCount", "movedCount", "deferredCount", "totalDisplacementMinutes", "criticalKept": {kept,total} },
      "explanation": ["…"], "optimal": true, "diagnosis": { "summary", "reasons", "conflictSet", "suggestions" } }] } }
```
when no feasible schedule exists every future has `feasible: false`, no `items`, and a `diagnosis`:
`{ summary, reasons[{code,message,itemIds,shortfallMinutes}], conflictSet[ids], suggestions[{action: defer_or_remove|extend_deadline|shorten|loosen_mobility, message, minutes?}] }`.

**`POST /api/schedules/:id/chaos`** `{ window, scenarios?(1..2000, default 200), seed?, severity?: "mild|realistic|severe", examples? }`
same seed, same report. `{ result: { seed, survivalRate, resilienceScore, fragileItems[], byType, worstScenarios[], summary } }`.

**`POST /api/schedules/:id/fortify`** `{ window, maxChanges?(1..8), maxShiftMinutes?(5..180), scenarios?, seed?, severity? }`
`{ result: { before, after, adjustments[{type: move|swap|shift_block, title, fromStart, toStart, reason, gain}], proposedStarts[], explanation[] } }`. **a proposal only.**

**`POST /api/schedules/:id/adopt`**: turn a proposal into a **new** schedule (the original and all external calendars are untouched).

```json
{ "window": {...}, "confirm": true, "name": "optional",
  "acceptDeferrals": ["<ids of every task the plan defers>"],
  "source": { "kind": "future", "strategy": "protect_priorities", "disruptions": [...] }  // or { "kind": "fortify", "maxChanges": 3 } }
```
`409 deferral_not_confirmed` (with the tasks listed) if a deferral is not confirmed; `409 no_feasible_plan` with the diagnosis. deferred tasks are **kept** in the new schedule without a start time.

## imports (read-only; auth required)

| | |
|---|---|
| `POST /api/schedules/:id/import/ics` | `{ ics: "<file text>", defaultTimezone?, allDayBlocks?, defaultTaskMinutes?, dryRun? }` (max 2 mb). the browser sends the text; the server never fetches a url. |
| `POST /api/schedules/:id/import/google` | `{ connectionId, calendarId, from, to, confirm: true, dryRun? }` |
| `POST /api/schedules/:id/import/notion` | `{ connectionId, databaseId, mapping?: { title, date, duration, priority, category, status, doneValues, defaultMinutes }, confirm: true, dryRun? }` |

response: `{ imported: { created, updated }, missing: [{id,title}], skipped, warnings[], note }`. re-importing is idempotent (matched by the source's id);
it refreshes title/time/duration but **never overwrites** what you set (locked, priority, category, deferrable, critical). items that vanished from the source are listed in
`missing` and **kept**. `dryRun: true` returns `{ wouldImport, preview[] }` and writes nothing. all-day and "free" events import as non-blocking by default.

**`POST /api/schedules/:id/import/link`** `{ url, provider?: "google"|"apple", dryRun?, allDayBlocks?, defaultTaskMinutes? }` imports a calendar from its link (google "secret address in ical format", icloud public calendar; `webcal://` is accepted). same response as the .ics import (`dryRun` returns a preview). no sign-in needed. the server fetches the link once from an allow-listed host (calendar.google.com, *.icloud.com) and never stores or echoes it; errors `link_invalid`, `link_not_allowed`, `link_not_found`, `link_forbidden`, `link_unreachable`, `not_ics`, `too_large` all carry plain-english messages. `GET /api/capabilities` now includes `calendarLink: true`.

**`POST /api/connections/notion/start`** `{ acknowledge: true, redirect? }` returns `{ url }`: send the browser to it to "log in with notion". notion calls back to `GET /api/connections/notion/callback`, which stores the workspace token encrypted and redirects to the site with `?connected=notion` (or `?ob=notion&connect_error=<code>`). works for guests. needs `NOTION_CLIENT_ID` and `NOTION_CLIENT_SECRET`; `GET /api/capabilities` reports `notionLogin`.

## connections (real accounts only; guests get `403 guest_not_allowed`)

| | |
|---|---|
| `GET /api/connections` | `[{ id, provider, accountLabel, scopes, consentAt, access: "read-only" }]` (never tokens) |
| `POST /api/connections/google/start` | `{ acknowledge: true, scopes: ["https://www.googleapis.com/auth/calendar.readonly"], redirect? }` returns `{ url }`. nothing is requested from google before this. |
| `GET /api/connections/google/callback` | redirects to the app with `?connected=google` or `?connect_error=<code>` (a grant broader than read-only is refused and revoked). |
| `POST /api/connections/notion` | `{ acknowledge: true, token: "<internal integration token>" }` (create the integration with *read content* only). |
| `GET /api/connections/:id/google/calendars` / `.../notion/databases` | pick what to import. |
| `DELETE /api/connections/:id` | revokes at google, deletes stored tokens. |

## capabilities (public)

`GET /api/capabilities` -> `{ ok, guest, ics, google, notion, accounts }`. `google` / `accounts` are `false` until `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set (notion needs an account, so it needs `accounts` too). the site calls this before opening a connector and shows a plain explanation instead of a failed redirect.

## guest demo (no login, nothing stored)

`GET /api/demo/schedule?tz=America/Chicago&date=YYYY-MM-DD` returns the landing-page scenario plus ready-made request bodies in `try.*`.
`POST /api/engine/{plan,simulate,chaos,breaking-point,futures,fortify}` takes the same body as the saved-schedule version plus an inline schedule
`{ "schedule": { "preferences": {...}, "items": [{ "id": "study", ...item fields }] }, "window": {...}, ... }` (max 300 items, 512 kb, 60/min per ip).

```powershell
$demo = Invoke-RestMethod http://localhost:8787/api/demo/schedule
Invoke-RestMethod -Method Post -ContentType application/json -Uri http://localhost:8787/api/engine/breaking-point -Body ($demo.try.breakingPoint | ConvertTo-Json -Depth 20)
```

## database

`migrations/001_init.sql`: `users`, `sessions` (hashed tokens), `oauth_states` (single-use), `connections` (encrypted tokens + consent time),
`schedules`, `schedule_items` (unique per `schedule_id, source, external_id` so imports are idempotent), `imports` (audit), `runs` (history), `audit_log`.
deleting a user cascades to everything they own.
