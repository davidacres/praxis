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
  buildCommitGraph,
  buildPartialHunkPatch,
  buildWorktreeName,
  discoverPlanFolders,
  ensureFrontMatter,
  mergeAppSettings,
  normalizeWorkflowStages,
  parseGitBranches,
  parseGitDiff,
  parseGitLog,
  parseGitStatus,
  parseGitTags,
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
  type GitBranchInfo,
  type GitCommitNode,
  type GitDiffFile,
  type GitRepositorySnapshot,
  type GitStatusSnapshot,
  type ParsedPlanFolder,
  type ProjectRecord,
  type ProjectWorkflowStage,
  type RustEventEnvelope,
  type RustHostStatus,
  type WorkspaceRecord
} from '@praxis/core';
import { getGitStatus, loadGitRepository, preflightGitRepository } from './gitService';
import { ProjectManager } from './projectManager';
import { attachRendererNavigationGuard, isOwnRendererSender, rendererDir } from './rendererNavigationGuard';
import {
  RustHostBridge,
  RustHostRpcError,
  StdioRustHostTransport,
  broadcastRustEventToWindows,
  hasRustHostBinary
} from './rustHostBridge';
import {
  DEFAULT_MIGRATED_CHANNELS,
  resolveInitialMigratedChannels
} from './rustHostInstance';

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

