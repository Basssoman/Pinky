// Passkey ("Face ID") protection of the deal key with a
// pretend WebAuthn + PRF: wrap/unwrap, the k2 link, what is stored, fallbacks.

import { beforeEach, describe, expect, test } from 'vitest';

import { keyFromSeed, newKey } from '../src/lib/keys';
import { forgetUnlocked, isLocked, memoryStore, parsePersonalLink, personalLink, rememberUnlocked, type LocalDeal } from '../src/lib/local';
import {
  b64u,
  fakeWebAuthn,
  parseSealedLink,
  PasskeyError,
  protectKey,
  seal,
  sealedLink,
  unb64u,
  unlockKey,
  unseal,
  type PasskeyMemo,
} from '../src/lib/passkey';

const RP = 'pinky.test';
const ORIGIN = 'https://pinky.test';

function memo(): PasskeyMemo & { value: string | null } {
  const m = { value: null as string | null, load: () => m.value, save: (c: string | null) => void (m.value = c) };
  return m;
}

function deal(role: 'creator' | 'client' = 'client'): LocalDeal {
  const token = 'ab'.repeat(16);
  return { role, token, handle: 'cd'.repeat(32), seed: newKey().seed, saved: true, title: 'Logo', createdAt: 1 };
}

beforeEach(() => forgetUnlocked());

