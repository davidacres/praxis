/**
 * Surface patterns — the figurative half of the material layer.
 *
 * A pattern is *data*, not CSS: each entry knows its seamless tile geometry and
 * how to draw one tile at an arbitrary ink colour and line weight. A surface
 * pack references one by id; the user can override that choice, its placement
 * and all of its material properties from Settings. `applySurfacePack` resolves
 * the result into the `--surface-watermark-*` custom properties that every pane
 * and the startup splash paint.
 *
 * Adding a new material therefore means adding one entry here — never a new
 * `[data-surface]` stylesheet block, and never a change to the panes.
 *
 * Two placements:
 *   tile   — the lattice repeats across every pane (a material).
 *   corner — one large motif anchored to a window corner, fading away
 *            diagonally (a brand watermark). Painted with
 *            `background-attachment: fixed` so a single motif spans all panes
 *            continuously instead of restarting at each pane boundary.
 */

export type SurfacePatternInk = 'accent' | 'text' | 'custom';
export type SurfacePatternPlacement = 'tile' | 'corner';
export type SurfacePatternAnchor = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export interface SurfacePatternDefinition {
  id: string;
  name: string;
  /** One seamless tile, in abstract units; only the ratio matters. */
  tile: { width: number; height: number };
  /** Default stroke weight, relative to a tile one unit wide. */
  weight: number;
  /** Inner SVG markup for exactly one tile, drawn in a `width × height` box. */
  body(ink: string, weight: number, width: number, height: number, fill?: number): string;
  /**
   * How many base tiles the repeat spans. Scattering solid cells needs a
   * super-tile, otherwise every repeat would fill the *same* cell and read as a
   * grid rather than a scatter. Omitted means a plain 1×1 repeat.
   */
  grid?(fill: number): { cols: number; rows: number };
  /**
   * Whether the pattern's `body` reads `fill` at all. The Solid-cells dial is
   * live only for these, so it never offers a control that does nothing — and
   * the panel does not have to hard-code a list of ids.
   */
  fillable?: boolean;
  /**
   * A bounded emblem rather than a lattice: in `corner` placement it is drawn
   * ONCE filling the spread box instead of repeated through an SVG `<pattern>`.
   * A fractal boundary cannot tile seamlessly, so the Mandelbrot is one mark.
   */
  singular?: boolean;
  /**
   * The same geometry as `body`, split into the order it should be built in.
   * A reveal animation staggers these so the mark assembles part by part; every
   * other path joins them, so a pattern without `parts` behaves exactly as
   * before. Only patterns that define it are offered `plot` and `iterate`.
   */
  parts?(ink: string, weight: number, width: number, height: number, fill?: number): string[];
  /**
   * A single path the `plot` head rides, in the same coordinates as `body`.
   * Patterns without a route do not offer `plot` — there is no one line to walk.
   */
  route?(width: number, height: number): string;
}

/**
 * How a motif moves. Mirrors `SurfaceMotifAnimation` in core (which is the
 * validation authority); duplicated here because core cannot be bundled into
 * the renderer. Two families: `draw` / `plot` / `iterate` are *reveal* styles
 * baked into the motif's own SVG because they need its geometry; the rest act
 * on the painted layer. `cyberpunk` uses both.
 */
export type SurfaceMotifAnimation =
  | 'none' | 'draw' | 'plot' | 'iterate'
  | 'shimmer' | 'glow' | 'drift' | 'ripple' | 'neon' | 'cyberpunk';

export const SURFACE_MOTIF_ANIMATIONS: ReadonlyArray<{ id: SurfaceMotifAnimation; name: string }> = [
  { id: 'none', name: 'None — still' },
  { id: 'draw', name: 'Draw — the mark draws itself' },
  { id: 'plot', name: 'Plot — draws behind a moving head' },
  { id: 'iterate', name: 'Iterate — assembles part by part' },
  { id: 'shimmer', name: 'Shimmer — a shine sweeps across' },
  { id: 'glow', name: 'Glow — the ink breathes' },
  { id: 'drift', name: 'Drift — a slow ambient pan' },
  { id: 'ripple', name: 'Ripple — a wave from the corner' },
  { id: 'neon', name: 'Neon — a failing-sign flicker' },
  { id: 'cyberpunk', name: 'Cyberpunk — ghosts, scanlines, glitch' }
];

/** Reveal styles need the motif's geometry, so they are baked into its SVG. */
const REVEAL_STYLES: ReadonlySet<SurfaceMotifAnimation> = new Set(['draw', 'plot', 'iterate']);

/** Base run length at speed 1, in ms. Drift is deliberately near-imperceptible. */
const BASE_DURATION_MS: Record<SurfaceMotifAnimation, number> = {
  none: 0, draw: 3600, plot: 4200, iterate: 5600, shimmer: 5200,
  glow: 4600, drift: 90000, ripple: 7000, neon: 3400, cyberpunk: 6000
};

/** Reveal styles: the share of the run spent staggering parts rather than drawing one. */
const STAGGER_SHARE: Record<string, number> = { draw: 0.45, plot: 0.4, iterate: 0.8 };

