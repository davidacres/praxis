import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron';
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_WORKFLOW,
  mergeAppSettings,
  normalizeWorkflowStages,
  parsePlanFolder,
  readBoardConfigFile,
  readWorkspaceFile,
  resolvePlanDependencyKeys,
  resolvePortableFolderPath,
  resolveStatus,
  sanitizeAppSettings,
  toPortableFolderPath,
  toWorkspaceFile,
  validateWorkflowStages,
  type AppSettings,
  type ParsedPlanFolder,
  type ProjectRecord,
  type ProjectWorkflowStage,
  type RustEventEnvelope,
  type RustHostStatus,
  type WorkspaceRecord
} from '@praxis/core';
import { ProjectManager } from './projectManager';
import { attachRendererNavigationGuard, isOwnRendererSender, rendererDir } from './rendererNavigationGuard';
import {
  RustHostBridge,
  RustHostRpcError,
  StdioRustHostTransport,
  broadcastRustEventToWindows
} from './rustHostBridge';

function createMockWindow(
  sent: Array<{ winId: string; channel: string; args: unknown[] }>,
  winId: string,
  destroyed = false
): BrowserWindow {
  const mainFrame = {
    isDestroyed: () => destroyed,
    url: pathToFileURL(path.join(rendererDir, 'index.html')).toString()
  };
  const webContents = {
    isDestroyed: () => destroyed,
    isCrashed: () => false,
    mainFrame,
    on: () => undefined,
    setWindowOpenHandler: () => undefined,
    send: (channel: string, ...args: unknown[]) => {
      sent.push({ winId, channel, args });
    }
  };
  return {
    isDestroyed: () => destroyed,
    webContents
  } as unknown as BrowserWindow;
}

