import { test, expect } from '@playwright/test';
import * as net from 'node:net';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { MobileSecureClient, generateKeyPair } from '@praxis/mobile-protocol';
import type { MobileCommand, MobileReadRequest } from '@praxis/core';
import { launchTestApp, closeTestApp } from './launchTestApp';
import { chooseOption } from './chipSelect';
import { WebSocket } from 'ws';
import { RelayServer } from '../../../packages/mobile-relay/src/relayServer';
import { relayConnector, lanConnector, newPhone, createProject, pairPhone, callerFor, type Phone } from './mobilePhone';

// The phone listener is the Rust host's (`mobile_bridge` + `mobile_services`). The Electron-era
// 'typescript' transport variant has no counterpart any more, so there is one run, not two.
{
  test('real phone pairing, scoped reads, schedule idempotency and key rotation', async () => {
    test.setTimeout(90000);
    const app = await launchTestApp();
    const win = app.window;
    let phone: MobileSecureClient | undefined;
    try {
      for (const key of ['MOB', 'OTH']) fs.mkdirSync(path.join(app.userDataDir, key), { recursive: true });
      const projects = await win.evaluate(async workspaceFolder => {
        const workspace = (await window.praxis.workspaces.list())[0];
        const create = (name: string, key: string) => window.praxis.projects.create({
          name, key, type: 'product', purpose: '', brief: {}, startingPoint: 'existing-folder', folderPath: `${workspaceFolder}/${key}`, storage: 'app', planningMode: 'files',
          workflowStages: [{ id: 'todo', name: 'To do', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }],
          starterTickets: [], defaultAiToolMode: 'full',
        }, workspace.id);
        return [await create('Mobile transport project', 'MOB'), await create('Other project', 'OTH')];
      }, app.userDataDir);
      await win.getByTestId('titlebar-settings').click(); await win.getByTestId('settings-nav-mobile').click();
      await chooseOption(win.getByTestId('mobile-access-mode'), 'local-only');
      await expect(win.getByTestId('mobile-listener-status')).toContainText('Listening');
      // The listener is the backend itself: it reports its own state, there is no child process to inspect.
      const hostStatus = await app.callHost('mobile:status');
      expect(hostStatus.listening).toBe(true);
      expect(hostStatus.port).toBeGreaterThan(0);
      await win.getByTestId('mobile-create-pairing').click();
      const pairing = await win.evaluate(() => window.praxis.settings.getMobileHostInfo());
      const invitation = pairing.invitation!;
      const port = pairing.listener.port!;
      phone = new MobileSecureClient({ endpoint: `127.0.0.1:${port}`, staticKeyPair: generateKeyPair(), remoteStaticPublicKey: Buffer.from(invitation.publicKeyHex, 'hex'),
        pairingTokenId: invitation.tokenId, connectTimeoutMs: 5000, requestTimeoutMs: 5000, legacyReadyAfterMs: 0,
        connect: handlers => {
          const socket = net.createConnection({ host: '127.0.0.1', port }, () => handlers.onConnect());
          socket.on('data', data => handlers.onData(typeof data === 'string' ? Buffer.from(data) : data)); socket.on('error', error => handlers.onError(error)); socket.on('close', () => handlers.onClose());
          return { write: bytes => socket.write(bytes), destroy: () => socket.destroy() };
        },
      });
      const connecting = phone.connect();
      void connecting.catch(() => undefined);
      await expect(win.getByTestId('mobile-pending-device')).toBeVisible();
      await win.getByTestId('mobile-pending-device').getByLabel('Mobile transport project', { exact: true }).check();
      await win.getByTestId('mobile-pending-device').getByLabel('Allow approvals', { exact: true }).check();
      await win.getByTestId('mobile-confirm-device').click(); await connecting;
      await expect(win.getByTestId('mobile-paired-devices')).toContainText('Trusted');
      await expect(win.getByTestId('mobile-listener-status')).toContainText('1 connection');
      const target = { hostId: pairing.hostId, projectId: projects[0].id };
      const caller = { deviceId: 'forged-admin', subject: 'forged-admin', capabilities: ['view', 'execute', 'approve'] as const };
      const read: MobileReadRequest = { protocolVersion: 1, requestId: 'phone-read-01', operation: 'projects.snapshot', caller, target: { hostId: pairing.hostId } };
      const visible = await phone.read<{ projects: Array<{ projectId: string }> }>(read);
      expect(visible.projects.map(project => project.projectId)).toEqual([projects[0].id]);
      await expect(phone.read({ ...read, operation: 'work.list', target: { ...target, projectId: projects[1].id } })).rejects.toThrow(/not authorised for project/);
      const info = await phone.read<{ surfaceRevision: number; scheduledRunExecution: string }>({ ...read, operation: 'host.info' });
      expect(info.surfaceRevision).toBe(8); expect(info.scheduledRunExecution).toBe('planning-only');
      const command: MobileCommand = { protocolVersion: 1, commandId: 'phone-schedule-001', issuedAt: new Date().toISOString(), caller, target,
        operation: 'scheduledRuns.save', payload: { name: 'Mobile adapter proof', date: '2099-11-09', time: '12:00', timezone: 'UTC', issueKeys: [] } };
      const first = await phone.command<{ id: string }>(command); expect(await phone.command(command)).toEqual(first);
      const schedules = await win.evaluate(() => window.praxis.scheduledRuns.list());
      expect(schedules.filter(view => view.run.id === first.id)).toHaveLength(1);
      // Exercise real permission ownership using the existing local ACP fixture.
      await win.evaluate(cliPath => window.praxis.settings.set({ ai: {
        activeProvider: 'claude-code-cli', providers: { 'claude-code-cli': { cliPath, enabled: true } },
      } }), path.join(__dirname, 'fixtures', 'fakeAcpAgent.mjs'));
      const session = await phone.command<{ sessionId: string }>({ ...command, commandId: 'phone-session-001',
        operation: 'sessions.create', payload: { title: 'Phone approval proof', message: 'WITH_PERMISSION please', provider: 'claude-code-cli', mode: 'chat' } });
      expect(session.sessionId).toBeTruthy();
      let pending: Array<{ requestId: string; sessionId: string }> = [];
      await expect.poll(async () => {
        pending = await phone!.read({ ...read, operation: 'attention.list', target });
        return pending.some(item => item.sessionId === session.sessionId);
      }, { timeout: 15000 }).toBe(true);
      const permission = pending.find(item => item.sessionId === session.sessionId)!;
      const response = await phone.command<{ requestId: string }>({ ...command, commandId: 'phone-approve-001',
        operation: 'permissions.respond', target: { ...target, requestId: permission.requestId }, payload: { decision: 'allow' } });
      expect(response.requestId).toBe(permission.requestId);
      await expect.poll(async () => {
        const records = await win.evaluate(() => window.praxis.ai.listSessions());
        return records.find(record => record.sessionId === session.sessionId)?.state;
      }, { timeout: 15000 }).toBe('completed');
      expect((await app.callHost('mobile:status')).connectionCount).toBeGreaterThanOrEqual(1);
      {
        const folder = path.resolve(__dirname, '../../.praxis/session-artifacts'); fs.mkdirSync(folder, { recursive: true });
        await win.screenshot({ path: path.join(folder, 'rust-mobile-desktop-connected.png') });
      }
      const previousKey = invitation.publicKeyHex;
      await win.evaluate(() => window.praxis.settings.rotateMobileHostKey());
      await expect.poll(() => phone!.isReady).toBe(false);
      await expect(win.getByTestId('mobile-listener-status')).toContainText('Listening');
      const rotated = await win.evaluate(() => window.praxis.settings.getMobileHostInfo());
      expect(rotated.publicKeyHex).not.toBe(previousKey); expect(rotated.listener.connectionCount).toBe(0);
      await expect.poll(async () => (await app.callHost('mobile:status')).listening).toBe(true);
      await chooseOption(win.getByTestId('mobile-access-mode'), 'off');
      await expect(win.getByTestId('mobile-listener-status')).toContainText('Not listening');
    } finally {
      phone?.close(); await closeTestApp(app);
    }
  });
}