/**
 * Masking styles can only ever subtract, so their resting mask sits below full
 * alpha and the bright band reaches it. These put the average back where the
 * declared strength asked for — as a *computed* multiplier, deliberately not by
 * raising `--surface-watermark-opacity`, which the contrast guard polices.
 */
const MASK_COMPENSATION: Record<string, number> = { shimmer: 1.15, ripple: 1.18, cyberpunk: 1.2 };

export function isRevealAnimation(style: SurfaceMotifAnimation | undefined): boolean {
  return style !== undefined && REVEAL_STYLES.has(style);
}

/** Wraps SVG markup as a CSS-safe `data:` URI (no base64 — keeps it inspectable). */
function svg(width: number, height: number, defs: string, body: string): string {
  const markup =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">${defs}${body}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(markup)}`;
}

/** √3 : 3 is the aspect of a seamless pointy-top hexagon tile. */
const HEX_RATIO = 3 / Math.sqrt(3);

/* ── Mandelbrot ────────────────────────────────────────────────────────────
   The set's silhouette as real geometry rather than an escape-time raster. The
   main cardioid is exact — c(θ) = e^{iθ}/2 − e^{2iθ}/4 — and every bulb is a
   true circle attached at its rotation number p/q with the classical radius
   sin(πp/q)/q². Drawing it this way is what lets it follow the theme ink, the
   line weight and the letterpress edge like every other entry in the library,
   and what lets a reveal animation draw it: a bitmap could do none of that.

   Pleasingly, the formula needs no special case for the big period-2 disc —
   p/q = 1/2 falls out of it as the exact circle of radius 1/4 at c = −1.
   ───────────────────────────────────────────────────────────────────────── */

/** The plane window the mark is drawn in: the whole set, plus a little air. */
const MANDELBROT_VIEW = { x0: -2.12, x1: 0.42, y0: -0.98, y1: 0.98 };
/** Cubic segments approximating the cardioid. The cusp falls out for free: c'(0) = 0. */
const CARDIOID_SEGMENTS = 24;

function cardioidPoint(t: number): [number, number] {
  return [Math.cos(t) / 2 - Math.cos(2 * t) / 4, Math.sin(t) / 2 - Math.sin(2 * t) / 4];
}
function cardioidTangent(t: number): [number, number] {
  return [-Math.sin(t) / 2 + Math.sin(2 * t) / 2, Math.cos(t) / 2 - Math.cos(2 * t) / 2];
}
function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * The Mandelbrot silhouette, split into the order it should be built in:
 * cardioid first, then the bulbs by period, then the period-2 disc's own
 * decorations, then the antenna and its period-3 island. `iterate` reveals
 * these in exactly this order, so the mark assembles as if computing itself.
 */
function mandelbrotParts(ink: string, weight: number, w: number, h: number, fill: number): string[] {
  const { x0, x1, y0, y1 } = MANDELBROT_VIEW;
  const planeW = x1 - x0;
  const planeH = y1 - y0;
  const s = Math.min(w / planeW, h / planeH);
  // Centre the mark in the box, whichever axis it is letterboxed on.
  const ox = (w - planeW * s) / 2 - x0 * s;
  const oy = (h - planeH * s) / 2 + y1 * s;
  const n = (value: number) => Math.round(value * 100) / 100;
  const px = (re: number) => n(ox + re * s);
  const py = (im: number) => n(oy - im * s);
  // A singular emblem is drawn at the spread size, so its stroke scales with
  // the plane unit rather than the box — one weight then reads the same whether
  // the mark is a 62px tile or a 900px corner watermark.
  const sw = Math.max(0.4, weight * s);
  const solid = fill > 0 ? ` fill="${ink}" fill-opacity="${Math.min(0.5, fill * 0.5)}"` : ' fill="none"';
  const stroke = `stroke="${ink}" stroke-width="${n(sw)}" stroke-linecap="round" stroke-linejoin="round"`;

  // ── the main cardioid, as Hermite-derived cubics ──
  let d = '';
  for (let i = 0; i <= CARDIOID_SEGMENTS; i += 1) {
    const t = (i / CARDIOID_SEGMENTS) * Math.PI * 2;
    const [re, im] = cardioidPoint(t);
    if (i === 0) {
      d = `M${px(re)} ${py(im)}`;
      continue;
    }
    const prev = ((i - 1) / CARDIOID_SEGMENTS) * Math.PI * 2;
    const [pre, pim] = cardioidPoint(prev);
    const [dx0, dy0] = cardioidTangent(prev);
    const [dx1, dy1] = cardioidTangent(t);
    const step = (Math.PI * 2) / CARDIOID_SEGMENTS / 3;
    d += `C${px(pre + dx0 * step)} ${py(pim + dy0 * step)} ` +
      `${px(re - dx1 * step)} ${py(im - dy1 * step)} ${px(re)} ${py(im)}`;
  }
  const parts: string[] = [`<path d="${d}Z"${solid} ${stroke}/>`];

  // ── bulbs on the cardioid, grouped by period so they reveal in order ──
  const disc = (cx: number, cy: number, r: number) =>
    `<circle cx="${px(cx)}" cy="${py(cy)}" r="${n(r * s)}"${solid} ${stroke}/>`;
  for (let q = 2; q <= 6; q += 1) {
    let group = '';
    for (let bp = 1; bp < q; bp += 1) {
      if (gcd(bp, q) !== 1) continue;
      const t = (2 * Math.PI * bp) / q;
      const [re, im] = cardioidPoint(t);
      const [tx, ty] = cardioidTangent(t);
      const len = Math.hypot(tx, ty) || 1;
      // Outward normal: the tangent turned −90°, which points away from the body.
      const r = Math.sin((Math.PI * bp) / q) / (q * q);
      group += disc(re + (ty / len) * r, im + (-tx / len) * r, r);
    }
    if (group) parts.push(group);
  }

  // ── the period-2 disc's own decorations, measured from where it attaches ──
  const P2 = { cx: -1, cy: 0, r: 0.25 };
  let secondary = '';
  for (let q = 2; q <= 4; q += 1) {
    for (let bp = 1; bp < q; bp += 1) {
      if (gcd(bp, q) !== 1) continue;
      const angle = (2 * Math.PI * bp) / q;
      const r = (P2.r * Math.sin((Math.PI * bp) / q)) / (q * q);
      secondary += disc(P2.cx + Math.cos(angle) * (P2.r + r), P2.cy + Math.sin(angle) * (P2.r + r), r);
    }
  }
  parts.push(secondary);

  // ── the antenna out to the tip at c = −2, and the period-3 island on it ──
  parts.push(
    `<path d="M${px(-1.4)} ${py(0)}H${px(-2)}" fill="none" ${stroke}/>` +
    disc(-1.7549, 0, 0.032)
  );
  return parts;
}

