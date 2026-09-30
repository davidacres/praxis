#!/usr/bin/env node
// Composes the README hero + feature tiles from the raw screenshots in
// docs/published-artifacts/shots, the way a marketing image is composed:
// rounded, shadowed windows and a phone in a device frame over a gradient.
//
//   node scripts/readme-assets.cjs
//
// Needs Playwright's Chromium (already a dev dependency of the desktop main workspace).
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const shots = path.join(root, 'docs/published-artifacts/shots');
const out = path.join(root, 'docs/assets/readme');
const { chromium } = require(require.resolve('playwright', {
  paths: [path.join(root, 'apps/praxis-desktop/main'), root],
}));

const url = (name) => 'file://' + path.join(shots, name);

const BG = 'radial-gradient(120% 90% at 15% 0%, #f4c9b4 0%, #d9826a 38%, #a9472f 72%, #5b2418 100%)';
const BG_SOFT = 'radial-gradient(120% 100% at 80% 0%, #f7dccd 0%, #e7a58d 45%, #b85a41 100%)';
const BG_NIGHT = 'radial-gradient(110% 100% at 20% 0%, #2c4b6e 0%, #16263b 55%, #0b1320 100%)';

const css = (w, h, bg) => `
  *{box-sizing:border-box;margin:0}
  body{width:${w}px;height:${h}px;overflow:hidden;background:${bg};position:relative;font-family:-apple-system,sans-serif}
  .win{position:absolute;overflow:hidden;border-radius:14px;
       box-shadow:0 0 0 1px rgba(0,0,0,.18),0 30px 80px rgba(0,0,0,.45)}
  .win img{display:block;width:100%;height:100%;object-fit:cover;object-position:top}
  .phone{position:absolute;border-radius:54px;padding:11px;background:#0a0a0c;
         box-shadow:0 0 0 2px #3a3a40,0 0 0 4px #17171a,0 30px 70px rgba(0,0,0,.55)}
  .phone img{display:block;width:100%;height:100%;border-radius:44px;object-fit:cover}
  .crop{position:absolute;inset:0;overflow:hidden}
  .crop img{position:absolute;max-width:none}
`;

// A full-bleed crop of a source screenshot: (sx,sy,sw,sh) is the region of the
// original image (px) that fills the whole canvas.
const cropTile = (file, [sx, sy, sw, sh], W, H) => `
  <div class="crop"><img src="${url(file)}" style="
    width:${(1664 / sw) * W}px; left:${(-sx / sw) * W}px; top:${(-sy / sh) * H}px"></div>`;

const tiles = {
  'readme-hero': {
    w: 1998,
    h: 1250,
    html: `<style>${css(1998, 1250, BG)}</style>
      <div class="win" style="left:70px;top:70px;width:1760px;height:990px"><img src="${url('desktop-board.jpg')}"></div>
      <div class="phone" style="left:1420px;top:300px;width:420px;height:880px"><img src="${url('m-nav.jpg')}"></div>`,
  },
  'mobile-companion': {
    html: (W, H) => `<style>${css(W, H, BG)}</style>
      <div class="win" style="left:40px;top:60px;width:820px;height:461px"><img src="${url('desktop-overview.jpg')}"></div>
      <div class="phone" style="left:660px;top:120px;width:250px;height:560px"><img src="${url('m-attention-permission.jpg')}"></div>
      <div class="phone" style="left:940px;top:190px;width:250px;height:560px"><img src="${url('m-session-progress.jpg')}"></div>`,
  },
  'boards': { crop: ['desktop-board.jpg', [264, 40, 1200, 675]] },
  'agent-sessions': { window: 'sessions-shell.jpg' },
  'review-diffs': { window: 'session-changes-diff-view.jpg' },
  'agent-runtime': { crop: ['desktop-agent-runtime.jpg', [209, 58, 1246, 701]] },
  'themes': {
    html: (W, H) => {
      const cell = (f, x, y) =>
        `<div class="win" style="left:${x}px;top:${y}px;width:${(W - 90) / 2}px;height:${(H - 90) / 2}px;border-radius:10px"><img src="${url(f)}"></div>`;
      const cw = (W - 90) / 2, ch = (H - 90) / 2;
      return `<style>${css(W, H, BG_NIGHT)}</style>
        ${cell('desktop-look-noir.jpg', 30, 30)}
        ${cell('desktop-look-blueprint.jpg', 60 + cw, 30)}
        ${cell('desktop-look-graphite.jpg', 30, 60 + ch)}
        ${cell('desktop-look-aurora-glass.jpg', 60 + cw, 60 + ch)}`;
    },
  },
};

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  for (const [name, t] of Object.entries(tiles)) {
    const W = t.w || 1440;
    const H = t.h || 810;
    const body = t.window
      ? `<style>${css(W, H, BG_SOFT)}</style><div class="win" style="left:50px;top:55px;width:${W - 100}px;height:${H - 110}px"><img src="${url(t.window)}"></div>`
      : t.crop
      ? `<style>${css(W, H, BG_SOFT)}</style>${cropTile(t.crop[0], t.crop[1], W, H)}`
      : typeof t.html === 'function' ? t.html(W, H) : t.html;
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    const tmp = path.join(require('os').tmpdir(), `praxis-readme-${name}.html`);
    fs.writeFileSync(tmp, `<!doctype html><html><body>${body}</body></html>`);
    await page.goto('file://' + tmp);
    await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth));
    await page.screenshot({ path: path.join(out, name + '.jpg'), type: 'jpeg', quality: 88 });
    await page.close();
    console.log('wrote', path.relative(root, path.join(out, name + '.jpg')));
  }
  await browser.close();
})();
