/**
 * Polite HTTP for scrapers.
 *
 *   • Identifying User-Agent
 *   • 1 request/second/host (simple in-memory throttle)
 *   • robots.txt fetched once per host per process and cached
 *   • Content hashing for dedup
 *   • Abort-signal aware
 */

import { createHash } from 'crypto';

const UA =
  process.env.SCRAPER_USER_AGENT ||
  'RB-BOX/1.0 (+https://rb-box.is/bot; icelandic AEC document library)';

const MIN_INTERVAL_MS = 1000;

// host → timestamp of last request
const lastRequestByHost = new Map<string, number>();

// host → set of Disallow prefixes (very simple robots.txt parser)
const robotsCache = new Map<string, string[] | 'error'>();

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

async function throttle(host: string, signal?: AbortSignal): Promise<void> {
  const last = lastRequestByHost.get(host) ?? 0;
  const wait = Math.max(0, last + MIN_INTERVAL_MS - Date.now());
  if (wait > 0) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(resolve, wait);
      signal?.addEventListener('abort', () => {
        clearTimeout(timeout);
        reject(new Error('aborted'));
      }, { once: true });
    });
  }
  lastRequestByHost.set(host, Date.now());
}

/**
 * Fetch /robots.txt for the host once, cache it, and return an array of
 * Disallow prefixes that apply to any user-agent (`*`).
 *
 * This is a deliberately simple parser — we handle User-agent: * groups and
 * Disallow lines. We don't handle Allow overrides or wildcards. If a host
 * uses a more restrictive robots policy for a specific UA, we err on the
 * side of caution and follow the * rules.
 */
async function loadRobots(host: string, signal?: AbortSignal): Promise<string[]> {
  const cached = robotsCache.get(host);
  if (cached === 'error') return [];
  if (cached) return cached;

  try {
    const res = await fetch(`https://${host}/robots.txt`, {
      headers: { 'User-Agent': UA, Accept: 'text/plain' },
      signal,
    });
    if (!res.ok) {
      robotsCache.set(host, []);
      return [];
    }
    const text = await res.text();
    const disallows: string[] = [];
    let inStarGroup = false;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.split('#')[0].trim();
      if (!line) continue;
      const [key, ...rest] = line.split(':');
      const value = rest.join(':').trim();
      const k = key.toLowerCase();
      if (k === 'user-agent') {
        inStarGroup = value === '*';
      } else if (k === 'disallow' && inStarGroup && value) {
        disallows.push(value);
      }
    }
    robotsCache.set(host, disallows);
    return disallows;
  } catch {
    robotsCache.set(host, 'error');
    return [];
  }
}

/** Is `url` allowed by the host's robots.txt? */
export async function isAllowed(url: string, signal?: AbortSignal): Promise<boolean> {
  const host = hostOf(url);
  if (!host) return false;
  const disallows = await loadRobots(host, signal);
  const path = new URL(url).pathname + new URL(url).search;
  return !disallows.some((d) => path.startsWith(d));
}

/**
 * Fetch a URL politely. Throttles per host, respects robots.txt,
 * sets a proper UA, and honors the abort signal.
 *
 * Returns the raw Response — the caller decides whether to read text/bytes.
 */
export async function politeFetch(
  url: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<Response> {
  const host = hostOf(url);
  if (!host) throw new Error(`Invalid URL: ${url}`);

  const allowed = await isAllowed(url, signal);
  if (!allowed) {
    throw new Error(`Blocked by robots.txt: ${url}`);
  }

  await throttle(host, signal);

  const headers = new Headers(init.headers);
  if (!headers.has('User-Agent')) headers.set('User-Agent', UA);
  if (!headers.has('Accept')) headers.set('Accept', 'text/html,application/pdf,application/xhtml+xml;q=0.9,*/*;q=0.5');
  if (!headers.has('Accept-Language')) headers.set('Accept-Language', 'is,en;q=0.8');

  return fetch(url, { ...init, headers, signal: signal ?? init.signal ?? null });
}

/** SHA-256 hex digest of the given bytes. Used for content-hash dedup. */
export function contentHash(bytes: ArrayBuffer | Uint8Array | Buffer): string {
  const buf = Buffer.isBuffer(bytes)
    ? bytes
    : bytes instanceof Uint8Array
      ? Buffer.from(bytes)
      : Buffer.from(new Uint8Array(bytes));
  return createHash('sha256').update(buf).digest('hex');
}

/** Guess if a URL points at a downloadable document rather than an HTML page. */
export function looksLikeDocument(url: string): boolean {
  return /\.(pdf|docx?|xlsx?|pptx?)(\?|$)/i.test(url);
}

/** Normalize a URL for dedup: strip fragment, sort query params, lowercase host. */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    u.host = u.host.toLowerCase();
    // Sort search params for stable dedup keys
    const params = Array.from(u.searchParams.entries()).sort(([a], [b]) => a.localeCompare(b));
    u.search = '';
    for (const [k, v] of params) u.searchParams.append(k, v);
    return u.toString();
  } catch {
    return url;
  }
}

/** Resolve a possibly-relative href against a base URL. Returns null if invalid. */
export function resolveUrl(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}