const PATTERNS: SurfacePatternDefinition[] = [
  {
    id: 'none',
    name: 'None',
    tile: { width: 1, height: 1 },
    weight: 0,
    body: () => ''
  },
  {
    /**
     * Honeycomb lattice — the Praxis signature. One pointy-top hexagon plus the
     * stem joining the offset row below it. Strokes straddling a tile edge are
     * completed by the neighbouring tile, so it repeats seamlessly both ways.
     */
    id: 'hexagon',
    name: 'Hexagon',
    fillable: true,
    tile: { width: 1, height: HEX_RATIO },
    weight: 0.055,
    /** A 3×2 super-tile once cells are filled, so the scatter never lines up. */
    grid: fill => (fill > 0 ? { cols: 3, rows: 2 } : { cols: 1, rows: 1 }),
    body: (ink, weight, w, h, fill = 0) => {
      const cols = fill > 0 ? 3 : 1;
      const rows = fill > 0 ? 2 : 1;
      const unit = w / cols;
      const cellH = h / rows;
      const r = cellH / 3;
      // One base tile: a hexagon plus the stem down to the offset row below it.
      const outline = (dx: number, dy: number) =>
        `M${dx + unit / 2} ${dy}L${dx + unit} ${dy + r / 2}L${dx + unit} ${dy + r * 1.5}` +
        `L${dx + unit / 2} ${dy + r * 2}L${dx} ${dy + r * 1.5}L${dx} ${dy + r / 2}Z` +
        `M${dx + unit / 2} ${dy + r * 2}L${dx + unit / 2} ${dy + cellH}`;
      const hexPath = (dx: number, dy: number) =>
        `M${dx + unit / 2} ${dy}L${dx + unit} ${dy + r / 2}L${dx + unit} ${dy + r * 1.5}` +
        `L${dx + unit / 2} ${dy + r * 2}L${dx} ${dy + r * 1.5}L${dx} ${dy + r / 2}Z`;

      let strokes = '';
      for (let i = 0; i < cols; i += 1) {
        for (let j = 0; j < rows; j += 1) {
          strokes += outline(i * unit, j * cellH);
        }
      }
      let solids = '';
      if (fill > 0) {
        // Fixed order chosen so low densities still look scattered, not clustered.
        const order: Array<[number, number]> = [[1, 0], [0, 1], [2, 1], [0, 0], [2, 0], [1, 1]];
        const count = Math.max(1, Math.min(order.length, Math.round(fill * order.length)));
        solids = order.slice(0, count)
          .map(([i, j]) => `<path d="${hexPath(i * unit, j * cellH)}" fill="${ink}" fill-opacity="0.5"/>`)
          .join('');
      }
      return solids +
        `<path d="${strokes}" fill="none" stroke="${ink}" stroke-width="${weight * unit}" stroke-linejoin="round"/>`;
    }
  },
  {
    id: 'dot-grid',
    name: 'Dot grid',
    tile: { width: 1, height: 1 },
    weight: 0.08,
    body: (ink, weight, w, h) =>
      `<circle cx="${w / 2}" cy="${h / 2}" r="${Math.max(0.4, weight * w)}" fill="${ink}"/>`
  },
  {
    /** Drafting grid with the classic major/minor rule: three light subdivisions per cell. */
    id: 'grid',
    name: 'Grid',
    tile: { width: 1, height: 1 },
    weight: 0.042,
    body: (ink, weight, w, h) => {
      const minor = [0.25, 0.5, 0.75]
        .map(f => `M0 ${h * f}H${w}M${w * f} 0V${h}`)
        .join('');
      return `<path d="${minor}" fill="none" stroke="${ink}" stroke-width="${weight * w * 0.55}" stroke-opacity="0.4"/>` +
        `<path d="M0 0H${w}M0 0V${h}" fill="none" stroke="${ink}" stroke-width="${weight * w}"/>`;
    }
  },
  {
    /** 45° crosshatch; both diagonals wrap cleanly across the tile corners. */
    id: 'diagonal',
    name: 'Diagonal',
    tile: { width: 1, height: 1 },
    weight: 0.06,
    body: (ink, weight, w, h) =>
      `<path d="M${-w / 4} ${h / 4}L${w / 4} ${-h / 4}M0 ${h}L${w} 0M${w * 0.75} ${h * 1.25}L${w * 1.25} ${h * 0.75}" ` +
      `fill="none" stroke="${ink}" stroke-width="${weight * w}"/>`
  },
  {
    /** Equilateral triangle lattice — denser, more technical than hexagon. */
    id: 'triangle',
    name: 'Triangle',
    tile: { width: 1, height: Math.sqrt(3) / 2 },
    weight: 0.05,
    body: (ink, weight, w, h) =>
      `<path d="M0 ${h}L${w / 2} 0L${w} ${h}M${-w / 2} ${h}L0 0M${w / 2} ${h}L${w} 0M0 ${h}H${w}M0 0H${w}" ` +
      `fill="none" stroke="${ink}" stroke-width="${weight * w}"/>`
  },
  {
    /** Basket weave — short offset dashes; reads as woven cloth at low opacity. */
    id: 'weave',
    name: 'Weave',
    tile: { width: 1, height: 1 },
    weight: 0.1,
    body: (ink, weight, w, h) =>
      `<path d="M0 ${h * 0.25}H${w / 2}M${w / 2} ${h * 0.75}H${w}M${w * 0.75} 0V${h / 2}M${w * 0.25} ${h / 2}V${h}" ` +
      `fill="none" stroke="${ink}" stroke-width="${weight * w}" stroke-linecap="round"/>`
  },
  {
    /**
     * The Mandelbrot set as line art — a brand-scale emblem rather than a
     * lattice, so it is `singular`: one mark filling the corner spread instead
     * of a repeat. Its `parts` are ordered by period, which is what gives the
     * reveal animations something meaningful to build.
     */
    id: 'mandelbrot',
    name: 'Mandelbrot',
    fillable: true,
    /** Follows the plane window's aspect (2.54 × 1.96) so the mark fills its box. */
    tile: { width: 1, height: 0.772 },
    weight: 0.012,
    singular: true,
    parts: (ink, weight, w, h, fill = 0) => mandelbrotParts(ink, weight, w, h, fill),
    body: (ink, weight, w, h, fill = 0) => mandelbrotParts(ink, weight, w, h, fill).join(''),
    /** The plot head rides the cardioid — the one continuous line in the mark. */
    route: (w, h) => {
      const markup = mandelbrotParts('#000', 0.012, w, h, 0)[0];
      return /d="([^"]+)"/.exec(markup)?.[1] ?? '';
    }
  },
  {
    /** Concentric arcs — soft topographic contours for organic materials. */
    id: 'topo',
    name: 'Topographic',
    tile: { width: 1, height: 1 },
    weight: 0.025,
    body: (ink, weight, w, h) => {
      const sw = weight * w;
      const rings = [0.125, 0.27, 0.42]
        .map(f => `<circle cx="${w / 2}" cy="${h / 2}" r="${w * f}"/>`)
        .join('');
      const corners = [[0, 0], [w, 0], [0, h], [w, h]]
        .map(([cx, cy]) => `<circle cx="${cx}" cy="${cy}" r="${w * 0.19}"/>`)
        .join('');
      return `<g fill="none" stroke="${ink}" stroke-width="${sw}">${rings}${corners}</g>`;
    }
  }
];

