import { test, expect } from '@playwright/test';
import * as net from 'node:net';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { MobileSecureClient, generateKeyPair } from '@praxis/mobile-protocol';
import type { MobileCommand, MobileReadRequest } from '@praxis/core';
import { launchTestApp, closeTestApp, notReproducible } from './launchTestApp';
import { chooseOption } from './chipSelect';
import { selectRustHostBinary } from './rustHostSelection';

const modes = (['typescript', 'rust'] as const).filter(mode =>
  !process.env.PRAXIS_EXPECT_MOBILE_TRANSPORT || process.env.PRAXIS_EXPECT_MOBILE_TRANSPORT === mode);
for (const mode of modes) {
  test(`real phone pairing, scoped reads, schedule idempotency and key rotation on ${mode}`, async () => {
    test.setTimeout(90000);
    const app = await launchTestApp(undefined, undefined, {
      PRAXIS_MOBILE_TRANSPORT: mode,
      PRAXIS_RUST_CHANNELS: mode === 'rust' ? 'default' : 'none',
      PRAXIS_RUST_HOST_BIN: mode === 'rust' ? selectRustHostBinary(path.resolve(__dirname, '../../../..')) : undefined,
    });
    const win = app.window;
    let phone: MobileSecureClient | undefined;
    const childPids: number[] = [];
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
      const diagnostic = await notReproducible('reads the Electron-main mobile listener diagnostics (mobileListenerInstance); the Rust backend does not expose them');
      expect(diagnostic.mode).toBe(mode);
      if (mode === 'rust') { childPids.push(diagnostic.pid); expect(diagnostic.ready).toBe(true); expect(diagnostic.crateVersion).toBeTruthy(); expect(diagnostic.pid).toBeGreaterThan(0); }
      console.log(`[mobile-dual-mode] ${JSON.stringify(diagnostic)}`);
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
      if (mode === 'rust') {
        const served = await notReproducible('reads the Electron-main mobile listener diagnostics (mobileListenerInstance); the Rust backend does not expose them');
        expect(served.pid).toBe(diagnostic.pid);
        expect(served.readCalls).toBeGreaterThan(0);
        expect(served.commandCalls).toBeGreaterThanOrEqual(4);
        console.log(`[mobile-dual-mode] Served requests: ${JSON.stringify(served)}`);
      }
      if (mode === 'rust') {
        const folder = path.resolve(__dirname, '../../.praxis/session-artifacts'); fs.mkdirSync(folder, { recursive: true });
        await win.screenshot({ path: path.join(folder, 'rust-mobile-desktop-connected.png') });
      }
      const previousKey = invitation.publicKeyHex;
      await win.evaluate(() => window.praxis.settings.rotateMobileHostKey());
      await expect.poll(() => phone!.isReady).toBe(false);
      await expect(win.getByTestId('mobile-listener-status')).toContainText('Listening');
      const rotated = await win.evaluate(() => window.praxis.settings.getMobileHostInfo());
      expect(rotated.publicKeyHex).not.toBe(previousKey); expect(rotated.listener.connectionCount).toBe(0);
      if (mode === 'rust') {
        const next = await notReproducible('reads the Electron-main mobile listener diagnostics (mobileListenerInstance); the Rust backend does not expose them');
        expect(next.ready).toBe(true); expect(next.pid).not.toBe(diagnostic.pid); childPids.push(next.pid);
      }
      await chooseOption(win.getByTestId('mobile-access-mode'), 'off');
      await expect(win.getByTestId('mobile-listener-status')).toContainText('Not listening');
    } finally {
      phone?.close(); await closeTestApp(app);
      await expect.poll(() => childPids.every(pid => { try { process.kill(pid, 0); return false; } catch { return true; } })).toBe(true);
    }
  });
}