describe('seal / unseal', () => {
  test('round trip; another PRF, another deal or a changed blob never opens it', async () => {
    const d = deal();
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const s = await seal(d.seed, prf, d.role, d.token, new Uint8Array([1, 2, 3, 4]), new Uint8Array(32));
    expect(s.pk).toBe(keyFromSeed(d.seed).pk);
    expect(JSON.stringify(s)).not.toContain(d.seed);
    expect(await unseal(s, prf, d.role, d.token)).toBe(d.seed);
    await expect(unseal(s, crypto.getRandomValues(new Uint8Array(32)), d.role, d.token)).rejects.toMatchObject({ code: 'wrong' });
    await expect(unseal(s, prf, 'creator', d.token)).rejects.toBeInstanceOf(PasskeyError);
    await expect(unseal(s, prf, d.role, 'ef'.repeat(16))).rejects.toBeInstanceOf(PasskeyError);
    const ct = unb64u(s.ct);
    ct[0] ^= 1;
    await expect(unseal({ ...s, ct: b64u(ct) }, prf, d.role, d.token)).rejects.toBeInstanceOf(PasskeyError);
  });

  test('base64url round trip', () => {
    const b = crypto.getRandomValues(new Uint8Array(33));
    expect(unb64u(b64u(b))).toEqual(b);
    expect(b64u(b)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('protect and unlock', () => {
  test('first time makes a passkey, later deals reuse it; a synced device opens the k2 link', async () => {
    const { wa, vault } = fakeWebAuthn();
    const m = memo();
    const d = deal('creator');
    const s = await protectKey(wa, m, RP, d);
    expect(m.value).toBe(s.cred);
    const d2 = { ...deal(), token: '12'.repeat(16) };
    const s2 = await protectKey(wa, m, RP, d2);
    expect(s2.cred).toBe(s.cred); // same passkey
    expect(s2.salt).not.toBe(s.salt); // own salt per deal

    // The k2 link: no seed in it, parses back.
    const link = sealedLink(ORIGIN, { ...d, sealed: s });
    expect(link.startsWith(`${ORIGIN}/k#k2.creator.${d.token}.`)).toBe(true);
    expect(link).not.toContain(d.seed);
    expect(parsePersonalLink(link)).toBeNull(); // the old reader never takes it as a plain key
    const p = parseSealedLink(link)!;
    expect(p.role).toBe('creator');

    // Another device with the synced passkey.
    const phone = fakeWebAuthn(vault).wa;
    expect(await unlockKey(phone, RP, p.sealed, p.role, p.token)).toBe(d.seed);
    // A device without it.
    await expect(unlockKey(fakeWebAuthn().wa, RP, p.sealed, p.role, p.token)).rejects.toMatchObject({ code: 'cancelled' });
  });

  test('a browser that gives the PRF only on use (Safari) still works', async () => {
    const { wa, state } = fakeWebAuthn(new Map(), { prfOnCreate: false });
    const d = deal();
    const s = await protectKey(wa, memo(), RP, d);
    expect(state.calls).toBe(2); // create, then one get
    expect(await unlockKey(wa, RP, s, d.role, d.token)).toBe(d.seed);
  });

  test('cancel or no PRF: nothing is sealed, the key stays as it was', async () => {
    const f = fakeWebAuthn();
    const m = memo();
    f.state.next = 'cancel';
    await expect(protectKey(f.wa, m, RP, deal())).rejects.toMatchObject({ code: 'cancelled' });
    f.state.next = 'noprf';
    await expect(protectKey(f.wa, m, RP, deal())).rejects.toMatchObject({ code: 'unsupported' });
    expect(m.value).toBeNull();
  });

  test('a remembered passkey that is gone: the error clears it, the next try makes a new one', async () => {
    const f = fakeWebAuthn();
    const m = memo();
    m.value = b64u(new Uint8Array(16));
    await expect(protectKey(f.wa, m, RP, deal())).rejects.toMatchObject({ code: 'cancelled' });
    expect(m.value).toBeNull();
    await protectKey(f.wa, m, RP, deal());
    expect(m.value).not.toBeNull();
  });
});

describe('what this browser stores', () => {
  test('a protected deal is written without its plain key; a reload locks it; Face ID or the key file unlocks it', async () => {
    const raw = new Map<string, string>();
    const store = memoryStore(raw);
    const d = deal();
    const { wa } = fakeWebAuthn();
    store.put(d);
    expect([...raw.values()].join()).toContain(d.seed);

    const sealed = await protectKey(wa, memo(), RP, d);
    store.put({ ...store.get(d.handle)!, sealed });
    expect([...raw.values()].join()).not.toContain(d.seed);
    expect(store.get(d.handle)!.seed).toBe(d.seed); // still open on this page
    expect(isLocked(store.get(d.handle))).toBe(false);

    forgetUnlocked(); // = a reload
    const locked = store.get(d.handle)!;
    expect(locked.seed).toBe('');
    expect(isLocked(locked)).toBe(true);

    // Face ID
    rememberUnlocked(d.handle, await unlockKey(wa, RP, locked.sealed!, locked.role, locked.token));
    expect(store.get(d.handle)!.seed).toBe(d.seed);

    // The key file (k1) is the same key: it matches the stored public key, no passkey needed.
    forgetUnlocked();
    const file = parsePersonalLink(personalLink(ORIGIN, d))!;
    expect(keyFromSeed(file.seed).pk).toBe(store.get(d.handle)!.sealed!.pk);

    // A later write while unlocked keeps the key out of storage.
    rememberUnlocked(d.handle, d.seed);
    store.put({ ...store.get(d.handle)!, title: 'changed' });
    expect([...raw.values()].join()).not.toContain(d.seed);
    expect(store.get(d.handle)!.title).toBe('changed');
  });

  test('old records and k1 links are unchanged', () => {
    const store = memoryStore();
    const d = deal();
    store.put(d);
    expect(store.get(d.handle)).toEqual(d);
    expect(isLocked(d)).toBe(false);
    expect(parsePersonalLink(personalLink(ORIGIN, d))).toEqual({ role: d.role, token: d.token, seed: d.seed });
    expect(parseSealedLink(personalLink(ORIGIN, d))).toBeNull();
  });
});

test('no WebAuthn (or not a secure page): the button is not offered', async () => {
  const { passkeySupport } = await import('../src/lib/passkey');
  expect(await passkeySupport()).toBe(false);
});
