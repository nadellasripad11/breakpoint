import { ImportError } from './ics.ts';
import type { Fetcher } from '../auth/google.ts';

/**
 * Read-only import from a calendar's private/public link (Google "Secret address in iCal format", iCloud "Public Calendar" link).
 * This needs no OAuth app and no Google verification: the user hands us a link that already grants read access.
 *
 * It is the one place the server fetches a URL the user typed, so it is deliberately narrow:
 *  - only https, only the calendar hosts of the provider (calendar.google.com, *.icloud.com), no IP addresses, no ports, no credentials in the URL;
 *  - every redirect is re-checked against the same allow-list, at most 3 hops;
 *  - a timeout, a hard size cap, GET only, no cookies or authorization sent;
 *  - the link is used once and never stored, logged or echoed back (it is a secret: anyone holding it can read that calendar).
 */

export type LinkProvider = 'google' | 'apple';

const ALLOWED: Record<LinkProvider, (host: string) => boolean> = {
  google: (h) => h === 'calendar.google.com',
  apple: (h) => h === 'icloud.com' || h.endsWith('.icloud.com'),
};
const NAME: Record<LinkProvider, string> = { google: 'Google Calendar', apple: 'Apple Calendar (iCloud)' };

export const MAX_LINK_BYTES = 6 * 1024 * 1024;

/** Turns what the user pasted (webcal://…, http://…, https://…) into an https URL on an allowed calendar host, or throws a clear error. */
export function normalizeCalendarLink(raw: string, provider?: LinkProvider): URL {
  let s = String(raw ?? '').trim().replace(/^[<"'\s]+|[>"'\s]+$/g, '');
  if (s.length < 12 || s.length > 2000) throw new ImportError('link_invalid', 'That doesn’t look like a calendar link.');
  s = s.replace(/^webcals?:\/\//i, 'https://').replace(/^http:\/\//i, 'https://');
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new ImportError('link_invalid', 'That doesn’t look like a calendar link. Paste the whole address, starting with https:// or webcal://.');
  }
  if (url.protocol !== 'https:') throw new ImportError('link_invalid', 'Calendar links must start with https:// or webcal://.');
  if (url.username || url.password) throw new ImportError('link_not_allowed', 'That link has a username or password in it. Use the calendar’s own share link instead.');
  if (url.port && url.port !== '443') throw new ImportError('link_not_allowed', 'That calendar address isn’t one Breakpoint can read.');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const providers: LinkProvider[] = provider ? [provider] : ['google', 'apple'];
  if (!providers.some((p) => ALLOWED[p](host))) {
    throw new ImportError(
      'link_not_allowed',
      provider ? `That isn’t a ${NAME[provider]} link. ${provider === 'google' ? 'It should start with https://calendar.google.com/calendar/ical/' : 'It should look like webcal://p12-caldav.icloud.com/published/…'}` : 'Only Google Calendar and iCloud calendar links are supported. You can still import an .ics file.',
    );
  }
  url.hash = '';
  return url;
}

const humanStatus = (status: number): ImportError => {
  if (status === 404 || status === 410) return new ImportError('link_not_found', 'That link doesn’t exist (any more). If you reset the link or turned sharing off, copy the new one.');
  if (status === 401 || status === 403) return new ImportError('link_forbidden', 'That calendar isn’t shared through this link (or sharing was turned off).');
  if (status === 400) return new ImportError('link_invalid', 'The calendar provider didn’t recognise that link. Copy the whole link again, including the long code at the end.');
  if (status === 429) return new ImportError('link_busy', 'The calendar provider is limiting requests. Try again in a minute.');
  return new ImportError('link_failed', `The calendar provider answered with an error (${status}). Try again in a moment.`);
};

async function readLimited(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw new ImportError('too_large', 'That calendar is too large to import from a link. Export it as an .ics file for a shorter date range instead.');
  if (!res.body) {
    const t = await res.text();
    if (t.length > max) throw new ImportError('too_large', 'That calendar is too large to import from a link. Export it as an .ics file for a shorter date range instead.');
    return t;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new ImportError('too_large', 'That calendar is too large to import from a link. Export it as an .ics file for a shorter date range instead.');
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder('utf-8').decode(all);
}

export interface FetchOptions {
  provider?: LinkProvider;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

/** GET the calendar text. Redirects are followed by hand so that each hop is checked against the allow-list. */
export async function fetchCalendarLink(f: Fetcher, start: URL, opts: FetchOptions = {}): Promise<string> {
  const maxRedirects = opts.maxRedirects ?? 3;
  let url = start;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 10_000);
    try {
      let res: Response;
      try {
        res = await f(url.toString(), { method: 'GET', redirect: 'manual', signal: ctl.signal, headers: { accept: 'text/calendar, text/plain;q=0.8, */*;q=0.1', 'user-agent': 'Breakpoint-calendar-import/1.0' } });
      } catch {
        throw new ImportError('link_unreachable', 'Couldn’t reach that calendar link. Check it and try again.');
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new ImportError('link_failed', 'The calendar provider sent us somewhere we couldn’t follow.');
        let next: string;
        try {
          next = new URL(loc, url).toString();
        } catch {
          throw new ImportError('link_failed', 'The calendar provider sent us somewhere we couldn’t follow.');
        }
        url = normalizeCalendarLink(next, opts.provider); // an off-list redirect is refused here, before anything is fetched
        continue;
      }
      if (!res.ok) throw humanStatus(res.status);
      try {
        return await readLimited(res, opts.maxBytes ?? MAX_LINK_BYTES);
      } catch (e) {
        if (e instanceof ImportError) throw e;
        throw new ImportError('link_unreachable', 'The calendar download was interrupted. Try again.');
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ImportError('link_failed', 'That link redirected too many times.');
}

/**
 * A calendar feed holds every event ever. Drop single events that ended before `cutoffYmd` (yyyymmdd) before parsing, so a big
 * old calendar fits the importer's limits. Recurring series are always kept; anything that can't be read is kept for the parser to judge.
 */
export function trimOldEvents(ics: string, cutoffYmd: string): { text: string; dropped: number } {
  const out: string[] = [];
  let dropped = 0;
  let block: string[] | null = null;
  const isOld = (b: string[]): boolean => {
    let start: string | null = null;
    let end: string | null = null;
    for (const l of b) {
      if (/^(RRULE|RDATE)[:;]/i.test(l)) return false;
      const s = /^DTSTART[^:]*:(\d{8})/i.exec(l);
      if (s && !start) start = s[1]!;
      const e = /^DTEND[^:]*:(\d{8})/i.exec(l);
      if (e && !end) end = e[1]!;
    }
    if (!start) return false;
    return (end && end > start ? end : start) < cutoffYmd;
  };
  for (const line of ics.split(/\r?\n/)) {
    if (block === null) {
      if (/^BEGIN:VEVENT\s*$/i.test(line)) block = [line];
      else out.push(line);
      continue;
    }
    block.push(line);
    if (/^END:VEVENT\s*$/i.test(line)) {
      if (isOld(block)) dropped++;
      else out.push(...block);
      block = null;
    }
  }
  if (block) out.push(...block); // unterminated: the parser decides
  return { text: out.join('\r\n'), dropped };
}
