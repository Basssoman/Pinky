// The home page: the approved pixel look
// (built as the dev look `home-v2`, now the real `/`). Press Start 2P caps
// headings, faint parallax squares, dithered band edges, faint lines around
// the mouse, pictures that assemble from squares, Lenis smooth scroll on
// desktop; reduced motion = everything still. Texts: i18n `home.v2` (plain
// language, approved 11-12). Styles: home.css. All pictures are drawn in code.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useT } from './i18n';
import { Bitmap, CELL, LAYERS, TILE, cursorLines } from './pixel';
import './home.css';

type Props = { onCreate: () => void; onExample: () => void };

/** Draw with rectangles on a character grid, then trim empty rows. */
function paint(w: number, h: number, draw: (set: (x: number, y: number, ch: string) => void) => void) {
  const g = Array.from({ length: h }, () => Array<string>(w).fill('.'));
  const set = (x: number, y: number, ch: string) => {
    if (x >= 0 && y >= 0 && x < w && y < h) g[y][x] = ch;
  };
  draw(set);
  const rows = g.map((r) => r.join(''));
  while (rows.length && !/[^.]/.test(rows[0])) rows.shift();
  while (rows.length && !/[^.]/.test(rows[rows.length - 1])) rows.pop();
  return rows;
}

/**
 * The brand picture: two fists, little fingers hooked into one link. The
 * right hand is the left one turned 180 degrees, in the accent color.
 */
const PINKIES = paint(44, 23, (set) => {
  const left: [number, number][] = [];
  const add = (x: number, y: number, w: number, h: number) => {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) left.push([i, j]);
  };
  add(1, 8, 14, 12); // the fist
  add(3, 6, 8, 2); // the thumb on top
  add(15, 8, 11, 2); // the little finger, straight out
  add(24, 10, 2, 3); // ...and hooked down
  const off = new Set(['1,8', '14,8', '1,19', '14,19', '3,6', '10,6']);
  for (const y of [11, 14, 17]) for (let x = 9; x < 15; x++) off.add(`${x},${y}`); // curled fingers
  for (const [x, y] of left) {
    if (off.has(`${x},${y}`)) continue;
    set(x, y, '#');
    set(43 - x, 22 - y, '*');
  }
  for (const [x, y] of [
    [21, 4],
    [29, 6],
    [13, 4],
    [17, 17],
    [32, 19],
    [6, 2],
  ])
    set(x, y, '+');
});