test('StdioRustHostTransport git:* and worktree:* channels match @praxis/core and gitService output', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-rust-git-'));
  const settingsPath = path.join(userDataDir, 'settings.json');
  const transport = new StdioRustHostTransport({
    userDataDir,
    settingsPath
  });
  const bridge = new RustHostBridge({ transport });

  try {
    await bridge.start();
    // 1. Parsers and graph layout parity
    const branchFixture = 'refs/heads/main\0abc123456789\0*\0\nrefs/remotes/origin/main\0def987654321\0\0refs/remotes/origin/main\n';
    const tsBranches = JSON.parse(JSON.stringify(parseGitBranches(branchFixture)));
    const rustBranches = await bridge.invoke<GitBranchInfo[]>('git:parseBranches', branchFixture);
    assert.deepEqual(rustBranches, tsBranches);

    const tagFixture = 'v1.0.0\0abc123456789\n';
    assert.deepEqual(await bridge.invoke('git:parseTags', tagFixture), parseGitTags(tagFixture));

    const logFixture = 'abc123456789\0base00000000\0Alice\x002026-01-02T00:00:00Z\0feat: add widget\0body text\x1ebase00000000\0\0Alice\x002026-01-01T00:00:00Z\0initial\0\x1e';
    const tsLog = parseGitLog(logFixture);
    assert.deepEqual(await bridge.invoke('git:parseLog', logFixture), tsLog);

    const tsGraph = buildCommitGraph(
      tsLog,
      new Map([['abc123456789', ['main', 'tag:v1.0.0']]]),
      tsBranches
    );
    const rustGraph = await bridge.invoke<GitCommitNode[]>(
      'git:buildCommitGraph',
      tsLog,
      { abc123456789: ['main', 'tag:v1.0.0'] },
      tsBranches
    );
    assert.deepEqual(rustGraph, tsGraph);

    const statusFixture = ' M src/index.ts\0A  src/new.ts\0UU src/conflict.ts\0';
    const tsStatus = JSON.parse(JSON.stringify(parseGitStatus(statusFixture, '/repo', 'main')));
    const rustStatus = await bridge.invoke<GitStatusSnapshot>('git:parseStatus', statusFixture, '/repo', 'main');
    assert.deepEqual(rustStatus, tsStatus);

    const diffFixture = [
      'diff --git a/src/old.ts b/src/new.ts',
      'similarity index 80%',
      'rename from src/old.ts',
      'rename to src/new.ts',
      'index 1111111..2222222 100644',
      '--- a/src/old.ts',
      '+++ b/src/new.ts',
      '@@ -1,3 +1,3 @@',
      ' const stable = true;',
      '-const oldName = 1;',
      '+const newName = 2;',
      ' export { stable };',
      ''
    ].join('\n');
    const tsDiff = JSON.parse(JSON.stringify(parseGitDiff(diffFixture)));
    const rustDiff = await bridge.invoke<GitDiffFile[]>('git:parseDiff', diffFixture);
    assert.deepEqual(rustDiff, tsDiff);

    const tsPartial = buildPartialHunkPatch(tsDiff[0].hunks[0], [2]);
    const rustPartial = await bridge.invoke<string>('git:buildPartialHunkPatch', rustDiff[0].hunks[0], [2]);
    assert.equal(rustPartial, tsPartial);

    // 2. Worktree naming parity
    for (const issue of [
      { key: 'FX-BE-195', summary: 'FX-BE-195: Port Core Domain, Folder Board, and Git', branch: undefined },
      { key: 'TASK-516', summary: 'Port git CLI parser, graph builder, and worktree manager', branch: undefined },
      { key: 'BUG-42', summary: '', branch: 'fix/custom-branch' }
    ]) {
      assert.equal(
        await bridge.invoke<string>('worktree:buildName', issue),
        buildWorktreeName(issue)
      );
    }

    // 3. Live repository preflight & open parity against this repo
    const repoRoot = path.resolve(__dirname, '../../../../..');
    const tsPreflight = JSON.parse(JSON.stringify(await preflightGitRepository(repoRoot)));
    const rustPreflight = await bridge.invoke('git:preflight', repoRoot);
    assert.deepEqual(rustPreflight, tsPreflight);

    const tsSnapshot = await loadGitRepository(repoRoot, { force: true });
    const rustSnapshot = await bridge.invoke<GitRepositorySnapshot>('git:open', repoRoot);
    assert.equal(rustSnapshot.repositoryPath, tsSnapshot.repositoryPath);
    assert.equal(rustSnapshot.repositoryName, tsSnapshot.repositoryName);
    assert.equal(rustSnapshot.head, tsSnapshot.head);
    assert.equal(rustSnapshot.currentBranch, tsSnapshot.currentBranch);
    assert.deepEqual(rustSnapshot.branches, JSON.parse(JSON.stringify(tsSnapshot.branches)));
    assert.deepEqual(rustSnapshot.tags, tsSnapshot.tags);
    assert.deepEqual(rustSnapshot.commits, JSON.parse(JSON.stringify(tsSnapshot.commits)));

    const tsRepoStatus = JSON.parse(JSON.stringify(await getGitStatus(repoRoot)));
    const rustRepoStatus = await bridge.invoke<GitStatusSnapshot>('git:status', repoRoot);
    assert.deepEqual(rustRepoStatus, tsRepoStatus);
  } finally {
    await bridge.dispose();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('hasRustHostBinary and resolveInitialMigratedChannels: environment flag and binary presence', () => {
  assert.equal(hasRustHostBinary(), true);

  const prevEnv = process.env.PRAXIS_RUST_CHANNELS;
  try {
    delete process.env.PRAXIS_RUST_CHANNELS;
    const defaultChannels = resolveInitialMigratedChannels();
    assert.ok(defaultChannels.includes('git:status'));
    assert.ok(defaultChannels.includes('git:preflight'));
    assert.ok(defaultChannels.includes('host:status'));
    assert.equal(defaultChannels.length, DEFAULT_MIGRATED_CHANNELS.length);

    process.env.PRAXIS_RUST_CHANNELS = 'none';
    assert.deepEqual(resolveInitialMigratedChannels(), []);

    process.env.PRAXIS_RUST_CHANNELS = 'git:*';
    const gitOnly = resolveInitialMigratedChannels();
    assert.ok(gitOnly.length > 0);
    assert.ok(gitOnly.every(c => c.startsWith('git:')));
  } finally {
    if (prevEnv !== undefined) {
      process.env.PRAXIS_RUST_CHANNELS = prevEnv;
    } else {
      delete process.env.PRAXIS_RUST_CHANNELS;
    }
  }
});

test('RustHostBridge.handleOrFallback: gracefully falls back to TypeScript when Rust channel is not registered', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-rust-unregistered-fallback-'));
  const settingsPath = path.join(userDataDir, 'test-settings.json');
  const transport = new StdioRustHostTransport({
    userDataDir,
    settingsPath
  });
  const bridge = new RustHostBridge({ transport });

  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const mockIpc: Pick<IpcMain, 'handle'> = {
    handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => any) => {
      handlers.set(channel, listener);
    }
  };

  const dummyEvent = {} as IpcMainInvokeEvent;

  try {
    await bridge.start();

    // Register a channel that does not exist on praxis-host
    bridge.handleOrFallback(
      'unregistered:customChannel',
      async (_event, val: string) => `ts-fallback-${val}`,
      mockIpc
    );

    bridge.markChannelMigrated('unregistered:customChannel');

    const invoke = handlers.get('unregistered:customChannel')!;
    // Should attempt Rust, receive CHANNEL_NOT_REGISTERED, and fall back to TS without throwing
    const result = await invoke(dummyEvent, 'probe');
    assert.equal(result, 'ts-fallback-probe');
  } finally {
    await bridge.dispose();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('DEFAULT_MIGRATED_CHANNELS contains settings:*, folder:*, plans:*, and folderService:*', () => {
  // settings:set stays on TypeScript until its mobile-subnet validation is ported (TASK-536).
  assert.ok(!DEFAULT_MIGRATED_CHANNELS.includes('settings:set'));
  const expectedChannels = [
    'settings:get',
    'settings:sanitize',
    'settings:merge',
    'folder:discoverPlans',
    'folder:discoverPlanFolders',
    'folder:discoverRepositoryFolders',
    'folder:parsePlanFolder',
    'folder:readBoardConfig',
    'folder:writeBoardConfig',
    'folder:ensureFrontMatter',
    'plans:discoverPlans',
    'plans:discoverPlanFolders',
    'plans:parsePlanFolder',
    'plans:readBoardConfig',
    'plans:writeBoardConfig',
    'plans:ensureFrontMatter',
    'folderService:getBoards',
    'folderService:getBoardDetails',
    'folderService:getIssues',
    'folderService:getIssue',
    'folderService:getTransitions',
    'folderService:createIssue',
    'folderService:updateIssue',
    'folderService:transitionIssue',
    'folderService:addComment'
  ];

  for (const channel of expectedChannels) {
    assert.ok(
      DEFAULT_MIGRATED_CHANNELS.includes(channel),
      `DEFAULT_MIGRATED_CHANNELS missing ${channel}`
    );
  }

  const prevEnv = process.env.PRAXIS_RUST_CHANNELS;
  try {
    process.env.PRAXIS_RUST_CHANNELS = 'settings:*,plans:*';
    const channels = resolveInitialMigratedChannels();
    assert.ok(channels.includes('settings:get'));
    assert.ok(!channels.includes('settings:set'));
    assert.ok(channels.includes('plans:parsePlanFolder'));
    assert.ok(channels.includes('plans:discoverPlans'));
    assert.ok(!channels.includes('git:status'));
  } finally {
    if (prevEnv !== undefined) {
      process.env.PRAXIS_RUST_CHANNELS = prevEnv;
    } else {
      delete process.env.PRAXIS_RUST_CHANNELS;
    }
  }
});

test('RustHostBridge.handleOrFallback: routes settings:*, folder:*, and plans:* through Rust when migrated', async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-rust-wiring-test-'));
  const settingsPath = path.join(userDataDir, 'test-settings.json');
  const transport = new StdioRustHostTransport({
    userDataDir,
    settingsPath,
    demoMode: true,
    e2eMode: true
  });
  const bridge = new RustHostBridge({
    transport,
    migratedChannels: [
      'settings:get',
      'settings:set',
      'folder:discoverPlans',
      'plans:discoverPlans',
      'folder:parsePlanFolder',
      'plans:parsePlanFolder',
      'plans:readBoardConfig',
      'plans:ensureFrontMatter'
    ]
  });

  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const mockIpc: Pick<IpcMain, 'handle'> = {
    handle: (channel: string, listener: (event: IpcMainInvokeEvent, ...args: any[]) => any) => {
      handlers.set(channel, listener);
    }
  };
  const dummyEvent = {} as IpcMainInvokeEvent;

  try {
    await bridge.start();

    let tsFallbackCalled = false;
    bridge.handleOrFallback(
      'settings:get',
      async () => {
        tsFallbackCalled = true;
        return { tsFallback: true };
      },
      mockIpc
    );

    const getHandler = handlers.get('settings:get')!;
    const settingsResult = (await getHandler(dummyEvent)) as AppSettings;
    assert.equal(tsFallbackCalled, false, 'Should have routed to Rust, not TS fallback');
    assert.ok(settingsResult.startup, 'Should have returned AppSettings from Rust');

    bridge.handleOrFallback(
      'settings:set',
      async () => {
        tsFallbackCalled = true;
        return { tsFallback: true };
      },
      mockIpc
    );
    const setHandler = handlers.get('settings:set')!;
    const patchResult = (await setHandler(dummyEvent, {
      startup: { reopenLastWorkspace: false }
    })) as AppSettings;
    assert.equal(tsFallbackCalled, false, 'Should have routed to Rust, not TS fallback');
    assert.equal(patchResult.startup.reopenLastWorkspace, false);

    // Test plans:ensureFrontMatter
    bridge.handleOrFallback(
      'plans:ensureFrontMatter',
      async (_event, content: string) => `ts-${content}`,
      mockIpc
    );
    const fmHandler = handlers.get('plans:ensureFrontMatter')!;
    const fmResult = (await fmHandler(dummyEvent, '# My Plan\n\nContent', 'Bug')) as string;
    assert.ok(fmResult.includes('**Type:** Bug'), 'Rust plans:ensureFrontMatter injected Bug frontmatter');

    // Test folder:discoverPlans with real plans directory
    const realPlansRoot = path.resolve(__dirname, '../../../docs/plans');
    bridge.handleOrFallback(
      'folder:discoverPlans',
      async () => [{ plansRootPath: 'ts-fallback' }],
      mockIpc
    );
    const discHandler = handlers.get('folder:discoverPlans')!;
    const discResult = (await discHandler(dummyEvent, realPlansRoot)) as Array<{ plansRootPath: string }>;
    assert.ok(Array.isArray(discResult));
    assert.ok(discResult.length > 0);
    assert.ok(discResult[0].plansRootPath.length > 0);
    assert.notEqual(discResult[0].plansRootPath, 'ts-fallback');

    // Test plans:readBoardConfig with real plans directory
    bridge.handleOrFallback(
      'plans:readBoardConfig',
      async () => ({ projectKey: 'FALLBACK' }),
      mockIpc
    );
    const bcfgHandler = handlers.get('plans:readBoardConfig')!;
    const bcfgResult = (await bcfgHandler(dummyEvent, realPlansRoot)) as { projectKey?: string };
    assert.ok(bcfgResult.projectKey, 'Read board config from Rust plans:readBoardConfig');
    assert.notEqual(bcfgResult.projectKey, 'FALLBACK');

    // Test fallback when channel is unmigrated
    bridge.handleOrFallback(
      'unmigrated:channel',
      async (_event, arg: string) => `ts-handled-${arg}`,
      mockIpc
    );
    const unmigratedHandler = handlers.get('unmigrated:channel')!;
    const unmigratedResult = await unmigratedHandler(dummyEvent, 'test');
    assert.equal(unmigratedResult, 'ts-handled-test');
  } finally {
    await bridge.dispose();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
