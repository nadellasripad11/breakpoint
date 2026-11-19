# Breakpoint API reference

Base URL: `http://localhost:8787` locally. All bodies are JSON. All times are ISO-8601 **with a UTC offset**
(`2026-11-20T17:00:00-06:00`); responses use the schedule's timezone. `minutes` / `durationMin` are plain integers.

## Conventions

**Authentication.** Either the `bp_session` cookie (HttpOnly; set by sign-in/guest) or `Authorization: Bearer <token>`.
Cookie-authenticated writes must come from an allowed origin or send `X-Breakpoint-Client: 1`.

**Errors.** Always `{ "error": { "code", "message", "details?", "requestId" } }`.

| Status | `code` examples |
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

**Window.** Engine endpoints take `window`: `{ "date": "2026-11-20" }` (that local day in the schedule's timezone) or `{ "from": ISO, "to": ISO }` (max 31 days).

**Disruptions** (`minutes` is always the size):

```json
{ "type": "overrun",   "targetId": "<item id>", "minutes": 45 }     // takes longer
{ "type": "delay",     "targetId": "<item id>", "minutes": 20 }     // starts later
{ "type": "unexpected","start": ISO, "minutes": 60, "title": "Dentist", "priority": 5 }
{ "type": "lost_time", "minutes": 30, "start": ISO? }               // default: start of the plan
```

**Item shape** (create/return):

```json
{ "id": "…", "kind": "event | task | break", "title": "Calculus", "start": ISO|null, "durationMin": 90, "allDay": false,
  "timezone": "America/Chicago", "locked": null, "priority": 1-5|null, "category": "School"|null,
  "deadline": ISO|null, "release": ISO|null, "deferrable": null, "critical": null, "blocking": true,
  "recurrence": { "rrule": "FREQ=WEEKLY;BYDAY=MO,WE", "exdates": [ISO] } | null, "source": "manual|ics|google|notion|demo", "externalId": null }
```
`null` means "use the default": events are locked, tasks flexible; priority comes from the category preference else 3;
tasks below `criticalPriority` (default 4) are deferrable; breaks are never deferrable. Tasks may omit `start` (the baseline places them).

**Preferences.**

```json
{ "workingHours": { "start": "08:00", "end": "22:00", "days": [0,1,2,3,4,5,6] },
  "protectedBreaks": [{ "id": "lunch", "title": "Lunch", "durationMin": 45, "windowStart": "12:00", "windowEnd": "14:00", "days": [1,2,3,4,5] }],
  "categoryPriority": { "School": 5, "Fitness": 4 },
  "mobility": "fixed | balanced | flexible", "criticalPriority": 4 }
```

## Auth

| | |
|---|---|
| `POST /api/auth/guest?tz=` | Sandbox session with the demo schedule seeded. Returns `{ user, token, expiresAt, demoScheduleId }` and sets the cookie. Reuses an existing session. 10/hour per IP. Data is deleted after 24h of inactivity. |
| `GET /api/auth/google/start?redirect=/path` | `{ url }` to send the browser to. A signed-in *guest* keeps their schedules. `501 google_not_configured` if not set up. |
| `GET /api/auth/google/callback` | Google redirects here; sets the session cookie and redirects to `APP_ORIGIN + redirect#bp_code=<code>`, or `?auth_error=<code>`. |
| `POST /api/auth/exchange` | `{ code }`: trades the single-use `#bp_code` from the sign-in redirect for `{ user, token, expiresAt }` (valid 2 minutes, one use). For frontends on a different site. |
| `POST /api/auth/logout` | Ends the session (204). |
| `GET /api/me` | `{ user: { id, email, name, picture, isGuest }, sessionExpiresAt }` |
| `DELETE /api/me` | Body `{ "confirm": "delete my account" }`. Revokes Google access, deletes **everything** (204). |

## Schedules and items (auth required)

| | |
|---|---|
| `GET /api/schedules` / `POST /api/schedules` | List / create `{ name, timezone, preferences? }`. Guests: 3 schedules max; users: 50. |
| `GET` / `PATCH` / `DELETE /api/schedules/:id` | Read / rename (`name`, `timezone`, `preferences`) / delete. |
| `PUT /api/schedules/:id/preferences` | Replace the preferences (missing fields get defaults). |
| `GET /api/schedules/:id/items` | Stored items. |
| `POST /api/schedules/:id/items` | One item or an array (max 200). Events need `start`; breaks need `start` or `release`+`deadline`. |
| `PATCH` / `DELETE /api/schedules/:id/items/:itemId` | Edit / remove. |

## The engine on a saved schedule

Every endpoint below takes `window` and is **non-destructive**: it reads the schedule, computes, and returns. Add `"save": true` to store a history
record (`GET /api/schedules/:id/runs`, `GET /api/runs/:runId`). Heavy ones are limited to 20/min per user.

**`POST /api/schedules/:id/plan`** `{ window }` returns the baseline plan after placing unscheduled tasks.
`{ items[], issues[], unscheduled[], warnings[], settings, diagnosis? }`. `issues` are problems *already in your plan* (overlaps, deadline violations); they are reported, never silently fixed.
Items that could not be placed appear with `start: null` and in `unscheduled[]` with an explanation.

**`POST /api/schedules/:id/simulate`** (Butterfly Effect) `{ window, disruptions[1..20] }`

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

**`POST /api/schedules/:id/futures`** (Parallel Futures) `{ window, disruptions? }`

```json
{ "result": { "recommended": "minimize_changes", "recommendedReason": "…", "doNothing": { "survives": false },
  "futures": [{ "strategy": "protect_priorities | maximize_completion | minimize_changes", "title", "description", "feasible": true,
      "items": [{ "id", "title", "start", "end", "original", "status": "locked|kept|moved|injected|unchanged", "movedByMinutes" }],
      "deferred": [{ "id", "title", "message" }], "requiresConfirmation": true,
      "metrics": { "placedCount", "keptCount", "movedCount", "deferredCount", "totalDisplacementMinutes", "criticalKept": {kept,total} },
      "explanation": ["…"], "optimal": true, "diagnosis": { "summary", "reasons", "conflictSet", "suggestions" } }] } }
```
When no feasible schedule exists every future has `feasible: false`, no `items`, and a `diagnosis`:
`{ summary, reasons[{code,message,itemIds,shortfallMinutes}], conflictSet[ids], suggestions[{action: defer_or_remove|extend_deadline|shorten|loosen_mobility, message, minutes?}] }`.

**`POST /api/schedules/:id/chaos`** `{ window, scenarios?(1..2000, default 200), seed?, severity?: "mild|realistic|severe", examples? }`
Same seed, same report. `{ result: { seed, survivalRate, resilienceScore, fragileItems[], byType, worstScenarios[], summary } }`.

**`POST /api/schedules/:id/fortify`** `{ window, maxChanges?(1..8), maxShiftMinutes?(5..180), scenarios?, seed?, severity? }`
`{ result: { before, after, adjustments[{type: move|swap|shift_block, title, fromStart, toStart, reason, gain}], proposedStarts[], explanation[] } }`. **A proposal only.**

**`POST /api/schedules/:id/adopt`**: turn a proposal into a **new** schedule (the original and all external calendars are untouched).

```json
{ "window": {...}, "confirm": true, "name": "optional",
  "acceptDeferrals": ["<ids of every task the plan defers>"],
  "source": { "kind": "future", "strategy": "protect_priorities", "disruptions": [...] }  // or { "kind": "fortify", "maxChanges": 3 } }
```
`409 deferral_not_confirmed` (with the tasks listed) if a deferral is not confirmed; `409 no_feasible_plan` with the diagnosis. Deferred tasks are **kept** in the new schedule without a start time.

## Imports (read-only; auth required)

| | |
|---|---|
| `POST /api/schedules/:id/import/ics` | `{ ics: "<file text>", defaultTimezone?, allDayBlocks?, defaultTaskMinutes?, dryRun? }` (max 2 MB). The browser sends the text; the server never fetches a URL. |
| `POST /api/schedules/:id/import/google` | `{ connectionId, calendarId, from, to, confirm: true, dryRun? }` |
| `POST /api/schedules/:id/import/notion` | `{ connectionId, databaseId, mapping?: { title, date, duration, priority, category, status, doneValues, defaultMinutes }, confirm: true, dryRun? }` |

Response: `{ imported: { created, updated }, missing: [{id,title}], skipped, warnings[], note }`. Re-importing is idempotent (matched by the source's id);
it refreshes title/time/duration but **never overwrites** what you set (locked, priority, category, deferrable, critical). Items that vanished from the source are listed in
`missing` and **kept**. `dryRun: true` returns `{ wouldImport, preview[] }` and writes nothing. All-day and "free" events import as non-blocking by default.

## Connections (real accounts only; guests get `403 guest_not_allowed`)

| | |
|---|---|
| `GET /api/connections` | `[{ id, provider, accountLabel, scopes, consentAt, access: "read-only" }]` (never tokens) |
| `POST /api/connections/google/start` | `{ acknowledge: true, scopes: ["https://www.googleapis.com/auth/calendar.readonly"], redirect? }` returns `{ url }`. Nothing is requested from Google before this. |
| `GET /api/connections/google/callback` | Redirects to the app with `?connected=google` or `?connect_error=<code>` (a grant broader than read-only is refused and revoked). |
| `POST /api/connections/notion` | `{ acknowledge: true, token: "<internal integration token>" }` (create the integration with *Read content* only). |
| `GET /api/connections/:id/google/calendars` / `.../notion/databases` | Pick what to import. |
| `DELETE /api/connections/:id` | Revokes at Google, deletes stored tokens. |

## Guest demo (no login, nothing stored)

`GET /api/demo/schedule?tz=America/Chicago&date=YYYY-MM-DD` returns the landing-page scenario plus ready-made request bodies in `try.*`.
`POST /api/engine/{plan,simulate,chaos,breaking-point,futures,fortify}` takes the same body as the saved-schedule version plus an inline schedule
`{ "schedule": { "preferences": {...}, "items": [{ "id": "study", ...item fields }] }, "window": {...}, ... }` (max 300 items, 512 KB, 60/min per IP).

```powershell
$demo = Invoke-RestMethod http://localhost:8787/api/demo/schedule
Invoke-RestMethod -Method Post -ContentType application/json -Uri http://localhost:8787/api/engine/breaking-point -Body ($demo.try.breakingPoint | ConvertTo-Json -Depth 20)
```

## Database

`migrations/001_init.sql`: `users`, `sessions` (hashed tokens), `oauth_states` (single-use), `connections` (encrypted tokens + consent time),
`schedules`, `schedule_items` (unique per `schedule_id, source, external_id` so imports are idempotent), `imports` (audit), `runs` (history), `audit_log`.
Deleting a user cascades to everything they own.