export const SURFACE_PATTERNS: SurfacePatternDefinition[] = PATTERNS;
export const SURFACE_PATTERN_IDS: string[] = PATTERNS.map(pattern => pattern.id);

export function findSurfacePattern(id: string | undefined): SurfacePatternDefinition | undefined {
  return id ? PATTERNS.find(pattern => pattern.id === id) : undefined;
}

/** What a pack — or the user's Motif override — stores to select and tune a pattern. */
export interface SurfacePatternSpec {
  id: string;
  /** Tile width in CSS pixels. Identical meaning in both placements. */
  scale: number;
  /** 0..1 strength of the watermark layer, before the user's Intensity dial. */
  opacity: number;
  /** Which live theme token tints it, or `custom` to use `inkColor`. */
  ink?: SurfacePatternInk;
  /** Explicit colour used when `ink` is `custom`. */
  inkColor?: string;
  /** Stroke weight, relative to a tile one unit wide. */
  weight?: number;
  /** Blend mode; `normal` stays predictable on any ground. */
  blend?: string;
  /** `tile` repeats everywhere; `corner` is one anchored, fading motif. */
  placement?: SurfacePatternPlacement;
  /** Which window corner a `corner` motif grows from. Legacy single-corner form. */
  anchor?: SurfacePatternAnchor;
  /**
   * Corners a `corner` motif is mirrored into — one to four, each its own faded
   * layer. Supersedes `anchor` when present and non-empty.
   */
  anchors?: SurfacePatternAnchor[];
  /** How far a `corner` motif spreads, in CSS pixels. */
  spread?: number;
  /** 0..1 — how far across the spread the motif fades to nothing. */
  fade?: number;
  /**
   * 0..1 density of *solid* cells scattered through the lattice. Turns a plain
   * mesh into a designed motif. Patterns without a `grid` ignore it.
   */
  fill?: number;
  /**
   * 0..1 strength of a second line drawn slightly offset *behind* the main one,
   * in a contrasting tone — the letterpress / engraved edge. Off by default;
   * applied generically, so every pattern in the library supports it.
   */
  outline?: number;
  /** Colour of that offset line. Callers pass the mode-appropriate default. */
  outlineInk?: string;
  /**
   * How the motif moves. Orthogonal to which pattern it is, so any style rides
   * over any pattern. Flat rather than nested: a pack's pattern and the user's
   * override are merged by shallow spread, and a nested object would replace
   * wholesale instead of letting one field be overridden on its own.
   */
  animation?: SurfaceMotifAnimation;
  /** Multiplier on the style's base duration. Higher is faster. */
  animationSpeed?: number;
  /** Reveal styles only: loop, or draw once and rest complete (the default). */
  animationRepeat?: boolean;
}

