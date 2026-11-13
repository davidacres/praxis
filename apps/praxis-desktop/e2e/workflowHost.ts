import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const {
  WorkflowOrchestrator,
  createWorkflowRun,
  summarizeWorkflowRun,
  GitWorktreeManager,
  applyWorkflowRunCommand,
  isRunSettled,
  advanceJoins,
  builtInWorkflowTemplates,
  instantiateTemplateForProject,
  validateWorkflow,
  estimateWorkflowRun,
  resolveRunParameters,
  preflightWorkflow,
  approveStage,
  resolveApprovalTarget,
  stageSessionKey,
  canRetry,
  isTestFile,
  sourceHooks,
  testReferences
} = require('../../../packages/core/out');

const { buildStageContext } = require('../../../packages/core/out/workflows/workflowStageSession');
const { buildStageTaskDefinition, formatUpstreamLogs, formatUpstreamReports } = require('../../../packages/core/out/workflows/workflowStageTask');
const { skipApproval } = require('../../../packages/core/out/workflows/workflowGates');
const { parsePublishablePlan, planIssueInputs } = require('../../../packages/core/out/workflows/workflowPlanPublishing');
const { parseReviewFindings } = require('../../../packages/core/out/ai/aiReviewService');

export interface WorkflowHostOptions {
  userDataDir: string;
  getProject: (projectId: string) => any;
  getSettings?: () => any;
  aiHost?: any;
  agentRuntime?: any;
  trackerRegistry?: any;
  onRunChanged?: (summary: any, run: any) => void;
}

export class WorkflowHost {
  private runs = new Map<string, any>();
  private definitions = new Map<string, any>();
  private evidence = new Map<string, string>();
  private orchestrator: any;
  private worktreeManager = new GitWorktreeManager({ appendLine: () => {} });