const PERSON = [
  '....####....',
  '...######...',
  '...######...',
  '...######...',
  '....####....',
  '............',
  '..########..',
  '.##########.',
  '.##########.',
  '.##########.',
  '.##########.',
];
const CREATOR = [
  '....####....',
  '...######...',
  '...######...',
  '...######...',
  '....####....',
  '............',
  '..########..',
  '.####**####.',
  '.###****###.',
  '.####**####.',
  '.##########.',
];
const SAFE = [
  '############',
  '#..........#',
  '#.########.#',
  '#.#......#.#',
  '#.#..**..#.#',
  '#.#.*..*.#.#',
  '#.#.*..*.#.#',
  '#.#..**..#.#',
  '#.#......#.#',
  '#.########.#',
  '#..........#',
  '############',
  '.##......##.',
];
const MARK_OK = ['....#', '...##', '#.##.', '###..', '.#...'];
const CLOCK = [
  '...######...',
  '..#......#..',
  '.#...*....#.',
  '#....*.....#',
  '#....*.....#',
  '#....****..#',
  '#..........#',
  '.#........#.',
  '..#......#..',
  '...######...',
  '............',
  '*...........',
  '************',
  '*...........',
];
const QUIET = [
  '############',
  '#..........#',
  '#..........#',
  '#.**.**.**.#',
  '#..........#',
  '#..........#',
  '#####..#####',
  '....#.#.....',
  '....##......',
  '....#.......',
  '........---.',
  '..........-.',
  '.........-..',
  '........---.',
];
const SPLIT = [
  '..####..****',
  '.#....#*....',
  '#......*....',
  '#......*....',
  '#......*....',
  '.#....#*....',
  '..####..****',
  '.....+......',
  '............',
  '#####..*****',
  '#####..*****',
  '............',
];
const HOURGLASS = [
  '############',
  '.#........#.',
  '..#......#..',
  '...#....#...',
  '....#..#....',
  '.....##.....',
  '.....##.....',
  '....#..#....',
  '...#....#...',
  '..#..**..#..',
  '.#..****..#.',
  '############',
];
const DOC = [
  '##############....',
  '#............##...',
  '#.--------...#.#..',
  '#............####.',
  '#.------------..#.',
  '#...............#.',
  '#.-----------...#.',
  '#...............#.',
  '#.------------..#.',
  '#...............#.',
  '#.--------......#.',
  '#...............#.',
  '#.........*****.#.',
  '#........*******#.',
  '#.......***+*+***.',
  '#.......**+***+**.',
  '#.......***+*+***.',
  '#........*******#.',
  '#.........*****.#.',
  '##################',
];
const QMARK = [
  '..######..',
  '.##....##.',
  '##......##',
  '........##',
  '.......##.',
  '.....###..',
  '....##....',
  '....##....',
  '..........',
  '....**....',
  '....**....',
];
const SEAL = ['..***..', '.*****.', '***+***', '**+*+**', '***+***', '.*****.', '..***..'];
const CHECK_SMALL = MARK_OK;
/** A browser window with the deal key inside (the privacy block). */
const BROWSER_KEY = [
  '######################',
  '#.*.*.*..............#',
  '######################',
  '#....................#',
  '#...####.............#',
  '#..#....#............#',
  '#..#.**.############.#',
  '#..#.**.#.....#.#....#',
  '#..#....#.....#.#....#',
  '#...####.............#',
  '#....................#',
  '#..----..----..---...#',
  '#....................#',
  '######################',
];
const PCT = [
  '####.......##...#',
  '....#......##..#.',
  '....#.........#..',
  '.###.........#...',
  '....#.......#....',
  '....#......#..##.',
  '####......#...##.',
];

// copy v1 names Bitcoin, Ethereum, USDT, Solana, TON, NEAR. TON here = the TON network
// (USDT on TON is in the live list; plain TON was paid in live deal 4, 2026-11-11)
const COINS = ['BTC', 'ETH', 'USDT', 'SOL', 'TON', 'NEAR', 'ZEC'];

// ---------------------------------------------------------------- parallax art (v2, 11-12)
// Behind a few blocks, a themed picture made of faint
// background-style squares. Scattered while the block is off-centre, they
// fly together into the picture as the block reaches the middle of the
// screen and scatter again as it leaves. Position-based (no timers).

