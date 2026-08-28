import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * Phase H — Task Designer port. Exercises the desktop canvas against the demo
 * backend and the mock gateway (no live key):
 *
 * 1. Round-trip: open the first demo board's designer, confirm the Session Log
 *    seed note, add two tickets, drag one, link them with a directed connector,
 *    zoom — then verify the canvas survives closing the view AND a full app
 *    relaunch into the same profile.
 * 2. AI recommend: mock gateway returns an ordering, the preview lane + order
 *    badges render, and applying stacks the nodes vertically.
 * 3. Master plan: with a seeded working directory, generating writes
 *    plans/master-plan.md to disk.
 */

const NO_GATEWAY_ENV = {
  AI_GATEWAY_API_KEY: undefined,
  VERCEL_OIDC_TOKEN: undefined,
  FROSTY_VERCEL_API_KEY: undefined,
  AI_GATEWAY_URL: undefined,
  VERCEL_AI_GATEWAY_URL: undefined,
  FROSTY_VERCEL_URL: undefined
} as const;

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;
const tempDirs: string[] = [];

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (mock) {
    await mock.close();
    mock = undefined;
  }
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function gatewayEnv(baseUrl: string): Record<string, string | undefined> {
  return { ...NO_GATEWAY_ENV, AI_GATEWAY_API_KEY: 'e2e-gateway-key', AI_GATEWAY_URL: baseUrl };
}

/** Open the first demo board in the Task Designer and wait for the canvas. */
async function openDesigner(win: import('playwright').Page): Promise<void> {
  await win.locator('[data-testid="board-nav-item"]').first().click();
  await win.locator('[data-testid="board-designer-btn"]').click();
  await win.locator('[data-testid="designer-page"]').waitFor();
  // The first open seeds the Session Log note.
  await win.locator('.designer-node[data-node-id="note-0"]').waitFor();
}

/** Add a ticket node through the toolbar entry form. */
async function addTicket(win: import('playwright').Page, issueKey: string, expectedNodeId: string): Promise<void> {
  await win.locator('[data-testid="designer-tool-ticket"]').click();
  await win.locator('[data-testid="designer-entry-input"]').fill(issueKey);
  await win.locator('[data-testid="designer-entry-confirm"]').click();
  await win.locator(`.designer-node[data-node-id="${expectedNodeId}"]`).waitFor();
}

async function assertCanvasPersisted(win: import('playwright').Page): Promise<void> {
  await win.locator('.designer-node[data-node-id="note-0"]').waitFor();
  await win.locator('.designer-node[data-node-id="ticket-APP-100-1"]').waitFor();
  await win.locator('.designer-node[data-node-id="ticket-APP-101-2"]').waitFor();
  await expect(win.locator('[data-testid="designer-connector-hit"]')).toHaveCount(1);
  // Zoom persisted at 1.2.
  await expect(win.locator('.designer-nodes-layer')).toHaveAttribute('style', /scale\(1\.2\)/);
}

