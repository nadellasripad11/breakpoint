/**
 * end-to-end smoke test against a running server (what a frontend would do).
 *   npm start            (terminal 1)
 *   npm run smoke        (terminal 2)       base_url=http://localhost:8787 by default
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:8787';
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

async function api(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, headers: res.headers };
}

const health = await api('GET', '/health');
check('server is up', health.status === 200, BASE);

// 1 · guest demo with no login: stateless engine endpoints
const demo = await api('GET', '/api/demo/schedule?tz=America/Chicago');
check('demo schedule available without login', demo.status === 200 && demo.json.schedule.items.length === 4, `date ${demo.json?.date}`);
const bp = await api('POST', '/api/engine/breaking-point', { body: demo.json.try.breakingPoint });
check('breaking point (stateless): Practice can run 30 min over', bp.json?.result?.cascade?.tolerableMinutes === 30, bp.json?.result?.cascade?.explanation);
const sim = await api('POST', '/api/engine/simulate', { body: demo.json.try.simulate });
check('butterfly effect: a 45 min overrun misses the Project deadline', sim.json?.result?.summary?.survives === false, sim.json?.result?.summary?.headline);
const fut = await api('POST', '/api/engine/futures', { body: demo.json.try.futures });
check('three parallel futures, all feasible', fut.json?.result?.futures?.length === 3 && fut.json.result.futures.every((f: any) => f.feasible), `recommended: ${fut.json?.result?.recommended}`);

// 2 · guest session with a saved schedule
const g = await api('POST', '/api/auth/guest?tz=America/Chicago');
check('guest session created', g.status === 201 && !!g.json.token);
const token = g.json.token as string;
const id = g.json.demoScheduleId as string;
const plan = await api('POST', `/api/schedules/${id}/plan`, { token, body: { window: { date: demo.json.date } } });
const practice = plan.json.items.find((i: any) => i.title === 'Practice');
check('saved schedule has a baseline plan', plan.status === 200 && plan.json.items.length === 4);
const chaos = await api('POST', `/api/schedules/${id}/chaos`, { token, body: { window: { date: demo.json.date }, scenarios: 200, seed: 1, save: true } });
check('chaos engine ran 200 seeded scenarios', chaos.status === 200, chaos.json?.result?.summary);
const fort = await api('POST', `/api/schedules/${id}/fortify`, { token, body: { window: { date: demo.json.date } } });
check('fortify returned a proposal (nothing applied)', fort.status === 200 && /proposal only/.test(fort.json.result.explanation.at(-1)));
const runs = await api('GET', `/api/schedules/${id}/runs`, { token });
check('saved run appears in history', runs.json?.runs?.length === 1);

// 3 · non-destructive: the original is untouched after everything above
const items = await api('GET', `/api/schedules/${id}/items`, { token });
check('original schedule unchanged by simulations', items.json.items.length === 4 && items.json.items.every((i: any) => i.source === 'demo'));

// 4 · adopt requires explicit confirmation
const fut2 = await api('POST', `/api/schedules/${id}/futures`, { token, body: { window: { date: demo.json.date }, disruptions: [{ type: 'overrun', targetId: practice.id, minutes: 45 }] } });
const keepAll = fut2.json.result.futures.find((f: any) => f.strategy === 'minimize_changes');
check('minimize-changes keeps every task', keepAll.deferred.length === 0, `moved ${keepAll.metrics.movedCount}, total movement ${keepAll.metrics.totalDisplacementMinutes} min`);
const noConfirm = await api('POST', `/api/schedules/${id}/adopt`, { token, body: { window: { date: demo.json.date }, source: { kind: 'future', strategy: 'minimize_changes', disruptions: [{ type: 'overrun', targetId: practice.id, minutes: 45 }] } } });
check('adopt without confirm is refused', noConfirm.status === 400);
const adopted = await api('POST', `/api/schedules/${id}/adopt`, { token, body: { window: { date: demo.json.date }, confirm: true, source: { kind: 'future', strategy: 'minimize_changes', disruptions: [{ type: 'overrun', targetId: practice.id, minutes: 45 }] } } });
check('adopt creates a NEW schedule, original untouched', adopted.status === 201 && adopted.json.originalScheduleUnchanged === true, adopted.json?.schedule?.name);

// 5 · clean up: the guest erases their own data
const del = await api('DELETE', '/api/me', { token, body: { confirm: 'delete my account' } });
check('guest can delete all their data', del.status === 204);

console.log(failures === 0 ? '\nAll smoke checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
