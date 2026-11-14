// The account page reader, run as its OWN process by
// accounts.ts with an empty environment: it holds no key or token of the
// server. Reads one job (JSON) from stdin, prints one answer (JSON) to stdout.
//
// Rules: https only; the exact host of the platform (www.youtube.com,
// www.behance.net); DNS is resolved here, every address must be public
// (no private, loopback, link-local, carrier-NAT, multicast …) and the
// connection goes to that very address (no second lookup to rebind); a
// redirect may only stay on the same host (at most 3); 8 s per request; at
// most 3 MB of page (the bio is near the top).

import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';

import { FETCH_HOST, isPublicAddress, judgePage, type CheckJob, type CheckResult, type FetchAnswer, type Platform } from './accounts.ts';

const REQUEST_MS = 8_000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 3;

class Stop extends Error {
  readonly result: CheckResult;
  constructor(result: CheckResult, why: string) {
    super(why);
    this.result = result;
  }
}

async function resolvePublic(host: string): Promise<{ address: string; family: number }> {
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Stop('unreadable', 'dns failed');
  }
  if (!addrs.length) throw new Stop('unreadable', 'no address');
  // Every address must be public: one private answer is enough to refuse.
  if (addrs.some((a) => !isPublicAddress(a.address))) throw new Stop('refused', 'private address');
  return addrs[0];
}

function get(url: URL, addr: { address: string; family: number }): Promise<{ status: number; location: string | null; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        servername: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PinkyAccountCheck/1.0)',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en',
          'Accept-Encoding': 'gzip, deflate, br',
        },
        // Connect to the address checked above, never a fresh lookup (DNS rebinding).
        lookup: (_h, opts, cb) => {
          if ((opts as { all?: boolean }).all) (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [addr]);
          else cb(null, addr.address, addr.family);
        },
        timeout: REQUEST_MS,
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === 'string' ? res.headers.location : null;
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ status, location, body: '' });
          return;
        }
        const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
        let stream: Readable = res;
        if (enc === 'gzip') stream = res.pipe(createGunzip());
        else if (enc === 'deflate') stream = res.pipe(createInflate());
        else if (enc === 'br') stream = res.pipe(createBrotliDecompress());
        const chunks: Buffer[] = [];
        let size = 0;
        let ended = false;
        const end = () => {
          if (ended) return;
          ended = true;
          resolve({ status, location, body: Buffer.concat(chunks).toString('utf8') });
        };
        stream.on('data', (c: Buffer) => {
          if (ended) return;
          const room = MAX_BYTES - size;
          chunks.push(c.length > room ? c.subarray(0, room) : c);
          size += Math.min(c.length, room);
          // Size cap: keep what came (the bio is near the top) and stop reading.
          if (size >= MAX_BYTES) {
            end();
            req.destroy();
          }
        });
        stream.on('end', end);
        stream.on('error', (e) => (ended ? undefined : reject(e)));
      },
    );
    req.on('timeout', () => req.destroy(new Stop('unreadable', 'time limit')));
    req.on('error', reject);
    req.end();
  });
}

export async function readAccount(job: CheckJob): Promise<FetchAnswer> {
  const host = FETCH_HOST[job.platform as Platform];
  if (!host) return { result: 'manual', why: 'platform is not read automatically' };
  let url: URL;
  try {
    url = new URL(job.url);
  } catch {
    return { result: 'refused', why: 'bad url' };
  }
  if (url.protocol !== 'https:' || url.hostname !== host || url.port || url.username || url.password) return { result: 'refused', why: 'host not allowed' };
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const addr = await resolvePublic(url.hostname);
      const res = await get(url, addr);
      if (res.status >= 300 && res.status < 400) {
        if (!res.location) return { result: 'unreadable', why: 'redirect without location' };
        const next = new URL(res.location, url);
        // No redirect off the host (consent pages, sign-in, other sites): the team checks by hand.
        if (next.protocol !== 'https:' || next.hostname !== host || next.port) return { result: 'unreadable', why: 'redirect off host' };
        url = next;
        continue;
      }
      if (res.status !== 200) return { result: 'unreadable', why: `status ${res.status}` };
      return { result: judgePage(res.body, job, job.codes), why: 'read' };
    }
    return { result: 'unreadable', why: 'too many redirects' };
  } catch (e) {
    if (e instanceof Stop) return { result: e.result, why: e.message };
    return { result: 'unreadable', why: 'network error' };
  }
}

// Run as the child process (not when a test imports it).
if (process.argv[1] && /account-fetch\.(js|ts)$/.test(process.argv[1])) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d: string) => {
    input += d;
    if (input.length > 8192) process.exit(2);
  });
  process.stdin.on('end', () => {
    let job: CheckJob;
    try {
      job = JSON.parse(input) as CheckJob;
      if (!job || typeof job.url !== 'string' || typeof job.handle !== 'string' || !Array.isArray(job.codes)) throw new Error('bad job');
    } catch {
      process.stdout.write(JSON.stringify({ result: 'refused', why: 'bad job' }));
      return;
    }
    void readAccount(job).then((a) => process.stdout.write(JSON.stringify(a)));
  });
}