test('designer canvas round-trips nodes, a link and zoom across view close and app relaunch', async () => {
  app = await launchTestApp(undefined, undefined, { ...NO_GATEWAY_ENV });
  let win = app.window;
  // Room for the two tickets side by side after the drag-aside.
  await win.setViewportSize({ width: 1440, height: 900 });

  await openDesigner(win);
  await addTicket(win, 'APP-100', 'ticket-APP-100-1');
  await addTicket(win, 'APP-101', 'ticket-APP-101-2');

  // Selection uses the application's existing right detail pane instead of
  // crowding every node with all of its ticket metadata.
  const itemDetail = win.locator('[data-testid="designer-item-detail"]');
  await expect(itemDetail).toContainText('APP-101');
  await expect(itemDetail).toContainText('Implement dependency-injected backend router');

  // Both tickets land at the same add point; drag the second one aside.
  const node2 = win.locator('.designer-node[data-node-id="ticket-APP-101-2"]');
  const box2 = await node2.boundingBox();
  if (!box2) {
    throw new Error('ticket-APP-101-2 has no box');
  }
  await win.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await win.mouse.down();
  await win.mouse.move(box2.x + box2.width / 2 + 320, box2.y + box2.height / 2 + 180, { steps: 8 });
  await win.mouse.up();

  // Select the first ticket so its handles are interactive, then link
  // bottom → top of the second ticket with a real pointer drag. While a link
  // drag is active the canvas reveals every node's handles, so the target
  // handle's box is measurable mid-drag.
  const node1 = win.locator('.designer-node[data-node-id="ticket-APP-100-1"]');
  await node1.click();
  await win.waitForTimeout(200);
  const sourceHandle = node1.locator('.designer-node-handle--bottom');
  const targetHandle = win
    .locator('.designer-node[data-node-id="ticket-APP-101-2"]')
    .locator('.designer-node-handle--top');
  const sourceBox = await sourceHandle.boundingBox();
  if (!sourceBox) {
    throw new Error('source handle has no box');
  }
  await win.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await win.mouse.down();
  // A small move starts the link preview (is-linking reveals target handles).
  await win.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2 + 30, {
    steps: 3
  });
  await win.waitForTimeout(150);
  const targetBox = await targetHandle.boundingBox();
  if (!targetBox) {
    throw new Error('target handle has no box');
  }
  await win.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
    steps: 8
  });
  await win.mouse.up();

  await win.locator('[data-testid="designer-connector-hit"]').waitFor();
  await expect(win.locator('[data-testid="designer-feedback"]')).toContainText('Directed link created.');

  // Zoom in twice (1.0 → 1.2).
  await win.locator('[data-testid="designer-tool-zoom-in"]').click();
  await win.locator('[data-testid="designer-tool-zoom-in"]').click();

  // Let the debounced persist flush before leaving the view.
  await win.waitForTimeout(400);

  // Close the designer and reopen — state survives the route change.
  await win.locator('[data-testid="designer-close"]').click();
  await win.locator('[data-testid="board-designer-btn"]').click();
  await win.locator('[data-testid="designer-page"]').waitFor();
  await assertCanvasPersisted(win);

  // Full relaunch into the same profile — state survives the restart.
  const reuse = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();
  app = await launchTestApp(undefined, reuse, { ...NO_GATEWAY_ENV });
  win = app.window;
  await openDesigner(win);
  await assertCanvasPersisted(win);
});

test('link mode connects two items by selecting source then target', async () => {
  app = await launchTestApp(undefined, undefined, { ...NO_GATEWAY_ENV });
  const win = app.window;
  await win.setViewportSize({ width: 1440, height: 900 });

  await openDesigner(win);
  await addTicket(win, 'APP-100', 'ticket-APP-100-1');
  await addTicket(win, 'APP-101', 'ticket-APP-101-2');

  const target = win.locator('.designer-node[data-node-id="ticket-APP-101-2"]');
  const targetBox = await target.boundingBox();
  if (!targetBox) {
    throw new Error('ticket-APP-101-2 has no box');
  }
  await win.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2);
  await win.mouse.down();
  await win.mouse.move(targetBox.x + targetBox.width / 2 + 300, targetBox.y + targetBox.height / 2 + 160, { steps: 6 });
  await win.mouse.up();

  await win.locator('[data-testid="designer-tool-link"]').click();
  await win.locator('.designer-node[data-node-id="ticket-APP-100-1"]').click();
  await expect(win.locator('[data-testid="designer-feedback"]')).toContainText('Select another item');
  await target.click();

  await expect(win.locator('[data-testid="designer-connector-hit"]')).toHaveCount(1);
  await expect(win.locator('[data-testid="designer-feedback"]')).toContainText('Directed link created.');
});

test('note resize adorner sits on the item corner and resizes the outer node', async () => {
  app = await launchTestApp(undefined, undefined, { ...NO_GATEWAY_ENV });
  const win = app.window;
  await openDesigner(win);

  const note = win.locator('.designer-node[data-node-id="note-0"]');
  await note.locator('.designer-node-header').click();
  const resize = note.locator('.designer-node-resize');
  const before = await note.boundingBox();
  const adorner = await resize.boundingBox();
  if (!before || !adorner) {
    throw new Error('note or resize adorner has no box');
  }

  // The control straddles the node frame and extends beyond its bottom/right
  // edges; it is not drawn inside the textarea.
  expect(adorner.x + adorner.width).toBeGreaterThan(before.x + before.width);
  expect(adorner.y + adorner.height).toBeGreaterThan(before.y + before.height);

  await win.mouse.move(adorner.x + adorner.width / 2, adorner.y + adorner.height / 2);
  await win.mouse.down();
  await win.mouse.move(adorner.x + adorner.width / 2 + 80, adorner.y + adorner.height / 2 + 50, { steps: 5 });
  await win.mouse.up();

  const after = await note.boundingBox();
  if (!after) {
    throw new Error('resized note has no box');
  }
  expect(after.width).toBeGreaterThan(before.width + 70);
  expect(after.height).toBeGreaterThan(before.height + 40);
});

