import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const {
  AiSessionManager,
  VercelAgentService,
  AcpAgentHost,
  getProviderDescriptor,
  McpClientPool,
  createMcpToolExtension,
  enabledMcpServers,
  mcpServerAppliesToProvider,
  describeMcpServerProblem,
  sanitizeMcpServers,
  ticketReviewSessionKey,
  reviewedIssueKey,
  buildTicketReviewGoal,
  GitWorktreeManager,
  WorktreeConflictError,
  discoverWorkspaceAgentWorkflows
} = require('../../../packages/core/out');

class PersistentKeyValueStore {
  private filePath?: string;
  private data = new Map<string, any>();

  constructor(filePath?: string) {
    this.filePath = filePath;
    if (filePath && fs.existsSync(filePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        for (const [k, v] of Object.entries(raw)) {
          this.data.set(k, v);
        }
      } catch {}
    }
  }

  get<T>(key: string, defaultValue?: T): T {
    return this.data.has(key) ? this.data.get(key) : defaultValue!;
  }

  async update(key: string, value: any): Promise<void> {
    this.data.set(key, value);
    if (this.filePath) {
      try {
        const obj: Record<string, any> = {};
        for (const [k, v] of this.data.entries()) {
          obj[k] = v;
        }
        fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), 'utf8');
      } catch {}
    }
  }
}

export class AiHost {
  private sessionManager: any;
  private vercelService: any;
  private acpHost: any;
  private mcpPool: any;
  private onSessionsChangedCb?: (sessions: any[], record?: any) => void;

  constructor(userDataDirOrCb?: string | ((sessions: any[], record?: any) => void), onSessionsChanged?: (sessions: any[], record?: any) => void) {
    let userDataDir: string | undefined;
    let cb = onSessionsChanged;
    if (typeof userDataDirOrCb === 'string') {
      userDataDir = userDataDirOrCb;
    } else if (typeof userDataDirOrCb === 'function') {
      cb = userDataDirOrCb;
    }
    this.onSessionsChangedCb = cb;
    const storePath = userDataDir ? path.join(userDataDir, 'ai-sessions.json') : undefined;
    this.sessionManager = new AiSessionManager(new PersistentKeyValueStore(storePath));
    this.mcpPool = new McpClientPool(() => {});
    this.vercelService = new VercelAgentService(this.sessionManager, { appendLine: () => {} });
    this.acpHost = new AcpAgentHost(this.sessionManager, { appendLine: () => {} });

    this.sessionManager.onDidChangeAgentSession((record: any) => {
      this.onSessionsChangedCb?.(this.sessionManager.listAgentSessionSummaries(), record);
    });
  }

  public listSessions(): any[] {
    return this.sessionManager.listAgentSessionSummaries();
  }

  public getSession(key: string): any {
    return this.sessionManager.getAgentSession(key) || null;
  }

