// .env.example stays in line with src/config.ts.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import { readConfig } from '../src/config.ts';

/** server/ from test/ (TS stripping) or dist/test/ (built). */
function serverDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    try {
      readFileSync(resolve(dir, '.env.example'));
      return dir;
    } catch {
      dir = resolve(dir, '..');
    }
  }
  throw new Error('server/.env.example not found');
}

const dir = serverDir();
const example = parseEnv(readFileSync(resolve(dir, '.env.example'), 'utf8')) as Record<string, string>;

test('.env.example lists every variable the server reads', () => {
  const src = ['config.ts', 'main.ts', 'app.ts', 'market.ts'].map((f) => readFileSync(resolve(dir, 'src', f), 'utf8')).join('\n');
  const read = new Set([...src.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]));
  read.delete('ENV_FILE'); // the path of this file itself
  const missing = [...read].filter((k) => !(k in example));
  assert.deepEqual(missing, []);
  const unknown = Object.keys(example).filter((k) => !read.has(k));
  assert.deepEqual(unknown, [], 'no variables the server ignores');
});

test('.env.example values are the config.ts defaults and hold no secrets', () => {
  assert.equal(example.ONECLICK_API_KEY, '');
  assert.equal(example.RELAYER_PRIVATE_KEY, '');
  const fromExample = readConfig({ ...example });
  const defaults = readConfig({});
  assert.deepEqual(fromExample, defaults);
});