test('a phone pairs and works through the relay, and leaving internet mode drops it', async () => {
  test.setTimeout(90000);
  const relay = new RelayServer({ host: '127.0.0.1', port: 0 });
  await relay.start();
  const relayUrl = `ws://127.0.0.1:${relay.port}`;
  const app = await launchTestApp(undefined, undefined, { PRAXIS_MOBILE_RELAY_URL: relayUrl });
  let paired: Awaited<ReturnType<typeof pairPhone>> | undefined;
  try {
    const project = await createProject(app.window, app.userDataDir, 'REL', 'Relay project');
    paired = await pairPhone(app, 'Relay project', 'internet', ({ relay: route }) => relayConnector(route!.url, route!.channel));
    const route = paired.relay!;
    expect(route.url).toBe(relayUrl);
    expect(route.channel).toMatch(/^[0-9a-f]{32}$/);
    const read = { protocolVersion: 1, requestId: 'relay-read-01', operation: 'projects.snapshot', caller: callerFor, target: { hostId: paired.pairing.hostId } } as MobileReadRequest;
    const visible = await paired.phone.client.read<{ projects: Array<{ projectId: string }> }>(read);
    expect(visible.projects.map(item => item.projectId)).toEqual([project.id]);
    await chooseOption(app.window.getByTestId('mobile-access-mode'), 'off');
    await expect.poll(() => paired!.phone.client.isReady).toBe(false);
    // The host's control connection is gone, so the relay has no route for the channel any more.
    const dead = new WebSocket(`${relayUrl}/v1/connect?channel=${route.channel}`);
    dead.on('error', () => undefined);
    const closeCode = await new Promise<number>(resolve => dead.on('close', code => resolve(code)));
    expect(closeCode).toBeGreaterThanOrEqual(4000);
  } finally {
    paired?.phone.client.close(); await closeTestApp(app); await relay.stop();
  }
});