type Ghost = 'safe' | 'clock' | 'coin' | 'lock';
/** The picture as cells on a 24 × 24 grid. */
function ghostCells(kind: Ghost): [number, number][] {
  const out: [number, number][] = [];
  const ring = (cx: number, cy: number, r0: number, r1: number) => {
    for (let y = 0; y < 24; y++)
      for (let x = 0; x < 24; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d >= r0 && d < r1) out.push([x, y]);
      }
  };
  const rect = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) out.push([x, y]);
  };
  const frame = (x0: number, y0: number, w: number, h: number) => {
    rect(x0, y0, w, 1);
    rect(x0, y0 + h - 1, w, 1);
    rect(x0, y0 + 1, 1, h - 2);
    rect(x0 + w - 1, y0 + 1, 1, h - 2);
  };
  if (kind === 'safe') {
    frame(1, 1, 22, 20);
    frame(3, 3, 18, 16);
    ring(12, 11, 3, 4.2);
    rect(11, 10, 2, 2);
    rect(17, 8, 1, 6); // the handle
    rect(3, 21, 3, 2); // feet
    rect(18, 21, 3, 2);
  } else if (kind === 'clock') {
    ring(12, 12, 10.2, 11.6);
    rect(11, 5, 2, 7); // minute hand
    rect(13, 11, 5, 2); // hour hand
    rect(11, 2, 2, 1); // 12, 3, 6, 9
    rect(21, 11, 1, 2);
    rect(11, 21, 2, 1);
    rect(2, 11, 1, 2);
  } else if (kind === 'lock') {
    frame(3, 10, 18, 13); // the body
    for (let y = 0; y < 10; y++)
      for (let x = 0; x < 24; x++) {
        const d = Math.hypot(x + 0.5 - 12, y + 0.5 - 10);
        if (d >= 5.6 && d < 7.2) out.push([x, y]); // the shackle
      }
    rect(5, 10, 2, 1);
    rect(17, 10, 2, 1);
    rect(11, 14, 2, 2); // the keyhole
    rect(11, 16, 2, 3);
  } else {
    ring(12, 12, 10.2, 11.6);
    ring(12, 12, 7.2, 8.2);
    rect(11, 8, 2, 8); // a mark in the middle of the coin
    rect(9, 9, 6, 1);
    rect(9, 14, 6, 1);
  }
  return out;
}

function ghostArt(canvas: HTMLCanvasElement, kind: Ghost, seed: number) {
  const ctx = canvas.getContext('2d');
  const band = canvas.parentElement as HTMLElement;
  const dark = band.classList.contains('band-dark');
  const fx = Number(canvas.dataset.ax ?? 0.76); // where the picture sits across the block
  const cells = ghostCells(kind);
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  // each square: where it flies in from, and a small lag so they don't move as one
  const fly = cells.map(() => {
    const a = rnd() * Math.PI * 2;
    const r = 180 + rnd() * 380;
    return { dx: Math.cos(a) * r, dy: Math.sin(a) * r, lag: rnd() * 0.35 };
  });
  let w = 0;
  let h = 0;
  let cell = CELL;
  let last = -1;
  const resize = () => {
    w = band.clientWidth;
    h = band.clientHeight;
    cell = w < 600 ? 10 : CELL;
    canvas.width = w; // 1 canvas px = 1 css px: the squares sit on whole pixels
    canvas.height = h;
    last = -1;
  };
  const ease = (x: number) => x * x * (3 - 2 * x);
  const draw = (t: number, faint = 1) => {
    const q = Math.round(t * 100) / 100;
    if (!ctx || q === last) return;
    last = q;
    canvas.dataset.t = String(q);
    ctx.clearRect(0, 0, w, h);
    const size = 24 * cell;
    // to the right of the text on wide screens, centred on phones
    const ax = Math.round((w < 900 ? w / 2 : w * fx) - size / 2);
    const ay = Math.round(h / 2 - size / 2);
    ctx.fillStyle = dark ? '#ffffff' : '#121212';
    ctx.globalAlpha = (dark ? 0.1 : 0.085) * faint * (0.5 + 0.5 * q);
    cells.forEach(([cx, cy], i) => {
      const f = fly[i];
      const k = ease(Math.min(1, Math.max(0, (q - f.lag) / (1 - f.lag))));
      const x = Math.round(ax + cx * cell + f.dx * (1 - k));
      const y = Math.round(ay + cy * cell + f.dy * (1 - k));
      ctx.fillRect(x, y, cell - 1, cell - 1);
    });
  };
  resize();
  return { band, resize, draw };
}
/** Block centre vs screen centre: 1 = assembled (near the middle), 0 = scattered. */
function gather(rect: DOMRect, vh: number) {
  const dist = Math.abs(rect.top + rect.height / 2 - vh / 2) / (rect.height / 2 + vh / 2);
  const c = Math.min(1, Math.max(0, (0.55 - dist) / 0.4));
  return c * c * (3 - 2 * c);
}

// ---------------------------------------------------------------- bands