export const DEFAULT_MOTIF_SPREAD = 720;
export const DEFAULT_MOTIF_FADE = 0.62;

/* ── Perceptual normalisation ──────────────────────────────────────────────
   A motif drawn at a fixed opacity does NOT read at a fixed strength: how much
   it stands out depends on how far its ink sits from the panel it is drawn on.
   Measured across the shipped palettes, the same 30% ranged from barely-there
   on Praxis Dark (terracotta on near-black) to nearly three times that on
   Catppuccin Mocha (light lilac on near-black). The declared strength is
   therefore treated as "as strong as it looks on the reference pairing", and
   scaled by how far this theme's ink/ground pair departs from it.

   The metric is ΔL* (CIE lightness), not the WCAG contrast ratio: for a
   translucent overlay the visible change is proportional to the lightness
   difference, and L* is far closer to perceptually uniform than raw luminance.
   ───────────────────────────────────────────────────────────────────────── */

/** ΔL* of the pairing every pack's opacity was tuned against: Praxis Dark's accent on its panel. */
const REFERENCE_DELTA_LSTAR = 31.5;
/** Never let the correction erase a motif, nor amplify a low-contrast one into noise. */
const SCALE_BOUNDS: [number, number] = [0.4, 1.6];

/** Parses `#rgb`, `#rrggbb`, `rgb()` and `rgba()`. Anything else returns undefined. */
function parseCssColor(value: string): [number, number, number] | undefined {
  const input = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input);
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].split('').map(c => c + c).join('') : hex[1];
    return [
      parseInt(digits.slice(0, 2), 16),
      parseInt(digits.slice(2, 4), 16),
      parseInt(digits.slice(4, 6), 16)
    ];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(input);
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map(Number);
    if (parts.length === 3 && parts.every(Number.isFinite)) {
      return [parts[0], parts[1], parts[2]];
    }
  }
  return undefined;
}

