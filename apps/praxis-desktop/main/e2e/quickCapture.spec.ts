import * as fs from 'node:fs';
import { openBoard } from './navigation';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, expandAllIssueStacks, type TestApp } from './launchTestApp';
import { chooseOption, chipOptionValues } from './chipSelect';

let app: TestApp | undefined;
test.afterEach(async () => { if (app) await closeTestApp(app); app = undefined; });

const artifactDir = path.resolve(__dirname, '../../../../.praxis/session-artifacts');

async function chooseFirstDestination() {
  const chip = app!.window.getByTestId('quick-capture-destination');
  const values = await chipOptionValues(chip);
  expect(values.length).toBeGreaterThan(0);
  await chooseOption(chip, values[0]);
  const project = app!.window.getByTestId('quick-capture-project');
  if (await project.count()) {
    const projectValues = await chipOptionValues(project);
    expect(projectValues.length).toBeGreaterThan(0);
    await chooseOption(project, projectValues[0]);
  }
}

test('global capture requires a destination, creates through the ordinary path, and clears only on success', async () => {
  app = await launchTestApp();
  const page = app.window;
  await page.getByTestId('quick-capture').click();
  const dialog = page.getByTestId('quick-capture-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('quick-capture-title')).toBeFocused();
  await page.getByTestId('quick-capture-title').fill('A quick task to follow up');
  await page.getByTestId('quick-capture-body').fill('Details captured without leaving the current screen.');
  await expect(page.getByTestId('quick-capture-save')).toBeDisabled();
  await chooseFirstDestination();
  await expect(page.getByTestId('quick-capture-save')).toBeEnabled();
  // Escape closes a portalled picker first, leaving the draft dialog open.
  await page.getByTestId('quick-capture-type').click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await page.getByTestId('quick-capture-save').focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Close Quick Capture', exact: true })).toBeFocused();
  fs.mkdirSync(artifactDir, { recursive: true });
  await page.screenshot({ path: path.join(artifactDir, 'quick-capture.png') });
  await page.getByTestId('quick-capture-save').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('issue-card').filter({ hasText: 'A quick task to follow up' })).toBeVisible();
  // Focus goes back to what opened the capture.
  await expect(page.getByTestId('quick-capture')).toBeFocused();
  await page.keyboard.press('Control+Shift+C');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('quick-capture-title')).toHaveValue('');
  await expect(page.getByTestId('quick-capture-body')).toHaveValue('');
  // A whitespace-only title can never be saved.
  await chooseFirstDestination();
  await page.getByTestId('quick-capture-title').fill('   ');
  await expect(page.getByTestId('quick-capture-save')).toBeDisabled();
  // ...and says why, inline (AC4).
  await expect(page.getByTestId('quick-capture-title-hint')).toHaveText("A title can't be only spaces.");
  await expect(page.getByTestId('quick-capture-title')).toHaveAttribute('aria-invalid', 'true');
  await page.getByTestId('quick-capture-title').fill('Now it has words');
  await expect(page.getByTestId('quick-capture-title-hint')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

/** Every item on every board the capture can reach, by key, so a test can tell exactly what a capture added. */
async function allIssueKeys(): Promise<string[]> {
  return app!.window.evaluate(async () => {
    const boards = await window.praxis.board.list({ projectKeys: [], types: [], searchText: '' });
    const keys: string[] = [];
    for (const board of boards) {
      const page = await window.praxis.issue.list({ projectKeys: [], boardId: board.id, statuses: [], issueTypes: [], searchText: '', assigneeMode: 'all', grouping: 'none' }, 0, 500, board.connectionId);
      keys.push(...page.issues.map(issue => `${board.connectionId ?? 'demo'}:${issue.key}`));
    }
    return [...new Set(keys)].sort();
  });
}

test('the capture shortcut opens over Settings and over another open dialog, on top of both', async () => {
  app = await launchTestApp();
  const page = app.window;
  const dialog = page.getByTestId('quick-capture-dialog');
  const onTop = () => page.evaluate(() => {
    const box = document.querySelector('[data-testid="quick-capture-dialog"]')!.getBoundingClientRect();
    return document.elementFromPoint(box.left + box.width / 2, box.top + 12)?.closest('[data-testid="quick-capture-dialog"]') !== null;
  });
  // Over Settings (a modal page of its own).
  await page.getByTestId('titlebar-settings').click();
  await expect(page.getByRole('dialog').first()).toBeVisible();
  await page.keyboard.press('Control+Shift+C');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('quick-capture-title')).toBeFocused();
  expect(await onTop()).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press('Escape');
  // Over the command palette, with focus inside its search field.
  await page.keyboard.press('Control+K');
  await expect(page.locator('.command-palette')).toBeVisible();
  await page.keyboard.press('Control+Shift+C');
  await expect(dialog).toBeVisible();
  expect(await onTop()).toBe(true);
});

test('a capture stamps its creation time; Escape creates nothing', async () => {
  app = await launchTestApp();
  const page = app.window;
  const before = await allIssueKeys();
  await page.keyboard.press('Control+Shift+C');
  await chooseFirstDestination();
  await page.getByTestId('quick-capture-title').fill('Abandoned thought');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('quick-capture-dialog')).toHaveCount(0);
  expect(await allIssueKeys()).toEqual(before);

  await page.keyboard.press('Control+Shift+C');
  const destination = (await page.getByTestId('quick-capture-destination').getAttribute('data-value'))!;
  await page.getByTestId('quick-capture-title').fill('Stamped capture');
  const startedAt = Date.now();
  await page.getByTestId('quick-capture-save').click();
  await expect(page.getByTestId('quick-capture-dialog')).toHaveCount(0);
  const added = (await allIssueKeys()).filter(key => !before.includes(key));
  expect(added).toHaveLength(1);
  const connectionId = destination.slice(0, destination.lastIndexOf(':'));
  const issueKey = added[0].slice(added[0].lastIndexOf(':') + 1);
  const created = await page.evaluate(([key, id]) => window.praxis.issue.get(key, id === 'demo' ? undefined : id), [issueKey, connectionId] as const);
  expect(created.summary).toBe('Stamped capture');
  expect(Date.parse(created.created ?? '')).toBeGreaterThanOrEqual(startedAt - 60_000);
  expect(Date.parse(created.created ?? '')).toBeLessThanOrEqual(Date.now() + 1_000);
});

