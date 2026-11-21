# breakpoint backend

a deterministic scheduling engine and rest api that stress-tests a schedule *before* life does.

- **chaos engine**: seeded, reproducible disruption scenarios (delays, overruns, unexpected commitments, lost time).
- **butterfly effect**: how one disruption ripples through everything after it (shifts, conflicts, missed deadlines).
- **breaking point**: the exact number of minutes a schedule tolerates before a *critical* failure, both "if you do nothing" and "if you re-plan".
- **parallel futures**: three recovery plans: *protect priorities*, *preserve the most tasks*, *minimize changes*.
- **fortify my day**: small preventive moves, each *proven* by re-simulation.
- **preferences**: fixed commitments, priorities, flexible tasks, deadlines, recurring events, protected breaks, mobility.
- **auth**: google sign-in (oidc + pkce), saved schedules, and a no-login guest demo.
- **imports (read-only)**: `.ics`, google calendar, notion, each behind explicit consent.

**no ai is involved in any scheduling calculation.** the engine is plain, deterministic typescript: same input, same output, every time.

## run it locally (about 2 minutes)

requires **node 24+** (it runs typescript and sqlite natively: no build step, no native add-ons).

```powershell
cd server
npm install
npm test            # 123 tests, ~1 minute (typecheck separately: npm run typecheck)
npm start           # http://localhost:8787
```

in a second terminal, drive the real server end to end (guest session, simulations, adopt, delete):

```powershell
npm run smoke       # 15 checks against http://localhost:8787
npm run sim         # API + pretend Google + pretend Notion: try every connector with no credentials (docs/SETUP-CONNECTORS.md)
```

or try it by hand: the landing-page scenario is served ready to use.

```powershell
curl http://localhost:8787/api/demo/schedule
```

optional configuration (google sign-in, production settings): copy `.env.example` to `.env`, then `node --env-file=.env src/index.ts`.
the guest demo and `.ics` import need no configuration at all.

## project structure

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

## how the engine reasons

time is integer minutes; plans are plain data. an item is an **event** (calendar commitment, *locked* by default), a **task** (flexible,
optional release time and **hard deadline**) or a **break** (protected, never deferrable). locked items are never moved, resized or removed.

**butterfly effect (do nothing).** disruptions are applied to *copies* of the plan. locked commitments stay put; if two of them collide that
is a conflict. flexible work keeps its order, starts when you are free, pauses around locked blocks and resumes after. nothing is ever dropped: whatever no
longer fits becomes a conflict with a severity: **critical** (hard deadline missed, a critical commitment double-booked, a non-deferrable task no
longer fits), **major**, or **minor** (outside your hours).

**breaking point.** the largest disruption that causes no *new* critical conflict (problems already in your plan are reported separately).
`cascade` mode scans minute by minute (exact). `recover` mode asks the solver whether *any* feasible re-plan exists and binary-searches
(exact; the search is monotone for overruns, lost time and unexpected commitments and scans linearly for delays). the tests check both against brute force.

**the solver.** flexible tasks run in one piece inside the free gaps between locked commitments and available hours, between their release time and hard deadline.
up to 18 tasks per window it is an exact subset dp: it finds a placement *iff one exists* and picks the best subset by an explicit objective.
beyond that it falls back to a deterministic greedy pass and says so (`optimal: false`). `solver.test.ts` checks it against an independent grid brute-force oracle.

**parallel futures.**
*protect priorities*: the highest-priority tasks keep their exact original times; lower-priority work absorbs the change (and may be **deferred**, explicitly).
*preserve the most tasks*: maximizes how many tasks are placed. *minimize changes*: keeps the most tasks unmoved, then minimizes total movement
(exhaustive over orderings for up to 6 moving tasks). every plan is re-checked by `validate.ts` before it is returned; a plan that fails is discarded with a 500, never shown.

**fortify my day.** tries small moves (earlier/later by minutes, swaps, shifting back-to-back runs), within `maxShiftMinutes`, and keeps a move only if the seeded chaos
survival rate and day-start tolerance get better and nothing gets worse. it is a proposal only.