function lstarOf(rgb: [number, number, number]): number {
  const linear = rgb.map(channel => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const y = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  const f = y > 0.008856 ? Math.cbrt(y) : 7.787 * y + 16 / 116;
  return 116 * f - 16;
}

/**
 * How much to scale a declared opacity so the motif reads at the same strength
 * over `ground` as it does on the reference pairing. Returns 1 when either
 * colour cannot be parsed, so an exotic value degrades to "no correction".
 */
export function perceptualOpacityScale(ink: string, ground: string): number {
  const inkRgb = parseCssColor(ink);
  const groundRgb = parseCssColor(ground);
  if (!inkRgb || !groundRgb) {
    return 1;
  }
  const delta = Math.abs(lstarOf(inkRgb) - lstarOf(groundRgb));
  if (delta < 1) {
    return SCALE_BOUNDS[1];
  }
  const scale = REFERENCE_DELTA_LSTAR / delta;
  return Math.min(SCALE_BOUNDS[1], Math.max(SCALE_BOUNDS[0], scale));
}

/** The gradient axis and CSS background-position for each anchor. */
const ANCHORS: Record<SurfacePatternAnchor, { grad: [number, number, number, number]; position: string }> = {
  'top-left': { grad: [0, 0, 1, 1], position: 'left top' },
  'top-right': { grad: [1, 0, 0, 1], position: 'right top' },
  'bottom-left': { grad: [0, 1, 1, 0], position: 'left bottom' },
  'bottom-right': { grad: [1, 1, 0, 0], position: 'right bottom' }
};

/** Everything `theme.css` needs to paint the watermark layer. */
export interface ResolvedSurfacePattern {
  image: string;
  size: string;
  opacity: string;
  blend: string;
  repeat: string;
  attachment: string;
  position: string;
  /** The style actually applied, for the `data-motif-anim` attribute. */
  animation: SurfaceMotifAnimation;
  /**
   * Literal CSS for the layer-family styles. Written as complete values rather
   * than composed in the stylesheet from nested `var()`s — see the
   * backdrop-filter note in surfaces.css for why this codebase distrusts that.
   */
  anim: string;
  filter: string;
  mask: string;
  maskSize: string;
  maskRepeat: string;
  maskPosition: string;
  /**
   * Multiplier folded into the layer's computed opacity, so a masking style can
   * put back the strength its resting mask takes away without touching
   * `--surface-watermark-opacity`, which the contrast guard polices.
   */
  flicker: string;
}

/** The inert layer values — what a still motif paints with. */
const STILL_LAYER = {
  animation: 'none' as SurfaceMotifAnimation,
  anim: 'none',
  filter: 'none',
  mask: 'none',
  maskSize: 'auto',
  maskRepeat: 'no-repeat',
  maskPosition: '0 0',
  flicker: '1'
};

/**
 * The layer-family styles: pure CSS over the painted watermark, so they work on
 * every pattern in the library without any pattern knowing about them. The
 * keyframes they name live in surfaces.css.
 */
function layerEffects(
  style: SurfaceMotifAnimation,
  durationMs: number,
  ink: string,
  anchorPosition: string
): typeof STILL_LAYER {
  const ms = Math.round(durationMs);
  switch (style) {
    case 'shimmer':
      return {
        ...STILL_LAYER,
        animation: style,
        // A mask can only ever subtract, so the resting alpha sits below 1 and
        // the travelling band reaches it; `flicker` puts the average back.
        mask: 'linear-gradient(115deg, rgba(0,0,0,.85) 34%, rgba(0,0,0,1) 47%, rgba(0,0,0,.85) 60%)',
        maskSize: '300% 300%',
        anim: `motif-shimmer ${ms}ms linear infinite`,
        flicker: String(MASK_COMPENSATION.shimmer)
      };
    case 'glow':
      return {
        ...STILL_LAYER,
        animation: style,
        filter: `drop-shadow(0 0 5px ${ink})`,
        anim: `motif-glow ${ms}ms ease-in-out infinite alternate`
      };
    case 'drift':
      return { ...STILL_LAYER, animation: style, anim: `motif-drift ${ms}ms linear infinite` };
    case 'ripple':
      return {
        ...STILL_LAYER,
        animation: style,
        mask: `radial-gradient(circle at ${anchorPosition}, rgba(0,0,0,.82) 0%, rgba(0,0,0,.82) 26%, ` +
          'rgba(0,0,0,1) 38%, rgba(0,0,0,.82) 52%, rgba(0,0,0,.82) 100%)',
        maskSize: '10% 10%',
        anim: `motif-ripple ${ms}ms ease-out infinite`,
        flicker: String(MASK_COMPENSATION.ripple)
      };
    case 'neon':
      return {
        ...STILL_LAYER,
        animation: style,
        filter: `drop-shadow(0 0 4px ${ink})`,
        anim: `motif-neon ${ms}ms steps(1, end) infinite`
      };
    case 'cyberpunk':
      return {
        ...STILL_LAYER,
        animation: style,
        mask: 'repeating-linear-gradient(0deg, rgba(0,0,0,1) 0 2px, rgba(0,0,0,.5) 2px 4px)',
        maskSize: '100% 100%',
        maskRepeat: 'repeat',
        filter: `drop-shadow(0 0 3px ${ink})`,
        anim: `motif-cyberpunk ${ms}ms steps(9, end) infinite`,
        flicker: String(MASK_COMPENSATION.cyberpunk)
      };
    default:
      // Reveal styles carry their motion inside the SVG; the layer stays inert.
      return { ...STILL_LAYER, animation: style };
  }
}

/** Every element the reveal animation can address, given a normalised length. */
const MEASURABLE = /<(path|circle|ellipse|line|polyline|rect)\s/g;

/**
 * The `<style>` the reveal styles bake into the motif's own SVG. It has to live
 * there because only the SVG knows the geometry — and it has to be *omitted*
 * rather than disabled when motion is unwanted, because a `prefers-reduced-motion`
 * query inside an SVG-as-image is not honoured by the renderer (verified).
 */
function revealStyle(
  style: SurfaceMotifAnimation,
  durationMs: number,
  repeat: boolean,
  partCount: number,
  route: string,
  ink: string,
  headRadius: number
): { css: string; head: string } {
  const count = repeat ? 'infinite' : '1';
  const easing = style === 'plot'
    ? 'linear'
    : style === 'iterate'
      ? 'cubic-bezier(.2,.9,.3,1)'
      : 'cubic-bezier(.45,.05,.35,1)';
  const share = partCount > 1 ? (STAGGER_SHARE[style] ?? 0.45) : 0;
  const partMs = Math.round(durationMs * (1 - share));
  const stagger = partCount > 1
    ? Array.from({ length: partCount }, (_, i) =>
        `.mp${i}>*{animation-delay:${Math.round((durationMs * share * i) / (partCount - 1))}ms}`).join('')
    : '';
  // `mkf` has no `to`: the element's own fill-opacity is the destination, so a
  // stroked-only shape is untouched while a filled one washes in as it draws.
  const css =
    `<style>.mp>*{stroke-dasharray:1000;stroke-dashoffset:1000;` +
    `animation:mkd ${partMs}ms ${easing} ${count} both,mkf ${partMs}ms ${easing} ${count} both}` +
    `@keyframes mkd{to{stroke-dashoffset:0}}@keyframes mkf{from{fill-opacity:0}}` +
    stagger +
    (style === 'plot' && route
      ? `.mkh{offset-path:path('${route}');offset-distance:0%;` +
        `animation:mkh ${Math.round(durationMs)}ms linear ${count} both}` +
        '@keyframes mkh{to{offset-distance:100%}}'
      : '') +
    '</style>';
  const head = style === 'plot' && route
    ? `<circle class="mkh" r="${Math.round(headRadius * 100) / 100}" fill="${ink}"/>`
    : '';
  return { css, head };
}

/**
 * Resolves a spec + a concrete ink colour into the watermark properties.
 * Returns `undefined` when the spec selects no pattern, so callers clear the
 * layer rather than painting an empty image.
 */
export function resolveSurfacePattern(
  spec: SurfacePatternSpec | undefined,
  ink: string
): ResolvedSurfacePattern | undefined {
  const pattern = findSurfacePattern(spec?.id);
  if (!spec || !pattern || pattern.id === 'none' || spec.opacity <= 0) {
    return undefined;
  }
  // `scale` is always the size of ONE cell; a super-tile (used to scatter solid
  // cells) multiplies the repeat without changing how big a hexagon looks.
  const fill = Math.min(1, Math.max(0, spec.fill ?? 0));
  const grid = pattern.grid?.(fill) ?? { cols: 1, rows: 1 };
  const unit = Math.max(6, spec.scale);
  const tileWidth = unit * grid.cols;
  const tileHeight = Math.round((unit * pattern.tile.height) / pattern.tile.width * grid.rows * 100) / 100;
  const weight = spec.weight ?? pattern.weight;
  const common = {
    opacity: String(Math.min(1, Math.max(0, spec.opacity))),
    blend: spec.blend ?? 'normal'
  };

  /**
   * The optional letterpress edge: the same geometry drawn once more in a
   * contrasting tone, nudged down-right and painted *behind* the main line.
   * Doing it here rather than per-pattern means every entry in the library
   * gets the effect for free. The offset content that leaves the tile is
   * supplied by the neighbouring tile, so the repeat stays seamless.
   */
  const outline = Math.min(1, Math.max(0, spec.outline ?? 0));

  // The motion, resolved once. `none` keeps every value below inert, so a still
  // motif is byte-identical to what this function produced before animation
  // existed. The caller is responsible for having already forced `none` when
  // the master gate or the OS reduced-motion preference says so.
  const style: SurfaceMotifAnimation = spec.animation ?? 'none';
  const speed = Math.min(4, Math.max(0.25, spec.animationSpeed ?? 1));
  const duration = BASE_DURATION_MS[style] / speed;
  const reveal = REVEAL_STYLES.has(style);

  /**
   * The geometry, in the order it should be built. The optional letterpress
   * edge and the cyberpunk chromatic ghosts are both the same trick — the body
   * drawn again in another tone and nudged — applied here rather than in each
   * pattern, so every entry in the library gets them for free. The offset
   * content that leaves a tile is supplied by the neighbouring tile, so the
   * repeat stays seamless.
   */
  const drawParts = (boxW: number, boxH: number, inkUnit: number): string[] => {
    const geometry = (colour: string): string[] => pattern.parts
      ? pattern.parts(colour, weight, boxW, boxH, fill)
      : [pattern.body(colour, weight, boxW, boxH, fill)];
    const main = geometry(ink);
    const offset = Math.max(0.6, weight * inkUnit * 0.85);
    const behind: string[][] = [];
    if (style === 'cyberpunk') {
      // Chromatic aberration: the same mark split into its colour channels and
      // pulled apart, which is what gives the style its bad-signal read.
      behind.push(geometry('#00e5ff').map(part =>
        `<g transform="translate(${-offset * 1.6} 0)" opacity="0.55">${part}</g>`));
      behind.push(geometry('#ff2d95').map(part =>
        `<g transform="translate(${offset * 1.6} 0)" opacity="0.55">${part}</g>`));
    }
    if (outline > 0) {
      behind.push(geometry(spec.outlineInk ?? '#ffffff').map(part =>
        `<g transform="translate(${offset} ${offset})" opacity="${outline}">${part}</g>`));
    }
    // Pair each ghost with the part it shadows, so a staggered reveal brings a
    // part and its edge in together rather than the whole edge up front.
    return main.map((part, i) => behind.map(layer => layer[i] ?? '').join('') + part);
  };

  const anchorPosition = (spec.placement ?? 'tile') === 'corner'
    ? (ANCHORS[(spec.anchors?.[0] ?? spec.anchor ?? 'top-right')]?.position ?? 'right top')
    : 'center';
  const layer = layerEffects(style, duration, ink, anchorPosition);

  /**
   * The finished markup for one tile — or, for a singular pattern, the whole
   * mark. Returns the `<defs>`-slot content separately because a reveal style's
   * `<style>` block has to precede the geometry it animates.
   */
  const compose = (boxW: number, boxH: number, inkUnit: number): { defs: string; body: string } => {
    let parts = drawParts(boxW, boxH, inkUnit);
    if (!reveal) {
      return { defs: '', body: parts.join('') };
    }
    // `pathLength` normalises every shape to the same nominal length, so one
    // dasharray reveals any of them exactly — no per-pattern length maths, and
    // no dependence on a shape's real perimeter.
    parts = parts.map(part => part.replace(MEASURABLE, (_m, tag) => `<${tag} pathLength="1000" `));
    const route = pattern.route?.(boxW, boxH) ?? '';
    const { css, head } = revealStyle(
      style, duration, spec.animationRepeat ?? false, parts.length, route, ink, Math.max(1.5, weight * inkUnit * 1.8)
    );
    const groups = parts.map((part, i) => `<g class="mp mp${i}">${part}</g>`).join('');
    return { defs: css, body: groups + head };
  };

  if ((spec.placement ?? 'tile') === 'tile') {
    const tile = compose(tileWidth, tileHeight, unit);
    return {
      ...common,
      ...layer,
      image: `url("${svg(tileWidth, tileHeight, tile.defs, tile.body)}")`,
      size: `${tileWidth}px ${tileHeight}px`,
      repeat: 'repeat',
      attachment: 'scroll',
      position: 'center'
    };
  }

  // Corner: one motif per selected corner, each `spread` px square, the tile
  // repeated inside it through an SVG <pattern> and masked by a gradient running
  // away from that corner. Painted fixed so every pane samples the same
  // viewport-anchored image; the layers are comma-joined so one to four corners
  // compose as a single multi-layer background.
  const spread = Math.max(120, spec.spread ?? DEFAULT_MOTIF_SPREAD);
  const fade = Math.min(1, Math.max(0.05, spec.fade ?? DEFAULT_MOTIF_FADE));
  const requested = spec.anchors && spec.anchors.length ? spec.anchors : [spec.anchor ?? 'top-right'];
  const corners = requested
    .filter((name): name is SurfacePatternAnchor => name in ANCHORS)
    .filter((name, index, list) => list.indexOf(name) === index)
    .slice(0, 4);
  const chosen = corners.length ? corners : (['top-right'] as SurfacePatternAnchor[]);
  // A singular pattern is an emblem, not a lattice: it is drawn ONCE filling the
  // spread box. A fractal boundary has no seamless repeat, and tiling one would
  // read as wallpaper rather than as a mark.
  const singular = pattern.singular === true;
  const markW = singular ? spread : tileWidth;
  const markH = singular ? Math.round((spread * pattern.tile.height) / pattern.tile.width) : tileHeight;
  // A singular mark is drawn at the spread box, so the letterpress / ghost
  // offsets have to scale with the box rather than with a notional cell.
  const mark = compose(markW, markH, singular ? markW / 3 : unit);

  const layers = chosen.map(name => {
    const anchor = ANCHORS[name];
    const [x1, y1, x2, y2] = anchor.grad;
    const defs =
      `<defs>` +
      `<linearGradient id="sf" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">` +
      `<stop offset="0" stop-color="#fff" stop-opacity="1"/>` +
      `<stop offset="${fade}" stop-color="#fff" stop-opacity="0"/>` +
      `</linearGradient>` +
      `<mask id="sm"><rect width="${spread}" height="${spread}" fill="url(#sf)"/></mask>` +
      (singular
        ? ''
        : `<pattern id="sp" width="${tileWidth}" height="${tileHeight}" patternUnits="userSpaceOnUse">` +
          mark.body +
          `</pattern>`) +
      `</defs>` +
      mark.defs;
    // The emblem is centred in the square and anchored by the layer's own
    // background-position, so it fades along the same diagonal as a lattice does.
    const inner = singular
      ? `<g mask="url(#sm)" transform="translate(0 ${Math.round((spread - markH) / 2)})">${mark.body}</g>`
      : `<rect width="${spread}" height="${spread}" fill="url(#sp)" mask="url(#sm)"/>`;
    return { image: `url("${svg(spread, spread, defs, inner)}")`, position: anchor.position };
  });
  return {
    ...common,
    ...layer,
    image: layers.map(entry => entry.image).join(', '),
    size: chosen.map(() => `${spread}px ${spread}px`).join(', '),
    repeat: chosen.map(() => 'no-repeat').join(', '),
    attachment: chosen.map(() => 'fixed').join(', '),
    position: layers.map(entry => entry.position).join(', ')
  };
}