test('successive captures each create their own item', async () => {
  app = await launchTestApp();
  const page = app.window;
  for (const title of ['Rapid capture one', 'Rapid capture two', 'Rapid capture three']) {
    await page.keyboard.press('Control+Shift+C');
    await chooseFirstDestination();
    await page.getByTestId('quick-capture-title').fill(title);
    await page.getByTestId('quick-capture-save').click();
    await expect(page.getByTestId('quick-capture-dialog')).toHaveCount(0);
  }
  for (const title of ['Rapid capture one', 'Rapid capture two', 'Rapid capture three']) {
    await expect(page.getByTestId('issue-card').filter({ hasText: title })).toHaveCount(1);
  }
  // In capture order (AC6): each was created no earlier than the one before it, and keyed after it.
  const order = await page.evaluate(async () => {
    const boards = await window.praxis.board.list({ projectKeys: [], types: [], searchText: '' });
    for (const board of boards) {
      const { issues } = await window.praxis.issue.list({ projectKeys: [], boardId: board.id, statuses: [], issueTypes: [], searchText: '', assigneeMode: 'all', grouping: 'none' }, 0, 500, board.connectionId);
      const found = ['Rapid capture one', 'Rapid capture two', 'Rapid capture three'].map(title => issues.find(issue => issue.summary === title));
      if (found.every(Boolean)) return found.map(issue => ({ key: issue!.key, created: issue!.created }));
    }
    return [];
  });
  expect(order).toHaveLength(3);
  const keyNumber = (key: string) => Number(/(\d+)$/.exec(key)?.[1]);
  expect(keyNumber(order[0].key)).toBeLessThan(keyNumber(order[1].key));
  expect(keyNumber(order[1].key)).toBeLessThan(keyNumber(order[2].key));
  for (let index = 1; index < order.length; index++) {
    expect(Date.parse(order[index].created ?? '')).toBeGreaterThanOrEqual(Date.parse(order[index - 1].created ?? ''));
  }
});