**mobility** (onboarding "how flexible is your schedule?"): `fixed` keeps the original order and never moves a task earlier; `balanced` allows reordering within 3 hours of where a task sits now;
`flexible` allows any rearrangement inside the window.

## the guarantees, and the tests that prove them

| guarantee | where it is enforced | test |
|---|---|---|
| never silently delete tasks | every item is placed *or* listed in `deferred`/`unscheduled` with a reason; the validator checks "placed xor deferred" | `futures.test.ts` property test (300 random schedules x 3 strategies), `api.test.ts` |
| never move locked commitments | locked items are not part of the solver's input | `futures.test.ts`, `cascade.test.ts`, `fortify` property test |
| never violate deadlines | hard deadlines are constraints, not preferences | property tests, `validate.ts` |
| clear explanations when infeasible | `diagnose.ts`: reasons, minimal conflicting set, concrete fixes | `engine-misc.test.ts`, `futures.test.ts`, `api.test.ts` |
| deterministic | no clock, no `Math.random`; seeded prng | `chaos`, `cascade`, api determinism tests |
| non-destructive simulations | engine works on copies; endpoints never write items | `cascade.test.ts`, `api.test.ts` (rows identical before and after) |
| deferrals need consent, and are kept | `adopt` needs `confirm` + `acceptDeferrals`; deferred tasks remain as unscheduled items | `api.test.ts` |
| imports are read-only | only get (and notion's read-only search/query); `calendar.readonly` scope enforced | `oauth.test.ts` records every outbound request |
| explicit permission | consent endpoints require `acknowledge: true` + the exact scope; per-import `confirm: true` | `oauth.test.ts` |

## security summary

- **sessions**: random 256-bit tokens; only the sha-256 hash is stored; httponly + secure (prod) + samesite cookies, or bearer tokens; sliding expiry; guests expire in 24h.
- **google sign-in**: authorization-code flow with pkce, single-use `state`, `nonce`, id-token signature/issuer/audience/expiry verification, verified email required, no open redirects.
- **connections**: read-only scopes only (a broader grant is refused *and revoked*); tokens aes-256-gcm encrypted at rest; never returned by the api; revoked at the provider on disconnect.
- **authorization**: every query is scoped to the signed-in owner; other people's objects return 404.
- **csrf**: cookie sessions require an allowed `Origin` or the `X-Breakpoint-Client` header. **cors**: explicit allow-list.
- **input**: strict zod schemas (unknown fields rejected), size limits (1 mb json, 2 mb `.ics`), bounded parsers and recurrence expansion, no server-side url fetching from user input (no ssrf).
- **abuse**: per-ip and per-user rate limits, caps on schedules, items, scenarios and window length.
- **privacy**: google events are requested with a `fields` mask (no descriptions, attendees or locations); `DELETE /api/me` erases everything.

## deploying

the api is a small node service with a sqlite file: run it anywhere node 24 runs with a persistent disk (fly.io, render, railway, a vps). set `NODE_ENV=production`,
`TOKEN_ENC_KEY`, `APP_ORIGINS` (your site, https) and `API_URL`; back up `DATABASE_PATH`. the in-memory rate limiter is per-process (use a shared store if you run several instances).
the frontend on cloudflare pages talks to it over https (see `docs/FRONTEND.md`). `store/types.ts` is an async interface and `migrations/` is plain sql, so a cloudflare d1 implementation is a drop-in later.

## known limits (mvp)

- chaos, breaking-point, futures and fortify are cpu-bound and run on the request thread (fortify takes about a second on a busy day); they are rate limited and capped (2000 scenarios, 31-day windows, 300 inline items).
- exact optimization covers up to 18 flexible tasks per window; larger days use a valid but not provably optimal greedy plan and say so.
- tasks are not splittable and have no dependencies (task a before task b); both are natural next steps.
- google/notion calls could not be exercised against the live services here (no credentials); they are tested against faithful simulations, including real rs256 id-token signing.
