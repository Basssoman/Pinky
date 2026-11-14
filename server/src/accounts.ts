// Verified creator accounts: the creator adds a
// YouTube / X / Behance account to the profile, gets a random code for that
// (profile, account), puts it in the account's bio, and the site reads the
// bio. The mark reads "account confirmed: @handle" (control of the account,
// not authorship of every work). The code STAYS in the bio: the site re-reads
// it now and then, and the mark goes when the code is gone.
//
// Fetch rules:
// - no API keys exist for YouTube / X here, so the site reads the public page;
// - only an exact host per platform (www.youtube.com, www.behance.net), https,
//   no redirect to another host, no private / link-local / loopback address
//   after DNS resolution (the connection goes to the very address checked),
//   a time limit and a size cap;
// - the fetch runs in a separate Node process (account-fetch.ts) started with
//   an empty environment: no keys or tokens of the server are in it.
// X bios cannot be read without signing in: X accounts (and any page the site
// could not read) wait for a person of the team, who opens the account and
// confirms by hand with ops/accounts.sh. The log keeps how each mark was made.

import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';

export const PLATFORMS = ['youtube', 'x', 'behance'] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Platforms whose public page the site can read by itself. */
export const AUTO_PLATFORMS: readonly Platform[] = ['youtube', 'behance'];

/** The one host the site fetches for each readable platform. */
export const FETCH_HOST: Record<Platform, string | null> = {
  youtube: 'www.youtube.com',
  behance: 'www.behance.net',
  x: null,
};

const ACCEPTED_HOSTS: Record<Platform, readonly string[]> = {
  youtube: ['youtube.com', 'www.youtube.com', 'm.youtube.com'],
  x: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com', 'mobile.x.com'],
  behance: ['behance.net', 'www.behance.net'],
};

export interface AccountRef {
  platform: Platform;
  /** The canonical https URL (what is stored and shown). */
  url: string;
  /** What the mark shows: "@name" (or the channel id for an old-style YouTube link). */
  handle: string;
}

const X_RESERVED = new Set(['home', 'explore', 'search', 'settings', 'i', 'intent', 'share', 'messages', 'notifications', 'login', 'signup', 'tos', 'privacy', 'hashtag']);
const BEHANCE_RESERVED = new Set(['search', 'galleries', 'joblist', 'gallery', 'live', 'assets', 'about', 'blog', 'onboarding', 'hire', 'misc', 'moodboard', 'jobs']);

/**
 * Reads a pasted account link: the profile page of a YouTube channel, an X
 * account or a Behance profile. Returns null for anything else (a video, a
 * post, another site). Query and fragment are dropped.
 */
export function parseAccountUrl(raw: string): AccountRef | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  const platform = PLATFORMS.find((p) => ACCEPTED_HOSTS[p].includes(host));
  if (!platform) return null;
  if (platform === 'youtube') {
    const first = parts[0] ?? '';
    const handle = /^@([A-Za-z0-9._-]{3,30})$/.exec(decodeSafe(first));
    if (handle && (parts.length === 1 || (parts.length === 2 && ['about', 'videos', 'featured'].includes(parts[1])))) {
      const h = handle[1].toLowerCase();
      return { platform, url: `https://www.youtube.com/@${h}`, handle: `@${h}` };
    }
    if (first === 'channel' && parts[1] && /^UC[A-Za-z0-9_-]{22}$/.test(parts[1]) && parts.length <= 3) {
      return { platform, url: `https://www.youtube.com/channel/${parts[1]}`, handle: parts[1] };
    }
    return null;
  }
  if (platform === 'x') {
    if (parts.length !== 1) return null;
    const m = /^@?([A-Za-z0-9_]{1,15})$/.exec(parts[0]);
    if (!m || X_RESERVED.has(m[1].toLowerCase())) return null;
    const h = m[1].toLowerCase();
    return { platform, url: `https://x.com/${h}`, handle: `@${h}` };
  }
  // behance
  if (parts.length < 1 || parts.length > 2) return null;
  if (parts.length === 2 && !['moodboards', 'appreciated', 'projects', 'info'].includes(parts[1])) return null;
  const m = /^([A-Za-z0-9_-]{3,40})$/.exec(parts[0]);
  if (!m || BEHANCE_RESERVED.has(m[1].toLowerCase())) return null;
  const h = m[1].toLowerCase();
  return { platform, url: `https://www.behance.net/${h}`, handle: `@${h}` };
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Crockford base32 without look-alikes, lower case. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * The verification code: random per (profile, account), 10 characters (50
 * bits), shaped unlike the key-reset code ("СБРОС-КЛЮЧА-…").
 */