test('failed capture retains title, body and destination after dismiss and reopen', async () => {
  app = await launchTestApp();
  const page = app.window;
  await page.keyboard.press('Control+Shift+C');
  await chooseFirstDestination();
  const destination = await page.getByTestId('quick-capture-destination').getAttribute('data-value');
  await page.getByTestId('quick-capture-title').fill('Retain this draft');
  await page.getByTestId('quick-capture-body').fill('Do not lose the details.');
  await app.electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('issue:create');
    ipcMain.handle('issue:create', () => { throw new Error('Creation temporarily unavailable'); });
  });
  await page.getByTestId('quick-capture-save').click();
  await expect(page.getByTestId('quick-capture-error')).toContainText('Creation temporarily unavailable');
  await expect(page.getByTestId('quick-capture-title')).toHaveValue('Retain this draft');
  await expect(page.getByTestId('quick-capture-body')).toHaveValue('Do not lose the details.');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('quick-capture-dialog')).toHaveCount(0);
  await page.getByTestId('quick-capture').click();
  await expect(page.getByTestId('quick-capture-title')).toHaveValue('Retain this draft');
  await expect(page.getByTestId('quick-capture-body')).toHaveValue('Do not lose the details.');
  await expect(page.getByTestId('quick-capture-destination')).toHaveAttribute('data-value', destination!);
});