test('StdioRustHostTransport + RustHostBridge: spawns praxis-host with isolated profile, dispatches RPCs, and streams events to main and detached chat windows', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-rust-host-test-'));
  const settingsPath = path.join(userDataDir, 'test-settings.json');
  const sentToWindows: Array<{ winId: string; channel: string; args: unknown[] }> = [];
  const mainWin = createMockWindow(sentToWindows, 'main');
  const detachedChatWin = createMockWindow(sentToWindows, 'detached-chat-FX-1');
  const closedWin = createMockWindow(sentToWindows, 'closed', true);

  const transport = new StdioRustHostTransport({
    userDataDir,
    settingsPath,
    demoMode: true,
    e2eMode: true
  });
  const bridge = new RustHostBridge({
    transport,
    getWindows: () => [mainWin, detachedChatWin, closedWin]
  });

  try {
    await bridge.start();
    const status = await bridge.invoke<RustHostStatus>('host:status');
    assert.equal(status.protocolVersion, 1);
    assert.equal(typeof status.crateVersion, 'string');

    const config = await bridge.invoke<{
      userDataDir: string;
      settingsPath: string;
      demoMode: boolean;
      e2eMode: boolean;
      registeredChannels: string[];
    }>('host:getConfig');
    assert.equal(config.userDataDir, userDataDir);
    assert.equal(config.settingsPath, settingsPath);
    assert.equal(config.demoMode, true);
    assert.equal(config.e2eMode, true);
    assert.ok(config.registeredChannels.includes('host:status'));

    // Seed safeStorage-unlocked secrets and read them back via the Rust secret store.
    const count = await bridge.syncSecrets({
      'github:conn-1:pat': 'ghp_isolated_secret',
      'ai:anthropic:apiKey': 'sk-ant-test'
    });
    assert.equal(count, 2);
    assert.equal(await bridge.invoke<boolean>('host:secrets:has', 'github:conn-1:pat'), true);
    assert.equal(
      await bridge.invoke<string | null>('host:secrets:get', 'github:conn-1:pat'),
      'ghp_isolated_secret'
    );

    // Emit a Rust domain event and verify it is broadcast to both mainWindow and detachedChatWin.
    const receivedEvents: RustEventEnvelope[] = [];
    const onEventPromise = new Promise<void>(resolve => {
      bridge.onEvent(envelope => {
        receivedEvents.push(envelope);
        if (receivedEvents.length === 2) resolve();
      });
    });

    await bridge.invoke('host:emitEvent', 'settings:changed', { theme: 'midnight' });
    await bridge.invoke('host:emitEvent', 'runs:statusChanged', [
      'proj-1',
      { serviceId: 'web', state: 'running' }
    ]);
    await onEventPromise;

    // 2 live windows * 2 events = 4 window sends; closedWin is skipped.
    assert.equal(sentToWindows.length, 4);
    assert.deepEqual(sentToWindows[0], {
      winId: 'main',
      channel: 'settings:changed',
      args: [{ theme: 'midnight' }]
    });
    assert.deepEqual(sentToWindows[1], {
      winId: 'detached-chat-FX-1',
      channel: 'settings:changed',
      args: [{ theme: 'midnight' }]
    });
    // Multi-arg channel (`runs:statusChanged`) spreads [projectId, status] to match preload/index.ts.
    assert.deepEqual(sentToWindows[2], {
      winId: 'main',
      channel: 'runs:statusChanged',
      args: ['proj-1', { serviceId: 'web', state: 'running' }]
    });
    assert.deepEqual(sentToWindows[3], {
      winId: 'detached-chat-FX-1',
      channel: 'runs:statusChanged',
      args: ['proj-1', { serviceId: 'web', state: 'running' }]
    });

    await assert.rejects(
      () => bridge.invoke('unregistered:domainChannel'),
      (err: unknown) =>
        err instanceof RustHostRpcError && err.code === 'CHANNEL_NOT_REGISTERED'
    );
  } finally {
    await bridge.dispose();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('RustHostBridge.handleOrFallback: switches channels between TypeScript fallback and Rust host while preserving sender verification', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-rust-fallback-test-'));
  const settingsPath = path.join(userDataDir, 'test-settings.json');
  const transport = new StdioRustHostTransport({
    userDataDir,
    settingsPath
  });
  const bridge = new RustHostBridge({ transport });

  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const guardedMockIpc: Pick<IpcMain, 'handle'> = {
    handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => any) => {
      handlers.set(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        if (!isOwnRendererSender(event, undefined)) {
          throw new Error('IPC sender is not a trusted application renderer.');
        }
        return listener(event, ...args);
      });
    }
  };

  const sent: Array<{ winId: string; channel: string; args: unknown[] }> = [];
  const trustedWin = createMockWindow(sent, 'main');
  attachRendererNavigationGuard(trustedWin, undefined);

  const trustedEvent = {
    sender: trustedWin.webContents,
    senderFrame: trustedWin.webContents.mainFrame
  } as unknown as IpcMainInvokeEvent;

  // Untrusted child WebContentsView (e.g. previewBrowser / aiBrowser loaded on https://example.com)
  const untrustedEvent = {
    sender: {
      isDestroyed: () => false,
      mainFrame: { isDestroyed: () => false, url: 'https://example.com/preview' }
    },
    senderFrame: { isDestroyed: () => false, url: 'https://example.com/preview' }
  } as unknown as IpcMainInvokeEvent;

  try {
    bridge.handleOrFallback(
      'host:ping',
      async (_event, arg: string) => ({ pong: false, source: 'ts-fallback', arg }),
      guardedMockIpc
    );

    const invokeHandler = handlers.get('host:ping')!;
    // 1. Before marking migrated, invokes the TypeScript fallback handler.
    const fallbackResult = await invokeHandler(trustedEvent, 'hello');
    assert.deepEqual(fallbackResult, { pong: false, source: 'ts-fallback', arg: 'hello' });

    // 2. Mark channel migrated -> delegates to Rust host without re-registering IPC.
    bridge.markChannelMigrated('host:ping');
    assert.equal(bridge.isChannelMigrated('host:ping'), true);
    const rustResult = await invokeHandler(trustedEvent, 'hello');
    assert.deepEqual(rustResult, { pong: true, args: ['hello'] });

    // 3. Untrusted child WebContentsView is rejected by sender verification before reaching Rust.
    assert.throws(
      () => invokeHandler(untrustedEvent, 'hello'),
      /IPC sender is not a trusted application renderer/
    );
  } finally {
    await bridge.dispose();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('broadcastRustEventToWindows: preserves single-array payloads for detachedChat:changed', () => {
  const sent: Array<{ winId: string; channel: string; args: unknown[] }> = [];
  const win = createMockWindow(sent, 'main');
  broadcastRustEventToWindows(
    { channel: 'detachedChat:changed', payload: ['FX-101', 'FX-102'] },
    [win]
  );
  assert.deepEqual(sent, [
    {
      winId: 'main',
      channel: 'detachedChat:changed',
      args: [['FX-101', 'FX-102']]
    }
  ]);
});

test('Rust host settings and workspace channels produce byte-identical results to @praxis/core', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-rust-golden-test-'));
  const settingsPath = path.join(userDataDir, 'settings.json');
  const transport = new StdioRustHostTransport({
    userDataDir,
    settingsPath
  });
  const bridge = new RustHostBridge({ transport });

  try {
    await bridge.start();

    // 1. Fresh settings:get matches sanitizeAppSettings({})
    const rustDefaults = await bridge.invoke<AppSettings>('settings:get');
    assert.deepEqual(rustDefaults, sanitizeAppSettings({}));

    // 2. Complex sanitize + merge golden comparison
    const complexPatch = {
      startup: { reopenLastWorkspace: false },
      appearance: {
        surfacePackId: 'graphite',
        accentColor: '#12ABcd',
        surface: {
          intensity: 0.65,
          motif: {
            id: 'hexagon',
            scale: 999,
            opacity: 0.4,
            ink: 'custom' as const,
            inkColor: '#4ec9b0',
            placement: 'corner' as const,
            anchors: ['top-right' as const, 'bottom-left' as const]
          }
        }
      },
      ai: {
        providerHandoverPercent: 85,
        activityWords: ['Analyzing', 'Synthesizing'],
        codeIntelligence: {
          enabled: false,
          projectOverrides: { '/repo/praxis': true },
          searchMode: 'hybrid' as const
        }
      },
      mobileAccess: {
        mode: 'local-only' as const,
        allowedSubnets: ['192.168.1.0/24', 'fd00::/8']
      }
    };

    const rustUpdated = await bridge.invoke<AppSettings>('settings:set', complexPatch);
    const tsExpected = JSON.parse(
      JSON.stringify(sanitizeAppSettings(mergeAppSettings(DEFAULT_APP_SETTINGS, complexPatch)))
    ) as AppSettings;
    assert.deepEqual(rustUpdated, tsExpected);

    // 3. Workspace file serialization, secret stripping, folderInspection removal, and portable path resolution
    const workspace: WorkspaceRecord = {
      id: 'ws-golden',
      name: 'Golden Team',
      description: 'Portable workspace test',
      projectIds: ['proj-1'],
      connectionIds: ['conn-1'],
      objectives: ['Zero drift'],
      defaultProjectId: 'proj-1',
      storagePath: '/Users/someone/dev/praxis/golden-team.workspace.praxis.json',
      createdAt: '2026-11-08T00:00:00.000Z',
      updatedAt: '2026-11-08T00:00:00.000Z',
      createdWithAppVersion: '0.1.0',
      lastSavedWithAppVersion: '0.1.0',
      schemaVersion: 2
    };
    const contents = {
      projects: [
        {
          id: 'proj-1',
          name: 'Praxis',
          key: 'PRX',
          type: 'software' as const,
          purpose: '',
          brief: {},
          storage: 'folder' as const,
          workspaceFolder: '/Users/someone/dev/praxis/apps/praxis-desktop',
          workflowStages: [],
          defaultBoardId: 'board-1',
          workItems: [],
          linkedBoards: [],
          defaultAiToolMode: 'full' as const,
          folderInspection: {
            path: '/Users/someone/dev/praxis/apps/praxis-desktop',
            exists: true,
            isDirectory: true,
            hasGit: true,
            projectFileExists: true,
            manifests: ['package.json'],
            languages: ['TypeScript'],
            frameworks: ['Electron']
          },
          createdAt: '2026-11-08T00:00:00.000Z',
          updatedAt: '2026-11-08T00:00:00.000Z'
        }
      ],
      connections: [
        {
          id: 'conn-1',
          name: 'Plans',
          type: 'folder' as const,
          mode: 'folder' as const,
          baseUrl: '',
          HasStoredSecret: false,
          settings: {
            roots: ['/Users/someone/dev/praxis/docs/plans', '/opt/external/plans'],
            apiToken: 'must-be-stripped',
            pat: 'must-also-be-stripped'
          }
        }
      ],
      boards: []
    };

    const wsDir = '/Users/someone/dev/praxis';
    const rustDoc = await bridge.invoke('workspaces:toFile', workspace, contents, wsDir);
    const tsDoc = toWorkspaceFile(workspace, contents, wsDir);
    assert.deepEqual(rustDoc, tsDoc);

    const rawJson = JSON.stringify(rustDoc, null, 2);
    const cloneDir = '/Volumes/work/cloned-praxis';
    const rustRead = await bridge.invoke('workspaces:readFile', rawJson, cloneDir);
    const tsRead = readWorkspaceFile(rawJson, cloneDir);
    assert.deepEqual(rustRead, tsRead);

    assert.equal(
      await bridge.invoke<string>('workspaces:toPortablePath', '/Users/someone/dev/praxis/apps/web', wsDir),
      toPortableFolderPath('/Users/someone/dev/praxis/apps/web', wsDir)
    );
    assert.equal(
      await bridge.invoke<string>('workspaces:resolvePortablePath', './apps/web', cloneDir),
      resolvePortableFolderPath('./apps/web', cloneDir)
    );
  } finally {
    await bridge.dispose();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('Rust host projectWorkflow, projectSnapshot, and markdownPlanParser match @praxis/core over real apps/praxis-desktop/docs/plans', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-rust-folder-golden-'));
  const settingsPath = path.join(userDataDir, 'settings.json');
  const transport = new StdioRustHostTransport({
    userDataDir,
    settingsPath
  });
  const bridge = new RustHostBridge({ transport });

  try {
    await bridge.start();

    // 1. Workflow resolution & normalization parity
    const rustDefaultWf = await bridge.invoke<ProjectWorkflowStage[]>('projects:defaultWorkflow');
    assert.deepEqual(rustDefaultWf, DEFAULT_WORKFLOW);

    const customStages = [
      { id: '1', name: 'Triage' },
      { id: '2', name: 'Build' },
      { id: '3', name: 'Shipped' }
    ] as unknown as ProjectWorkflowStage[];
    const rustNormalized = await bridge.invoke<ProjectWorkflowStage[]>(
      'projects:normalizeWorkflowStages',
      customStages
    );
    assert.deepEqual(rustNormalized, normalizeWorkflowStages(customStages));

    for (const sample of ['📋 Proposed', '🔄 In Progress', '🚫 Blocked', '✅ Complete', 'Under Review', 'unknown-token']) {
      assert.equal(
        await bridge.invoke<string>('projects:resolveStatus', sample, rustNormalized),
        resolveStatus(sample, rustNormalized)
      );
      assert.equal(
        await bridge.invoke<string>('projects:resolveStatus', sample, null),
        resolveStatus(sample)
      );
    }

    assert.equal(
      await bridge.invoke<string | null>('projects:validateWorkflowStages', rustNormalized),
      validateWorkflowStages(rustNormalized) ?? null
    );

    // 2. writeProjectSnapshot marker safety parity in isolated temp directories
    const tsSnapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-ts-snap-'));
    const rustSnapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-rust-snap-'));
    try {
      const sampleProject: ProjectRecord = {
        id: 'proj-snap',
        name: 'Snapshot Verification',
        key: 'SNAP',
        type: 'software',
        purpose: 'Verify marker-protected project.praxis.md generation.',
        brief: { constraints: 'Never overwrite unmarked files', targetUsers: 'Developers' },
        storage: 'folder',
        workspaceFolder: rustSnapDir,
        workflowStages: rustNormalized,
        defaultBoardId: '1',
        workItems: [],
        linkedBoards: [],
        defaultAiToolMode: 'full',
        createdAt: '2026-11-08T00:00:00.000Z',
        updatedAt: '2026-11-08T00:00:00.000Z'
      };
      const pm = new ProjectManager({} as never);
      await pm.refreshProjectFile({ ...sampleProject, workspaceFolder: tsSnapDir });
      const rustStatus1 = await bridge.invoke<string>('projects:writeSnapshot', rustSnapDir, sampleProject);
      assert.equal(rustStatus1, 'created');
      assert.equal(
        fs.readFileSync(path.join(rustSnapDir, 'project.praxis.md'), 'utf8'),
        fs.readFileSync(path.join(tsSnapDir, 'project.praxis.md'), 'utf8')
      );

      // Unmarked file must be retained untouched by both
      const unmarkedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-unmarked-snap-'));
      fs.writeFileSync(path.join(unmarkedDir, 'project.praxis.md'), '# Hand-authored file\nDo not touch.\n', 'utf8');
      const retainedStatus = await bridge.invoke<string>('projects:writeSnapshot', unmarkedDir, sampleProject);
      assert.equal(retainedStatus, 'retained');
      assert.equal(
        fs.readFileSync(path.join(unmarkedDir, 'project.praxis.md'), 'utf8'),
        '# Hand-authored file\nDo not touch.\n'
      );
      fs.rmSync(unmarkedDir, { recursive: true, force: true });
    } finally {
      fs.rmSync(tsSnapDir, { recursive: true, force: true });
      fs.rmSync(rustSnapDir, { recursive: true, force: true });
    }

    // 3. Real plans folder (`apps/praxis-desktop/docs/plans`) read-only parse & dependency graph parity
    const realPlansRoot = path.resolve(__dirname, '../../../docs/plans');
    const boardCfg = await readBoardConfigFile(realPlansRoot);
    const rustBoardCfg = await bridge.invoke('folder:readBoardConfig', realPlansRoot);
    assert.deepEqual(rustBoardCfg, boardCfg);

    const projectKey = boardCfg.projectKey ?? 'PRAXIS';
    const tsParsed = await parsePlanFolder(realPlansRoot, undefined, boardCfg.workflow);
    const tsDepsRecord = Object.fromEntries(resolvePlanDependencyKeys(tsParsed, projectKey).entries());

    const rustParseResult = await bridge.invoke<{
      parsed: ParsedPlanFolder;
      dependencyKeys: Record<string, string[]>;
    }>('folder:parsePlanFolder', realPlansRoot, boardCfg.workflow ?? null, projectKey);

    assert.equal(rustParseResult.parsed.plansRootPath, tsParsed.plansRootPath);
    assert.equal(rustParseResult.parsed.featuresRootPath, tsParsed.featuresRootPath);
    assert.equal(rustParseResult.parsed.features.length, tsParsed.features.length);
    assert.equal(rustParseResult.parsed.stories.length, tsParsed.stories.length);
    assert.equal(rustParseResult.parsed.childItems.length, tsParsed.childItems.length);

    // Strip `undefined` fields on TS objects via JSON round-trip to compare serialized shapes directly
    const normalizedTsFeatures = JSON.parse(JSON.stringify(tsParsed.features));
    const normalizedTsStories = JSON.parse(JSON.stringify(tsParsed.stories));
    const normalizedTsChildren = JSON.parse(JSON.stringify(tsParsed.childItems));

    assert.deepEqual(rustParseResult.parsed.features, normalizedTsFeatures);
    assert.deepEqual(rustParseResult.parsed.stories, normalizedTsStories);
    assert.deepEqual(rustParseResult.parsed.childItems, normalizedTsChildren);
    assert.deepEqual(rustParseResult.dependencyKeys, tsDepsRecord);
  } finally {
    await bridge.dispose();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
