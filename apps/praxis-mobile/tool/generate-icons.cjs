// Run from the repository: node apps/praxis-mobile/tool/generate-icons.cjs
// Requires the repository's Playwright installation and macOS sips.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
    const svg = fs.readFileSync(path.join(root, 'assets/icon/praxis-icon.svg'), 'utf8');
    await page.setContent('<style>html,body{margin:0;overflow:hidden}</style>' + svg);
    const master = path.join(root, 'assets/icon/praxis-icon.png');
    await page.screenshot({ path: master, omitBackground: false });
    const catalog = path.join(root, 'ios/Runner/Assets.xcassets/AppIcon.appiconset');
    const { images } = JSON.parse(fs.readFileSync(path.join(catalog, 'Contents.json'), 'utf8'));
    for (const item of images) {
      const size = Number(item.size.split('x')[0]) * Number(item.scale.replace('x', ''));
      execFileSync('sips', ['-z', String(size), String(size), master, '--out', path.join(catalog, item.filename)], { stdio: 'ignore' });
    }
    console.log('Generated master and all ' + new Set(images.map(i => i.filename)).size + ' iOS icon sizes.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