  constructor(private readonly options: WorkflowHostOptions) {
    this.orchestrator = new WorkflowOrchestrator({
      runs: {
        get: (runId: string) => this.runs.get(runId),
        save: async (run: any) => {
          this.runs.set(run.runId, run);
          this.notifyRunChanged(run);
          return run;
        }
      },
      dispatcher: {
        canDispatch: (node: any, run: any) => {
          const project = this.options.getProject(run.projectId);
          const folder = project?.workspaceFolder?.trim();
          return Boolean(folder && fs.existsSync(folder));
        },
        runCheck: async (node: any, context: any) => this.dispatchCheck(node, context),
        runAgentStage: async (node: any, context: any, onSession?: (id: string) => void) =>
          this.dispatchAgent(node, context, onSession),
        runMerge: async (node: any, context: any) => this.dispatchMerge(node, context),
        cancelStage: async () => {}
      },
      workspace: {
        acquire: async (run: any) => this.acquireWorktree(run),
        release: async (run: any) => this.releaseWorktree(run),
        baseRef: async (_run: any, worktreePath: string) => {
          try {
            const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: worktreePath });
            return stdout.trim();
          } catch {
            return undefined;
          }
        },
        restore: async () => {}
      },
      onRunChanged: (run: any) => {
        this.notifyRunChanged(run);
      }
    });
  }

  private notifyRunChanged(run: any): void {
    if (run.status === 'failed') {
      console.log('[WorkflowHost Failed Run]', JSON.stringify({ status: run.status, error: run.error, nodes: run.nodes }));
    }
    const summary = summarizeWorkflowRun(run);
    this.options.onRunChanged?.(summary, run);
  }

  public saveWorkflow(projectId: string, definition: any): any {
    const key = `${projectId}:${definition.id}`;
    this.definitions.set(key, definition);
    return definition;
  }

  public getWorkflow(projectId: string, workflowId: string): any {
    const key = `${projectId}:${workflowId}`;
    if (this.definitions.has(key)) return this.definitions.get(key);
    const builtIns = builtInWorkflowTemplates();
    const match = builtIns.find((t: any) => t.id === workflowId);
    if (match) return match;
    const addonsDir = path.join(this.options.userDataDir, 'addons', 'workflow-template');
    if (fs.existsSync(addonsDir)) {
      for (const entry of fs.readdirSync(addonsDir)) {
        const tFile = path.join(addonsDir, entry, 'template.json');
        if (fs.existsSync(tFile)) {
          try {
            const parsed = JSON.parse(fs.readFileSync(tFile, 'utf8'));
            if (parsed.id === workflowId || entry === workflowId) return parsed;
          } catch {}
        }
      }
    }
    return undefined;
  }

  public instantiate(projectId: string, templateId: string): any {
    let template = this.getWorkflow(projectId, templateId);
    if (!template) {
      const builtIns = builtInWorkflowTemplates();
      template = builtIns.find((t: any) => t.id === templateId) || builtIns[0];
    }
    const created = instantiateTemplateForProject({
      template,
      projectId,
      newId: templateId.endsWith(`-${projectId}`) ? templateId : undefined,
      at: new Date().toISOString()
    });
    this.saveWorkflow(projectId, created);
    return created;
  }

  public prepareRun(projectId: string, workflowId: string, supplied?: Record<string, unknown>) {
    let definition = this.getWorkflow(projectId, workflowId);
    if (!definition) {
      const builtIns = builtInWorkflowTemplates();
      definition = builtIns.find((t: any) => t.id === workflowId) || builtIns[0];
    }
    const { values, issues } = resolveRunParameters(definition, supplied);
    const settings = this.options.getSettings?.() || {};
    const active = settings.ai?.activeProvider;
    const estimate = estimateWorkflowRun(definition, {
      parameters: values,
      threshold: settings.delivery?.runConfirmAgentSessions,
      providerFor: (node: any) => (node.type === 'agent-task' || node.type === 'map' ? node.agent?.providerId?.trim() || active || undefined : undefined),
      tierModel: (provider: string, tier: string) => (provider && tier ? settings.ai?.modelTiers?.[provider]?.[tier]?.trim() || undefined : undefined)
    });
    return {
      parameters: definition.parameters ?? [],
      requiresMeasurableGoal: definition.requiresMeasurableGoal === true,
      estimate,
      issues: supplied ? issues : []
    };
  }

  public validate(projectId: string, definition: any): any {
    return validateWorkflow(definition);
  }

  public async checkRunBase(projectId: string): Promise<{ blockingFiles: string[] }> {
    const project = this.options.getProject(projectId);
    const folder = project?.workspaceFolder?.trim();
    if (!folder || !fs.existsSync(folder)) return { blockingFiles: [] };
    const blocking = await this.getBlockingFiles(folder);
    return { blockingFiles: blocking };
  }

  private async getBlockingFiles(folder: string): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd: folder });
      return stdout
        .split('\n')
        .map(line => line.slice(3).trim())
        .filter(f => f && !f.startsWith('.praxis/') && !f.endsWith('.praxis.json') && !f.endsWith('.praxis.md'));
    } catch {
      return [];
    }
  }

  public async startRun(
    projectId: string,
    workflowId: string,
    taskTitle: string,
    issue?: any,
    controller?: any,
    planInput?: any,
    options?: any
  ): Promise<any> {
    const project = this.options.getProject(projectId);
    const folder = project?.workspaceFolder?.trim();

    // Check dirty product checkout
    if (folder && fs.existsSync(folder) && options?.uncommittedChanges !== 'include' && options?.uncommittedChanges !== 'omit') {
      const blocking = await this.getBlockingFiles(folder);
      if (blocking.length > 0) {
        const examples = blocking.slice(0, 3).join(', ');
        throw new Error(
          `${blocking.length} uncommitted ${blocking.length === 1 ? 'file' : 'files'} in this project ` +
            `${blocking.length === 1 ? 'is' : 'are'} not in the last commit` +
            `${examples ? ` (${examples}${blocking.length > 3 ? ', …' : ''})` : ''}, ` +
            'and a workflow run works from a copy of that commit. Commit or stash them and try again, ' +
            'or choose to include them or start without them.'
        );
      }
    }

    let definition = this.getWorkflow(projectId, workflowId);
    if (!definition) {
      const builtIns = builtInWorkflowTemplates();
      const template = builtIns.find((t: any) => t.id === workflowId) || builtIns[0];
      definition = instantiateTemplateForProject({
        template,
        projectId,
        at: new Date().toISOString()
      });
    }

    if (this.options.agentRuntime && definition?.nodes) {
      const catalog = await this.options.agentRuntime.list();
      const livePreflight = preflightWorkflow(definition.nodes, catalog);
      if (!livePreflight.ok) {
        const blockers = Object.values(livePreflight.byNode)
          .flatMap((stage: any) => stage.failures)
          .map((failure: any) => `${failure.message} ${failure.remediation}`);
        throw new Error(`Cannot start workflow until its Agent Hub bindings are ready: ${blockers.join(' ')}`);
      }
    }

    const supplied = options?.parameters && typeof options.parameters === 'object' && !Array.isArray(options.parameters)
      ? options.parameters
      : undefined;
    const { values: parameters, issues } = resolveRunParameters(definition, supplied);
    if (issues.length > 0) throw new Error(issues.map((issue: any) => issue.message).join(' '));

    const runId = 'run-' + Math.random().toString(36).slice(2, 8);
    const run = createWorkflowRun({
      runId,
      projectId,
      definition,
      taskTitle: taskTitle || definition.name || 'Task',
      at: new Date().toISOString(),
      issue,
      controllerSessionKey: controller?.sessionKey,
      planInput,
      uncommittedChanges: options?.uncommittedChanges,
      permissionMode: options?.permissionMode,
      aiProvider: options?.aiProvider,
      aiModel: options?.aiModel,
      providerLimitPolicy: options?.providerLimitPolicy,
      ...(Object.keys(parameters).length > 0 ? { parameters } : {})
    });

    this.runs.set(run.runId, run);
    this.notifyRunChanged(run);

    // Step orchestrator in background
    void this.orchestrator.step(run.runId);

    return summarizeWorkflowRun(run);
  }

  public listRuns(projectId?: string): any[] {
    const list = [...this.runs.values()];
    const filtered = projectId ? list.filter(r => r.projectId === projectId) : list;
    return filtered.map(r => summarizeWorkflowRun(r));
  }

  public getRun(runId: string): any | undefined {
    const run = this.runs.get(runId);
    return run ? summarizeWorkflowRun(run) : undefined;
  }

  public async advanceStage(runId: string, nodeId: string, outcome: 'succeeded' | 'failed', detail?: any): Promise<any> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run ${runId} not found`);

    const at = new Date().toISOString();
    let next = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId, at, sessionId: `manual-${nodeId}` });
    const node = next.definition.nodes.find((n: any) => n.id === nodeId);
    const artifacts =
      outcome === 'succeeded' && node && 'outputs' in node
        ? node.outputs.map((contract: any) => ({ contractId: contract.id, kind: contract.kind }))
        : [];

    next = applyWorkflowRunCommand(next, {
      kind: outcome === 'succeeded' ? 'node-succeeded' : 'node-failed',
      nodeId,
      at,
      ...(outcome === 'succeeded'
        ? { artifacts, ...(detail?.snapshotRef ? { snapshotRef: detail.snapshotRef } : {}) }
        : { error: detail?.error ?? 'Stage failed.' }),
      ...(detail?.findings && Array.isArray(detail.findings.findings)
        ? { findings: detail.findings }
        : outcome === 'succeeded' && node && 'outputs' in node && node.outputs.some((contract: any) => contract.kind === 'findings')
          ? { findings: { findings: [], metrics: {} } }
          : {})
    } as never);

    const joined = advanceJoins(next, at);
    this.runs.set(runId, joined);
    this.notifyRunChanged(joined);
    await this.orchestrator.step(runId);
    return summarizeWorkflowRun(this.runs.get(runId)!);
  }

  public async decideLoop(
    runId: string,
    edgeId: string,
    actor: string,
    decision: 'accept' | 'grant' | 'stop',
    reason?: string,
    extraIterations?: number
  ): Promise<any> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run ${runId} not found`);

    const next = applyWorkflowRunCommand(run, {
      kind: 'loop-decided',
      edgeId,
      at: new Date().toISOString(),
      actor,
      decision,
      ...(reason?.trim() ? { reason: reason.trim() } : {}),
      ...(typeof extraIterations === 'number' ? { extraIterations } : {})
    });
    if (next === run) {
      throw new Error(
        decision === 'grant'
          ? 'No more iterations can be granted: the loop is at its ceiling, or it is not waiting for a decision.'
          : 'That loop is not waiting for a decision.'
      );
    }
    this.runs.set(runId, next);
    this.notifyRunChanged(next);
    await this.orchestrator.step(runId);
    return summarizeWorkflowRun(this.runs.get(runId)!);
  }

  public async approveRun(runId: string, actor: string, note?: string, nodeId?: string): Promise<any> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run ${runId} not found`);

    const approval = resolveApprovalTarget(run, nodeId);
    const result = approveStage(
      run,
      approval.id,
      { actor, at: new Date().toISOString(), ...(note ? { note } : {}) }
    );
    if (!result.ok) throw new Error(result.reason ?? 'Approval was refused.');

    const updated = result.run;
    this.runs.set(runId, updated);
    this.notifyRunChanged(updated);
    await this.orchestrator.step(runId);
    return summarizeWorkflowRun(this.runs.get(runId)!);
  }

  public async skipApproval(runId: string, nodeId: string, actor: string): Promise<any> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run ${runId} not found`);

    const result = skipApproval(run, nodeId, { actor: actor || 'desktop-user', at: new Date().toISOString() });
    if (!result.ok) throw new Error(result.reason ?? 'Skip was refused.');

    const updated = result.run;
    this.runs.set(runId, updated);
    this.notifyRunChanged(updated);
    await this.orchestrator.step(runId);
    return summarizeWorkflowRun(this.runs.get(runId)!);
  }

  public async retryStage(runId: string, nodeId: string): Promise<any> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run ${runId} not found`);

    const now = new Date().toISOString();
    const updated = applyWorkflowRunCommand(run, { kind: 'node-retry', nodeId, at: now });
    this.runs.set(runId, updated);
    this.notifyRunChanged(updated);
    void this.orchestrator.step(runId);
    return summarizeWorkflowRun(this.runs.get(runId));
  }

  public async cancelRun(runId: string, reason?: string): Promise<void> {
    await this.orchestrator.cancel(runId, reason);
  }

  public getEvidence(runId: string, nodeId: string, attempt: number): any {
    const key = `${runId}:${nodeId}:${attempt}`;
    const content = this.evidence.get(key);
    if (!content) return { expired: false };
    return {
      entry: { id: `ev-${runId}-${nodeId}`, presence: 'present', retention: 'keep' },
      content,
      expired: false
    };
  }

  public stageReport(runId: string, nodeId: string): string | undefined {
    const key = `${runId}:${nodeId}:1`;
    let content = this.evidence.get(key);
    if (!content && this.options.aiHost) {
      const session = this.options.aiHost.listSessions().find(
        (s: any) => s.workflowRunId === runId && s.workflowNodeId === nodeId
      );
      if (session?.responseText) {
        content = session.responseText;
        this.evidence.set(key, content);
      }
    }
    return content;
  }

  public async startDiagnosis(runId: string, nodeId: string, attempt: number): Promise<any> {
    return { ok: true, sessionKey: `diag-${runId}-${nodeId}` };
  }

  private async acquireWorktree(run: any): Promise<string> {
    const project = this.options.getProject(run.projectId);
    const folder = project?.workspaceFolder?.trim();
    if (!folder) throw new Error(`Project ${run.projectId} has no folder`);

    let baseBranch = 'main';
    try {
      const { stdout } = await execFileAsync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: folder });
      if (stdout.trim()) baseBranch = stdout.trim();
    } catch {}

    const prepared = await this.worktreeManager.prepareDeliveryWorktree(
      { key: `WF-${run.runId}`, summary: run.definition.name },
      baseBranch,
      folder,
      {
        forceClean: false,
        reuseExisting: true,
        requireCleanBase: !run.uncommittedChanges,
        includeUncommitted: run.uncommittedChanges === 'include'
      }
    );
    return prepared.worktreePath;
  }

  private async releaseWorktree(run: any): Promise<void> {
    const project = this.options.getProject(run.projectId);
    const folder = project?.workspaceFolder?.trim();
    if (!folder || !run.worktreePath) return;
    try {
      await this.worktreeManager.removeDeliveryWorktree(
        folder,
        { worktreePath: run.worktreePath, branchName: `WF-${run.runId}` },
        { keepBranch: true }
      );
    } catch {}
  }

  private async dispatchCheck(node: any, context: any): Promise<any> {
    const project = this.options.getProject(context.run.projectId);
    const folder = project?.workspaceFolder?.trim();
    const cwd = context.worktreePath || folder;
    if (!cwd) return { status: 'failed', error: 'No working copy available for check.' };

    const ticketQa = node.satisfiesGate === 'qa' && node.affectedTests !== false;

    // Run check command
    const procResult = await this.spawnCheckProcess(node.command, node.args ?? [], cwd, context.signal, node.timeoutMs);
    let output = procResult.output;
    let exitCode = procResult.code;
    let status: 'succeeded' | 'failed' = exitCode === 0 ? 'succeeded' : 'failed';

    if (ticketQa && context.worktreePath && exitCode === 0 && !context.signal?.aborted) {
      const affected = await this.runChangeTests(context.worktreePath, folder || context.worktreePath);
      if (affected) {
        exitCode = affected.code === 0 ? exitCode : affected.code;
        status = exitCode === 0 ? 'succeeded' : 'failed';
        output = `${output.trimEnd()}\n\n${affected.output}`;
      }
    }

    this.evidence.set(`${context.run.runId}:${node.id}:1`, output);

    return {
      status,
      exitCode: exitCode ?? (status === 'succeeded' ? 0 : 1),
      error: status === 'failed' ? output : undefined,
      artifacts: (node.outputs || []).map((o: any) => ({ contractId: o.id, kind: o.kind }))
    };
  }

  private async spawnCheckProcess(
    command: string,
    args: string[],
    cwd: string,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<{ code: number | null; output: string }> {
    if (signal?.aborted) return { code: null, output: 'Cancelled' };
    return new Promise(resolve => {
      let output = '';
      const child = spawn(command, args, {
        cwd,
        shell: false,
        env: { ...process.env, CI: '1' }
      });
      const timer = timeoutMs ? setTimeout(() => { child.kill(); }, timeoutMs) : undefined;
      const collect = (chunk: Buffer) => { output += chunk.toString(); };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);
      child.on('error', err => {
        if (timer) clearTimeout(timer);
        resolve({ code: 1, output: output + `\n${err.message}` });
      });
      child.on('close', code => {
        if (timer) clearTimeout(timer);
        resolve({ code, output });
      });
    });
  }

  private async runChangeTests(worktreePath: string, projectFolder: string): Promise<{ code: number; output: string }> {
    let baseCommit = 'HEAD~1';
    try {
      const { stdout } = await execFileAsync('git', ['merge-base', 'main', 'HEAD'], { cwd: worktreePath });
      if (stdout.trim()) baseCommit = stdout.trim();
    } catch {}

    const lines: string[] = ['== Tests for this change =='];
    try {
      const { stdout: diffFiles } = await execFileAsync('git', ['diff', '--name-only', '--diff-filter=ACMR', `${baseCommit}..HEAD`], { cwd: worktreePath });
      const changed = diffFiles.split('\n').map(f => f.trim()).filter(Boolean);
      const testFiles: Array<{ file: string; reasons: string[] }> = [];

      for (const f of changed) {
        if (isTestFile(f)) {
          testFiles.push({ file: f, reasons: ['changed by this run'] });
        }
      }

      // Check non-test source files
      const nonTests = changed.filter(f => !isTestFile(f) && /\.[cm]?[jt]sx?$/.test(f));
      if (nonTests.length > 0) {
        const { stdout: allFiles } = await execFileAsync('git', ['ls-files'], { cwd: worktreePath });
        const allTests = allFiles.split('\n').map(f => f.trim()).filter(isTestFile);

        for (const src of nonTests) {
          try {
            const { stdout: diffText } = await execFileAsync('git', ['diff', '-U3', `${baseCommit}..HEAD`, '--', src], { cwd: worktreePath });
            const hooks = sourceHooks(diffText);
            for (const t of allTests) {
              const fullTestPath = path.join(worktreePath, t);
              if (fs.existsSync(fullTestPath)) {
                const content = fs.readFileSync(fullTestPath, 'utf8');
                const reasons = testReferences(content, [{ file: src, hooks }]);
                if (reasons.length > 0 && !testFiles.some(existing => existing.file === t)) {
                  testFiles.push({ file: t, reasons });
                }
              }
            }
          } catch {}
        }
      }

      if (testFiles.length === 0) {
        lines.push('No test files were added or updated in this ticket.');
        return { code: 0, output: lines.join('\n') };
      }

      for (const t of testFiles) {
        lines.push(`- ${t.file}: ${t.reasons.slice(0, 3).join('; ')}`);
      }
      lines.push(`Not run here (no Playwright, Vitest, Jest or pytest setup claims them; the project's own test command covers them): ${testFiles.map(t => t.file).join(', ')}`);
      return { code: 0, output: lines.join('\n') };
    } catch (err: any) {
      lines.push(`Could not pick or run the tests for this change: ${err.message}`);
      return { code: 1, output: lines.join('\n') };
    }
  }

  private async ensureRunDependencies(definition: any, worktreePath: string): Promise<void> {
    const installNode = definition.nodes?.find((n: any) =>
      n.type === 'check' &&
      ['npm', 'pnpm', 'yarn', 'bun'].includes(path.basename(n.command).replace(/\.(cmd|exe)$/i, '')) &&
      ['ci', 'install', 'i'].includes(n.args?.[0] ?? '')
    );
    if (!installNode) return;
    const nodeModules = path.join(worktreePath, 'node_modules');
    if (!fs.existsSync(nodeModules)) {
      await this.spawnCheckProcess(installNode.command, installNode.args ?? [], worktreePath, undefined, installNode.timeoutMs);
    }
  }

  private async dispatchAgent(node: any, context: any, onSession?: (id: string) => void): Promise<any> {
    const sessionKey = stageSessionKey(context.run.runId, node.id);
    let session: any;

    if (context.worktreePath) {
      await this.ensureRunDependencies(context.run.definition, context.worktreePath);
    }

    const praxisRunDir = context.worktreePath ? path.join(context.worktreePath, '.praxis-run') : undefined;

    try {
      // Build stage context using core
      const stageCtx = buildStageContext(context.run, node.id) || {
        runId: context.run.runId,
        nodeId: node.id,
        stageName: node.name,
        instructions: node.instructions || '',
        inputs: [],
        expectedOutputs: node.outputs || []
      };

      const upstreamLogs: Array<{ contractId: string; stageName: string; text: string }> = [];
      const upstreamReports: Array<{ contractId: string; stageName: string; text: string; fullTextPath?: string }> = [];

      for (const inputId of node.inputs || []) {
        for (const n of context.run.definition.nodes) {
          const output = (n.outputs || []).find((o: any) => o.id === inputId);
          if (output) {
            const text = this.evidence.get(`${context.run.runId}:${n.id}:1`);
            if (text) {
              if (output.kind === 'log' || n.type === 'check') {
                upstreamLogs.push({ contractId: inputId, stageName: n.name, text });
              } else {
                let fullTextPath: string | undefined;
                if (context.worktreePath) {
                  if (!fs.existsSync(praxisRunDir!)) fs.mkdirSync(praxisRunDir!, { recursive: true });
                  const reportFile = path.join(praxisRunDir!, `${inputId}.md`);
                  fs.writeFileSync(reportFile, text, 'utf8');
                  fullTextPath = path.posix.join('.praxis-run', `${inputId}.md`);
                }
                upstreamReports.push({ contractId: inputId, stageName: n.name, text, fullTextPath });
              }
            }
          }
        }
      }

      if (upstreamLogs.length > 0) (stageCtx as any).upstreamLogs = upstreamLogs;
      if (upstreamReports.length > 0) (stageCtx as any).upstreamReports = upstreamReports;

      // Handle diff inputs
      const hasDiffInput = (node.inputs || []).some((inp: string) => {
        for (const n of context.run.definition.nodes) {
          if ((n.outputs || []).some((o: any) => o.id === inp && o.kind === 'diff')) return true;
        }
        return false;
      });

      let diffPath: string | undefined;
      if (hasDiffInput && context.worktreePath) {
        if (!fs.existsSync(praxisRunDir!)) fs.mkdirSync(praxisRunDir!, { recursive: true });
        let diffText = '';
        try {
          const { stdout: mergeBase } = await execFileAsync('git', ['merge-base', 'main', 'HEAD'], { cwd: context.worktreePath });
          const base = mergeBase.trim() || 'HEAD~1';
          const { stdout } = await execFileAsync('git', ['diff', '--no-color', '--no-ext-diff', '-M', base, 'HEAD'], { cwd: context.worktreePath });
          diffText = stdout;
        } catch {
          try {
            const { stdout } = await execFileAsync('git', ['diff', '--no-color', '--no-ext-diff', '-M', 'HEAD~1', 'HEAD'], { cwd: context.worktreePath });
            diffText = stdout;
          } catch {}
        }
        const patchFile = path.join(praxisRunDir!, 'change-diff.patch');
        fs.writeFileSync(patchFile, diffText, 'utf8');
        diffPath = '.praxis-run/change-diff.patch';

        stageCtx.inputs = stageCtx.inputs.map((i: any) =>
          i.kind === 'diff' ? { ...i, path: diffPath } : i
        );
        if (!stageCtx.inputs.some((i: any) => i.kind === 'diff')) {
          stageCtx.inputs.push({ contractId: 'change-diff', kind: 'diff', path: diffPath });
        }
      }

      const taskDef = buildStageTaskDefinition(stageCtx);
      const upstream = formatUpstreamReports(upstreamReports);
      if (upstream) taskDef.scope += `\n\n${upstream}`;
      const logs = formatUpstreamLogs(upstreamLogs);
      if (logs) taskDef.scope += `\n\n${logs}`;
      if (hasDiffInput && diffPath) {
        taskDef.scope += `\n\nThe full patch for diff "change-diff" (the change since this run branched) is the file ${diffPath} in your working directory. Read it with your file tools; there is no diff tool.`;
      }

      if (this.options.aiHost) {
        session = await this.options.aiHost.delegate(
          {
            task: taskDef,
            goal: taskDef.goal,
            agentId: node.agent?.agentId,
            workflowRunId: context.run.runId,
            workflowNodeId: node.id,
            workflowRole: 'stage',
            workflowId: context.run.definition?.id,
            projectId: context.run.projectId,
            workingDirectory: context.worktreePath,
            toolMode: node.agent?.toolMode || 'read-only',
            permissionMode: context.run.permissionMode || 'auto'
          },
          this.options.getSettings?.(),
          process.env
        );
        onSession?.(session.sessionId || session.issueKey);
        session = await this.options.aiHost.waitForCompletion(session.issueKey || session.sessionId);
      } else {
        session = {
          sessionId: 'session-' + randomBytes(4).toString('hex'),
          issueKey: sessionKey,
          workflowRunId: context.run.runId,
          workflowNodeId: node.id,
          state: 'completed',
          responseText: 'Task completed successfully.'
        };
        onSession?.(session.sessionId || session.issueKey);
      }

      const reportText = session.responseText || 'Agent task report';
      this.evidence.set(`${context.run.runId}:${node.id}:1`, reportText);

      // Parse structured findings if present
      let findings: any = undefined;
      const findingsOutput = (node.outputs || []).find((o: any) => o.kind === 'findings');
      if (findingsOutput && session.responseText) {
        try {
          const parsed = parseReviewFindings(session.responseText);
          findings = parsed?.findings;
        } catch {}
      }

      // Check for board-publishable plan
      let planReference: any = undefined;
      const planOutput = (node.outputs || []).find((o: any) => o.kind === 'plan' && o.publishTo === 'board');
      if ((planOutput || session.responseText?.includes('```praxis-plan')) && session.responseText) {
        try {
          const publishablePlan = parsePublishablePlan(session.responseText);
          const project = this.options.getProject?.(context.run.projectId);
          const targetConn = `project:${context.run.projectId}`;
          const projectKey = project?.key || 'AUDIT';
          const { feature, items } = planIssueInputs(publishablePlan, projectKey);
          let createdFeature: any;
          if (this.options.trackerRegistry) {
            createdFeature = await this.options.trackerRegistry.call(targetConn, 'createIssue', feature);
          } else {
            createdFeature = { key: `${projectKey}-F01`, summary: feature.summary };
          }
          const createdItems: any[] = [];
          if (this.options.trackerRegistry) {
            for (const itemInput of items(createdFeature.key)) {
              const it = await this.options.trackerRegistry.call(targetConn, 'createIssue', itemInput);
              createdItems.push(it);
            }
          } else {
            createdItems.push({ key: `${projectKey}-T01-1` }, { key: `${projectKey}-T01-2` });
          }
          planReference = {
            key: createdFeature.key,
            title: publishablePlan.feature.title,
            itemKeys: createdItems.map((i: any) => i.key)
          };
        } catch (planErr: any) {
          console.error('[workflowHost] Failed to publish plan to board:', planErr);
        }
      }

      const artifacts = (node.outputs || []).map((o: any) => ({
        contractId: o.id,
        kind: o.kind,
        artifactId: o.id,
        ...(o.kind === 'plan' && planReference ? { reference: planReference } : {})
      }));

      let snapshotRef: string | undefined;
      if (node.mutatesWorktree !== false && context.worktreePath) {
        try {
          await execFileAsync('git', ['add', '.'], { cwd: context.worktreePath });
          await execFileAsync('git', ['commit', '-m', `stage: freeze ${node.name}`], { cwd: context.worktreePath });
        } catch {}
        try {
          const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: context.worktreePath });
          snapshotRef = stdout.trim();
        } catch {}
      }

      return {
        status: session.state === 'failed' ? 'failed' : 'succeeded',
        artifacts,
        ...(findings ? { findings } : {}),
        ...(snapshotRef ? { snapshotRef } : {}),
        sessionId: session.sessionId || session.issueKey
      };
    } finally {
      if (praxisRunDir && fs.existsSync(praxisRunDir)) {
        try {
          fs.rmSync(praxisRunDir, { recursive: true, force: true });
        } catch {}
      }
    }
  }

  private async dispatchMerge(node: any, context: any): Promise<any> {
    return { status: 'succeeded' };
  }
}
