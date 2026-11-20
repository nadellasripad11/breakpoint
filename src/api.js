import { BreakpointApi, onboardingToPreferences } from '../server/client/breakpoint-client.js';

/**
 * The one place the page talks to the Breakpoint API.
 *  - No VITE_API_URL  -> `api` is null and every helper reports "preview mode" (the site works as before).
 *  - Sessions are lazy: nobody gets a guest sandbox until they actually connect something.
 *  - Tokens live in sessionStorage (tab-scoped), never localStorage; cookies are used too when the browser allows them.
 */
const BASE = (import.meta.env.VITE_API_URL || '').trim();
const TOKEN_KEY = 'bp:token';
const SCHEDULE_KEY = 'bp:schedule';
const SCHEDULE_NAME = 'My schedule';

const mem = {};
const ss = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return mem[k] ?? null; } },
  set(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { mem[k] = v; } },
};
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return mem[k] ?? null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { mem[k] = v; } },
};

export const api = BASE ? new BreakpointApi({ baseUrl: BASE, token: ss.get(TOKEN_KEY), onToken: (t) => ss.set(TOKEN_KEY, t) }) : null;
export const apiEnabled = !!api;

export const timezone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

let user = null;
let scheduleId = null;

/** Who we are right now: reuses a live session, otherwise starts a guest sandbox (no login, no personal data). */
export async function ensureSession() {
  if (user) return user;
  try {
    user = (await api.me()).user;
  } catch (e) {
    if (e.status !== 401) throw e;
    api._setToken(null);
    user = (await api.guest(timezone())).user;
  }
  return user;
}

/** Like ensureSession, but never creates a guest: returns null when nobody is signed in. */
export async function peekSession() {
  if (user) return user;
  try {
    user = (await api.me()).user;
    return user;
  } catch (e) {
    if (e.status !== 401) throw e;
    api._setToken(null);
    return null;
  }
}

/** Call once on page load. Trades a #bp_code from Google sign-in for a session (see docs/FRONTEND.md). */
export async function completeSignIn() {
  const u = await api.completeSignIn();
  if (u) { user = u; scheduleId = null; }
  return u;
}

export const currentUser = () => user;

/** The visitor's schedule, if they already have one. Never creates anything. */
export async function findSchedule() {
  if (scheduleId) return scheduleId;
  if (!(await peekSession())) return null;
  const saved = ls.get(SCHEDULE_KEY);
  if (saved) {
    try {
      scheduleId = (await api.getSchedule(saved)).id;
      return scheduleId;
    } catch (e) {
      if (e.status !== 404 && e.status !== 403) throw e;
    }
  }
  // a new tab or cleared storage still has the session: reuse the schedule onboarding made earlier
  const existing = (await api.listSchedules()).find((s) => s.name === SCHEDULE_NAME);
  if (!existing) return null;
  scheduleId = existing.id;
  ls.set(SCHEDULE_KEY, scheduleId);
  return scheduleId;
}

/** The schedule onboarding imports into. Re-running onboarding reuses it (imports are idempotent). */
export async function ensureSchedule() {
  const found = await findSchedule().catch((e) => { if (e.status === 401) return null; throw e; });
  if (found) return found;
  await ensureSession();
  scheduleId = (await api.createSchedule({ name: SCHEDULE_NAME, timezone: timezone() })).id;
  ls.set(SCHEDULE_KEY, scheduleId);
  return scheduleId;
}

export async function savePreferences({ priorities, flexibility }) {
  const id = await ensureSchedule();
  return api.setPreferences(id, onboardingToPreferences({ priorities, flexibility, timezone: timezone() }));
}

/** Messages are written for people. Network failures get one clear sentence; API errors already carry one. */
export function friendlyError(e) {
  if (!e) return 'Something went wrong. Please try again.';
  if (e.name === 'AbortError' || (e instanceof TypeError && /fetch|network|load failed|failed to/i.test(e.message))) return 'Couldn’t reach the Breakpoint server. Check your connection and try again.';
  if (e.code === 'rate_limited') return 'Too many tries in a row. Wait a minute, then try again.';
  if (e.code === 'unauthenticated') return 'Your session ended. Close this and try again.';
  if (e.code === 'validation_error' && Array.isArray(e.details) && e.details[0]) return e.details[0].message || e.message;
  return e.message || 'Something went wrong. Please try again.';
}

/** Messages for the ?auth_error= / ?connect_error= codes the API redirects back with. */
export const RETURN_ERRORS = {
  access_denied: 'You chose not to share, so nothing was connected. You can try again whenever you like.',
  scope_too_broad: 'Google offered more access than Breakpoint asked for, so nothing was saved. Try again and keep only the read-only calendar permission.',
  scope_missing: 'Read-only calendar access wasn’t granted, so nothing was connected. Try again and keep the calendar permission ticked.',
  no_refresh_token: 'Google didn’t allow ongoing read access, so nothing was connected. Try again.',
  invalid_state: 'That sign-in link expired. Start again from here.',
  invalid_request: 'That sign-in link wasn’t valid. Start again from here.',
  invalid_code: 'That sign-in link expired or was already used. Start again from here.',
  google_not_configured: 'Google isn’t switched on for this server yet.',
  notion_not_configured: 'Log in with Notion isn’t switched on for this server yet. You can paste a token instead.',
  connect_failed: 'Notion or Google couldn’t finish that, so nothing was connected. Please try again.',
  email_unverified: 'Google says that email address isn’t verified, so we couldn’t sign you in.',
};
export const returnError = (code) => RETURN_ERRORS[code] || 'That couldn’t be finished, so nothing was connected. Please try again.';

export function resetSessionCache() { user = null; scheduleId = null; }
