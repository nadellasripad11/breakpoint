# Rescue My Day, Pip Explains Why, and the Judge Challenge

All three are built on the same deterministic engine as the rest of Breakpoint (`src/engine/`). No language model is involved anywhere:
every schedule, number and sentence is computed. The engine is also bundled into the website (as a lazy chunk), so the demos work on the static
site with **no account and no server**.

## Try it

* Landing page → **Rescue my day** (nav) or **Can you save this day?** (hero link). Both open one overlay with two tabs.
* **Rescue my day** opens with a generated sample day already broken. Add your own disruptions (runs long, starts late, surprise commitment, lost time), change how flexible the day is, replay the timeline, read the conflicts, the changes and Pip's explanation. "Try another sample day" generates a new one.
* **Can you save this day?** gives you a fragile day, lets you break it, and asks you to fix it by hand (drag blocks, or tap one and nudge it). You are then compared with Breakpoint's own fix.

## What "the smallest feasible change" means

Applied in this order, exactly:

1. **Defer nothing** if some valid schedule keeps every task. If not, defer the least important work (never anything with a hard deadline, never a protected break), explicitly and listed, never deleted.
2. **Touch the fewest items.** An item is "kept" only if it still starts at exactly its original minute.
3. **Move the touched items the fewest total minutes.** Exact: the least total distance over every order and every integer start minute (`minDisplacementPlacement`, a dynamic programme over (set of tasks placed, minute the last one ends)).

Hard rules that are never traded away: locked commitments do not move; hard deadlines are met; protected breaks stay inside their windows
(and are never deferred or shortened); nothing overlaps; flexible work stays inside the user's available hours. If no schedule satisfies them, the result is
`status: "impossible"`, nothing is changed, and the diagnosis says why with numbers (shortfall minutes, the minimal conflicting set, the cheapest fixes).

How this is checked (not just claimed), in `test/rescue.test.ts` and `test/challenge.test.ts`:

* 400 random small instances: the solver's cost equals an independent brute-force search, in both free and fixed-order modes, including "no placement exists".
* 120 random tiny days: rescue's (items moved, minutes moved) equals an exhaustive search of every possible day, and "impossible" is reported exactly when the exhaustive search finds no valid day.
* 300 random nudges of Breakpoint's own fix, and every one of over 100 valid alternatives built by random strategies, never beat it.
* Property tests: over 300 random days, whenever a repair exists every guarantee is re-verified true and nothing locked moved.

**Limits.** The exact optimisation covers up to 9 flexible tasks inside a 2,000-minute span. Beyond that it falls back to a deterministic heuristic and returns
`optimal: false`, and the UI says it is not proven the smallest.

## Output (`rescueDay(plan, disruptions)`)

| Field | Meaning |
|---|---|
| `status` | `absorbed` (no conflicts), `repaired`, `repaired_with_deferrals`, `impossible` |
| `lanes.original / disrupted / repaired` | the three schedules, side by side (`repaired` is `null` when impossible) |
| `conflicts[]` | every conflict if you carry on, with `slackBefore`, `lateBy`, the `chain` that carried the disruption to that item, and a one-sentence `detail` |
| `changes[]` | each moved item: from, to, minutes, and why |
| `deferred[]` | tasks that had to wait (kept, never deleted) |
| `guarantees[]` | locked unmoved, deadlines met, breaks protected, no overlap, nothing deleted, inside hours: **re-checked against the repaired lanes**, with counts |
| `diagnosis` | when impossible: reasons, minimal conflicting set, suggestions |
| `replay[]` | frames for the timeline replay: original → each disruption in turn → conflicts → each move → done |
| `pip[]` | Pip's explanation (below) |
| `alternatives[]` | what the other two strategies would cost |

API: `POST /api/engine/rescue` (no login, inline schedule) and `POST /api/schedules/:id/rescue` (saved schedule). Body: `{ window, disruptions[1..20] }`. Times in the response are ISO strings.

## Pip Explains Why

`explainRescue` (in `src/engine/explain.ts`) turns the simulation results into sentences. Each sentence is a fixed template whose blanks are filled from computed values, and
each line carries those values in `facts`, so they can be checked. For example the buffer is found by a binary search over the cascade simulation:

> Your project ran 45 minutes long, but you had only 25 minutes of buffer before it misses its 5:25 PM deadline. We need to find another 20 minutes.

* *buffer* = the most minutes that disruption could take, on its own, before something new breaks (exact; tests compare it with a minute-by-minute scan);
* *wall* = the first thing that breaks one minute later (a deadline, a lock, a protected break);
* *shortfall* = disruption − buffer;
* then the smallest fix, one line per change (with the items either side of its new slot), why it is the smallest (the other strategies' costs), what stayed put (locked items, protected windows), or, if impossible, the diagnosis and cheapest ways out.

Nothing is invented: if a quantity cannot be computed, no sentence is produced for it.

## The judge challenge

* `makeChallenge(seed)` generates a deliberately fragile day (8 items, 2 locked events, a protected lunch, hard deadlines, tiny gaps) plus a suggested disruption. A seed gives the same day every time. The generator **verifies** each candidate: the starting day is valid, the suggested disruption really breaks it, it is repairable without deferrals, and the fix is visible but modest (1–4 moves). Candidates that fail are skipped.
* `judgeAttempt(plan, attempt)` checks a visitor's fix with exact messages (overlaps with minutes, deadlines missed by N minutes, break outside its window, silent drops, moving a lock...) and cross-checks itself against the engine's independent validator (it throws if they ever disagree).
* The comparison is lexicographic on (tasks deferred, items moved, minutes moved). The score is `100 × (Breakpoint's cost + 30) / (your cost + 30)` where cost = minutes moved + 15 per item touched + 120 per task deferred (shown in the UI).
* Visitors may add any disruption. If nobody could survive it, the verdict is "this day cannot be saved" with the reason.

Times in the challenge are fixed wall-clock times (UTC labels), the same for everyone.
