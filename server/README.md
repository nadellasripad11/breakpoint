# Breakpoint backend

A deterministic scheduling engine and REST API that stress-tests a schedule *before* life does.

- **Chaos Engine**: seeded, reproducible disruption scenarios (delays, overruns, unexpected commitments, lost time).
- **Butterfly Effect**: how one disruption ripples through everything after it (shifts, conflicts, missed deadlines).
- **Breaking Point**: the exact number of minutes a schedule tolerates before a *critical* failure, both "if you do nothing" and "if you re-plan".
- **Parallel Futures**: three recovery plans: *Protect priorities*, *Preserve the most tasks*, *Minimize changes*.
- **Fortify My Day**: small preventive moves, each *proven* by re-simulation.
- **Preferences**: fixed commitments, priorities, flexible tasks, deadlines, recurring events, protected breaks, mobility.
- **Auth**: Google sign-in (OIDC + PKCE), saved schedules, and a no-login guest demo.
- **Imports (read-only)**: `.ics`, Google Calendar, Notion, each behind explicit consent.

**No AI is involved in any scheduling calculation.** The engine is plain, deterministic TypeScript: same input, same output, every time.

## Run it locally (about 2 minutes)

Requires **Node 24+** (it runs TypeScript and SQLite natively: no build step, no native add-ons).

```powershell
cd server
npm install
npm test            # 84 tests, ~1 minute (typecheck separately: npm run typecheck)
npm start           # http://localhost:8787
```

In a second terminal, drive the real server end to end (guest session, simulations, adopt, delete):

```powershell
npm run smoke       # 15 checks against http://localhost:8787
npm run sim         # API + pretend Google + pretend Notion: try every connector with no credentials (docs/SETUP-CONNECTORS.md)
```

Or try it by hand: the landing-page scenario is served ready to use.

```powershell
curl http://localhost:8787/api/demo/schedule
```

Optional configuration (Google sign-in, production settings): copy `.env.example` to `.env`, then `node --env-file=.env src/index.ts`.
The guest demo and `.ics` import need no configuration at all.

## Project structure

```
server/
  src/
    engine/                  <- the product: pure functions, no I/O, no clock, no randomness (except a seeded PRNG)
      types.ts               shared types (items, disruptions, conflicts, results)
      time.ts  intervals.ts  timezone/DST-safe time, interval arithmetic
      world.ts               applies disruptions to COPIES; builds the locked-vs-flexible view
      cascade.ts             Butterfly Effect (do-nothing propagation + conflict detection)
      solver.ts              exact subset-DP placement of flexible tasks, with deadlines and availability
      futures.ts             Parallel Futures (protect / maximize / minimize-changes)
      breakingPoint.ts       Breaking Point (cascade + recover modes) and weak-link profile
      chaos.ts               seeded scenario generator + statistics
      fortify.ts             preventive adjustments, validated by simulation
      diagnose.ts            "no feasible schedule" explanations + concrete fixes
      validate.ts            independent checker run on every plan before it is returned
      baseline.ts            places unscheduled tasks; preferences.ts: working hours, breaks, priorities
    calendar/
      ics.ts                 .ics parser (read-only, hardened)      recurrence.ts   RRULE expansion
      expand.ts              stored items -> engine plan (recurrence, defaults, preferences)
    integrations/            googleCalendar.ts, notion.ts: read-only connectors
    auth/                    google.ts (OIDC, PKCE, token verification), crypto.ts (AES-256-GCM, hashing)
    store/                   types.ts (async interface), sqlite.ts (node:sqlite implementation)
    http/                    middleware, zod schemas, serializers, routes/ (auth, connections, schedules, imports, engine)
    app.ts  config.ts  index.ts  demo.ts
  migrations/001_init.sql    database schema (SQLite; written to port to Cloudflare D1)
  test/                      83 tests: unit, property-based (random schedules), API, OAuth with simulated Google/Notion
  client/breakpoint-client.js  browser client (copy into the frontend)
  docs/API.md  docs/FRONTEND.md
  scripts/smoke.ts           end-to-end check against a running server
  scripts/sim.ts             local simulator: the real API against a pretend Google + Notion
```

## How the engine reasons

Time is integer minutes; plans are plain data. An item is an **event** (calendar commitment, *locked* by default), a **task** (flexible,
optional release time and **hard deadline**) or a **break** (protected, never deferrable). Locked items are never moved, resized or removed.

**Butterfly Effect (do nothing).** Disruptions are applied to *copies* of the plan. Locked commitments stay put; if two of them collide that
is a conflict. Flexible work keeps its order, starts when you are free, pauses around locked blocks and resumes after. Nothing is ever dropped: whatever no
longer fits becomes a conflict with a severity: **critical** (hard deadline missed, a critical commitment double-booked, a non-deferrable task no
longer fits), **major**, or **minor** (outside your hours).

**Breaking Point.** The largest disruption that causes no *new* critical conflict (problems already in your plan are reported separately).
`cascade` mode scans minute by minute (exact). `recover` mode asks the solver whether *any* feasible re-plan exists and binary-searches
(exact; the search is monotone for overruns, lost time and unexpected commitments and scans linearly for delays). The tests check both against brute force.

