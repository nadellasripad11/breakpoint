# rescue my day, pip explains why, and the judge challenge

all three are built on the same deterministic engine as the rest of breakpoint (`src/engine/`). no language model is involved anywhere:
every schedule, number and sentence is computed. the engine is also bundled into the website (as a lazy chunk), so the demos work on the static
site with **no account and no server**.

## try it

* landing page -> **rescue my day** (nav) or **can you save this day?** (hero link). both open one overlay with two tabs.
* **rescue my day** opens with a generated sample day already broken. add your own disruptions (runs long, starts late, surprise commitment, lost time), change how flexible the day is, replay the timeline, read the conflicts, the changes and pip's explanation. "try another sample day" generates a new one.
* **can you save this day?** gives you a fragile day, lets you break it, and asks you to fix it by hand (drag blocks, or tap one and nudge it). you are then compared with breakpoint's own fix.

## what "the smallest feasible change" means

applied in this order, exactly:

1. **defer nothing** if some valid schedule keeps every task. if not, defer the least important work (never anything with a hard deadline, never a protected break), explicitly and listed, never deleted.
2. **touch the fewest items.** an item is "kept" only if it still starts at exactly its original minute.
3. **move the touched items the fewest total minutes.** exact: the least total distance over every order and every integer start minute (`minDisplacementPlacement`, a dynamic programme over (set of tasks placed, minute the last one ends)).

hard rules that are never traded away: locked commitments do not move; hard deadlines are met; protected breaks stay inside their windows
(and are never deferred or shortened); nothing overlaps; flexible work stays inside the user's available hours. if no schedule satisfies them, the result is
`status: "impossible"`, nothing is changed, and the diagnosis says why with numbers (shortfall minutes, the minimal conflicting set, the cheapest fixes).

how this is checked (not just claimed), in `test/rescue.test.ts` and `test/challenge.test.ts`:

* 400 random small instances: the solver's cost equals an independent brute-force search, in both free and fixed-order modes, including "no placement exists".
* 120 random tiny days: rescue's (items moved, minutes moved) equals an exhaustive search of every possible day, and "impossible" is reported exactly when the exhaustive search finds no valid day.
* 300 random nudges of breakpoint's own fix, and every one of over 100 valid alternatives built by random strategies, never beat it.
* property tests: over 300 random days, whenever a repair exists every guarantee is re-verified true and nothing locked moved.

**limits.** the exact optimisation covers up to 9 flexible tasks inside a 2,000-minute span. beyond that it falls back to a deterministic heuristic and returns
`optimal: false`, and the ui says it is not proven the smallest.

## output (`rescueDay(plan, disruptions)`)

| field | meaning |
|---|---|
| `status` | `absorbed` (no conflicts), `repaired`, `repaired_with_deferrals`, `impossible` |
| `lanes.original / disrupted / repaired` | the three schedules, side by side (`repaired` is `null` when impossible) |
| `conflicts[]` | every conflict if you carry on, with `slackBefore`, `lateBy`, the `chain` that carried the disruption to that item, and a one-sentence `detail` |
| `changes[]` | each moved item: from, to, minutes, and why |
| `deferred[]` | tasks that had to wait (kept, never deleted) |
| `guarantees[]` | locked unmoved, deadlines met, breaks protected, no overlap, nothing deleted, inside hours: **re-checked against the repaired lanes**, with counts |
| `diagnosis` | when impossible: reasons, minimal conflicting set, suggestions |
| `replay[]` | frames for the timeline replay: original -> each disruption in turn -> conflicts -> each move -> done |
| `pip[]` | pip's explanation (below) |
| `brief[]` | pip in three short lines or fewer: what happened, what breaks, the fix. this is what the screen shows, typed out in a speech box (each way forward in `options[]` has its own). every number in it is computed |
| `options[]` | **three ways forward** for the same disruption (protect priorities / preserve the most tasks / minimize changes). each has its own `view`: repaired lane, changes, guarantees, pip's words and replay. `sameAs` says when two ways land on the identical day. the top-level fields above always describe the smallest change |
| `alternatives[]` | what the other two strategies would cost (kept for older clients) |

**test it again.** `adoptRepair(plan, disruptions, strategy)` turns one way forward into a new plan (every item where that repair put it, an overrun keeps its new length, a surprise commitment becomes a locked event, deferred tasks are set aside, not deleted). the rescue screen's "test this schedule again" uses it, then breaks the repaired day's weakest link. the tests prove the adopted day has no conflicts left.

the site opens on generated day 0. link to another with `?day=N` (for example `?day=4`, where the three ways genuinely differ).

api: `POST /api/engine/rescue` (no login, inline schedule) and `POST /api/schedules/:id/rescue` (saved schedule). body: `{ window, disruptions[1..20] }`. times in the response are iso strings.

## pip explains why

`explainRescue` (in `src/engine/explain.ts`) turns the simulation results into sentences. each sentence is a fixed template whose blanks are filled from computed values, and
each line carries those values in `facts`, so they can be checked. for example the buffer is found by a binary search over the cascade simulation:

> your project ran 45 minutes long, but you had only 25 minutes of buffer before it misses its 5:25 pm deadline. we need to find another 20 minutes.

* *buffer* = the most minutes that disruption could take, on its own, before something new breaks (exact; tests compare it with a minute-by-minute scan);
* *wall* = the first thing that breaks one minute later (a deadline, a lock, a protected break);
* *shortfall* = disruption − buffer;
* then the smallest fix, one line per change (with the items either side of its new slot), why it is the smallest (the other strategies' costs), what stayed put (locked items, protected windows), or, if impossible, the diagnosis and cheapest ways out.

nothing is invented: if a quantity cannot be computed, no sentence is produced for it.

## the judge challenge

* `makeChallenge(seed)` generates a deliberately fragile day (8 items, 2 locked events, a protected lunch, hard deadlines, tiny gaps) plus a suggested disruption. a seed gives the same day every time. the generator **verifies** each candidate: the starting day is valid, the suggested disruption really breaks it, it is repairable without deferrals, and the fix is visible but modest (1–4 moves). candidates that fail are skipped.
* `judgeAttempt(plan, attempt)` checks a visitor's fix with exact messages (overlaps with minutes, deadlines missed by n minutes, break outside its window, silent drops, moving a lock...) and cross-checks itself against the engine's independent validator (it throws if they ever disagree).
* the comparison is lexicographic on (tasks deferred, items moved, minutes moved). the score is `100 × (Breakpoint's cost + 30) / (your cost + 30)` where cost = minutes moved + 15 per item touched + 120 per task deferred (shown in the ui).
* visitors may add any disruption. if nobody could survive it, the verdict is "this day cannot be saved" with the reason.

times in the challenge are fixed wall-clock times (utc labels), the same for everyone.
