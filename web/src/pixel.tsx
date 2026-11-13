// The shared pixel kit: pictures drawn as squares, the faint
// background squares with parallax, and the faint lines around the mouse. The
// home page (Landing.tsx) uses all of it inside its bands; every other page
// gets the squares and the lines from <PixelBackground /> (Shell).
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

// ---------------------------------------------------------------- pixel kit

/**
 * A bitmap as SVG squares. '#' = ink, '*' = accent, '-' = faint ink,
 * '+' = accent that blinks now and then. Anything else is empty.
 */
export function Bitmap({ rows, className, label, style }: { rows: string[]; className?: string; label?: string; style?: CSSProperties }) {
  const w = Math.max(...rows.map((r) => r.length));
  const cells: ReactNode[] = [];
  const cls: Record<string, string> = { '#': 'px-on', '*': 'px-acc', '-': 'px-dim', '+': 'px-acc px-spark' };
  rows.forEach((r, y) =>
    [...r].forEach((ch, x) => {
      if (!cls[ch]) return;
      cells.push(
        <rect
          key={`${x}-${y}`}
          x={x}
          y={y}
          width="1"
          height="1"
          className={cls[ch]}
          style={ch === '+' ? { animationDelay: `${((x * 7 + y * 13) % 11) * 310}ms` } : undefined}
        />,
      );
    }),
  );
  return (
    <svg
      className={`bitmap ${className ?? ''}`}
      style={style}
      viewBox={`0 0 ${w} ${rows.length}`}
      shapeRendering="crispEdges"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {cells}
    </svg>
  );
}

// ---------------------------------------------------------------- background squares (v2, 11-12)
// Random and EVEN, no visible repeat. A jittered grid: the
// plane is cut into blocks and each block gets exactly one square at a random
// cell, so the spread is even but has no pattern. The tile is 1680 px, wider
// than a laptop screen, so a repeat is not visible.

type Pt = { x: number; y: number }; // a square's top-left corner inside the tile
export const CELL = 14;
export const TILE = 1680; // a multiple of 6 × 14 and 10 × 14
function jittered(seed: number, block: number): Pt[] {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const n = TILE / (block * CELL);
  const pts: Pt[] = [];
  for (let by = 0; by < n; by++)
    for (let bx = 0; bx < n; bx++) {
      // one cell of the block, never its last row or column, so two squares never touch
      const cx = Math.floor(rnd() * (block - 1));
      const cy = Math.floor(rnd() * (block - 1));
      pts.push({ x: (bx * block + cx) * CELL, y: (by * block + cy) * CELL });
    }
  return pts;
}
const tileUrl = (pts: Pt[]) =>
  `url("data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' width='${TILE}' height='${TILE}' fill='white'>${pts
      .map((p) => `<rect x='${p.x}' y='${p.y}' width='${CELL - 1}' height='${CELL - 1}'/>`)
      .join('')}</svg>`,
  )}")`;
// densities as before: 1 square per 6 × 6 cells (was 3%), 1 per 10 × 10 (was 1%);
// speeds 0.14 / 0.42 (more visible parallax; was 0.06 / 0.16)
export const LAYERS = [
  { speed: 0.14, pts: jittered(7, 6) },
  { speed: 0.42, pts: jittered(31, 10) },
].map((l) => ({ ...l, url: tileUrl(l.pts) }));
export const layerOffset = (speed: number, scrollY: number) => -((scrollY * speed) % TILE);

/**
 * Faint lines between nearby background squares around the
 * mouse. One fixed canvas inside the squares layer (so it gets the same
 * "difference" blend: lighter on black, darker on white). Redrawn only on
 * pointer move, on scroll while visible, and during the short fade after the
 * pointer leaves. Desktop pointer only, off under reduced motion.
 */
export function cursorLines(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext('2d');
  const R = 180; // radius around the cursor
  const LINK = 112; // the longest line between two squares
  let mx = -1e4;
  let my = -1e4;
  let level = 0; // 0..1, fades in on move and out on leave
  let target = 0;
  let w = 0;
  let h = 0;
  let dpr = 1;
  let queued = false;
  const draw = () => {
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    level += (target - level) * 0.18;
    if (Math.abs(target - level) < 0.01) level = target;
    if (level > 0) {
      const near: { x: number; y: number; k: number }[] = [];
      const y0 = window.scrollY;
      const half = (CELL - 1) / 2;
      for (const l of LAYERS) {
        const oy = layerOffset(l.speed, y0);
        for (const p of l.pts) {
          for (let ty = p.y + oy + half; ty < h + TILE; ty += TILE) {
            if (Math.abs(ty - my) > R) continue;
            for (let tx = p.x + half; tx < w + TILE; tx += TILE) {
              const d = Math.hypot(tx - mx, ty - my);
              if (d < R) near.push({ x: tx, y: ty, k: 1 - d / R });
            }
          }
        }
      }
      ctx.lineWidth = 1;
      for (let i = 0; i < near.length; i++)
        for (let j = i + 1; j < near.length; j++) {
          const a = near[i];
          const b = near[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d > LINK) continue;
          const k = Math.sqrt(Math.min(a.k, b.k)) * (1 - d / LINK / 2) * level;
          ctx.strokeStyle = `rgba(255,255,255,${(0.11 * k).toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(Math.round(a.x) + 0.5, Math.round(a.y) + 0.5);
          ctx.lineTo(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5);
          ctx.stroke();
        }
    }
    canvas.dataset.level = level.toFixed(2);
    if (level !== target) schedule(); // still fading
  };
  function schedule() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      draw();
    });
  }
  const resize = () => {
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    schedule();
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    mx = e.clientX;
    my = e.clientY;
    target = 1;
    schedule();
  };
  const onLeave = () => {
    target = 0;
    schedule();
  };
  const onScroll = () => {
    if (level > 0) schedule();
  };
  resize();
  window.addEventListener('pointermove', onMove, { passive: true });
  document.documentElement.addEventListener('pointerleave', onLeave);
  window.addEventListener('blur', onLeave);
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', resize);
  return () => {
    window.removeEventListener('pointermove', onMove);
    document.documentElement.removeEventListener('pointerleave', onLeave);
    window.removeEventListener('blur', onLeave);
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', resize);
  };
}

// ---------------------------------------------------------------- the background of every other page

/**
 * The squares layer behind a page (not the home page, which has its own inside
 * its bands): two parallax layers + the lines around the mouse. Reduced motion:
 * still squares, no lines. Desktop pointer only for the lines.
 */
export function PixelBackground() {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const layers = [...el.querySelectorAll<HTMLElement>('[data-speed]')];
    const update = () => {
      const y = window.scrollY;
      for (const l of layers) l.style.transform = `translate3d(0, ${layerOffset(Number(l.dataset.speed), y)}px, 0)`;
    };
    let queued = false;
    const onScroll = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        update();
      });
    };
    update();
    if (!reduce) window.addEventListener('scroll', onScroll, { passive: true });
    const lines = el.querySelector('canvas');
    const stopLines = lines && !reduce && matchMedia('(hover: hover) and (pointer: fine)').matches ? cursorLines(lines) : null;
    return () => {
      window.removeEventListener('scroll', onScroll);
      stopLines?.();
    };
  }, []);
  return (
    <div ref={root} className="squares squares-site" aria-hidden="true">
      {LAYERS.map((l) => (
        <span key={l.speed} data-speed={l.speed} style={{ backgroundImage: l.url }} />
      ))}
      <canvas className="squares-lines" />
    </div>
  );
}

