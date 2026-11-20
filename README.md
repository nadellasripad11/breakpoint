# breakpoint

plan for the what if.

breakpoint is a schedule stress-tester. it tells you exactly how much disruption your day can take before something critical breaks, and when it does break, it computes the smallest change that fixes it. the scheduling is real math, not an ai guessing.

- live site: https://breakpoint-41x.pages.dev
- live api: https://breakpoint-api.nadellasripad11.workers.dev/api/health

## try it in 30 seconds (no account, no setup)

1. open the site and click **can you save this day?**. you get a deliberately fragile day. break it, then fix it by hand without moving a locked event, missing a deadline or touching the protected lunch. breakpoint then shows how it would have done it and scores you against the smallest valid change.
2. open **rescue my day** for the signature feature: a day breaks, and you see the original, the broken day and the repaired day side by side, with a timeline replay, the exact conflicts, and pip explaining why in plain english.
3. click **get started** to bring in your own calendar (google calendar or apple calendar by private link, notion, or an .ics file), then use **rescue my day → my schedule** on it.

## what it does

- **rescue my day**: the smallest feasible change that repairs a broken day. "smallest" has one precise meaning: defer nothing if possible, then touch the fewest items, then move them the fewest total minutes. it is exact, and the tests prove it against brute-force search. locked events never move, deadlines are never missed, protected breaks stay inside their windows. if no valid schedule exists it says why, with numbers, and changes nothing.
- **pip explains why**: plain-english explanations built only from computed numbers ("your project ran 45 minutes long, but you only had 25 minutes of buffer. we need to find another 20 minutes."). no language model, so nothing is invented.
- **can you save this day?**: a judge challenge. days are generated from a seed, your fix is checked with exact messages, and compared with breakpoint's own.
- **the engine**: butterfly effect (how one disruption ripples), breaking point (how many minutes the day can take), parallel futures (protect priorities / keep the most tasks / minimize changes), chaos engine (seeded random disruptions), fortify my day (small changes that make it more resilient).
- **imports, all read-only**: google calendar (its secret ical link), apple calendar (its public icloud link), notion, .ics files. nothing is ever written back to your calendars, and a calendar link is used once and never saved.

## how it is built

```
browser (cloudflare pages)                 api (cloudflare worker)             database
vite + vanilla js, gsap, lenis             hono + zod + jose                   cloudflare d1
the scheduling engine, bundled in   <--->  the same engine + auth + imports    (sqlite in the cloud)
rescue + challenge run entirely here       cron cleans up expired sessions
```

- the engine (`server/src/engine/`) is plain typescript, pure and deterministic: integer minutes, a seeded random generator, an exact subset-dp solver, no network, no clock. the same input always gives the same output. it runs natively on node 24 with no build step, and it is bundled into the website, so the demos work with no server at all.
- the api (`server/src/`) is a hono app that runs on node (sqlite) or on a cloudflare worker (d1). it keeps imports read-only, requires explicit consent for connections, encrypts stored tokens (aes-256-gcm), and uses a csrf guard, a cors allow-list and rate limits.
- guests get a sandbox that is deleted after 24 hours. nothing needs a login except google sign-in, which is optional.

## run it locally

you need node 24 or newer.

```
npm install
npm run dev              # the site on http://localhost:5173  (add ?static to skip animations)
```

to try every connector with no credentials, run the simulator (the real api against a pretend google, icloud and notion):

```
cd server
npm install
npm run sim              # api on http://localhost:8787
```

the site reads the api address from `.env.development`. a production build reads `.env.production`.

## tests

```
npm test                 # the site's unit tests
cd server
npm test                 # the engine and api (110+ tests, includes exhaustive and property tests)
npm run test:d1          # the api suites again, on the cloudflare d1 store
npm run check            # typecheck + all tests
npm run smoke            # 15 end-to-end checks against a running server
```

## deploy

```
npm run build
cd server
npm run cf:migrate       # only when server/migrations changes
npm run cf:deploy
```

then upload `dist/` to cloudflare pages. full steps, secrets and limits are in [`server/docs/HOSTING.md`](server/docs/HOSTING.md).

## project map

| path | what is there |
|---|---|
| `index.html`, `src/` | the landing page, onboarding, connector sheet, rescue and challenge screens |
| `server/src/engine/` | the scheduling engine: cascade, solver, futures, breaking point, chaos, fortify, rescue, explain, challenge |
| `server/src/http/`, `server/src/calendar/`, `server/src/integrations/` | the api, the .ics and calendar-link importers, notion and google connectors |
| `server/src/store/` | sqlite and d1 databases behind one interface |
| `server/scripts/` | the simulator, smoke test and live checks |
| `server/docs/` | the guides below |
| `test/`, `server/test/` | the tests |

## docs

- [`server/docs/RESCUE.md`](server/docs/RESCUE.md): rescue my day, pip explains why and the judge challenge, including what "smallest" means and how it is tested
- [`server/docs/SETUP-CONNECTORS.md`](server/docs/SETUP-CONNECTORS.md): google and apple calendar links, notion, google sign-in
- [`server/docs/HOSTING.md`](server/docs/HOSTING.md): what is deployed where, redeploying, secrets, limits, and why not supabase
- [`server/docs/API.md`](server/docs/API.md) and [`server/docs/FRONTEND.md`](server/docs/FRONTEND.md): the api and how a frontend uses it

## honest limits

- there is no separate "plan" dashboard: finishing onboarding takes you straight into rescue my day on your own schedule.
- notion login is live. google sign-in is switched off on purpose (google wants to verify apps that read calendars), so google calendar uses its private link instead. guest data lasts 24 hours.
- apple has no sign-in for calendars, so apple calendar uses its public link or an exported file. asking for an apple password would be a bad idea, so it is intentionally not offered.
- the cloudflare free plan has request and cpu limits; the hosting guide says what to watch.

made by sripad for a hackathon.
