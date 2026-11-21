// breakpoint api client. zero dependencies, works in any browser (and node 18+).
// copy this file into the frontend (e.g. src/api.js) and import it:
//
//   import { breakpointapi } from './api.js';
//   const api = new breakpointapi({ baseurl: 'https://api.example.com' });
//
// two ways to authenticate (see docs/frontend.md):
//   cookie mode (default): the api is on the same site as the app; the browser stores an httponly session cookie for you.
//   token mode: pass `token` / `ontoken` and the client sends `authorization: bearer ...` instead (cross-site setups).

export class BreakpointError extends Error {
  constructor(status, body) {
    const e = body && body.error ? body.error : {};
    super(e.message || `Request failed (${status})`);
    this.name = 'BreakpointError';
    this.status = status;
    this.code = e.code || 'unknown_error';
    this.details = e.details;
    this.requestId = e.requestId;
  }
}

export class BreakpointApi {
  /**
   * @param {{ baseurl: string, token?: string|null, ontoken?: (t: string|null) => void, fetch?: typeof fetch, timeoutms?: number }} opts
   */
  constructor(opts) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 20000; // every request is abandoned after this (capabilities() uses 4 s)
    this.token = opts.token ?? null;
    this.onToken = opts.onToken ?? null;
    this._fetch = opts.fetch ?? ((...a) => fetch(...a));
  }

  async request(method, path, body, timeoutMs = this.timeoutMs) {
    const headers = { 'X-Breakpoint-Client': '1' }; // csrf guard: forces a cors preflight for cross-site pages
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    let res;
    try {
      res = await this._fetch(this.baseUrl + path, {
        method,
        headers,
        credentials: 'include',
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctl ? ctl.signal : undefined,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (res.status === 204) return null;
    let json = null;
    try {
      json = await res.json();
    } catch {
      /* non-json error */
    }
    if (!res.ok) throw new BreakpointError(res.status, json);
    return json;
  }

  _setToken(t) {
    this.token = t;
    if (this.onToken) this.onToken(t);
  }

  /** what the server can do: { google, notion, ics, accounts }. throws if the server is unreachable (4s timeout). */
  capabilities() { return this.request('GET', '/api/capabilities', undefined, 4000); }

  /* ───────── session ───────── */

  /** start (or reuse) a guest session with the demo schedule: no login needed. */
  async guest(timezone) {
    const r = await this.request('POST', `/api/auth/guest${timezone ? `?tz=${encodeURIComponent(timezone)}` : ''}`);
    if (r.token) this._setToken(r.token);
    return r; // { user, token, expiresat, demoscheduleid }
  }
  me() { return this.request('GET', '/api/me'); }
  async logout() { await this.request('POST', '/api/auth/logout'); this._setToken(null); }
  async deleteAccount() { await this.request('DELETE', '/api/me', { confirm: 'delete my account' }); this._setToken(null); }

  /**
   * call once on every page load. if the url has #bp_code=... (you were just redirected back from google sign-in) this trades
   * the single-use code for a session token (needed when the app and api are on different sites) and cleans the url.
   * returns the user, or null when there was no code.
   */
  async completeSignIn() {
    const m = /[#&]bp_code=([A-Za-z0-9_-]+)/.exec(typeof location !== 'undefined' ? location.hash : '');
    if (!m) return null;
    try {
      const r = await this.request('POST', '/api/auth/exchange', { code: m[1] });
      this._setToken(r.token);
      return r.user;
    } finally {
      if (typeof history !== 'undefined') history.replaceState(null, '', location.pathname + location.search);
    }
  }

  /** returns the google sign-in url. navigate to it: `location.href = await api.googlesigninurl('/app')`. a guest keeps their schedules. */
  async googleSignInUrl(redirectPath = '/') {
    return (await this.request('GET', `/api/auth/google/start?redirect=${encodeURIComponent(redirectPath)}`)).url;
  }

  /* ───────── connections (read-only, explicit consent) ───────── */

  listConnections() { return this.request('GET', '/api/connections').then((r) => r.connections); }
  /** show the user the read-only scope first. only call this after they click "allow read-only access". */
  async googleConnectUrl(redirectPath = '/') {
    return (await this.request('POST', '/api/connections/google/start', { acknowledge: true, scopes: ['https://www.googleapis.com/auth/calendar.readonly'], redirect: redirectPath })).url;
  }
  /** "log in with notion": returns the notion consent url (navigate to it). needs `capabilities().notionlogin`. */
  async notionLoginUrl(redirectPath = '/') { return (await this.request('POST', '/api/connections/notion/start', { acknowledge: true, redirect: redirectPath })).url; }
  connectNotion(integrationToken) { return this.request('POST', '/api/connections/notion', { acknowledge: true, token: integrationToken }); }
  disconnect(connectionId) { return this.request('DELETE', `/api/connections/${connectionId}`); }
  googleCalendars(connectionId) { return this.request('GET', `/api/connections/${connectionId}/google/calendars`).then((r) => r.calendars); }
  notionDatabases(connectionId) { return this.request('GET', `/api/connections/${connectionId}/notion/databases`).then((r) => r.databases); }

  /* ───────── schedules + items ───────── */

  listSchedules() { return this.request('GET', '/api/schedules').then((r) => r.schedules); }
  createSchedule({ name, timezone, preferences }) { return this.request('POST', '/api/schedules', { name, timezone, preferences }).then((r) => r.schedule); }
  getSchedule(id) { return this.request('GET', `/api/schedules/${id}`).then((r) => r.schedule); }
  renameSchedule(id, name) { return this.request('PATCH', `/api/schedules/${id}`, { name }); }
  deleteSchedule(id) { return this.request('DELETE', `/api/schedules/${id}`); }
  /** replaces the preferences. see `onboardingtopreferences` below for the onboarding screens. */
  setPreferences(id, preferences) { return this.request('PUT', `/api/schedules/${id}/preferences`, preferences).then((r) => r.preferences); }
  listItems(id) { return this.request('GET', `/api/schedules/${id}/items`).then((r) => r.items); }
  addItems(id, itemOrItems) { return this.request('POST', `/api/schedules/${id}/items`, itemOrItems).then((r) => r.items); }
  updateItem(id, itemId, patch) { return this.request('PATCH', `/api/schedules/${id}/items/${itemId}`, patch).then((r) => r.item); }
  deleteItem(id, itemId) { return this.request('DELETE', `/api/schedules/${id}/items/${itemId}`); }

  /* ───────── imports (read-only copies) ───────── */

  /** `text` is the contents of the .ics file (read it in the browser with file.text()). use dryrun to preview. */
  importIcs(id, text, opts = {}) { return this.request('POST', `/api/schedules/${id}/import/ics`, { ics: text, ...opts }); }
  /** a calendar link: google "secret address in ical format" or an icloud public calendar link. read once by the server, never stored. `provider`: 'google' | 'apple'. */
  importLink(id, url, opts = {}) { return this.request('POST', `/api/schedules/${id}/import/link`, { url, ...opts }); }
  importGoogle(id, { connectionId, calendarId, from, to, dryRun }) { return this.request('POST', `/api/schedules/${id}/import/google`, { connectionId, calendarId, from, to, confirm: true, dryRun }); }
  importNotion(id, { connectionId, databaseId, mapping, dryRun }) { return this.request('POST', `/api/schedules/${id}/import/notion`, { connectionId, databaseId, mapping: mapping || {}, confirm: true, dryRun }); }

  /* ───────── the engine on a saved schedule ─────────
     `window` is { date: 'yyyy-mm-dd' } (the schedule's local day) or { from, to } as iso strings. */

  plan(id, window) { return this.request('POST', `/api/schedules/${id}/plan`, { window }); }
  simulate(id, window, disruptions, save) { return this.request('POST', `/api/schedules/${id}/simulate`, { window, disruptions, save }); }
  breakingPoint(id, window, opts = {}) { return this.request('POST', `/api/schedules/${id}/breaking-point`, { window, ...opts }); }
  futures(id, window, disruptions = []) { return this.request('POST', `/api/schedules/${id}/futures`, { window, disruptions }); }
  chaos(id, window, opts = {}) { return this.request('POST', `/api/schedules/${id}/chaos`, { window, ...opts }); }
  fortify(id, window, opts = {}) { return this.request('POST', `/api/schedules/${id}/fortify`, { window, ...opts }); }
  /** creates a new schedule from a future/fortify proposal. `confirm` is mandatory; list deferred task ids in acceptdeferrals. */
  adopt(id, { window, source, name, acceptDeferrals }) { return this.request('POST', `/api/schedules/${id}/adopt`, { window, source, name, acceptDeferrals, confirm: true }); }
  runs(id) { return this.request('GET', `/api/schedules/${id}/runs`).then((r) => r.runs); }

  /* ───────── guest demo: no account, nothing stored ───────── */

  demoSchedule(timezone) { return this.request('GET', `/api/demo/schedule${timezone ? `?tz=${encodeURIComponent(timezone)}` : ''}`); }
  /** kind: plan | simulate | chaos | breaking-point | futures | fortify. `body` = { schedule: { preferences, items }, window, ... } */
  engine(kind, body) { return this.request('POST', `/api/engine/${kind}`, body); }
}

/**
 * maps the onboarding screens to api preferences.
 *   priorities: ids selected on "what matters most?", in the order the user wants them protected
 *               (the first gets priority 5, the next 4, ...). e.g. ['school', 'fitness']
 *   flexibility: 0 | 1 | 2  ->  'fixed' | 'balanced' | 'flexible'   ("how flexible is your schedule?")
 */
export function onboardingToPreferences({ priorities = [], flexibility = 1, timezone, workingHours } = {}) {
  const names = { school: 'School', fitness: 'Fitness', extra: 'Extracurriculars', other: 'Other' };
  const categoryPriority = {};
  priorities.slice(0, 4).forEach((p, i) => { categoryPriority[names[p] || p] = 5 - i; });
  return {
    ...(timezone ? { timezone } : {}),
    ...(workingHours ? { workingHours } : {}),
    categoryPriority,
    mobility: ['fixed', 'balanced', 'flexible'][flexibility] || 'balanced',
  };
}