/**
 * The dithered pixel edge between two bands (v6): a strip of
 * ROWS cells at the top of the LOWER band. `draw(p)`, p in 0..1 = how far the
 * band line has travelled up the screen:
 * - p = 0: the whole strip is the UPPER band's color (a straight line at the
 *   strip's lower boundary);
 * - p = 1: the whole strip is the lower band's own color (a straight line at
 *   the strip's upper boundary = the band's top);
 * - in between the lower color grows UP through the strip as a dithered front.
 * Each cell has a fixed threshold = row bias (bottom rows low, top rows high)
 * + fixed random jitter; a cell shows the lower color once p > threshold. Only
 * position-based, so scrolling back reverses it. Cells 14 px (10 px on
 * phones), drawn on whole device pixels: crisp, no seams. The strip sits in
 * the band's top padding (184 / 128 px), so it never covers content.
 * v7: 5 rows, all of them dithered at once
 * mid-way (see the thresholds in `resize`).
 */
const EDGE_ROWS = 5;
function makeEdge(canvas: HTMLCanvasElement, seed: number) {
  const ctx = canvas.getContext('2d');
  const band = canvas.parentElement as HTMLElement;
  const prev = band.previousElementSibling;
  const upper = prev ? getComputedStyle(prev).backgroundColor : getComputedStyle(band).backgroundColor;
  let cell = 14;
  let dpr = 1;
  let cols = 0;
  let th: number[][] = []; // th[row][col], row 0 = top of the strip
  let last = -1;
  const resize = () => {
    const w = canvas.clientWidth;
    cell = w < 600 ? 10 : 14;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.style.top = '0px';
    canvas.style.height = `${EDGE_ROWS * cell}px`;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(EDGE_ROWS * cell * dpr);
    let s = seed;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    cols = Math.ceil(w / cell);
    th = [];
    for (let r = 0; r < EDGE_ROWS; r++) {
      const bias = 1 - r / (EDGE_ROWS - 1); // 1 = top row (fills last), 0 = bottom row (fills first)
      const row: number[] = [];
      let jit = 0;
      for (let x = 0; x < cols; x++) {
        // a cell sometimes repeats its left neighbour: short 2-3 cell bars, as in the reference
        if (!x || rnd() >= 0.3) jit = rnd();
        // v7: the jitter outweighs the row bias, so at the peak (p 0.5) all
        // rows are mixed at once: ~86% lower color in the bottom row, ~14% in
        // the top one. 0.01 + 0.98 * (…): the fill uses the whole p range, so the straight
        // zones are just the 5% flat ends of `progress` (11-12; was 0.15 + 0.7).
        row.push(0.01 + 0.98 * (0.42 * bias + 0.58 * jit));
      }
      th.push(row);
    }
    last = -1;
  };
  const X = (c: number) => Math.round(c * cell * dpr);
  const Y = (r: number) => Math.round(r * cell * dpr);
  const draw = (p: number) => {
    const q = Math.round(Math.min(1, Math.max(0, p)) * 200) / 200;
    if (!ctx || q === last) return;
    last = q;
    canvas.dataset.p = String(q);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = upper;
    for (let r = 0; r < EDGE_ROWS; r++)
      for (let x = 0; x < cols; x++) if (!(q > th[r][x])) ctx.fillRect(X(x), Y(r), X(x + 1) - X(x), Y(r + 1) - Y(r));
  };
  resize();
  return { canvas, band, resize, draw };
}

/** Band line position on screen (0 = bottom, 1 = top) to fill progress: 0 in the bottom 5%, 1 in the top 5%, linear between (was 15%). */
function progress(pos: number) {
  return Math.min(1, Math.max(0, (pos - 0.05) / 0.9));
}

