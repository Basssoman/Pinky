// The creator's profile picture, browser side. The chosen file
// is opened here, the middle square is cut out and drawn again at 512 x 512,
// so what leaves this browser is fresh pixels only (no location, no camera
// data). Our server checks it, re-encodes it again (256 x 256 WebP) and serves
// it from our own address. Nothing ever links to a picture elsewhere.

import { sha256 } from '@noble/hashes/sha2';
import { MESSAGE_PREFIX, sign } from './keys';
import { expiresNs, profileIdOfKey, type ProfileKey, type SignedWrite } from './market';

/** What the server accepts (it checks the first bytes too). */
export const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** The server's limit for what we send. */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/** A bigger file is not even opened (a phone photo is 2–12 MB). */
export const AVATAR_MAX_FILE = 25 * 1024 * 1024;
const SIDE = 512;

export type AvatarProblem = 'type' | 'big' | 'unreadable';

export class AvatarFileError extends Error {
  readonly problem: AvatarProblem;
  constructor(problem: AvatarProblem) {
    super(problem);
    this.problem = problem;
  }
}

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Same message as the server (`avatarMessage` in server/src/market.ts): sha256 of the exact bytes, or "remove". */
export const avatarMessage = (contractId: string, profileId: string, imageSha256OrRemove: string, exp: string) =>
  `${MESSAGE_PREFIX}|${contractId}|profile-avatar|${profileId}|${imageSha256OrRemove}|${exp}`;

export function signAvatar(contractId: string, k: ProfileKey, bytes: Uint8Array | 'remove', nowMs: number): SignedWrite {
  const exp = expiresNs(nowMs);
  const what = bytes === 'remove' ? 'remove' : hex(sha256(bytes));
  return { expires_at_ns: exp, sig: sign({ seed: k.seed, pk: k.pk }, avatarMessage(contractId, profileIdOfKey(k), what, exp)) };
}

export function bytesToBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The middle square of a w x h picture: [x, y, side]. */
export function centerSquare(w: number, h: number): [number, number, number] {
  const side = Math.min(w, h);
  return [Math.floor((w - side) / 2), Math.floor((h - side) / 2), side];
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((res) => canvas.toBlob(res, type, quality));
}

/**
 * Opens the picture, crops the middle square, draws it at 512 x 512 and
 * returns WebP (or PNG where the browser cannot write WebP).
 */
export async function prepareAvatar(file: File): Promise<Blob> {
  if (file.type && !(AVATAR_TYPES as readonly string[]).includes(file.type)) throw new AvatarFileError('type');
  if (file.size > AVATAR_MAX_FILE) throw new AvatarFileError('big');
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new AvatarFileError(file.type ? 'unreadable' : 'type');
  }
  try {
    const [x, y, side] = centerSquare(bmp.width, bmp.height);
    if (side < 1) throw new AvatarFileError('unreadable');
    const out = Math.min(SIDE, side);
    const canvas = document.createElement('canvas');
    canvas.width = out;
    canvas.height = out;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new AvatarFileError('unreadable');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, x, y, side, side, 0, 0, out, out);
    let blob = await toBlob(canvas, 'image/webp', 0.9);
    if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/png');
    if (!blob) throw new AvatarFileError('unreadable');
    if (blob.size > AVATAR_MAX_BYTES) throw new AvatarFileError('big');
    return blob;
  } finally {
    bmp.close();
  }
}
