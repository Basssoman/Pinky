// DEVELOPMENT ONLY: a stand-in for the marketplace routes while the real ones
// are being built (`npm run dev:mock`, Vite mode "mock"). It lives in this
// browser's localStorage. It is loaded only behind `import.meta.env.DEV`, so a
// production build never contains it. The creators below are made-up samples
// for trying the screens; they are never shown on the real site.

import { ApiError } from '../lib/api';
import { sha256Hex } from '../lib/keys';
import type { Card, InboxItem, Profile, ProfileFields, RequestStatus, ReviewLink } from '../lib/market';
import { profileIdOf } from '../lib/market';
import type { MarketApi } from '../lib/marketApi';

interface Stored {
  profiles: Record<string, Profile & { profile_pk: string; hidden?: boolean }>;
  requests: Record<string, InboxItem & { profile_id: string; deal_link_box?: unknown }>;
}

const KEY = 'kept.dev.marketMock';

const SAMPLES: [string, ProfileFields, number, number | null, number][] = [
  [
    'a1b2c3d4e5f60718293a4b5c',
    {
      nickname: 'sample_motion',
      bio: 'Sample profile for development. Logo reveals, short explainers, loops for launch posts.',
      categories: ['motion', 'video'],
      portfolio: ['https://example.com/reel', 'https://example.com/loops'],
      contacts: [{ kind: 'telegram', value: '@sample_motion' }],
      services: [
        { id: '0a1b2c3d', title: 'Logo reveal, 5–8 s', description: 'One animated logo, two rounds of changes, MP4 + transparent MOV.', price_from_usdc: 120, delivery_days: 5 },
        { id: '1b2c3d4e', title: 'Explainer, 30–60 s', description: 'Script help, style frames, animation, music from a free library.', price_from_usdc: 600, delivery_days: 21 },
      ],
    },
    7,
    4.8,
    5,
  ],
  [
    'b2c3d4e5f60718293a4b5c6d',
    {
      nickname: 'sample_editor',
      bio: 'Sample profile for development. I cut long streams into short clips.',
      categories: ['editing'],
      portfolio: ['https://example.com/clips'],
      contacts: [],
      services: [{ id: '2c3d4e5f', title: '10 short clips from one stream', description: 'Vertical, with captions.', price_from_usdc: 80, delivery_days: 4 }],
    },
    2,
    null,
    0,
  ],
  [
    'c3d4e5f60718293a4b5c6d7e',
    {
      nickname: 'sample_pixels',
      bio: 'Sample profile for development. Pixel art, NFT drops, banners.',
      categories: ['design', 'other'],
      portfolio: [],
      contacts: [{ kind: 'x', value: '@sample_pixels' }, { kind: 'email', value: 'pixels@example.com' }],
      services: [],
    },
    0,
    null,
    0,
  ],
];

function seed(): Stored {
  const s: Stored = { profiles: {}, requests: {} };
  for (const [id, f, done, rating, n] of SAMPLES) {
    s.profiles[id] = {
      ...f,
      profile_id: id,
      profile_pk: '',
      finished_deals: done,
      rating_avg: rating,
      reviews_count: n,
      reviews: n
        ? [
            { review_id: `${id.slice(0, 12)}0001`, rating: 5, text: 'Fast and clear. Sample review for development.', month: '2026-10', outcome: 'paid' },
            {
              review_id: `${id.slice(0, 12)}0002`,
              rating: 4,
              text: 'Good work, one round more than planned.',
              month: '2026-09',
              outcome: 'dispute',
              reply: { text: 'Thanks! We settled the extra round fairly.', month: '2026-09' },
            },
            { review_id: `${id.slice(0, 12)}0003`, rating: 1, text: 'Never delivered.', month: '2026-08', outcome: 'refunded', refunded: true },
          ]
        : [],
      updated_month: '2026-11',
      since_month: '2026-08',
    };
  }
  return s;
}

function load(): Stored {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Stored;
  } catch {
    /* fresh */
  }
  return seed();
}
function save(s: Stored) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

/** Answer time; `localStorage['kept.dev.mockDelay'] = '1500'` tries a slow server. */
const wait = () => new Promise((r) => setTimeout(r, Number(localStorage.getItem('kept.dev.mockDelay')) || 250));
const notFound = () => new ApiError(404, 'not_found', 'not found');