function useBands(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const layers = [...el.querySelectorAll<HTMLElement>('[data-speed]')];
    const edges = [...el.querySelectorAll<HTMLCanvasElement>('canvas.band-edge')].map((c, i) => makeEdge(c, 11 + i * 17));
    const ghosts = [...el.querySelectorAll<HTMLCanvasElement>('canvas.lp-ghost')].map((c, i) =>
      ghostArt(c, c.dataset.ghost as Ghost, 101 + i * 37),
    );

    const update = () => {
      const vh = window.innerHeight;
      if (reduce) {
        for (const e of edges) e.draw(1); // the final state: a straight line at the band top
        for (const g of ghosts) g.draw(1, 0.6); // the pictures stay assembled, a bit fainter
        return;
      }
      const y = window.scrollY;
      for (const l of layers) l.style.transform = `translate3d(0, ${-((y * Number(l.dataset.speed)) % TILE)}px, 0)`;
      for (const e of edges) {
        const pos = Math.min(1, Math.max(0, 1 - e.band.getBoundingClientRect().top / vh));
        e.draw(progress(pos));
      }
      for (const g of ghosts) {
        const r = g.band.getBoundingClientRect();
        if (r.bottom > 0 && r.top < vh) g.draw(gather(r, vh));
      }
    };
    let queued = false;
    const onScroll = () => {
      if (document.hidden) return update();
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        update();
      });
    };
    const onResize = () => {
      edges.forEach((e) => e.resize());
      ghosts.forEach((g) => g.resize());
      update();
    };
    update();
    if (!reduce) window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);

    // Lines around the mouse: desktop pointer only, not under reduced motion.
    const lines = el.querySelector<HTMLCanvasElement>('canvas.squares-lines');
    const stopLines = lines && !reduce && matchMedia('(hover: hover) and (pointer: fine)').matches ? cursorLines(lines) : null;

    // Loops (coins on the track, blinking pixels) run only while their band is on screen.
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) en.target.classList.toggle('on', en.isIntersecting);
    });
    el.querySelectorAll('.band').forEach((b) => io.observe(b));

    // Inertial smooth scroll on desktop only (a fine pointer that can hover).
    let lenis: { destroy(): void } | null = null;
    let gone = false;
    if (!reduce && matchMedia('(hover: hover) and (pointer: fine)').matches) {
      Promise.all([import('lenis'), import('lenis/dist/lenis.css')]).then(([{ default: Lenis }]) => {
        if (!gone) lenis = new Lenis({ autoRaf: true, anchors: true, allowNestedScroll: true, lerp: 0.1 });
      });
    }
    return () => {
      gone = true;
      lenis?.destroy();
      stopLines?.();
      io.disconnect();
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, [root]);
}

function Band(props: { tone: 'dark' | 'light'; edge?: boolean; cls?: string; ghost?: Ghost; ghostX?: number; children: ReactNode }) {
  const { tone, edge = true, cls = '', ghost, ghostX, children } = props;
  return (
    <div className={`band band-${tone} ${cls}`}>
      {edge && <canvas className="band-edge" aria-hidden="true" />}
      {ghost && <canvas className="lp-ghost" data-ghost={ghost} data-ax={ghostX} aria-hidden="true" />}
      <div className="band-in">{children}</div>
    </div>
  );
}

/** A 20-cell pixel meter: how a case ends, client share vs creator share. */
function Meter({ client, creator }: { client: number; creator: number }) {
  return (
    <span className="lp-meter" aria-hidden="true">
      {Array.from({ length: 20 }, (_, i) => (
        <span key={i} className={i < client ? 'c' : i >= 20 - creator ? 'k' : ''} />
      ))}
    </span>
  );
}

/**
 * An accordion where only one answer is open at a time; the
 * first is open at the start. Buttons with aria-expanded / aria-controls.
 */