test('the event feed carries live session snapshots and the desktop appearance, and replays after a reconnect', async () => {
  test.setTimeout(90000);
  const app = await launchTestApp();
  const win = app.window;
  let paired: Awaited<ReturnType<typeof pairPhone>> | undefined;
  let again: Phone | undefined;
  try {
    const project = await createProject(win, app.userDataDir, 'EVT', 'Event project');
    paired = await pairPhone(app, 'Event project', 'local-only', ({ port }) => lanConnector(port));
    const { phone } = paired;
    const target = { hostId: paired.pairing.hostId, projectId: project.id };
    const command = (operation: string, commandId: string, payload: unknown) => ({ protocolVersion: 1, commandId, issuedAt: new Date().toISOString(), caller: callerFor, target, operation, payload }) as unknown as MobileCommand;

    // host.appearance: a valid theme is announced once, a malformed one is dropped, a repeat is silent.
    const colors = Object.fromEntries(['bg', 'bgElevated', 'bgSunken', 'bgInput', 'border', 'borderStrong', 'text', 'textSecondary', 'textTertiary', 'accent', 'accentContrast', 'success', 'warning', 'danger'].map(key => [key, '#2C2620']));
    const appearance = { themeId: 'e2e-theme', themeName: 'E2E theme', mode: 'dark', colors };
    await app.callHost('settings:publishMobileAppearance', { ...appearance, colors: { ...colors, bg: 'red' } });
    await app.callHost('settings:publishMobileAppearance', appearance);
    await app.callHost('settings:publishMobileAppearance', appearance);
    await expect.poll(() => phone.events.filter(item => item.event.type === 'host.appearance').length).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(phone.events.filter(item => item.event.type === 'host.appearance')).toHaveLength(1);
    const announced = phone.events.find(item => item.event.type === 'host.appearance')!.event.appearance as { themeId: string; colors: Record<string, string> };
    expect(announced.themeId).toBe('e2e-theme');
    expect(announced.colors.bg).toBe('#2c2620');

    // session.snapshot: live events as the agent works.
    await win.evaluate(cliPath => window.praxis.settings.set({ ai: {
      activeProvider: 'claude-code-cli', providers: { 'claude-code-cli': { cliPath, enabled: true } },
    } }), path.join(__dirname, 'fixtures', 'fakeAcpAgent.mjs'));
    const session = await phone.client.command<{ sessionId: string }>(command('sessions.create', 'evt-session-001', { title: 'Feed proof', message: 'hello', provider: 'claude-code-cli', mode: 'chat' }));
    await expect.poll(() => phone.events.some(item => item.event.type === 'session.snapshot'), { timeout: 15000 }).toBe(true);
    await expect.poll(async () => (await win.evaluate(() => window.praxis.ai.listSessions())).find(record => record.sessionId === session.sessionId)?.state, { timeout: 15000 }).toBe('completed');
    const sequences = phone.events.map(item => item.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    const seenBefore = Math.max(...sequences);

    // phone.replay(n): a reconnecting phone resumes from its cursor and is handed what it missed.
    phone.client.close();
    await expect.poll(async () => (await app.callHost('mobile:status')).connectionCount).toBe(0);
    await app.callHost('settings:publishMobileAppearance', { ...appearance, themeId: 'while-away', colors: { ...colors, bg: '#102030' } });
    again = newPhone(paired.connect, paired.endpoint, paired.invitation.publicKeyHex, paired.keys);
    await again.client.connect();
    const replay = await again.client.replay(seenBefore);
    expect(replay.replaying).toBe(true);
    expect(replay.latestSequence).toBeGreaterThan(seenBefore);
    await expect.poll(() => again!.events.length, { timeout: 15000 }).toBeGreaterThan(0);
    expect(again.events.every(item => item.sequence > seenBefore)).toBe(true);
    expect(again.events.map(item => item.event.type)).toContain('host.appearance');
    expect((again.events.find(item => item.event.type === 'host.appearance')!.event.appearance as { themeId: string }).themeId).toBe('while-away');
  } finally {
    again?.client.close(); paired?.phone.client.close(); await closeTestApp(app);
  }
});

test('a phone rejects a run awaiting approval, with a recorded reason', async () => {
  test.setTimeout(90000);
  const app = await launchTestApp();
  const win = app.window;
  let paired: Awaited<ReturnType<typeof pairPhone>> | undefined;
  try {
    // A run builds an isolated copy from Git history, so the project folder must be a repository.
    const folder = path.join(app.userDataDir, 'RJT');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'README.md'), '# Reject\n');
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init']]) execFileSync('git', args, { cwd: folder });
    const project = await createProject(win, app.userDataDir, 'RJT', 'Reject project');
    const started = await win.evaluate(async projectId => {
      const now = new Date().toISOString();
      await window.praxis.workflows.save(projectId, { schemaVersion: 1, id: 'phone-reject', name: 'Approval only', scope: 'project', projectId, version: 1, entryNodeId: 'approve', createdAt: now, updatedAt: now, edges: [],
        nodes: [{ type: 'approval', id: 'approve', name: 'Approve', x: 0, y: 0, inputs: [], prompt: 'Ship?', requiredGates: [], allowBypass: false }] } as never);
      return window.praxis.workflows.startRun(projectId, 'phone-reject', 'Phone reject proof');
    }, project.id);
    const runId = (started as { runId: string }).runId;
    const run = () => win.evaluate(id => window.praxis.workflows.getRun(id), runId);
    await expect.poll(async () => (await run())?.status, { timeout: 20000 }).toBe('awaiting-approval');

    paired = await pairPhone(app, 'Reject project', 'local-only', ({ port }) => lanConnector(port));
    const { phone } = paired;
    const target = { hostId: paired.pairing.hostId, projectId: project.id, runId };
    const reject = (commandId: string, payload: unknown, over: Record<string, unknown> = {}) => ({ protocolVersion: 1, commandId, issuedAt: new Date().toISOString(), caller: callerFor, target, operation: 'workflowGates.reject', payload, ...over }) as unknown as MobileCommand;
    await expect(phone.client.command(reject('reject-blank-001', { reason: '  ' }))).rejects.toThrow(/Say why you are rejecting/);
    expect((await run())?.status).toBe('awaiting-approval');
    await expect(phone.client.command(reject('reject-foreign-001', { reason: 'nope' }, { target: { ...target, runId: 'does-not-exist' } }))).rejects.toThrow();
    expect((await run())?.status).toBe('awaiting-approval');

    await phone.client.command(reject('reject-ok-001', { reason: 'Not ready to ship' }));
    await expect.poll(async () => (await run())?.status, { timeout: 20000 }).not.toBe('awaiting-approval');
    expect(JSON.stringify(await run())).toContain('Not ready to ship');
  } finally {
    paired?.phone.client.close(); await closeTestApp(app);
  }
});
