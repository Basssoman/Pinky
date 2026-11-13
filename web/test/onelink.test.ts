// One personal link + "open with Face ID or your key file", unfinished deals
//.

import { expect, test } from 'vitest';

import { en } from '../src/i18n/en';
import { FileKeyError, keyFileText, keyFromFile } from '../src/keyFile';
import { keyFromSeed, newKey } from '../src/lib/keys';
import { backupCode, findKeyInFile, parsePersonalLink, unfinishedDeals, type LocalDeal } from '../src/lib/local';
import { fakeWebAuthn, ownLink, parseSealedLink, protectKey } from '../src/lib/passkey';

const ORIGIN = 'https://pinky.test';

function deal(over: Partial<LocalDeal> = {}): LocalDeal {
  return { role: 'creator', token: 'ab'.repeat(16), handle: 'cd'.repeat(32), seed: newKey().seed, saved: false, title: 'Logo', createdAt: 1, ...over };
}

const memo = () => ({ v: null as string | null, load() { return this.v; }, save(c: string | null) { this.v = c; } });

test('one link: the plain link until protected, then the Face ID link; the file holds that link + the backup key', async () => {
  const d = deal();
  expect(ownLink(ORIGIN, d)).toBe(`${ORIGIN}/k#k1.creator.${d.token}.${d.seed}`);
  const plainFile = keyFileText(en, 'Logo', 'Role: creator', d, ORIGIN);
  expect(plainFile).toContain(ownLink(ORIGIN, d));
  expect(plainFile).not.toContain(en.flow.fileBackupTitle);

  const sealed = await protectKey(fakeWebAuthn().wa, memo(), 'pinky.test', d);
  const p = { ...d, sealed };
  const link = ownLink(ORIGIN, p);
  expect(parseSealedLink(link)).not.toBeNull();
  expect(link).not.toContain(d.seed);
  const file = keyFileText(en, 'Logo', 'Role: creator', p, ORIGIN);
  expect(file).toContain(link); // the same ONE link
  expect(file.split(`${ORIGIN}/k#`).length - 1).toBe(1); // and no second link
  expect(file).toContain(backupCode(d)); // the way in without the passkey
  expect(findKeyInFile(file)).toEqual({ role: 'creator', token: d.token, seed: d.seed });
});

test('open with the key file: old and new files work, another deal\x27s file or junk is refused', async () => {
  const d = deal();
  const pk = keyFromSeed(d.seed).pk;
  const oldFile = new Blob([en.key.file('Logo', 'Role: creator', `${ORIGIN}/k#k1.creator.${d.token}.${d.seed}`).join('\n')]);
  expect(await keyFromFile(oldFile, { role: 'creator', token: d.token, pk })).toBe(d.seed);
  const other = deal({ token: '12'.repeat(16) });
  const otherFile = new Blob([backupCode(other)]);
  await expect(keyFromFile(otherFile, { role: 'creator', token: d.token, pk })).rejects.toMatchObject({ code: 'wrong' });
  await expect(keyFromFile(new Blob([backupCode(d)]), { role: 'client', token: d.token })).rejects.toBeInstanceOf(FileKeyError);
  const sameLinkOtherKey = new Blob([backupCode({ ...d, seed: newKey().seed })]);
  await expect(keyFromFile(sameLinkOtherKey, { role: 'creator', token: d.token, pk })).rejects.toMatchObject({ code: 'wrong' });
  await expect(keyFromFile(new Blob(['hello']), { role: 'creator', token: d.token })).rejects.toMatchObject({ code: 'unreadable' });
  // the plain link still parses as before
  expect(parsePersonalLink(`${ORIGIN}/k#${backupCode(d)}`)).toEqual({ role: 'creator', token: d.token, seed: d.seed });
});

test('unfinished deals: key not saved, link still working, not joined', () => {
  const now = Date.now();
  const offer = (expMs: number) => JSON.stringify({ offer_expires_at_ns: (BigInt(expMs) * 1_000_000n).toString() });
  const cache = (expMs: number, dealId: number | null = null) => ({ offer: offer(expMs), offerSignature: '', terms: { title: '', description: '', revisions: '', salt: '' }, dealId });
  const open = deal({ handle: '01'.repeat(32), cache: cache(now + 3600_000) });
  const saved = deal({ handle: '02'.repeat(32), saved: true, cache: cache(now + 3600_000) });
  const expired = deal({ handle: '03'.repeat(32), cache: cache(now - 1) });
  const joined = deal({ handle: '04'.repeat(32), cache: cache(now + 3600_000, 7) });
  expect(unfinishedDeals([open, saved, expired, joined], now).map((d) => d.handle)).toEqual([open.handle]);
});