test('designer sidebar shows board tickets, supports drag to canvas, and restores workspace on exit', async () => {
  app = await launchTestApp(undefined, undefined, { ...NO_GATEWAY_ENV });
  const win = app.window;
  await win.setViewportSize({ width: 1440, height: 900 });
  await openDesigner(win);

  const palette = win.locator('[data-testid="designer-sidebar"]');
  await expect(palette).toBeVisible();
  await expect(win.locator('[data-testid="nav-connections"]')).toHaveCount(0);

  const ticket = palette.getByRole('button', { name: /^APP-101 / });
  await ticket.click();
  await expect(win.locator('[data-testid="designer-item-detail"]')).toContainText(
    'Implement dependency-injected backend router'
  );

  // APP-101 has related tickets in the demo data; declining the optional
  // expansion still adds the dragged ticket itself.
  win.once('dialog', dialog => dialog.dismiss());
  await ticket.dragTo(win.locator('[data-testid="designer-canvas"]'), {
    targetPosition: { x: 520, y: 320 }
  });
  await win.locator('.designer-node[data-node-id="ticket-APP-101-1"]').waitFor();

  await win.getByRole('button', { name: 'Exit Designer' }).click();
  await expect(win.locator('[data-testid="designer-page"]')).toHaveCount(0);
  await expect(win.locator('[data-testid="designer-sidebar"]')).toHaveCount(0);
  await expect(win.locator('[data-testid="nav-connections"]')).toBeVisible();
  await expect(win.locator('[data-testid="board-view"]')).toBeVisible();
});

test('AI recommend flow previews an ordering and applying stacks the tickets vertically', async () => {
  const reply = JSON.stringify({
    orderedNodeIds: ['ticket-APP-101-2', 'ticket-APP-100-1'],
    connectors: [{ sourceNodeId: 'ticket-APP-101-2', targetNodeId: 'ticket-APP-100-1' }],
    rationale: 'test ordering'
  });
  mock = await startMockGatewayServer({ mode: 'complete', reply });
  app = await launchTestApp(undefined, undefined, gatewayEnv(mock.baseUrl));
  const win = app.window;

  await openDesigner(win);
  await addTicket(win, 'APP-100', 'ticket-APP-100-1');
  await addTicket(win, 'APP-101', 'ticket-APP-101-2');

  await win.locator('[data-testid="designer-tool-recommend-flow"]').click();

  // Preview: vertical lane + 1-based order badges on both tickets.
  await win.locator('[data-testid="designer-lane"]').waitFor({ timeout: 15000 });
  const badges = win.locator('[data-testid="designer-order-badge"]');
  await expect(badges).toHaveCount(2);
  const node1Badge = win.locator('.designer-node[data-node-id="ticket-APP-100-1"] [data-testid="designer-order-badge"]');
  const node2Badge = win.locator('.designer-node[data-node-id="ticket-APP-101-2"] [data-testid="designer-order-badge"]');
  await expect(node2Badge).toHaveText('1');
  await expect(node1Badge).toHaveText('2');

  await win.locator('[data-testid="designer-tool-apply-recommendation"]').click();
  await expect(win.locator('[data-testid="designer-feedback"]')).toContainText(
    'AI recommendation applied.'
  );

  // Applied layout: same x, APP-101 stacked above APP-100.
  const box1 = await win.locator('.designer-node[data-node-id="ticket-APP-100-1"]').boundingBox();
  const box2 = await win.locator('.designer-node[data-node-id="ticket-APP-101-2"]').boundingBox();
  if (!box1 || !box2) {
    throw new Error('applied nodes have no box');
  }
  expect(Math.abs(box1.x - box2.x)).toBeLessThan(4);
  expect(box2.y).toBeLessThan(box1.y);
});

test('generate master plan writes plans/master-plan.md under the working directory', async () => {
  const workingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-plan-'));
  tempDirs.push(workingDirectory);
  app = await launchTestApp({ ai: { workingDirectory } }, undefined, { ...NO_GATEWAY_ENV });
  const win = app.window;

  await openDesigner(win);
  await addTicket(win, 'APP-100', 'ticket-APP-100-1');

  await win.locator('[data-testid="designer-tool-master-plan"]').click();
  await expect(win.locator('[data-testid="designer-feedback"]')).toContainText(
    'Master plan generated',
    { timeout: 10000 }
  );

  const masterPlanPath = path.join(workingDirectory, 'plans', 'master-plan.md');
  expect(fs.existsSync(masterPlanPath)).toBe(true);
  expect(fs.readFileSync(masterPlanPath, 'utf8')).toContain('# Task Designer Master Plan');
});