  public async delegate(input: any, settings: any, env: any): Promise<any> {
    const provider = input?.provider || settings?.ai?.activeProvider || 'vercel-gateway';
    const provConfig = settings?.ai?.providers?.[provider];
    if (provConfig?.enabled === false) {
      throw new Error(`Provider '${provider}' is turned off in Settings.`);
    }

    const issueKey = input.issueKey || (input.projectKey ? `${input.projectKey}-${randomUUID().slice(0, 4)}` : `SESSION-${randomUUID().slice(0, 8)}`);
    const issue = {
      key: issueKey,
      summary: input.goal || input.task?.goal || 'Task',
      issueType: 'Task',
      status: 'New',
      projectKey: input.projectKey || 'SESSION',
      projectId: input.projectId
    };
    const taskDefinition = {
      goal: input.goal || input.task?.goal || 'Task',
      kind: input.mode === 'analysis' ? 'analysis' : 'chat',
      projectId: input.projectId,
      ...input.task
    };

    let toolExtension: any = undefined;
    if (input.toolMode === 'full') {
      const servers = enabledMcpServers(settings?.ai?.mcpServers || []).filter((s: any) =>
        mcpServerAppliesToProvider(s, provider)
      );
      if (servers.length) {
        toolExtension = await createMcpToolExtension(servers, this.mcpPool);
      }
    }

    const gatewayUrl = env?.AI_GATEWAY_URL || env?.VERCEL_AI_GATEWAY_URL || settings?.ai?.gatewayUrl || undefined;
    const apiKey = env?.AI_GATEWAY_API_KEY || 'test-key';

    // Optional dedicated worktree branched off the working folder's current branch
    // (mirrors the retired Electron main's ai:delegate).
    let worktree: { worktreePath: string; branchName: string; baseBranch: string; worktreeName: string } | undefined;
    if (input.runInWorktree) {
      if (!input.workingDirectory) throw new Error('Pick a git repository folder to run this session in a worktree.');
      let baseBranch: string | undefined;
      try {
        baseBranch = require('node:child_process').execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: input.workingDirectory, encoding: 'utf8' }).trim();
      } catch {}
      if (!baseBranch || baseBranch === 'HEAD') baseBranch = settings?.delivery?.defaultBaseBranch?.trim();
      if (!baseBranch) throw new Error('Could not determine a base branch for the worktree (detached HEAD?).');
      const manager = new GitWorktreeManager({ appendLine: () => {} });
      try {
        const prepared = await manager.prepareDeliveryWorktree({ key: issueKey, summary: issue.summary }, baseBranch, input.workingDirectory, { forceClean: false });
        worktree = { worktreePath: prepared.worktreePath, branchName: prepared.branchName, baseBranch: prepared.baseBranch, worktreeName: prepared.worktreeName };
      } catch (error) {
        if (error instanceof WorktreeConflictError) {
          throw new Error(`A worktree for ${issueKey} already exists at ${(error as any).worktreePath}. Remove it (or that session) and retry.`);
        }
        throw error;
      }
      input = { ...input, workingDirectory: worktree.worktreePath };
    }

    const descriptor = getProviderDescriptor(provider);
    const isCli = descriptor?.kind === 'cli-agent' || Boolean(provConfig?.cliPath) || provider.includes('cli');
    if (isCli) {
      const cliPath = provConfig?.cliPath || 'claude';
      const isScript = cliPath.endsWith('.js') || cliPath.endsWith('.mjs');
      const command = isScript ? process.execPath : cliPath;
      const args = isScript ? [cliPath] : [];
      await this.acpHost.startTask(
        issue as any,
        taskDefinition as any,
        provider,
        {
          command,
          args,
          toolMode: input.toolMode ?? 'full',
          permissionMode: input.permissionMode ?? 'manual',
          workingDirectory: input.workingDirectory || process.cwd(),
          projectId: input.projectId,
          connectionId: input.connectionId,
          linkedIssueKey: input.linkedIssueKey,
          workflowId: input.workflowId
        }
      );
    } else {
      await this.vercelService.startTask(issue as any, taskDefinition as any, {
        provider,
        toolMode: input.toolMode ?? 'full',
        permissionMode: input.permissionMode ?? 'manual',
        // Mirrors the retired Electron main: bypass/autopilot pre-approve tool calls.
        ...((input.permissionMode === 'bypass' || input.permissionMode === 'autopilot') ? { autoApprovePermissions: true } : {}),
        toolExtension,
        workingDirectory: input.workingDirectory || process.cwd(),
        gatewayUrl,
        apiKey,
        projectId: input.projectId,
        connectionId: input.connectionId,
        linkedIssueKey: input.linkedIssueKey,
        workflowId: input.workflowId
      });
    }

    if (input.projectId) {
      try {
        this.sessionManager.assignAgentSession(issueKey, input.projectId, input.linkedIssueKey);
      } catch {}
    }

    const session = this.sessionManager.getAgentSession(issueKey);
    if (session) {
      if (input.workflowRunId) session.workflowRunId = input.workflowRunId;
      if (input.workflowNodeId) session.workflowNodeId = input.workflowNodeId;
      if (input.workflowRole) session.workflowRole = input.workflowRole;
      if (input.workflowId) session.workflowId = input.workflowId;
      if (input.workingDirectory) {
        session.workingDirectory = input.workingDirectory;
        session.worktreePath = input.workingDirectory;
      }
      this.sessionManager.updateAgentRuntime(issueKey, {
        workflowRole: input.workflowRole || (input.workflowRunId ? 'stage' : undefined),
        workingDirectory: input.workingDirectory,
        ...(worktree ? {
          worktreePath: worktree.worktreePath,
          worktreeBranch: worktree.branchName,
          worktreeBaseBranch: worktree.baseBranch,
          worktreeName: worktree.worktreeName
        } : {})
      });
      void this.sessionManager.persistAgentSessions?.();
    }

    return this.sessionManager.getAgentSession(issueKey) ?? session;
  }

  /** Mirrors the retired Electron main's ai:listWorkflowPacks. */
  public async listWorkflowPacks(settings: any, projects: any[]): Promise<any[]> {
    const configuredRoot = String(settings?.ai?.workingDirectory ?? '').trim();
    const projectRoot = (projects || []).map(p => p?.workspaceFolder?.trim()).find((f: any) => Boolean(f));
    return discoverWorkspaceAgentWorkflows(configuredRoot || projectRoot || undefined);
  }

  public getWorkflowAssignment(issueKey: string): any {
    return this.sessionManager.getIssueWorkflowAssignment(issueKey);
  }

  public setWorkflowAssignment(issueKey: string, workflow: any): void {
    if (workflow) this.sessionManager.setIssueWorkflowAssignment(issueKey, workflow, { source: 'manual' });
    else this.sessionManager.removeIssueWorkflowAssignment(issueKey);
  }

  public async removeWorktree(issueKey: string): Promise<void> {
    const record = this.sessionManager.getAgentSession(issueKey);
    if (!record) throw new Error(`No agent session found for ${issueKey}.`);
    if (!['completed', 'failed', 'aborted'].includes(record.state)) {
      throw new Error('Wait for the current session to finish before removing its worktree.');
    }
    const worktreePath = record.worktreePath?.trim();
    const worktreeBranch = record.worktreeBranch?.trim();
    if (!worktreePath || !worktreeBranch) throw new Error(`Session ${issueKey} has no dedicated worktree.`);
    const manager = new GitWorktreeManager({ appendLine: () => {} });
    try {
      await manager.removeDeliveryWorktree(worktreePath, { worktreePath, branchName: worktreeBranch });
    } catch (error) {
      throw new Error(`Could not remove the session worktree: ${error instanceof Error ? error.message : String(error)}`);
    }
    // The session ran in the worktree, so point it back at the main checkout.
    this.sessionManager.updateAgentRuntime(issueKey, {
      workingDirectory: path.dirname(path.dirname(worktreePath)),
      worktreePath: '',
      worktreeBranch: '',
      worktreeBaseBranch: '',
      worktreeName: ''
    });
  }

  public async waitForCompletion(issueKey: string, timeoutMs = 30000): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const session = this.sessionManager.getAgentSession(issueKey);
      if (session && !(session as any)._handoverInProgress) {
        if (session.state === 'completed' || session.state === 'failed' || session.state === 'aborted') {
          return session;
        }
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return this.sessionManager.getAgentSession(issueKey);
  }

  public attachWorkflowRun(key: string, runId: string): void {
    const session = this.sessionManager.getAgentSession(key);
    if (session) {
      if (!session.workflowRunIds) session.workflowRunIds = [];
      if (!session.workflowRunIds.includes(runId)) {
        session.workflowRunIds.push(runId);
      }
      session.workflowRunId = runId;
      void this.sessionManager.persistAgentSessions?.();
      this.sessionManager._onDidChangeAgentSession?.fire?.(session);
    }
  }

  public respondToPermission(issueKey: string, decision: any): void {
    this.vercelService.respondToPermission(issueKey, decision);
  }

  public async startTicketReview(input: any, settings: any, trackerRegistry: any): Promise<any> {
    const provider = input.provider || settings?.ai?.activeProvider || 'claude-code-cli';
    const provConfig = settings?.ai?.providers?.[provider];
    if (provConfig?.enabled === false) {
      throw new Error(`Provider '${provider}' is turned off in Settings.`);
    }

    let issue = await trackerRegistry.call(input.connectionId, 'getIssue', input.issueKey);
    if (!issue && trackerRegistry.hasService()) {
      issue = await trackerRegistry.call(undefined, 'getIssue', input.issueKey);
    }
    if (!issue) {
      issue = {
        key: input.issueKey,
        summary: `Review ${input.issueKey}`,
        description: '',
        issueType: 'Task',
        status: 'To Do'
      };
    }

    const sessionKey = ticketReviewSessionKey(issue.key);
    const existing = this.sessionManager.getAgentSession(sessionKey);
    if (existing) {
      if (this.acpHost.hasActiveTask(sessionKey)) {
        await this.acpHost.abortTask(sessionKey);
      }
    }

    const goal = buildTicketReviewGoal(issue);
    const cliPath = provConfig?.cliPath || 'claude';
    const isScript = cliPath.endsWith('.js') || cliPath.endsWith('.mjs');
    const command = isScript ? process.execPath : cliPath;
    const args = isScript ? [cliPath] : [];

    const taskDefinition = {
      kind: 'ticket-review',
      sessionMode: 'review',
      goal,
      scope: 'Read-only review of this ticket and any workspace context it references.',
      definitionOfDone: 'A verdict is presented and each actionable finding is offered as a decision.',
      nonGoals: ['Do not edit files or write to the tracker.'],
      completionContract: 'Stop after presenting the review and wait for the user to answer the decisions.'
    };

    let workingDir = input.workingDirectory;
    if (!workingDir && input.connectionId) {
      try {
        const s = await trackerRegistry.getService(input.connectionId);
        workingDir = s?.boardRoots?.[0]?.rootPath;
      } catch {}
    }
    if (!workingDir) workingDir = process.cwd();

    const projectId = input.projectId || (input.connectionId?.startsWith('project:') ? input.connectionId.slice(8) : undefined);

    await this.acpHost.startTask(
      { ...issue, key: sessionKey },
      taskDefinition as any,
      provider,
      {
        command,
        args,
        toolMode: 'read-only',
        permissionMode: 'manual',
        workingDirectory: workingDir,
        projectId,
        connectionId: input.connectionId,
        linkedIssueKey: issue.key
      }
    );

    const record = this.sessionManager.getAgentSession(sessionKey);
    if (record) {
      if (input.connectionId) {
        this.sessionManager.updateAgentRuntime(sessionKey, { connectionId: input.connectionId });
      }
      if (projectId) {
        try {
          this.sessionManager.assignAgentSession(sessionKey, projectId, issue.key);
        } catch {}
      }
      this.sessionManager.renameAgentSession(sessionKey, `Review ${issue.key} — ${issue.summary}`);
    }
    return this.sessionManager.getAgentSession(sessionKey) || record;
  }

  public getTicketReview(issueKey: string): any {
    return this.getSession(ticketReviewSessionKey(issueKey));
  }

  public async continueSession(issueKey: string, message: string, images?: any[], _options?: any, settings?: any): Promise<void> {
    const session = this.sessionManager.getAgentSession(issueKey);
    if (!session) throw new Error(`Session ${issueKey} not found.`);
    // The session's own provider owns the follow-up; the active provider may differ.
    const provider = session.provider || session.runtimeOptions?.provider || settings?.ai?.activeProvider || 'claude-code-cli';
    const provConfig = settings?.ai?.providers?.[provider];
    const descriptor = getProviderDescriptor(provider);
    if (descriptor?.kind !== 'cli-agent' && !provConfig?.cliPath) {
      await this.vercelService.resumeTask(issueKey, {
        provider,
        toolMode: session.toolMode,
        permissionMode: session.permissionMode,
        workingDirectory: session.workingDirectory || process.cwd(),
        gatewayUrl: process.env.AI_GATEWAY_URL || settings?.ai?.gatewayUrl || undefined,
        apiKey: process.env.AI_GATEWAY_API_KEY || 'test-key'
      }, message, images);
      return;
    }
    const cliPath = provConfig?.cliPath || 'claude';
    const isScript = cliPath.endsWith('.js') || cliPath.endsWith('.mjs');
    const command = isScript ? process.execPath : cliPath;
    const args = isScript ? [cliPath] : [];

    await this.acpHost.continueTask(
      issueKey,
      message,
      {
        command,
        args,
        images,
        toolMode: session.runtimeOptions?.toolMode || 'read-only',
        permissionMode: session.runtimeOptions?.permissionMode || 'manual',
        workingDirectory: session.workingDirectory || process.cwd(),
        projectId: session.projectId,
        connectionId: session.connectionId,
        linkedIssueKey: session.linkedIssueKey
      }
    );
  }

  public async testMcpServer(candidate: any): Promise<any> {
    const problem = describeMcpServerProblem(candidate);
    if (problem) return { ok: false, error: problem };
    const [config] = sanitizeMcpServers([{ ...candidate, id: candidate.id || 'test' }]);
    if (!config) return { ok: false, error: 'That server configuration is not valid.' };
    const probePool = new McpClientPool(() => {});
    try {
      const result = await probePool.probe(config);
      return {
        ok: true,
        serverName: result.serverName,
        tools: result.tools.map((tool: any) => ({ name: tool.name, description: tool.description }))
      };
    } catch (error: any) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      try { await probePool.closeAll(); } catch {}
    }
  }

  public async dispose(): Promise<void> {
    try {
      await this.acpHost.dispose();
    } catch {}
    try {
      await this.mcpPool.closeAll();
    } catch {}
  }
}