export function verifyCode(): string {
  let s = '';
  for (let i = 0; i < 10; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `pinky-${s}`;
}
export const VERIFY_CODE_RE = /^pinky-[0-9a-hjkmnp-tv-z]{10}$/;

// ---------------------------------------------------------------- addresses

function v4Parts(ip: string): number[] | null {
  const p = ip.split('.').map(Number);
  return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? p : null;
}

function publicV4(ip: string): boolean {
  const p = v4Parts(ip);
  if (!p) return false;
  const [a, b, c] = p;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this net, private, loopback, multicast + reserved
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  return true;
}

/** Expands an IPv6 address to 8 groups (null if it is not one). */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (s.includes('.')) {
    // An IPv4 tail ("::ffff:10.0.0.1"): write it as two hex groups.
    const cut = s.lastIndexOf(':');
    const v4 = v4Parts(s.slice(cut + 1));
    if (!v4) return null;
    s = `${s.slice(0, cut + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string) => (h === '' ? [] : h.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (head.some(Number.isNaN) || rest.some(Number.isNaN)) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - rest.length;
  return fill < 1 ? null : [...head, ...Array<number>(fill).fill(0), ...rest];
}

function publicV6(ip: string): boolean {
  const g = v6Groups(ip);
  if (!g) return false;
  if (g.every((x) => x === 0)) return false; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1
  const v4of = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return publicV4(v4of(g[6], g[7])); // IPv4-mapped
  if (g.slice(0, 6).every((x) => x === 0)) return false; // IPv4-compatible (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b) return publicV4(v4of(g[6], g[7])); // NAT64
  if ((g[0] & 0xfe00) === 0xfc00) return false; // unique local
  if ((g[0] & 0xffc0) === 0xfe80) return false; // link-local
  if ((g[0] & 0xffc0) === 0xfec0) return false; // site-local (old)
  if ((g[0] & 0xff00) === 0xff00) return false; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo
  if (g[0] === 0x2002) return false; // 6to4 (may hide an IPv4)
  if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return false; // discard-only
  return true;
}

/** true only for a public unicast address (private / link-local / loopback are refused). */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return publicV4(ip);
  if (v === 6) return publicV6(ip);
  return false;
}

// ---------------------------------------------------------------- page reading

/** Decodes the HTML entities a description meta tag or JSON text may use. */
function unescapeText(s: string): string {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeChar(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
const safeChar = (n: number) => (n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '');

export type PageVerdict = 'found' | 'absent' | 'unreadable';

/**
 * Looks for any of the codes on the account's own page. The page counts as
 * read only when it names the account (its handle or channel id): a sign-in
 * wall or a "are you a robot" page must never take a mark away.
 * Only the account owner writes on their profile page (bio, own titles), and a
 * code is random and known only to the profile owner.
 */
export function judgePage(html: string, ref: Pick<AccountRef, 'url' | 'handle'>, codes: readonly string[]): PageVerdict {
  const text = unescapeText(html);
  const lower = text.toLowerCase();
  const name = ref.handle.replace(/^@/, '').toLowerCase();
  const path = new URL(ref.url).pathname.toLowerCase();
  if (!lower.includes(name) && !lower.includes(path)) return 'unreadable';
  return codes.some((c) => c && text.includes(c)) ? 'found' : 'absent';
}

// ---------------------------------------------------------------- the checker (parent side)

export type CheckResult =
  /** The code is in the bio. */
  | 'found'
  /** The page was read and names the account, but the code is not there. */
  | 'absent'
  /** Could not read it (blocked, sign-in page, time limit, off-host redirect): the team checks by hand. */
  | 'unreadable'
  /** The fetch rules refused it (address, host). */
  | 'refused'
  /** This platform is never read automatically (X): the team checks by hand. */
  | 'manual';

export interface CheckJob {
  platform: Platform;
  url: string;
  handle: string;
  /** The code(s) to look for: the verification code, or both lines of a key-reset code. */
  codes: string[];
}

export interface AccountChecker {
  check(job: CheckJob): Promise<CheckResult>;
}

/** What the fetch process prints (one JSON line). */
export interface FetchAnswer {
  result: CheckResult;
  /** A short reason for the log; never page text. */
  why?: string;
}

const CHILD_TIMEOUT_MS = 25_000;
const MAX_PARALLEL = 2;

/**
 * Runs each check in a separate Node process (account-fetch.ts) with an empty
 * environment, so no server key or token can leak into it. At most 2 at once.
 */
export function processChecker(script = defaultScript()): AccountChecker {
  let running = 0;
  return {
    async check(job) {
      if (!AUTO_PLATFORMS.includes(job.platform)) return 'manual';
      if (running >= MAX_PARALLEL) return 'unreadable';
      running++;
      try {
        return (await runChild(script, job)).result;
      } finally {
        running--;
      }
    },
  };
}

function defaultScript(): string {
  const here = import.meta.url;
  return fileURLToPath(new URL(here.endsWith('.ts') ? './account-fetch.ts' : './account-fetch.js', here));
}

/** Only what Node needs to start and resolve names; no secrets. */
function bareEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'windir']) {
    const v = process.env[k];
    if (v) env[k] = v;
  }
  return env;
}

export function runChild(script: string, job: CheckJob): Promise<FetchAnswer> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script], { env: bareEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    let done = false;
    const finish = (a: FetchAnswer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(a);
    };
    const timer = setTimeout(() => finish({ result: 'unreadable', why: 'time limit' }), CHILD_TIMEOUT_MS);
    timer.unref();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      out += d;
      if (out.length > 4096) finish({ result: 'unreadable', why: 'answer too long' });
    });
    child.on('error', () => finish({ result: 'unreadable', why: 'could not start' }));
    child.on('close', () => {
      try {
        const a = JSON.parse(out.trim()) as FetchAnswer;
        const ok: CheckResult[] = ['found', 'absent', 'unreadable', 'refused', 'manual'];
        finish(ok.includes(a.result) ? { result: a.result, why: typeof a.why === 'string' ? a.why.slice(0, 120) : undefined } : { result: 'unreadable', why: 'bad answer' });
      } catch {
        finish({ result: 'unreadable', why: 'bad answer' });
      }
    });
    child.stdin.end(JSON.stringify(job));
  });
}
