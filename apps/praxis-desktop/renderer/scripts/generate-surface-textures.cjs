/**
 * Bakes the surface packs' grain tiles to seamless WebP.
 *
 * Why bake at all: the packs used to carry live `feTurbulence` data URIs, which
 * the browser re-rasterises on every paint and which can only afford a couple of
 * octaves. Baking once lets each tile carry far more detail (5–6 octaves plus a
 * directional smear) at a fraction of the runtime cost.
 *
 * Seamlessness: `stitchTiles="stitch"` makes the noise itself wrap, but any
 * blur or smear would sample past the tile edge and leave a visible seam. The
 * smear here is therefore done with a *repeating* canvas pattern, so every
 * offset sample wraps around the tile instead of running off it.
 *
 * Runs on Electron's own Chromium rather than a Playwright browser download —
 * it is already a dependency here, and it is the exact engine that will render
 * these tiles at runtime.
 *
 * Run with:  npm run textures --workspace=@praxis/desktop-renderer
 * Output:    apps/praxis-desktop/renderer/src/assets/surfaces/<name>.webp  (+ @2x)
 */
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

const OUT_DIR = path.join(__dirname, '..', 'src', 'assets', 'surfaces');

/**
 * Each tile is grayscale and centred on mid-grey, because the packs blend it
 * with `soft-light` / `overlay` — where mid-grey is the neutral value, so one
 * asset reads correctly on both light and dark grounds.
 *
 *  freq     feTurbulence baseFrequency; an asymmetric pair stretches the noise
 *           into fibres (vertical) or brushing (horizontal).
 *  octaves  detail depth — the whole point of baking.
 *  contrast <1 flattens toward mid-grey, >1 deepens.
 *  smear    [dx, dy, passes] wrap-around directional blur, in tile pixels.
 */
const TEXTURES = [
  {
    name: 'paper-fibre',
    size: 256,
    freq: '0.024 0.62',
    octaves: 5,
    contrast: 0.92,
    smear: [0, 2, 5],
    quality: 0.72
  },
  {
    name: 'brushed-metal',
    size: 256,
    freq: '0.006 0.86',
    octaves: 4,
    contrast: 0.88,
    smear: [9, 0, 9],
    quality: 0.7
  },
  {
    name: 'film-grain',
    size: 256,
    freq: '0.8',
    octaves: 3,
    contrast: 1,
    smear: [0, 0, 0],
    quality: 0.76
  },
  {
    name: 'frost',
    size: 256,
    freq: '0.014',
    octaves: 6,
    contrast: 0.8,
    smear: [2, 2, 3],
    quality: 0.68
  }
];

/** The seamless noise source, before any smearing. */
function noiseSvg(size, freq, octaves, contrast) {
  const intercept = (0.5 - contrast * 0.5).toFixed(4);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <filter id="t" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB">
      <feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="${octaves}"
                    seed="7" stitchTiles="stitch" result="n"/>
      <!-- Average RGB into grey and force alpha opaque; the raw turbulence is
           noisy in alpha too, which would punch holes in the tile. -->
      <feColorMatrix in="n" type="matrix" values="
        0.333 0.333 0.333 0 0
        0.333 0.333 0.333 0 0
        0.333 0.333 0.333 0 0
        0     0     0     0 1"/>
      <!-- Pull the contrast around mid-grey so the tile stays blend-neutral. -->
      <feComponentTransfer>
        <feFuncR type="linear" slope="${contrast}" intercept="${intercept}"/>
        <feFuncG type="linear" slope="${contrast}" intercept="${intercept}"/>
        <feFuncB type="linear" slope="${contrast}" intercept="${intercept}"/>
      </feComponentTransfer>
    </filter>
    <rect width="${size}" height="${size}" filter="url(#t)"/>
  </svg>`;
}

/** Rendered inside the page: rasterise the SVG, smear it, encode WebP. */
function renderInPage({ svg, size, smear, quality }) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error('svg failed to decode'));
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      const [dx, dy, passes] = smear;
      if (passes > 0 && (dx || dy)) {
        // A repeating pattern wraps, so every offset copy re-enters on the
        // opposite edge and the smear stays perfectly tileable.
        const pattern = ctx.createPattern(img, 'repeat');
        ctx.globalAlpha = 1 / passes;
        for (let i = 0; i < passes; i += 1) {
          const t = passes === 1 ? 0 : i / (passes - 1) - 0.5;
          ctx.save();
          ctx.translate(t * dx * 2, t * dy * 2);
          ctx.fillStyle = pattern;
          ctx.fillRect(-t * dx * 2, -t * dy * 2, size, size);
          ctx.restore();
        }
        ctx.globalAlpha = 1;
      } else {
        ctx.drawImage(img, 0, 0);
      }
      resolve(canvas.toDataURL('image/webp', quality));
    };
    img.src = 'data:image/svg+xml,' + encodeURIComponent(svg);
  });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const win = new BrowserWindow({ show: false, width: 64, height: 64 });
  await win.loadURL('data:text/html,<!doctype html><meta charset="utf-8">');
  const report = [];

  for (const spec of TEXTURES) {
    for (const [suffix, scale] of [['', 1], ['@2x', 2]]) {
      const size = spec.size * scale;
      const args = {
        svg: noiseSvg(size, spec.freq, spec.octaves, spec.contrast),
        size,
        smear: spec.smear,
        quality: spec.quality
      };
      const dataUrl = await win.webContents.executeJavaScript(
        `(${renderInPage.toString()})(${JSON.stringify(args)})`
      );
      const buffer = Buffer.from(dataUrl.split(',')[1], 'base64');
      const file = path.join(OUT_DIR, `${spec.name}${suffix}.webp`);
      fs.writeFileSync(file, buffer);
      report.push({ file: path.basename(file), px: size, kb: +(buffer.length / 1024).toFixed(1) });
    }
  }

  const total = report.reduce((sum, row) => sum + row.kb, 0);
  for (const row of report) {
    console.log(`${row.file.padEnd(26)} ${String(row.px).padStart(4)}px  ${String(row.kb).padStart(6)} KB`);
  }
  console.log(`${''.padEnd(26)}       total ${total.toFixed(1)} KB`);
}

app.whenReady()
  .then(main)
  .then(() => app.exit(0))
  .catch(error => {
    console.error(error);
    app.exit(1);
  });
