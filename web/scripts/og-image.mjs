// Draws the share picture (`public/og.png`, 1200×630, for X / Telegram link
// cards) and the home-screen icon (`public/icon-180.png`) in the site's pixel
// style: dark page, faint squares, the PINKY word, the two hooked little
// fingers from the home page (Landing.tsx PINKIES). No dependencies: a tiny
// bitmap font and a PNG writer. Run: `node scripts/og-image.mjs` in web/.
// Change the words below if the home headline changes.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const TAG = 'HELD IN A SMART CONTRACT ON NEAR';
const TITLE = ['SAFE DEALS FOR', 'FREELANCE WORK'];
const NOTE = 'NO SIGN-UP. NO WALLET TO CONNECT.';

const INK = [255, 255, 255];
const SOFT = [168, 168, 168];
const BLUE = [127, 176, 255];
const PAPER = [18, 18, 18];
const FAINT = [30, 30, 30];

// 5×7 capitals, '#' = on.
const FONT = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  B: ['####.', '#...#', '#...#', '####.', '#...#', '#...#', '####.'],
  C: ['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.'],
  D: ['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.'],
  E: ['#####', '#....', '#....', '####.', '#....', '#....', '#####'],
  F: ['#####', '#....', '#....', '####.', '#....', '#....', '#....'],
  G: ['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.####'],
  H: ['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  L: ['#....', '#....', '#....', '#....', '#....', '#....', '#####'],
  M: ['#...#', '##.##', '#.#.#', '#.#.#', '#...#', '#...#', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#..##', '#...#', '#...#', '#...#'],
  O: ['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  P: ['####.', '#...#', '#...#', '####.', '#....', '#....', '#....'],
  R: ['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
  U: ['#...#', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.'],
  W: ['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '##.##', '#...#'],
  Y: ['#...#', '#...#', '.#.#.', '..#..', '..#..', '..#..', '..#..'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  '-': ['.....', '.....', '.....', '.###.', '.....', '.....', '.....'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

function canvas(w, h) {
  const px = new Uint8Array(w * h * 3);
  const rect = (x, y, rw, rh, c) => {
    for (let j = Math.max(0, y); j < Math.min(h, y + rh); j++)
      for (let i = Math.max(0, x); i < Math.min(w, x + rw); i++) px.set(c, (j * w + i) * 3);
  };
  const text = (s, x, y, scale, c) => {
    let cx = x;
    for (const ch of s) {
      const g = FONT[ch];
      if (!g) throw new Error(`no glyph for "${ch}"`);
      g.forEach((row, gy) => [...row].forEach((v, gx) => v === '#' && rect(cx + gx * scale, y + gy * scale, scale, scale, c)));
      cx += 6 * scale;
    }
    return cx - scale - x;
  };
  return { w, h, px, rect, text };
}

function png(c) {
  const raw = Buffer.alloc((c.w * 3 + 1) * c.h);
  for (let y = 0; y < c.h; y++) Buffer.from(c.px.buffer, y * c.w * 3, c.w * 3).copy(raw, y * (c.w * 3 + 1) + 1);
  const table = Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  const crc = (b) => {
    let x = 0xffffffff;
    for (const v of b) x = table[(x ^ v) & 0xff] ^ (x >>> 8);
    return (x ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(c.w, 0);
  ihdr.writeUInt32BE(c.h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** The two hooked little fingers, as on the home page: '#' white hand, '*' blue hand, '+' blue sparks. */
function pinkies() {
  const grid = Array.from({ length: 23 }, () => Array(44).fill('.'));
  const left = [];
  const add = (x, y, w, h) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) left.push([i, j]);
  };
  add(1, 8, 14, 12);
  add(3, 6, 8, 2);
  add(15, 8, 11, 2);
  add(24, 10, 2, 3);
  const off = new Set(['1,8', '14,8', '1,19', '14,19', '3,6', '10,6']);
  for (const y of [11, 14, 17]) for (let x = 9; x < 15; x++) off.add(`${x},${y}`);
  for (const [x, y] of left) {
    if (off.has(`${x},${y}`)) continue;
    grid[y][x] = '#';
    grid[22 - y][43 - x] = '*';
  }
  for (const [x, y] of [[21, 4], [29, 6], [13, 4], [17, 17], [32, 19], [6, 2]]) grid[y][x] = '+';
  return grid;
}

function faintSquares(c, seed) {
  let s = seed;
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  for (let by = 0; by < c.h; by += 84)
    for (let bx = 0; bx < c.w; bx += 84) c.rect(bx + Math.floor(rnd() * 5) * 14, by + Math.floor(rnd() * 5) * 14, 13, 13, FAINT);
}

// ---- share picture
const og = canvas(1200, 630);
og.rect(0, 0, og.w, og.h, PAPER);
faintSquares(og, 7);
const X = 80;
og.text(TAG, X, 92, 3, BLUE);
og.text('PINKY', X, 140, 18, INK);
og.text(TITLE[0], X, 318, 6, INK);
og.text(TITLE[1], X, 378, 6, INK);
og.text(NOTE, X, 488, 3, SOFT);
const art = pinkies();
const S = 10;
const ax = og.w - 44 * S - 64;
const ay = 318;
art.forEach((row, y) => row.forEach((v, x) => v !== '.' && og.rect(ax + x * S, ay + y * S, S - 1, S - 1, v === '#' ? INK : BLUE)));
og.rect(0, og.h - 8, og.w, 8, BLUE);
writeFileSync(new URL('../public/og.png', import.meta.url), png(og));

// ---- home-screen icon: the pixel P, as in favicon.svg
const icon = canvas(180, 180);
icon.rect(0, 0, 180, 180, PAPER);
icon.text('P', 40, 34, 16, INK);
icon.rect(40 + 4 * 16, 34 + 6 * 16, 16, 16, BLUE);
writeFileSync(new URL('../public/icon-180.png', import.meta.url), png(icon));
console.log('wrote public/og.png and public/icon-180.png');
