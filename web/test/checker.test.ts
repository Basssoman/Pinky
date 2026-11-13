// Fixes from an independent check (2026-11-12): the link lifetimes the contract
// allows, no raw server English in any language, and the way back
// after "Hide" on the unfinished-deal reminder.
import { describe, expect, test } from 'vitest';
import { linkChoices } from '../src/lib/limits';
import { LANGS, setLang } from '../src/i18n';
import { DAY, HOUR } from '../src/i18n/time';
import { ApiError } from '../src/lib/api';
import { ActionError } from '../src/lib/flows';
import { hiddenUnfinished, hideUnfinished, unfinishedDeals, unhideUnfinished, type LocalDeal } from '../src/lib/local';
import { explain } from '../src/ui';

describe('link lifetimes follow the contract', () => {
  test('unknown limit: every choice, 3 days by default', () => {
    expect(linkChoices(undefined)).toEqual({ options: ['1', '2', '3', '7'], preferred: '3' });
    expect(linkChoices({ maxLinkMs: null, payWithinMs: null }).options).toEqual(['1', '2', '3', '7']);
  });
  test('a test contract allowing 1 hour: one choice, "as long as allowed"', () => {
    expect(linkChoices({ maxLinkMs: HOUR, payWithinMs: 3 * HOUR })).toEqual({ options: ['max'], preferred: 'max' });
  });
  test('a contract allowing 2 days: 1 and 2 days, the longest by default', () => {
    expect(linkChoices({ maxLinkMs: 2 * DAY, payWithinMs: 7 * DAY })).toEqual({ options: ['1', '2'], preferred: '2' });
  });
  test('the final contract (7 days or more): every choice, 3 days by default', () => {
    expect(linkChoices({ maxLinkMs: 7 * DAY, payWithinMs: 7 * DAY })).toEqual({ options: ['1', '2', '3', '7'], preferred: '3' });
  });
});

describe('server refusals are shown translated, never in raw English', () => {
  const raw = 'offer.fee_bps must be 300 (a 3% fee)';
  const cases: unknown[] = [
    new ApiError(400, 'bad_fee', raw),
    new ApiError(400, 'bad_request', raw),
    new ApiError(422, 'something_new', raw),
    new ApiError(409, 'wrong_state', raw),
    new ApiError(403, 'wrong_key', raw),
    new ActionError(raw, 'contract_rejected', null as never, false),
    new ActionError(raw, 'failed', null as never, false),
  ];
  for (const lang of LANGS) {
    test(lang.code, () => {
      setLang(lang.code);
      try {
        for (const e of cases) {
          const shown = explain(e);
          expect(shown).not.toContain(raw);
          expect(shown.trim()).not.toBe('');
        }
      } finally {
        setLang('en');
      }
    });
  }
});

test('hidden unfinished deals can be shown again', () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  } as unknown as Storage;
  const now = Date.now();
  const d: LocalDeal = {
    role: 'creator',
    token: 'ab'.repeat(16),
    handle: 'cd'.repeat(32),
    seed: '00'.repeat(32),
    saved: false,
    title: 'Logo',
    createdAt: 1,
    cache: {
      offer: JSON.stringify({ offer_expires_at_ns: (BigInt(now + HOUR) * 1_000_000n).toString() }),
      offerSignature: '',
      terms: { title: '', description: '', revisions: '', salt: '' },
      dealId: null,
    },
  };
  storage.setItem(`kept.deal.${d.handle}`, JSON.stringify(d));
  const read = () => [JSON.parse(storage.getItem(`kept.deal.${d.handle}`)!) as LocalDeal];
  hideUnfinished(d.handle, storage);
  expect(unfinishedDeals(read(), now)).toEqual([]);
  expect(hiddenUnfinished(read(), now).map((x) => x.handle)).toEqual([d.handle]);
  unhideUnfinished(d.handle, storage);
  expect(unfinishedDeals(read(), now).map((x) => x.handle)).toEqual([d.handle]);
  expect(hiddenUnfinished(read(), now)).toEqual([]);
  expect(read()[0].seed).toBe(d.seed); // the key is never touched
});
