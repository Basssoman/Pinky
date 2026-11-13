// The key file: the ONE personal link, plus — for a deal
// protected with Face ID — the backup key code that opens it without the passkey.
import type { Dict } from './i18n';
import { keyFromSeed } from './lib/keys';
import { backupCode, findKeyInFile, type LocalDeal, type Role } from './lib/local';
import { ownLink, type Sealed } from './lib/passkey';

type Own = Pick<LocalDeal, 'role' | 'token' | 'seed'> & { sealed?: Sealed };

export function keyFileText(t: Dict, title: string, who: string, own: Own, origin = window.location.origin): string {
  const lines = t.key.file(title, who, ownLink(origin, own));
  if (own.sealed) lines.push('', t.flow.fileBackupTitle, backupCode(own));
  return lines.join('\n');
}

export function saveTextFile(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export class FileKeyError extends Error {
  readonly code: 'unreadable' | 'wrong';
  constructor(code: FileKeyError['code']) {
    super(code);
    this.code = code;
  }
}

/** The key from a key file the person picks; it must be this deal's key (same role, link and, when known, public key). */
export async function keyFromFile(file: Blob, want: { role: Role; token: string; pk?: string }): Promise<string> {
  const found = findKeyInFile(await file.slice(0, 64 * 1024).text());
  if (!found) throw new FileKeyError('unreadable');
  if (found.role !== want.role || found.token !== want.token) throw new FileKeyError('wrong');
  if (want.pk && keyFromSeed(found.seed).pk !== want.pk) throw new FileKeyError('wrong');
  return found.seed;
}