function Faq({ q, a }: { q: string[]; a: string[] }) {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <div className="lp-faq-list">
      {q.map((question, i) => {
        const on = open === i;
        return (
          <div key={question} className={`lp-faq-item${on ? ' open' : ''}`}>
            <h3>
              <button
                type="button"
                id={`lp-faq-q${i}`}
                aria-expanded={on}
                aria-controls={`lp-faq-a${i}`}
                onClick={() => setOpen(on ? null : i)}
              >
                {question}
              </button>
            </h3>
            <div id={`lp-faq-a${i}`} role="region" aria-labelledby={`lp-faq-q${i}`} hidden={!on}>
              <p>{a[i]}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- page

export function Landing(p: Props) {
  const t = useT().home.v2;
  const root = useRef<HTMLElement>(null);
  useBands(root);

  const Actions = ({ more = true }: { more?: boolean }) => (
    <div className="lp-actions">
      <button className="cta cta-inline" type="button" onClick={p.onCreate}>
        {t.create}
      </button>
      {more && (
        <button className="btn-ghost" type="button" onClick={p.onExample}>
          {t.example}
        </button>
      )}
    </div>
  );

  const wiArt = [CLOCK, QUIET, SPLIT, HOURGLASS];
  const wiMeter: [number, number][] = [
    [20, 0],
    [0, 20],
    [10, 10],
    [0, 0],
  ];
  // ASCII "-": the pixel font has no U+2212 minus (it rendered as ".9")
  const fees = ['300 USDC', '-9 USDC', '291 USDC', '0'];

  // Copy v1: 11 blocks in the order of the approved master text.
  // Band tones alternate dark / light from the hero on.
  return (
    <main ref={root} className="lp">
      <div className="squares" aria-hidden="true">
        {LAYERS.map((l) => (
          <span key={l.speed} data-speed={l.speed} style={{ backgroundImage: l.url }} />
        ))}
        <canvas className="squares-lines" />
      </div>

      {/* 1 HERO: centred text only (no pinky hands here) */}
      <Band tone="dark" edge={false} cls="band-hero">
        <section className="lp-hero" aria-labelledby="lp-title">
          <div className="lp-hero-text">
            <h1 id="lp-title">{t.title}</h1>
            <p className="lp-lead">{t.lead}</p>
            <Actions />
            <ul className="lp-proof">
              {t.proof.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </div>
          <p className="lp-client-note">{t.clientNote}</p>
        </section>
      </Band>

      {/* 2 WHY: the fear on both sides, the frozen payment in the middle */}
      {/* no ghost art here: the "safe" picture was removed */}
      <Band tone="light">
        <section className="lp-flow" aria-labelledby="lp-why">
          <h2 id="lp-why">{t.whyTitle}</h2>
          <div className="lp-flow-map">
            <div className="lp-node">
              <Bitmap rows={PERSON} className="lp-node-art" />
              <strong>{t.clientLabel}</strong>
              <span className="lp-fear">{t.whyClient}</span>
            </div>
            <div className="lp-track" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <div className="lp-node lp-node-safe">
              <Bitmap rows={SAFE} className="lp-node-art" />
              <strong>{t.safeLabel}</strong>
            </div>
            <div className="lp-track" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
            <div className="lp-node">
              <Bitmap rows={CREATOR} className="lp-node-art" />
              <strong>{t.creatorLabel}</strong>
              <span className="lp-fear">{t.whyCreator}</span>
            </div>
            <p className="lp-back lp-fix">
              <Bitmap rows={CHECK_SMALL} className="lp-mark" />
              {t.whyFix}
            </p>
          </div>
        </section>
      </Band>

      {/* 3 SIDES: what each side gets, client first (the old two-panel layout) */}
      <Band tone="dark">
        <section className="lp-cmp" aria-labelledby="lp-sides">
          <h2 id="lp-sides">{t.sidesTitle}</h2>
          <div className="lp-cmp-panels">
            <div className="lp-panel lp-panel-yes">
              <Bitmap rows={PERSON} className="lp-panel-art" />
              <h3>{t.forClient}</h3>
              <ul>
                {t.client.map((x) => (
                  <li key={x}>
                    <Bitmap rows={MARK_OK} className="lp-mark" />
                    {x}
                  </li>
                ))}
              </ul>
              <p className="lp-panel-hint">{t.clientHint}</p>
            </div>
            <div className="lp-panel lp-panel-side">
              <Bitmap rows={CREATOR} className="lp-panel-art" />
              <h3>{t.forCreator}</h3>
              <ul>
                {t.creator.map((x) => (
                  <li key={x}>
                    <Bitmap rows={MARK_OK} className="lp-mark" />
                    {x}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      </Band>

      {/* 4 HOW: zig-zag steps starting with the client, each with a small pixel screen */}
      <Band tone="light">
        <section className="lp-how" aria-labelledby="lp-how">
          <h2 id="lp-how">{t.howTitle}</h2>
          <ol>
            {t.how.map((title, i) => (
              <li key={title} className="lp-step">
                <div className="lp-step-text">
                  <span className="lp-step-n" aria-hidden="true">
                    0{i + 1}
                  </span>
                  <h3>{title}</h3>
                  <p>{t.howText[i]}</p>
                </div>
                <div className={`lp-screen lp-screen-${i + 1}`} aria-hidden="true">
                  {i === 0 && (
                    <>
                      <span className="lp-bubble lp-bubble-in">
                        <i style={{ width: '80%' }} />
                      </span>
                      <span className="lp-bubble lp-bubble-out">
                        <i style={{ width: '64%', background: '#555' }} />
                      </span>
                      <span className="lp-bubble lp-bubble-in">
                        <i style={{ width: '50%' }} />
                      </span>
                      <span className="lp-stamp lp-stamp-plain">{t.howMock[0]}</span>
                    </>
                  )}
                  {i === 1 && (
                    <>
                      <b>{t.howMock[1]}</b>
                      <span className="lp-bars">
                        <i style={{ width: '90%' }} />
                        <i style={{ width: '72%' }} />
                        <i style={{ width: '80%' }} />
                      </span>
                      <span className="lp-screen-row">
                        <em>{t.howMock[2]}</em>
                        <span className="lp-stamp">
                          <Bitmap rows={SEAL} className="lp-seal" />
                          {t.howMock[3]}
                        </span>
                      </span>
                    </>
                  )}
                  {i === 2 && (
                    <>
                      <span className="lp-ok">
                        <Bitmap rows={CHECK_SMALL} className="lp-mark" />
                        {t.howMock[4]}
                      </span>
                      <span className="lp-screen-row lp-screen-row-start">
                        <Bitmap rows={SAFE} className="lp-screen-art" />
                        <b>{t.howMock[5]}</b>
                      </span>
                      <span className="lp-fill">
                        {Array.from({ length: 16 }, (_, k) => (
                          <i key={k} style={{ animationDelay: `${k * 90}ms` }} />
                        ))}
                      </span>
                    </>
                  )}
                  {i === 3 && (
                    <>
                      <Bitmap rows={CREATOR} className="lp-screen-art" />
                      <span className="lp-ok">
                        <Bitmap rows={CHECK_SMALL} className="lp-mark" />
                        {t.howMock[6]}
                      </span>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>
      </Band>

      {/* 5 WHAT IF: a bento of four cases, each ends in an outcome meter */}
      <Band tone="dark">
        <section className="lp-wi" aria-labelledby="lp-wi">
          <div className="lp-wi-head">
            <h2 id="lp-wi">{t.wiTitle}</h2>
            <p className="lp-lead">{t.wiLead}</p>
          </div>
          <div className="lp-wi-grid">
            {t.wi.map((title, i) => (
              <article key={title} className={`lp-case lp-case-${i + 1}`}>
                <Bitmap rows={wiArt[i]} className="lp-case-art" />
                <h3>{title}</h3>
                <p>{t.wiText[i]}</p>
                <div className="lp-out">
                  <Meter client={wiMeter[i][0]} creator={wiMeter[i][1]} />
                  <span>{t.wiOut[i]}</span>
                </div>
              </article>
            ))}
          </div>
          <p className="lp-legend" aria-hidden="true">
            <span className="c" /> {t.clientLabel} <span className="k" /> {t.creatorLabel}
          </p>
        </section>
      </Band>

      {/* 6 TRUST: the rule in one paragraph, the sealed document, three reasons */}
      <Band tone="light" ghost="lock" ghostX={0.74}>
        <section className="lp-trust" aria-labelledby="lp-trust">
          <h2 id="lp-trust">{t.trTitle}</h2>
          <p className="lp-lead lp-trust-lead">{t.trLead}</p>
          <div className="lp-trust-body">
            <Bitmap rows={DOC} className="lp-doc" />
            <dl className="lp-ledger">
              {t.tr.map((title, i) => (
                <div key={title}>
                  <dt>
                    <span aria-hidden="true">0{i + 1}</span>
                    {title}
                  </dt>
                  <dd>{t.trText[i]}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>
      </Band>

      {/* 7 COINS: many coins funnel into one USDC tile */}
      <Band tone="dark" ghost="coin" ghostX={0.22}>
        <section className="lp-coins" aria-labelledby="lp-coins">
          <div className="lp-coins-text">
            <h2 id="lp-coins">{t.coinTitle}</h2>
            <p className="lp-lead">{t.coinList}</p>
            <p className="lp-coins-out">{t.coinUsdc}</p>
          </div>
          <div className="lp-funnel">
            <ul className="lp-tiles">
              {COINS.map((c, i) => (
                <li key={c} style={{ animationDelay: `${i * 0.45}s` }}>
                  {c}
                </li>
              ))}
            </ul>
            <span className="lp-arrow" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <div className="lp-usdc">
              <b>USDC</b>
              <span>{t.coinHeld}</span>
            </div>
          </div>
        </section>
      </Band>

      {/* 8 FEES: a giant 3% and a paper receipt */}
      <Band tone="light">
        <section className="lp-fees" aria-labelledby="lp-fees">
          <div className="lp-fees-text">
            <Bitmap rows={PCT} className="lp-pct" />
            <h2 id="lp-fees">{t.feeTitle}</h2>
            <p className="lp-lead">{t.feeText}</p>
            <p className="lp-fees-client">{t.feeClient}</p>
          </div>
          <figure className="lp-receipt">
            <figcaption>{t.feeReceipt}</figcaption>
            <dl>
              {t.feeRows.map((row, i) => (
                <div key={row} className={i === 2 ? 'total' : ''}>
                  <dt>{row}</dt>
                  <dd>{fees[i]}</dd>
                </div>
              ))}
            </dl>
          </figure>
        </section>
      </Band>

      {/* 9 PRIVACY: a browser window holding the key, two short paragraphs */}
      <Band tone="dark">
        <section className="lp-priv" aria-labelledby="lp-priv">
          <Bitmap rows={BROWSER_KEY} className="lp-priv-art" />
          <div>
            <h2 id="lp-priv">{t.privTitle}</h2>
            <p className="lp-lead">{t.privText}</p>
            <p className="lp-priv-public">{t.privPublic}</p>
          </div>
        </section>
      </Band>

      {/* 10 FAQ: sticky title with a pixel question mark, an accordion */}
      <Band tone="light">
        <section className="lp-faq" aria-labelledby="lp-faq">
          <div className="lp-faq-side">
            <Bitmap rows={QMARK} className="lp-q" />
            <h2 id="lp-faq">{t.faqTitle}</h2>
          </div>
          <Faq q={t.faqQ} a={t.faqA} />
        </section>
      </Band>

      {/* 11 END: the promise again, the one action */}
      <Band tone="dark">
        <section className="lp-end" aria-labelledby="lp-end">
          <Bitmap rows={PINKIES} className="lp-pinkies lp-pinkies-end" />
          <h2 id="lp-end">{t.endTitle}</h2>
          <p className="lp-lead">{t.endText}</p>
          <Actions />
          <p className="lp-client-note">{t.clientNote}</p>
        </section>
      </Band>
    </main>
  );
}
