// Creator avatars: the picture is uploaded to us, decoded and
// RE-ENCODED here, stored in our database and served from our API. Nothing
// links to an image elsewhere (a hot-linked image could track who views a
// profile by IP, or carry text / a QR code past moderation).
//
// What comes in: JPEG, PNG or WebP only (checked by the first bytes, then by
// the decoder), at most 2 MB. What goes out: a square 256 x 256 WebP made from
// the decoded pixels only, so EXIF (GPS, camera), XMP, ICC and comments are
// gone; only the first frame of an animation is kept.
//
// Library: sharp, WebAssembly build (`server/.npmrc` has `cpu=wasm32`): the
// live server runs from this same folder in WSL Linux while tests run on
// Windows, and native image binaries are per OS. It is loaded lazily: if it
// cannot load, uploads answer 503 and everything else keeps working.

import { createHash } from 'node:crypto';

export const AVATAR = {
  /** Largest picture accepted (decoded bytes). */
  maxBytes: 2 * 1024 * 1024,
  /** Side of the stored square (px). */
  size: 256,
  /** Largest picture in pixels the decoder will open (decompression bombs). */
  maxPixels: 25_000_000,
  /** Pictures processed at the same time; more answer "busy". */
  maxParallel: 2,
} as const;

export type ImageKind = 'jpeg' | 'png' | 'webp';

/** The picture type from its first bytes; null for anything else (GIF, SVG, HEIC, HTML, …). */
export function sniffImage(b: Uint8Array): ImageKind | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length >= 8 && png.every((v, i) => b[i] === v)) return 'png';
  const ascii = (from: number, s: string) => [...s].every((c, i) => b[from + i] === c.charCodeAt(0));
  if (b.length >= 12 && ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'webp';
  return null;
}

type SharpFn = (typeof import('sharp'))['default'];
let loading: Promise<SharpFn | null> | null = null;

/** sharp, or null when it cannot load on this machine (the server still starts). */
export function loadSharp(): Promise<SharpFn | null> {
  loading ??= import('sharp').then(
    (m) => m.default,
    () => null,
  );
  return loading;
}

export const bytesSha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

export class AvatarError extends Error {
  readonly code: 'bad_image' | 'unavailable' | 'busy';
  constructor(code: AvatarError['code'], message: string) {
    super(message);
    this.code = code;
  }
}

let running = 0;

/**
 * Decodes the picture (it must really be `kind`), turns it upright by its
 * EXIF orientation, crops the middle square, scales it to 256 x 256 and
 * encodes a fresh WebP without any metadata.
 */
export async function reencodeAvatar(input: Uint8Array, kind: ImageKind): Promise<Uint8Array> {
  const sharp = await loadSharp();
  if (!sharp) throw new AvatarError('unavailable', 'pictures cannot be processed on this server right now');
  if (running >= AVATAR.maxParallel) throw new AvatarError('busy', 'the server is busy with other pictures; try again in a moment');
  running++;
  try {
    const opts = { limitInputPixels: AVATAR.maxPixels, failOn: 'error' as const, animated: false };
    let format: string | undefined;
    try {
      format = (await sharp(input, opts).metadata()).format;
    } catch {
      throw new AvatarError('bad_image', 'the picture could not be read');
    }
    if (format !== kind) throw new AvatarError('bad_image', 'the picture is not a real JPEG, PNG or WebP');
    try {
      // No keepMetadata()/withMetadata(): sharp writes only the pixels (sRGB).
      const out = await sharp(input, opts)
        .autoOrient()
        .resize(AVATAR.size, AVATAR.size, { fit: 'cover', position: 'centre' })
        .webp({ quality: 82, effort: 4 })
        .toBuffer();
      return new Uint8Array(out);
    } catch {
      throw new AvatarError('bad_image', 'the picture could not be read');
    }
  } finally {
    running--;
  }
}
