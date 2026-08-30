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
  const drawBody = (): string => {
    const main = pattern.body(ink, weight, tileWidth, tileHeight, fill);
    if (outline <= 0) return main;
    const offset = Math.max(0.6, weight * unit * 0.85);
    const behind = pattern.body(spec.outlineInk ?? '#ffffff', weight, tileWidth, tileHeight, fill);
    return `<g transform="translate(${offset} ${offset})" opacity="${outline}">${behind}</g>${main}`;
  };

  if ((spec.placement ?? 'tile') === 'tile') {
    return {
      ...common,
      image: `url("${svg(tileWidth, tileHeight, '', drawBody())}")`,
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
      `<pattern id="sp" width="${tileWidth}" height="${tileHeight}" patternUnits="userSpaceOnUse">` +
      drawBody() +
      `</pattern>` +
      `</defs>`;
    const rect = `<rect width="${spread}" height="${spread}" fill="url(#sp)" mask="url(#sm)"/>`;
    return { image: `url("${svg(spread, spread, defs, rect)}")`, position: anchor.position };
  });
  return {
    ...common,
    image: layers.map(layer => layer.image).join(', '),
    size: chosen.map(() => `${spread}px ${spread}px`).join(', '),
    repeat: chosen.map(() => 'no-repeat').join(', '),
    attachment: chosen.map(() => 'fixed').join(', '),
    position: layers.map(layer => layer.position).join(', ')
  };
}
