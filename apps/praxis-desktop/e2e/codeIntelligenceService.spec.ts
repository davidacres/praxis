import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

// The code intelligence owner is a background process that outlives the app, so a running
// one can hold an older build than the app's service. Settings shows it and can start, stop
// and restart it, and app launch replaces an owner left by another build. Real packaged
// service; the outdated owner is the Debug build, whose build ID differs from the package's.
const executable = process.env.PRAXIS_CODE_INTELLIGENCE_EXE;
const debugAssembly = path.resolve(__dirname, '../../../../services/code-intelligence/src/Praxis.CodeIntelligence/bin/Debug/net10.0/Praxis.CodeIntelligence.dll');

let app: TestApp | undefined;
let outdated: ChildProcess | undefined;
let data: string | undefined;
test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  if (outdated && outdated.exitCode === null) outdated.kill();
  outdated = undefined;
  if (data) {
    try { execFileSync(executable!, ['stop', '--data', data]); } catch { /* nothing running */ }
    fs.rmSync(path.dirname(data), { recursive: true, force: true });
  }
  data = undefined;
});

function ownerOnDisk(): { processId: number; build: string } | undefined {
  try { return JSON.parse(fs.readFileSync(path.join(data!, 'owner.json'), 'utf8')); } catch { return undefined; }
}
const processAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function launch(): Promise<Page> {
  app = await launchTestApp(undefined, undefined, {
    AI_GATEWAY_API_KEY: 'gateway-fixture-key',
    PRAXIS_CODE_INTELLIGENCE_EXE: executable!,
    // The owner's Unix socket lives in the data directory, so keep the path short.
    PRAXIS_CODE_INTELLIGENCE_DATA_DIRECTORY: data!
  });
  return app.window;
}

async function openPanel(win: Page) {
  await win.getByTestId('titlebar-settings').click();
  await win.getByTestId('settings-nav-code-intelligence').click();
  return win.getByTestId('code-intel-service-card');
}

test('settings shows the service and can stop, start and restart it', async ({}, testInfo) => {
  test.skip(!executable, 'Set PRAXIS_CODE_INTELLIGENCE_EXE to a self-contained host package.');
  test.setTimeout(120_000);
  data = path.join(fs.mkdtempSync('/tmp/pci-svc-'), 'data');
  const source = path.join(path.dirname(data), 'source');
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'Example.cs'), 'public class ServiceSmoke { }\n');
  const win = await launch();
  // A selected repository keeps the panel polling index status, which would restart a
  // stopped service on demand; Stop must hold anyway.
  const registered = await win.evaluate(root => window.praxis.ai.codeIntelligence({ action: 'register', root }), source);
  expect(registered.error).toBeUndefined();
  const card = await openPanel(win);
  await expect(card.getByTestId('code-intel-service-badge')).toHaveText('Running');
  await expect(card.getByTestId('code-intel-service-status')).toContainText('(current)');
  const first = ownerOnDisk()!;
  await expect(card.getByTestId('code-intel-service-status')).toContainText(`Process ${first.processId}`);
  await card.screenshot({ path: testInfo.outputPath('service-running.png') });

  await card.getByTestId('code-intel-service-stop-btn').click();
  await expect(card.getByTestId('code-intel-service-badge')).toHaveText('Stopped');
  expect(processAlive(first.processId)).toBe(false);
  await win.waitForTimeout(4_000); // longer than the panel's 3-second poll
  expect(ownerOnDisk()).toBeUndefined();
  await card.screenshot({ path: testInfo.outputPath('service-stopped.png') });

  await card.getByTestId('code-intel-service-start-btn').click();
  await expect(card.getByTestId('code-intel-service-badge')).toHaveText('Running');
  const second = ownerOnDisk()!;
  expect(second.processId).not.toBe(first.processId);

  await card.getByTestId('code-intel-service-restart-btn').click();
  // Wait for the replacement itself: between stop and start there is briefly no owner at all.
  await expect.poll(() => { const pid = ownerOnDisk()?.processId; return pid !== undefined && pid !== second.processId; }).toBe(true);
  await expect(card.getByTestId('code-intel-service-badge')).toHaveText('Running');
  await expect(card.getByTestId('code-intel-service-status')).toContainText(`Process ${ownerOnDisk()!.processId}`);
  expect(processAlive(second.processId)).toBe(false);
});

test('app launch replaces a service left running by another build', async ({}, testInfo) => {
  test.skip(!executable || !fs.existsSync(debugAssembly), 'Needs a host package and the Debug service build.');
  test.setTimeout(120_000);
  data = path.join(fs.mkdtempSync('/tmp/pci-svc-'), 'data');
  // An owner from an earlier session, still running another build.
  outdated = spawn('dotnet', [debugAssembly, 'serve', '--data', data], { stdio: 'ignore' });
  await expect.poll(() => ownerOnDisk()?.processId).toBe(outdated.pid);
  const packageBuild = JSON.parse(execFileSync(executable!, ['version'], { encoding: 'utf8' })).data.build as string;
  expect(ownerOnDisk()!.build).not.toBe(packageBuild);

  const win = await launch();
  await expect.poll(() => ownerOnDisk()?.build, { timeout: 30_000 }).toBe(packageBuild);
  await expect.poll(() => outdated!.exitCode !== null || outdated!.signalCode !== null).toBe(true);
  const card = await openPanel(win);
  await expect(card.getByTestId('code-intel-service-badge')).toHaveText('Running');
  await expect(card.getByTestId('code-intel-service-status')).toContainText('(current)');
  await card.screenshot({ path: testInfo.outputPath('service-replaced.png') });
});
