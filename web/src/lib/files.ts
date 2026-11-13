// One fingerprint for all delivered files. The files never
// leave the device: the browser hashes them and only the fingerprint goes
// on-chain as `deliverable_hash`.
//
// manifest    = "kept-files-v1\n" + one line "<sha256 hex> <size>" per file,
//               lines sorted (names are left out: download sites rename files)
// fingerprint = "v1:" + hex( sha256( salt bytes ‖ utf8(manifest) ) )
// The random salt travels in the encrypted delivery note, so a file that is
// published later cannot be matched to the deal on-chain.

import { sha256 } from '@noble/hashes/sha2';
import { concat, hex, randomHex, unhex, utf8 } from './bytes';

/** What the browser needs from a chosen file (a `File` fits). */
export interface FileLike {
  size: number;
  stream(): ReadableStream<Uint8Array>;
}

async function hashFile(file: FileLike, onBytes?: (n: number) => void): Promise<string> {
  const h = sha256.create();
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    h.update(value);
    onBytes?.(value.length);
  }
  return hex(h.digest());
}

export async function filesManifest(files: FileLike[], onProgress?: (done: number, total: number) => void): Promise<string> {
  const total = files.reduce((n, f) => n + f.size, 0);
  let done = 0;
  const lines: string[] = [];
  for (const f of files) {
    const digest = await hashFile(f, (n) => {
      done += n;
      onProgress?.(done, total);
    });
    lines.push(`${digest} ${f.size}`);
  }
  return `kept-files-v1\n${lines.sort().join('\n')}`;
}

export const newFilesSalt = (): string => randomHex(16);

export function filesFingerprint(salt: string, manifest: string): string {
  return `v1:${hex(sha256(concat(unhex(salt), utf8(manifest))))}`;
}