function card(p: Profile): Card {
  const prices = p.services.map((s) => s.price_from_usdc);
  return {
    profile_id: p.profile_id,
    nickname: p.nickname,
    categories: p.categories,
    price_from_usdc: prices.length ? Math.min(...prices) : null,
    finished_deals: p.finished_deals,
    rating_avg: p.rating_avg,
    reviews_count: p.reviews_count,
    since_month: p.since_month,
    avatar: p.avatar ?? null,
  };
}

/** Pictures live apart (they are big): profile id → { version, data URL }. */
const AVATARS = 'kept.dev.marketMock.avatars';
function avatars(): Record<string, { v: string; url: string }> {
  try {
    return JSON.parse(localStorage.getItem(AVATARS) ?? '{}') as Record<string, { v: string; url: string }>;
  } catch {
    return {};
  }
}

export function mockMarketApi(): MarketApi {
  return {
    async profiles(q) {
      await wait();
      const s = load();
      const items = Object.values(s.profiles)
        .filter((p) => !p.hidden)
        .filter((p) => !q.category || p.categories.includes(q.category as never))
        .filter((p) => !q.q || `${p.nickname} ${p.bio}`.toLowerCase().includes(q.q.toLowerCase()))
        .map(card);
      return { items, next_cursor: null };
    },
    async profile(id) {
      await wait();
      const p = load().profiles[id];
      if (!p || p.hidden) throw notFound();
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { profile_pk, hidden, ...pub } = p;
      return pub;
    },
    async putProfile(id, body) {
      await wait();
      if (profileIdOf(body.profile_pk) !== id) throw new ApiError(400, 'bad_request', 'profile id does not match the key');
      const s = load();
      const old = s.profiles[id];
      s.profiles[id] = {
        ...body.profile,
        services: body.profile.services.map((sv, i) => ({ ...sv, id: sv.id ?? sha256Hex(`${id}|${i}|${Date.now()}`).slice(0, 8) })),
        profile_id: id,
        profile_pk: body.profile_pk,
        finished_deals: old?.finished_deals ?? 0,
        rating_avg: old?.rating_avg ?? null,
        reviews_count: old?.reviews_count ?? 0,
        reviews: old?.reviews ?? [],
        updated_month: new Date().toISOString().slice(0, 7),
        avatar: old?.avatar ?? null,
      };
      save(s);
      return { ok: true };
    },
    async hideProfile(id) {
      await wait();
      const s = load();
      if (s.profiles[id]) s.profiles[id].hidden = true;
      save(s);
      return { ok: true };
    },
    async createRequest(body) {
      await wait();
      const s = load();
      if (!s.profiles[body.profile_id]) throw notFound();
      const svc = s.profiles[body.profile_id].services.find((x) => x.id === body.service_id);
      s.requests[body.handle] = {
        handle: body.handle,
        profile_id: body.profile_id,
        status: 'open',
        service: svc ? { id: svc.id!, title: svc.title } : null,
        brief: body.brief,
        wanted_deadline: body.wanted_deadline ?? null,
        client_contact: body.client_contact,
        created_at: new Date().toISOString(),
        client_box_pk: body.client_box_pk,
      };
      save(s);
      return { handle: body.handle, profile_pk: s.profiles[body.profile_id].profile_pk };
    },
    async request(handle, token) {
      await wait();
      if (sha256Hex(token) !== handle) throw notFound();
      const s = load();
      const r = s.requests[handle];
      if (!r) throw notFound();
      return {
        status: r.status,
        profile: {
          profile_id: r.profile_id,
          nickname: s.profiles[r.profile_id]?.nickname ?? '?',
          avatar: s.profiles[r.profile_id]?.avatar ?? null,
          profile_pk: s.profiles[r.profile_id]?.profile_pk ?? null,
        },
        service: r.service ?? null,
        brief: r.brief,
        wanted_deadline: r.wanted_deadline,
        deal_link_box: (r.deal_link_box as never) ?? null,
      };
    },
    async cancelRequest(handle) {
      await wait();
      const s = load();
      const r = s.requests[handle];
      if (!r) throw notFound();
      if (r.status !== 'open') throw new ApiError(409, 'not_open', 'This request can no longer be cancelled.');
      r.status = 'cancelled';
      save(s);
      return { ok: true };
    },
    async inbox(id) {
      await wait();
      const s = load();
      const items = Object.values(s.requests)
        .filter((r) => r.profile_id === id)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        .map(({ profile_id, deal_link_box, ...r }) => r);
      return { items };
    },
    async decline(handle, body) {
      await wait();
      const s = load();
      const r = s.requests[handle];
      if (!r) throw notFound();
      r.status = 'declined' as RequestStatus;
      r.decline_reason = body.reason ?? null;
      save(s);
      return { ok: true };
    },
    async discuss(handle) {
      await wait();
      const s = load();
      const r = s.requests[handle];
      if (!r) throw notFound();
      r.status = 'discussing' as RequestStatus;
      save(s);
      return { ok: true };
    },
    async profileByKey(pk) {
      await wait();
      const p = Object.values(load().profiles).find((x) => x.profile_pk === pk);
      if (!p) throw notFound();
      return { profile_id: p.profile_id, pending: null };
    },
    async cancelKeyReset() {
      await wait();
      return { ok: true };
    },
    async reviewLink(): Promise<ReviewLink> {
      await wait();
      return { linked: false };
    },
    async postReview() {
      await wait();
      return { ok: true };
    },
    async briefStatus() {
      return { enabled: true };
    },
    async brief(body) {
      await new Promise((r) => setTimeout(r, 1200));
      // Dev only: a canned answer shaped like the real one (the real server asks NEAR AI).
      return {
        checklist: [
          `- ${body.request.split('\n')[0].slice(0, 80)}`,
          '- Delivered as MP4, 1920×1080, 30 fps (suggested), plus a vertical 1080×1920 version',
          '- Length: 6–8 seconds (suggested)',
          '- Two rounds of changes included',
          '- The client sends the logo as SVG or PNG and the brand colors',
          '- Not included: voice-over and paid music',
        ].join('\n'),
        model: 'mock',
        verified: localStorage.getItem('kept.dev.briefUnverified') !== '1',
        gpu_checked: localStorage.getItem('kept.dev.briefNoGpu') !== '1',
      };
    },
    async replyReview(id, reviewId, body) {
      await wait();
      const s = load();
      const r = s.profiles[id]?.reviews.find((x) => x.review_id === reviewId);
      if (!r) throw notFound();
      if (r.reply) throw new ApiError(409, 'already_replied', 'already answered');
      r.reply = { text: body.text, month: new Date().toISOString().slice(0, 7) };
      save(s);
      return { ok: true, review: r };
    },
    // Dev only: no re-encoding here (the real server makes a 256 x 256 WebP); same refusals as the server.
    async putAvatar(id, body) {
      await wait();
      const s = load();
      if (!s.profiles[id]) throw new ApiError(404, 'profile_not_found', 'save the profile first, then add a picture');
      if (body.image.length > Math.ceil((2 * 1024 * 1024) / 3) * 4) throw new ApiError(413, 'image_too_big', 'the picture must be at most 2 MB');
      const type = body.image.startsWith('UklGR') ? 'image/webp' : body.image.startsWith('iVBOR') ? 'image/png' : body.image.startsWith('/9j/') ? 'image/jpeg' : '';
      if (!type) throw new ApiError(415, 'bad_image_type', 'the picture must be JPEG, PNG or WebP');
      const v = sha256Hex(body.image).slice(0, 16);
      localStorage.setItem(AVATARS, JSON.stringify({ ...avatars(), [id]: { v, url: `data:${type};base64,${body.image}` } }));
      s.profiles[id].avatar = v;
      save(s);
      return { ok: true, avatar: v };
    },
    async removeAvatar(id) {
      await wait();
      const s = load();
      if (!s.profiles[id]) throw notFound();
      const all = avatars();
      delete all[id];
      localStorage.setItem(AVATARS, JSON.stringify(all));
      s.profiles[id].avatar = null;
      save(s);
      return { ok: true };
    },
    avatarUrl(id, v) {
      const a = avatars()[id];
      return a && a.v === v ? a.url : '';
    },
    // Dev only: nothing is stored or sent; same refusals as the server.
    async report(body) {
      await wait();
      if ([...(body.text ?? '')].length > 500) throw new ApiError(400, 'bad_request', 'text is too long (max 500 characters)');
      // type "rate" in the box to see the "too many" answer
      if (body.text?.trim() === 'rate') throw new ApiError(429, 'rate_limited', 'too many reports for now; try again later');
      return { ok: true };
    },
  };
}

/** Dev only: what the deal-from-request call would tell the server (the real server does this in POST /api/deals). */
export function mockLinkDeal(handle: string, box: unknown) {
  const s = load();
  const r = s.requests[handle];
  if (!r) return;
  r.status = 'deal_ready';
  r.deal_link_box = box;
  save(s);
}