test('folder creation opt-in is enforced with an explanation and no discarded input', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-quick-capture-'));
  fs.mkdirSync(path.join(root, 'features', 'feature-01-demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'features', 'feature-01-demo', 'feature.md'), '# Demo\n\n**Status:** Proposed\n**Type:** Feature\n\n## Description\nDemo\n');
  try {
    app = await launchTestApp({ connections: [{ id: 'capture-readonly', name: 'Capture readonly', mode: 'folder', settings: { path: root, projectKey: 'CAP', projectName: 'Capture readonly' } }] });
    const page = app.window;
    await openBoard(page, 'Capture readonly');
    await page.getByTestId('quick-capture').click();
    await page.getByTestId('quick-capture-title').fill('Keep this capture');
    await expect(page.getByTestId('quick-capture-unavailable')).toContainText('Allow issue creation');
    await expect(page.getByTestId('quick-capture-save')).toBeDisabled();
    await expect(page.getByTestId('quick-capture-title')).toHaveValue('Keep this capture');
  } finally {
    // Stop the folder watcher before removing the fixture it watches.
    if (app) await closeTestApp(app);
    app = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an enabled folder capture explicitly requires a feature for its task', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-quick-capture-write-'));
  fs.mkdirSync(path.join(root, 'features', 'feature-01-demo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'features', 'feature-01-demo', 'feature.md'), '# Demo\n\n**Status:** Proposed\n**Type:** Feature\n\n## Description\nDemo\n');
  try {
    app = await launchTestApp({ connections: [{ id: 'capture-folder', name: 'Capture folder', mode: 'folder', settings: { path: root, projectKey: 'CAP', projectName: 'Capture folder', allowIssueCreation: true } }] });
    const page = app.window;
    await openBoard(page, 'Capture folder');
    await page.getByTestId('quick-capture').click();
    await page.getByTestId('quick-capture-title').fill('A captured folder task');
    await page.getByTestId('quick-capture-save').click();
    await expect(page.getByTestId('quick-capture-error')).toHaveText('Feature is required for Task items.');
    await expect(page.locator('#quick-capture-parents option')).toHaveCount(1);
    await page.getByTestId('quick-capture-parent').fill((await page.locator('#quick-capture-parents option').getAttribute('value'))!);
    await page.getByTestId('quick-capture-save').click();
    await expect(page.getByTestId('quick-capture-dialog')).toHaveCount(0);
    await expect.poll(() => fs.readdirSync(path.join(root, 'features', 'feature-01-demo')).filter(name => name.startsWith('task-')).length).toBe(1);
  } finally {
    // Stop the folder watcher before removing the fixture it watches.
    if (app) await closeTestApp(app);
    app = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a captured folder item is marked on disk and badged until it leaves the first column', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-quick-capture-origin-'));
  const featureDir = path.join(root, 'features', 'feature-01-demo');
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, 'feature.md'), '# Demo\n\n**Status:** Proposed\n**Type:** Feature\n\n## Description\nDemo\n');
  fs.writeFileSync(path.join(featureDir, 'task-01-1-typed-ticket.md'), '# Typed ticket\n\n**Status:** Proposed\n**Type:** Task\n**Parent:** CAP-F01\n\n## Description\nWritten by hand.\n');
  try {
    app = await launchTestApp({ connections: [{ id: 'capture-origin', name: 'Capture origin', mode: 'folder', settings: { path: root, projectKey: 'CAP', projectName: 'Capture origin', allowIssueCreation: true } }] });
    const page = app.window;
    await openBoard(page, 'Capture origin');
    await page.getByTestId('quick-capture').click();
    await page.getByTestId('quick-capture-title').fill('Captured stub');
    await page.getByTestId('quick-capture-parent').fill((await page.locator('#quick-capture-parents option').first().getAttribute('value'))!);
    await page.getByTestId('quick-capture-save').click();
    await expect(page.getByTestId('quick-capture-dialog')).toHaveCount(0);
    const capturedFile = () => fs.readdirSync(featureDir).find(name => name.includes('captured-stub'));
    await expect.poll(capturedFile).toBeTruthy();
    expect(fs.readFileSync(path.join(featureDir, capturedFile()!), 'utf8')).toMatch(/^\*\*Origin:\*\* capture$/m);

    await expandAllIssueStacks(page);
    const captured = page.getByTestId('issue-card').filter({ hasText: 'Captured stub' });
    await expect(captured.getByTestId('issue-card-captured')).toHaveText('Captured');
    await expect(page.getByTestId('issue-card').filter({ hasText: 'Typed ticket' }).getByTestId('issue-card-captured')).toHaveCount(0);
    fs.mkdirSync(artifactDir, { recursive: true });
    await captured.screenshot({ path: path.join(artifactDir, 'quick-capture-badge.png') });

    // Triage = moving it on. The badge goes; the provenance line stays.
    await captured.click();
    await chooseOption(page.getByTestId('issue-edit-status'), { label: 'In Progress' });
    await page.getByTestId('issue-edit-save-btn').click();
    await expandAllIssueStacks(page);
    await expect(page.getByTestId('issue-card').filter({ hasText: 'Captured stub' })).toHaveCount(1);
    await expect(page.getByTestId('issue-card-captured')).toHaveCount(0);
    expect(fs.readFileSync(path.join(featureDir, capturedFile()!), 'utf8')).toMatch(/^\*\*Origin:\*\* capture$/m);
  } finally {
    // Stop the folder watcher before removing the fixture it watches.
    if (app) await closeTestApp(app);
    app = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the capture dialog fits and stays readable across themes, surface packs and zoom', async () => {
  app = await launchTestApp();
  const page = app.window;
  // 150% whole-window zoom: the tightest layout the app ships.
  for (let step = 0; step < 5; step++) await page.getByTestId('titlebar-zoom-in').click();
  await expect(page.getByTestId('titlebar-zoom-reset')).toHaveText('150%');
  await page.keyboard.press('Control+Shift+C');
  await chooseFirstDestination();
  await page.getByTestId('quick-capture-title').fill('Readable everywhere');

  const themes = ['praxis-dark', 'praxis-light', 'github-dark', 'github-light', 'dracula-dark', 'nord-dark', 'solarized-light', 'catppuccin-latte', 'tokyo-night', 'xcode-light', 'humanist-light', 'tm-default-1'];
  const packs = ['flat', 'parchment', 'graphite', 'aurora-glass', 'noir'];
  const isDark = (theme: string) => /dark|night|dracula|nord|tm-default-1/.test(theme);
  const failures: string[] = [];
  for (const theme of themes) {
    for (const pack of packs) {
      if (pack === 'noir' && !isDark(theme)) continue;
      const result = await page.evaluate(([themeId, packId, dark]) => {
        const root = document.documentElement;
        root.setAttribute('data-mode', dark ? 'dark' : 'light');
        root.setAttribute('data-theme', themeId);
        root.setAttribute('data-surface', packId);
        const parse = (color: string): [number, number, number, number] => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          const d = ctx.getImageData(0, 0, 1, 1).data;
          return [d[0], d[1], d[2], d[3] / 255];
        };
        const over = (top: [number, number, number, number], bottom: [number, number, number]): [number, number, number] =>
          [0, 1, 2].map(i => top[i] * top[3] + bottom[i] * (1 - top[3])) as [number, number, number];
        const ground = (el: Element): [number, number, number] => {
          const chain: Element[] = [];
          for (let node: Element | null = el; node; node = node.parentElement) chain.push(node);
          let base: [number, number, number] = [255, 255, 255];
          for (const node of chain.reverse()) base = over(parse(getComputedStyle(node).backgroundColor), base);
          return base;
        };
        const lum = ([r, g, b]: [number, number, number]) => {
          const f = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const contrast = (a: [number, number, number], b: [number, number, number]) => {
          const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
          return (hi + 0.05) / (lo + 0.05);
        };
        const ratio = (selector: string) => {
          const el = document.querySelector(selector)!;
          const bg = ground(el);
          return contrast(over(parse(getComputedStyle(el).color), bg), bg);
        };
        const dialog = document.querySelector('[data-testid="quick-capture-dialog"]')!;
        const themeText = over(parse(getComputedStyle(root).getPropertyValue('--text').trim() || '#000'), ground(dialog));
        const box = dialog.getBoundingClientRect();
        return {
          baseline: contrast(themeText, ground(dialog)),
          fits: box.top >= 0 && box.left >= 0 && box.bottom <= window.innerHeight && box.right <= window.innerWidth,
          parts: {
            heading: ratio('[data-testid="quick-capture-dialog"] .modal-header h3'),
            label: ratio('[data-testid="quick-capture-dialog"] .app-dialog-field span'),
            input: ratio('[data-testid="quick-capture-title"]'),
            save: ratio('[data-testid="quick-capture-save"]')
          }
        };
      }, [theme, pack, isDark(theme)] as const);
      if (!result.fits) failures.push(`${theme}/${pack}: dialog overflows the window`);
      // Every part must reach WCAG AA, or the palette's own text ceiling where the palette itself sits below it.
      // The label and primary button are app-wide primitives; they once missed AA in six palettes
      // (github-dark, xcode-light, solarized-light, tm-default-1, humanist-light, catppuccin-latte).
      const bar = Math.min(4.5, result.baseline) - 0.05;
      for (const [part, value] of Object.entries(result.parts)) {
        if (value < bar) failures.push(`${theme}/${pack}: ${part} ${value.toFixed(2)}:1 (needs ${bar.toFixed(2)})`);
      }
    }
  }
  expect(failures, failures.join('\n')).toEqual([]);
  await expect(page.getByTestId('quick-capture-save')).toBeInViewport();
  fs.mkdirSync(artifactDir, { recursive: true });
  await page.evaluate(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', 'praxis-dark');
    root.setAttribute('data-surface', 'graphite');
    root.setAttribute('data-mode', 'dark');
  });
  // Let the theme transition finish so the capture is the settled frame, not a blend.
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => undefined)));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  // A native capture: Playwright's page screenshot crops to the unzoomed viewport under whole-window zoom.
  const png = await app.electronApp.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  fs.writeFileSync(path.join(artifactDir, 'quick-capture-dark-150.png'), Buffer.from(png, 'base64'));
});