**The solver.** Flexible tasks run in one piece inside the free gaps between locked commitments and available hours, between their release time and hard deadline.
Up to 18 tasks per window it is an exact subset DP: it finds a placement *iff one exists* and picks the best subset by an explicit objective.
Beyond that it falls back to a deterministic greedy pass and says so (`optimal: false`). `solver.test.ts` checks it against an independent grid brute-force oracle.

**Parallel Futures.**
*Protect priorities*: the highest-priority tasks keep their exact original times; lower-priority work absorbs the change (and may be **deferred**, explicitly).
*Preserve the most tasks*: maximizes how many tasks are placed. *Minimize changes*: keeps the most tasks unmoved, then minimizes total movement
(exhaustive over orderings for up to 6 moving tasks). Every plan is re-checked by `validate.ts` before it is returned; a plan that fails is discarded with a 500, never shown.

**Fortify My Day.** Tries small moves (earlier/later by minutes, swaps, shifting back-to-back runs), within `maxShiftMinutes`, and keeps a move only if the seeded chaos
survival rate and day-start tolerance get better and nothing gets worse. It is a proposal only.

**Mobility** (onboarding "How flexible is your schedule?"): `fixed` keeps the original order and never moves a task earlier; `balanced` allows reordering within 3 hours of where a task sits now;
`flexible` allows any rearrangement inside the window.

## The guarantees, and the tests that prove them

| Guarantee | Where it is enforced | Test |
|---|---|---|
| Never silently delete tasks | every item is placed *or* listed in `deferred`/`unscheduled` with a reason; the validator checks "placed xor deferred" | `futures.test.ts` property test (300 random schedules x 3 strategies), `api.test.ts` |
| Never move locked commitments | locked items are not part of the solver's input | `futures.test.ts`, `cascade.test.ts`, `fortify` property test |
| Never violate deadlines | hard deadlines are constraints, not preferences | property tests, `validate.ts` |
| Clear explanations when infeasible | `diagnose.ts`: reasons, minimal conflicting set, concrete fixes | `engine-misc.test.ts`, `futures.test.ts`, `api.test.ts` |
| Deterministic | no clock, no `Math.random`; seeded PRNG | `chaos`, `cascade`, API determinism tests |
| Non-destructive simulations | engine works on copies; endpoints never write items | `cascade.test.ts`, `api.test.ts` (rows identical before and after) |
| Deferrals need consent, and are kept | `adopt` needs `confirm` + `acceptDeferrals`; deferred tasks remain as unscheduled items | `api.test.ts` |
| Imports are read-only | only GET (and Notion's read-only search/query); `calendar.readonly` scope enforced | `oauth.test.ts` records every outbound request |
| Explicit permission | consent endpoints require `acknowledge: true` + the exact scope; per-import `confirm: true` | `oauth.test.ts` |

## Security summary

- **Sessions**: random 256-bit tokens; only the SHA-256 hash is stored; HttpOnly + Secure (prod) + SameSite cookies, or Bearer tokens; sliding expiry; guests expire in 24h.
- **Google sign-in**: authorization-code flow with PKCE, single-use `state`, `nonce`, ID-token signature/issuer/audience/expiry verification, verified email required, no open redirects.
- **Connections**: read-only scopes only (a broader grant is refused *and revoked*); tokens AES-256-GCM encrypted at rest; never returned by the API; revoked at the provider on disconnect.
- **Authorization**: every query is scoped to the signed-in owner; other people's objects return 404.
- **CSRF**: cookie sessions require an allowed `Origin` or the `X-Breakpoint-Client` header. **CORS**: explicit allow-list.
- **Input**: strict zod schemas (unknown fields rejected), size limits (1 MB JSON, 2 MB `.ics`), bounded parsers and recurrence expansion, no server-side URL fetching from user input (no SSRF).
- **Abuse**: per-IP and per-user rate limits, caps on schedules, items, scenarios and window length.
- **Privacy**: Google events are requested with a `fields` mask (no descriptions, attendees or locations); `DELETE /api/me` erases everything.

## Deploying

The API is a small Node service with a SQLite file: run it anywhere Node 24 runs with a persistent disk (Fly.io, Render, Railway, a VPS). Set `NODE_ENV=production`,
`TOKEN_ENC_KEY`, `APP_ORIGINS` (your site, https) and `API_URL`; back up `DATABASE_PATH`. The in-memory rate limiter is per-process (use a shared store if you run several instances).
The frontend on Cloudflare Pages talks to it over HTTPS (see `docs/FRONTEND.md`). `store/types.ts` is an async interface and `migrations/` is plain SQL, so a Cloudflare D1 implementation is a drop-in later.

## Known limits (MVP)

- Chaos, breaking-point, futures and fortify are CPU-bound and run on the request thread (fortify takes about a second on a busy day); they are rate limited and capped (2000 scenarios, 31-day windows, 300 inline items).
- Exact optimization covers up to 18 flexible tasks per window; larger days use a valid but not provably optimal greedy plan and say so.
- Tasks are not splittable and have no dependencies (task A before task B); both are natural next steps.
- Google/Notion calls could not be exercised against the live services here (no credentials); they are tested against faithful simulations, including real RS256 ID-token signing.
