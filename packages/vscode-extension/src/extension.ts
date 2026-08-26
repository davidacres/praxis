import * as path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as util from 'node:util';
import * as vscode from 'vscode';
import { AiSessionManager } from './ai/aiSessionManager';
import { BackendRouter } from './backends/backendRouter';
import type { IssueTrackerService } from './backends/issueTrackerService';
import { registerImportCommand } from './commands/importMarkdownFiles';
import { registerCommands } from './commands/registerCommands';
import { AppConfigStore } from './config/jiraConfig';
import { ConnectionStore } from './config/connectionStore';
import { VsCodeMementoStore } from './adapters/vsCodeMementoStore';
import { VsCodeSettingsStore } from './adapters/vsCodeSettingsStore';
import { VsCodeSecretsStore } from './adapters/vsCodeSecretsStore';
import { prepareArtifactForJiraUpload } from './file/jiraArtifactArchive';
import { issueTypeHex } from './board/issueTypeColors';
import { BoardColumnStore } from './state/boardColumnStore';
import { BoardStore } from './state/boardStore';
import { FilterStore, shouldAdoptJiraMcpEpicIssueScope } from './state/filterStore';
import type {
  AiProvider,
  BackendMode,
  Board,
  IssueDetails,
  IssueSummary,
  UpdateIssueInput,
  WorkflowTransition
} from './types';
import {
  assessCopilotImplementationReadiness,
  buildTicketContext,
  recommendTaskDesignerFlowWithCopilot,
  respondToCopilotComment,
  reviewTicketWithCopilot,
  runLocalPeerReview
} from './ai/aiReviewService';
import {
  AI_PROVIDER_LABELS,
  describeAiConfigurationResult,
  promptToConfigureDefaultAiProvider,
  sortAiOptionsByDefaultProvider
} from './ai/aiProviderSetup';
import { BackendModeContextState, resolveBackendModeContextState } from './ui/backendModeContext';
import { initializeMcpOAuthManager, getMcpOAuthManager } from './mcp/oauthManager';
import { setMcpOAuthProviderSource } from './mcp/clientFactory';
import { BoardColumnConfigPanel } from './views/boardColumnConfigPanel';
import { BoardPanelManager } from './views/boardPanelManager';
import { ClassicBoardsSidebarViewProvider } from './views/classicBoardsSidebarViewProvider';
import { BoardsTreeProvider } from './views/boardsTreeProvider';
import { DetailsViewProvider } from './views/detailsViewProvider';
import { EpicsSidebarViewProvider } from './views/epicsSidebarViewProvider';
import { IssueDetailPanelManager } from './views/issueDetailPanelManager';
import { LocalPeerReviewPanel } from './views/localPeerReviewPanel';
import { NewProjectWizardPanel } from './views/newProjectWizardPanel';
import { WorkModeBoardsSidebarViewProvider } from './views/workModeBoardsSidebarViewProvider';
import { SetupWizardPanel } from './views/setupWizardPanel';
import { UserWorkspaceBoardWizardPanel } from './views/userWorkspaceBoardWizardPanel';
import { ConnectionsManagerPanel } from './views/connectionsManagerPanel';
import { AiGatewaySettingsPanel } from './views/aiGatewaySettingsPanel';
import { IssueDetailsSidebarViewProvider } from './views/issueDetailsSidebarViewProvider';
import { IssuesSidebarViewProvider } from './views/issuesSidebarViewProvider';
import { IssuesTreeProvider } from './views/issuesTreeProvider';
import { SetupSidebarViewProvider } from './views/setupSidebarViewProvider';
import { TicketManagerStatusBar } from './views/ticketManagerStatusBar';
import { TaskDesignerPanelManager } from './views/taskDesignerPanelManager';
import { IssueAnalysisPanelManager, type AnalysisRepositoryEntry } from './views/issueAnalysisPanelManager';
import { VercelAgentService, type VercelAgentLogger } from './ai/vercelAgentService';
import { CopilotSessionPanelManager, type AgentSessionController } from './views/copilotSessionPanel';
import { ActiveSessionsSidebarViewProvider } from './views/activeSessionsSidebarViewProvider';
import type { AgentSessionRecord, AgentTaskDefinition, AgentWorkflowReference } from './ai/agentTypes';
import {
  fetchModels,
  normalizeInboundModelId,
  resolveGatewayApiKeyFromEnv,
  resolveGatewayUrlFromEnv
} from './ai/gateway';
import { getParentRule } from './issues/issueHierarchy';
import {
  AI_COMMENT_HEADER,
  COPILOT_AGENT_INPUT_REQUEST_MARKER,
  buildDeliveryAnalysisBlockedComment,
  buildDeliveryAnalysisTaskDefinition,
  buildDeliveryStartedComment,
  buildDeliveryFailureComment,
  buildPollingAnalysisReadyComment,
  resolveDeliveryPublishCommand,
  buildDeliverySuccessComment,
  buildDeliveryTaskDefinition,
  buildSubTaskAnalysisTaskDefinition,
  buildSubTaskDeliveryTaskDefinition,
  buildMissingBaseBranchClarificationComment,
  buildMissingWorkflowComment,
  buildWorktreeConflictClarificationComment,
  extractAgentProviderDirective,
  extractDeliveryBaseBranch,
  extractModelDirective,
  parseDeliveryAnalysisResult,
  parseDeliveryTaskResult,
  validateDeliveryWorkflowSettings
} from './ai/deliveryWorkflow';
import {
  isFeatureRequestTicket,
  buildFeatureDecompositionTaskDefinition,
  buildFeatureDecompositionStartedComment,
  buildFeatureDecompositionCompleteComment,
  buildFeatureDecompositionBlockedComment,
  parseFeatureDecompositionResult,
  type FeatureDecompositionResult
} from './ai/featureDecompositionWorkflow';
import type { FeatureSubTaskRecord } from './ai/agentTypes';
import {
  buildMergeRequestCreatedComment,
  buildMergeRequestFailureReplyComment,
  buildMergeRequestFeedbackTaskDefinition,
  buildMergeRequestReplyComment,
  parseMergeRequestFeedbackResult
} from './ai/mergeRequestWorkflow';
import { GitWorktreeManager, WorktreeConflictError } from './git/gitWorktreeManager';
import {
  discoverWorkspaceAgentWorkflows,
  promptForAgentWorkflowSelection,
  resolveWorkflowReference
} from './ai/agentWorkflowCatalog';
import { stageIssueAttachments } from './ai/issueAttachmentContext';
import {
  createGitLabHandledNoteState,
  diffGitLabDiscussionNotes,
  GitLabApiService,
  inferGitLabProjectFromRepo,
  isTicketManagerManagedMergeRequestNote,
  mergeRequestMatchesIssueKey,
  shouldCreateMergeRequestForStatusChange,
  wrapTicketManagerManagedMergeRequestNote,
  type GitLabDiscussionNote,
  type GitLabMergeRequest
} from './gitlab/gitLabApiService';

const execFile = util.promisify(execFileCallback);

export interface TicketManagerExtensionApi {
  refresh(): Promise<void>;
  backendService: IssueTrackerService;
  filterStore: FilterStore;
  boardStore: BoardStore;
  boardColumnStore: BoardColumnStore;
  issuesProvider: IssuesTreeProvider;
  boardsProvider: BoardsTreeProvider;
  detailsProvider: DetailsViewProvider;
  boardPanelManager: BoardPanelManager;
  issueDetailPanelManager: IssueDetailPanelManager;
  configStore: AppConfigStore;
  aiSessionManager: AiSessionManager;
  outputChannel: vscode.OutputChannel;
}

const STARTUP_BACKEND_LOAD_TIMEOUT_MS = 30000;
const STARTUP_BACKEND_LOAD_CANCELLED = 'ticket-manager-startup-load-cancelled';
const STARTUP_BACKEND_LOAD_TIMED_OUT = 'ticket-manager-startup-load-timed-out';

function rejectStartupLoadCancelled(reject: (reason?: unknown) => void): void {
  reject(new Error(STARTUP_BACKEND_LOAD_CANCELLED));
}

function rejectStartupLoadTimedOut(reject: (reason?: unknown) => void): void {
  reject(new Error(STARTUP_BACKEND_LOAD_TIMED_OUT));
}

function createStartupLoadCancelledPromise(token: vscode.CancellationToken): Promise<never> {
  return new Promise((_, reject) => {
    token.onCancellationRequested(() => rejectStartupLoadCancelled(reject));
  });
}

function createStartupLoadTimedOutPromise(
  timeoutMs: number
): { promise: Promise<never>; handle: ReturnType<typeof setTimeout> } {
  let handle!: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_, reject) => {
    handle = setTimeout(() => rejectStartupLoadTimedOut(reject), timeoutMs);
  });
  return { promise, handle };
}

interface AiOptionPick {
  provider: AiProvider;
  label: string;
  description: string;
  agentName?: string;
  credential?: string;
}

interface AiAssignmentMenuOption {
  provider: AiProvider;
  label: string;
}

interface AiModelOption {
  id: string;
  label: string;
}

const ANALYSIS_MODEL_OPTIONS: Partial<Record<AiProvider, AiModelOption[]>> = {
  'vercel-gateway': [
    { id: 'claude-opus-4-6', label: 'Claude Opus 4.6' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { id: 'gpt-5.4', label: 'GPT 5.4' },
    { id: 'gpt-4.1', label: 'GPT 4.1' },
    { id: 'o3', label: 'o3' }
  ]
};

/**
 * Live Vercel AI Gateway models discovered via GET /v1/models.
 * Falls back to the curated `vercel-gateway` list until the first refresh completes.
 */
let gatewayModelCache: AiModelOption[] = [];

async function refreshGatewayModelCache(
  options: { apiKey?: string; gatewayUrl?: string },
  log?: (message: string) => void
): Promise<void> {
  try {
    const apiKey = resolveGatewayApiKeyFromEnv(options.apiKey);
    if (!apiKey) {
      return;
    }
    const models = await fetchModels({
      url: resolveGatewayUrlFromEnv(options.gatewayUrl),
      apiKey
    });
    const seen = new Set<string>();
    const next: AiModelOption[] = [];
    for (const model of models) {
      const id = normalizeInboundModelId(model.id).trim();
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      next.push({ id, label: model.name?.trim() || id });
    }
    if (next.length > 0) {
      gatewayModelCache = next;
      log?.(`[ai-models] Loaded ${next.length} Vercel AI Gateway model(s).`);
    }
  } catch (error) {
    log?.(
      `[ai-models] Failed to load Vercel AI Gateway models: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function getModelOptionsForProvider(provider: AiProvider): AiModelOption[] {
  if (provider === 'vercel-gateway' && gatewayModelCache.length > 0) {
    return gatewayModelCache;
  }
  return ANALYSIS_MODEL_OPTIONS[provider] ?? [];
}

function logError(output: vscode.OutputChannel, error: unknown, scope?: string): void {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  output.appendLine(scope ? `[${scope}] ${message}` : message);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectRegexMatches(text: string, pattern: RegExp): string[] {
  return Array.from(text.matchAll(pattern), match => match[0]);
}

function getGitLabProjectRef(issueKey: string): string | undefined {
  const separatorIndex = issueKey.lastIndexOf('#');
  if (separatorIndex <= 0) {
    return undefined;
  }

  const projectRef = issueKey.slice(0, separatorIndex).trim();
  return projectRef.includes('/') ? projectRef : undefined;
}

function extractReferencedIssueKeys(issue: IssueDetails): string[] {
  const currentKeyLower = issue.key.trim().toLowerCase();
  const gitLabProjectRef = getGitLabProjectRef(issue.key);
  const sources = [
    issue.summary,
    issue.description,
    issue.parentIssue?.key,
    ...(issue.dependsOn ?? []),
    ...(issue.comments?.map(comment => comment.body) ?? [])
  ].filter((value): value is string => Boolean(value?.trim()));
  const orderedKeys: string[] = [];
  const seen = new Set<string>();

  const addReference = (rawKey: string): void => {
    const key = rawKey.trim();
    if (!key) {
      return;
    }

    const normalized = key.toLowerCase();
    if (normalized === currentKeyLower || seen.has(normalized)) {
      return;
    }

    seen.add(normalized);
    orderedKeys.push(key);
  };

  for (const source of sources) {
    for (const key of collectRegexMatches(source, /\b[A-Z][A-Z0-9]+-\d+\b/g)) {
      addReference(key);
    }

    for (const key of collectRegexMatches(source, /\b[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+#\d+\b/g)) {
      addReference(key);
    }

    if (!gitLabProjectRef) {
      continue;
    }

    for (const match of source.matchAll(/(^|[^A-Za-z0-9._/-])#(\d+)\b/g)) {
      addReference(`${gitLabProjectRef}#${match[2]}`);
    }
  }

  return orderedKeys;
}

async function buildReferencedIssueAnalysisContext(
  issue: IssueDetails,
  getIssue: (issueKey: string) => Promise<IssueDetails>
): Promise<string | undefined> {
  const referencedKeys = extractReferencedIssueKeys(issue).slice(0, 5);
  if (referencedKeys.length === 0) {
    return undefined;
  }

  const referencedIssues = await Promise.all(
    referencedKeys.map(async issueKey => {
      try {
        return await getIssue(issueKey);
      } catch {
        return undefined;
      }
    })
  );
  const referencedBlocks = referencedIssues
    .filter((referencedIssue): referencedIssue is IssueDetails => Boolean(referencedIssue))
    .map(referencedIssue => buildTicketContext(referencedIssue, { recentCommentLimit: 2, newestComments: true }));

  if (referencedBlocks.length === 0) {
    return undefined;
  }

  return ['Referenced tickets mentioned in this ticket:', ...referencedBlocks].join('\n\n');
}

interface AnalysisRepositoryContext {
  promptContext: string;
  workingDirectory?: string;
}

interface AnalysisRepositoryReference {
  repository?: string;
  branch?: string;
  commit?: string;
  subdirectory?: string;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isGitRepository(repoPath: string): Promise<boolean> {
  try {
    await execFile('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: repoPath,
      windowsHide: true
    });
    return true;
  } catch {
    return false;
  }
}

async function readGitStdout(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFile('git', args, {
      cwd,
      windowsHide: true
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function cleanCapturedRepositoryReference(value: string): string {
  return value.trim().replace(/[),.;]+$/g, '');
}

function cleanCapturedRepositoryDetail(value: string): string | undefined {
  const trimmed = cleanCapturedRepositoryReference(value).replace(/^['"]|['"]$/g, '');
  return trimmed || undefined;
}

function extractRepositoryReferenceFromText(text: string): string | undefined {
  const explicitMatch = text.match(/(?:^|\n)\s*(?:repo|repository)\s*:\s*(\S+)/i);
  if (explicitMatch?.[1]) {
    return cleanCapturedRepositoryReference(explicitMatch[1]);
  }

  const remoteMatch = text.match(/(https?:\/\/[^\s'"]+|ssh:\/\/[^\s'"]+|git@[^\s'"]+)/i);
  if (remoteMatch?.[1]) {
    return cleanCapturedRepositoryReference(remoteMatch[1]);
  }

  const windowsPathMatch = text.match(/([A-Za-z]:\\[^\s'"]+)/);
  if (windowsPathMatch?.[1]) {
    return cleanCapturedRepositoryReference(windowsPathMatch[1]);
  }

  const relativePathMatch = text.match(/((?:\.\.?[\\/]|[\\/])[^\s'"]+)/);
  if (relativePathMatch?.[1]) {
    return cleanCapturedRepositoryReference(relativePathMatch[1]);
  }

  return undefined;
}

function extractRepositoryBranchFromText(text: string): string | undefined {
  const explicitMatch = text.match(/(?:^|\n)\s*branch\s*:\s*(\S+)/i);
  if (explicitMatch?.[1]) {
    return cleanCapturedRepositoryDetail(explicitMatch[1]);
  }

  const inlineMatch = text.match(/\bbranch\s+([A-Za-z0-9._/-]+)\b/i);
  return inlineMatch?.[1] ? cleanCapturedRepositoryDetail(inlineMatch[1]) : undefined;
}

function extractRepositoryCommitFromText(text: string): string | undefined {
  const explicitMatch = text.match(/(?:^|\n)\s*(?:commit|sha|revision)\s*:\s*([A-Fa-f0-9]{7,40})/i);
  if (explicitMatch?.[1]) {
    return cleanCapturedRepositoryDetail(explicitMatch[1]);
  }

  const inlineMatch = text.match(/\b(?:commit|sha|revision)\s+([A-Fa-f0-9]{7,40})\b/i);
  return inlineMatch?.[1] ? cleanCapturedRepositoryDetail(inlineMatch[1]) : undefined;
}

function extractRepositorySubdirectoryFromText(text: string): string | undefined {
  const explicitMatch = text.match(/(?:^|\n)\s*(?:subdir|subdirectory|path|folder)\s*:\s*(\S+)/i);
  if (explicitMatch?.[1]) {
    return cleanCapturedRepositoryDetail(explicitMatch[1]);
  }

  return undefined;
}

function extractAllGitReferencesFromText(text: string): string[] {
  const refs: string[] = [];
  const explicitMatches = text.matchAll(/(?:^|\n)\s*(?:repo|repository)\s*:\s*(\S+)/gi);
  for (const m of explicitMatches) {
    if (m[1]) {
      refs.push(cleanCapturedRepositoryReference(m[1]));
    }
  }
  const remoteMatches = text.matchAll(/(https?:\/\/[^\s'"]+\.git(?:\b|$)|ssh:\/\/[^\s'"]+|git@[^\s'"]+)/gi);
  for (const m of remoteMatches) {
    if (m[1]) {
      const cleaned = cleanCapturedRepositoryReference(m[1]);
      if (!refs.includes(cleaned)) {
        refs.push(cleaned);
      }
    }
  }
  return refs;
}

function extractAnalysisRepositoryReference(
  question: string,
  history: Array<{ role: string; text: string }>,
  issueTexts?: string[]
): AnalysisRepositoryReference | undefined {
  const texts = [
    question,
    ...history.filter(entry => entry.role === 'user').map(entry => entry.text).reverse(),
    ...(issueTexts ?? [])
  ];
  const reference: AnalysisRepositoryReference = {};

  for (const text of texts) {
    reference.repository ??= extractRepositoryReferenceFromText(text);
    reference.branch ??= extractRepositoryBranchFromText(text);
    reference.commit ??= extractRepositoryCommitFromText(text);
    reference.subdirectory ??= extractRepositorySubdirectoryFromText(text);

    if (reference.repository && (reference.branch || reference.commit || reference.subdirectory)) {
      return reference;
    }
  }

  return reference.repository || reference.branch || reference.commit || reference.subdirectory ? reference : undefined;
}

function buildMissingRepositoryPrompt(reason?: string): string {
  const lines = [reason ?? 'Repository access is currently unavailable.'];
  lines.push('If code-level confidence depends on implementation details, ask the user for:');
  lines.push('1. The git repository URL or a local repository path');
  lines.push('2. The branch or commit to inspect if not the default branch');
  lines.push('3. Any relevant subdirectory if the repository is large');
  lines.push('Provide any ticket-only findings you can make now, but clearly separate them from code-backed findings.');
  return lines.join('\n');
}

function getAnalysisRepoRoot(workingDirectory: string | undefined, globalStoragePath: string): string {
  return workingDirectory
    ? path.join(workingDirectory, '.ticket-manager-analysis', 'repos')
    : path.join(globalStoragePath, 'analysis-repos');
}

function isRemoteRepositoryReference(reference: string): boolean {
  return /^(?:https?:\/\/|ssh:\/\/|git@)/i.test(reference) || reference.endsWith('.git');
}

function resolveLocalRepositoryPath(reference: string, workingDirectory: string | undefined): string {
  if (path.isAbsolute(reference)) {
    return path.normalize(reference);
  }

  return path.resolve(workingDirectory ?? process.cwd(), reference);
}

function buildAnalysisRepoFolderName(issueKey: string, source: string, branch?: string, commit?: string): string {
  const fingerprint = createHash('sha1')
    .update(JSON.stringify({ source, branch: branch ?? '', commit: commit ?? '' }))
    .digest('hex')
    .slice(0, 10);
  return `${issueKey.replace(/[^a-z0-9._-]+/gi, '-').toLowerCase()}-${fingerprint}`;
}

async function ensureAnalysisCheckoutRevision(repoPath: string, branch?: string, commit?: string): Promise<void> {
  if (branch) {
    await execFile('git', ['fetch', '--depth', '1', 'origin', branch], {
      cwd: repoPath,
      windowsHide: true
    }).catch(() => undefined);
    await execFile('git', ['checkout', branch], {
      cwd: repoPath,
      windowsHide: true
    }).catch(async () => {
      await execFile('git', ['checkout', '-B', branch, `origin/${branch}`], {
        cwd: repoPath,
        windowsHide: true
      });
    });
  }

  if (commit) {
    await execFile('git', ['fetch', '--depth', '1', 'origin', commit], {
      cwd: repoPath,
      windowsHide: true
    }).catch(() => undefined);
    await execFile('git', ['checkout', commit], {
      cwd: repoPath,
      windowsHide: true
    });
  }
}

async function prepareAnalysisRepositoryClone(options: {
  issueKey: string;
  source: string;
  analysisRepoRoot: string;
  branch?: string;
  commit?: string;
}): Promise<string> {
  await fs.mkdir(options.analysisRepoRoot, { recursive: true });
  const repoPath = path.join(
    options.analysisRepoRoot,
    buildAnalysisRepoFolderName(options.issueKey, options.source, options.branch, options.commit)
  );

  if (!await pathExists(repoPath)) {
    await execFile('git', ['clone', '--depth', '1', options.source, repoPath], {
      cwd: options.analysisRepoRoot,
      windowsHide: true
    });
  }

  await ensureAnalysisCheckoutRevision(repoPath, options.branch, options.commit);
  return repoPath;
}

async function readOptionalTextFile(filePath: string, maxChars = 1600): Promise<string | undefined> {
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const trimmed = text.trim();
    if (!trimmed) {
      return undefined;
    }
    return trimmed.slice(0, maxChars);
  } catch {
    return undefined;
  }
}

async function buildRepositorySummary(repoPath: string, sourceLabel: string): Promise<string> {
  const [branch, remoteUrl] = await Promise.all([
    readGitStdout(['rev-parse', '--abbrev-ref', 'HEAD'], repoPath),
    readGitStdout(['config', '--get', 'remote.origin.url'], repoPath)
  ]);
  const rootEntries = await fs.readdir(repoPath, { withFileTypes: true }).catch(
    () => [] as Array<{ name: string; isDirectory(): boolean }>
  );
  const visibleEntries = rootEntries
    .filter(entry => !['.git', 'node_modules', '.worktrees', '.ticket-manager-analysis'].includes(entry.name))
    .slice(0, 12)
    .map(entry => `${entry.isDirectory() ? 'dir' : 'file'}:${entry.name}`);
  const readmeText = await readOptionalTextFile(path.join(repoPath, 'README.md'))
    ?? await readOptionalTextFile(path.join(repoPath, 'README'));
  const packageJsonText = await readOptionalTextFile(path.join(repoPath, 'package.json'), 1200);
  let packageSummary: string | undefined;
  if (packageJsonText) {
    try {
      const parsed = JSON.parse(packageJsonText) as {
        name?: unknown;
        private?: unknown;
        scripts?: Record<string, unknown>;
        dependencies?: Record<string, unknown>;
        devDependencies?: Record<string, unknown>;
      };
      packageSummary = JSON.stringify(
        {
          name: typeof parsed.name === 'string' ? parsed.name : undefined,
          private: typeof parsed.private === 'boolean' ? parsed.private : undefined,
          scripts: Object.keys(parsed.scripts ?? {}).slice(0, 10),
          dependencyCount: Object.keys(parsed.dependencies ?? {}).length,
          devDependencyCount: Object.keys(parsed.devDependencies ?? {}).length
        },
        null,
        2
      );
    } catch {
      packageSummary = packageJsonText;
    }
  }

  return [
    'Repository access is available for this analysis.',
    `Repository source: ${sourceLabel}`,
    `Local repository path: ${repoPath}`,
    branch ? `Repository branch: ${branch}` : undefined,
    remoteUrl ? `Repository origin: ${remoteUrl}` : undefined,
    visibleEntries.length > 0 ? `Top-level entries: ${visibleEntries.join(', ')}` : undefined,
    readmeText ? `README excerpt:\n${readmeText}` : undefined,
    packageSummary ? `package.json summary:\n${packageSummary}` : undefined,
    'Use repository context when it helps. If important implementation details are still missing, ask specific follow-up questions.'
  ]
    .filter((part): part is string => Boolean(part))
    .join('\n\n');
}

async function resolveAnalysisRepositoryContext(options: {
  issueKey: string;
  question: string;
  history: Array<{ role: string; text: string }>;
  workingDirectory?: string;
  globalStoragePath: string;
  repositories?: AnalysisRepositoryEntry[];
  issueTexts?: string[];
}): Promise<AnalysisRepositoryContext> {
  // When explicit repository entries are attached, use them instead of regex extraction.
  if (options.repositories && options.repositories.length > 0) {
    const summaries: string[] = [];
    let lastWorkingDirectory: string | undefined;

    for (const entry of options.repositories) {
      try {
        const analysisRepoRoot = getAnalysisRepoRoot(options.workingDirectory, options.globalStoragePath);
        let repoPath: string;
        if (isRemoteRepositoryReference(entry.source)) {
          repoPath = await prepareAnalysisRepositoryClone({
            issueKey: options.issueKey,
            source: entry.source,
            analysisRepoRoot,
            branch: entry.branch,
            commit: entry.commit
          });
        } else if (entry.branch || entry.commit) {
          const localSourcePath = resolveLocalRepositoryPath(entry.source, options.workingDirectory);
          repoPath = await prepareAnalysisRepositoryClone({
            issueKey: options.issueKey,
            source: localSourcePath,
            analysisRepoRoot,
            branch: entry.branch,
            commit: entry.commit
          });
        } else {
          repoPath = resolveLocalRepositoryPath(entry.source, options.workingDirectory);
        }

        if (entry.subdirectory) {
          repoPath = path.join(repoPath, entry.subdirectory);
        }

        if (!await pathExists(repoPath)) {
          summaries.push(`Repository ${entry.label}: path not found — ${repoPath}`);
          continue;
        }

        const repoSummary = await buildRepositorySummary(
          entry.subdirectory ? path.dirname(repoPath) : repoPath,
          entry.source
        );
        const parts = [
          `Repository: ${entry.label}`,
          repoSummary,
          entry.branch ? `Requested branch: ${entry.branch}` : undefined,
          entry.commit ? `Requested commit: ${entry.commit}` : undefined,
          entry.subdirectory ? `Requested subdirectory: ${entry.subdirectory}` : undefined
        ]
          .filter((part): part is string => Boolean(part));
        summaries.push(parts.join('\n\n'));
        lastWorkingDirectory = repoPath;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        summaries.push(`Repository ${entry.label}: access error — ${message}`);
      }
    }

    return {
      workingDirectory: lastWorkingDirectory,
      promptContext: summaries.join('\n\n---\n\n')
    };
  }

  // Fallback: regex extraction from question/history/ticket text.
  const repositoryReference = extractAnalysisRepositoryReference(options.question, options.history, options.issueTexts);
  if (!repositoryReference?.repository) {
    if (options.workingDirectory && await isGitRepository(options.workingDirectory)) {
      const workspacePath = repositoryReference?.subdirectory
        ? path.join(options.workingDirectory, repositoryReference.subdirectory)
        : options.workingDirectory;
      return {
        workingDirectory: workspacePath,
        promptContext: [
          await buildRepositorySummary(options.workingDirectory, 'current workspace repository'),
          repositoryReference?.subdirectory
            ? `Requested repository subdirectory: ${repositoryReference.subdirectory}`
            : undefined,
          repositoryReference?.branch ? `Requested branch hint: ${repositoryReference.branch}` : undefined,
          repositoryReference?.commit ? `Requested commit hint: ${repositoryReference.commit}` : undefined
        ]
          .filter((part): part is string => Boolean(part))
          .join('\n\n')
      };
    }

    return {
      promptContext: buildMissingRepositoryPrompt()
    };
  }

  try {
    const analysisRepoRoot = getAnalysisRepoRoot(options.workingDirectory, options.globalStoragePath);
    let repoPath: string;
    if (isRemoteRepositoryReference(repositoryReference.repository)) {
      repoPath = await prepareAnalysisRepositoryClone({
        issueKey: options.issueKey,
        source: repositoryReference.repository,
        analysisRepoRoot,
        branch: repositoryReference.branch,
        commit: repositoryReference.commit
      });
    } else if (repositoryReference.branch || repositoryReference.commit) {
      const localSourcePath = resolveLocalRepositoryPath(repositoryReference.repository, options.workingDirectory);
      repoPath = await prepareAnalysisRepositoryClone({
        issueKey: options.issueKey,
        source: localSourcePath,
        analysisRepoRoot,
        branch: repositoryReference.branch,
        commit: repositoryReference.commit
      });
    } else {
      repoPath = resolveLocalRepositoryPath(repositoryReference.repository, options.workingDirectory);
    }

    if (repositoryReference.subdirectory) {
      repoPath = path.join(repoPath, repositoryReference.subdirectory);
    }

    if (!await isGitRepository(repositoryReference.subdirectory ? path.dirname(repoPath) : repoPath)) {
      return {
        promptContext: buildMissingRepositoryPrompt(
          `The provided repository reference could not be opened as a git repository: ${repositoryReference.repository}`
        )
      };
    }

    if (!await pathExists(repoPath)) {
      return {
        promptContext: buildMissingRepositoryPrompt(
          `The provided repository path or subdirectory does not exist: ${repoPath}`
        )
      };
    }

    return {
      workingDirectory: repoPath,
      promptContext: [
        await buildRepositorySummary(repositoryReference.subdirectory ? path.dirname(repoPath) : repoPath, repositoryReference.repository),
        repositoryReference.branch ? `Requested branch: ${repositoryReference.branch}` : undefined,
        repositoryReference.commit ? `Requested commit: ${repositoryReference.commit}` : undefined,
        repositoryReference.subdirectory ? `Requested subdirectory: ${repositoryReference.subdirectory}` : undefined
      ]
        .filter((part): part is string => Boolean(part))
        .join('\n\n')
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      promptContext: buildMissingRepositoryPrompt(
        `The provided repository reference could not be accessed (${repositoryReference.repository}): ${message}`
      )
    };
  }
}

function extractCopilotRequest(body: string, mentionNames: string[] = ['copilot']): string | undefined {
  const names = [...new Set(mentionNames.map(name => name.trim()).filter(Boolean))].map(escapeRegExp);
  if (names.length === 0) {
    return undefined;
  }
  const pattern = new RegExp(`(?:^|\\s)@(?:${names.join('|')})(?=$|[\\s:,.!?])[:,]?\\s*`, 'i');
  const mentionMatch = body.match(pattern);
  if (!mentionMatch) {
    return undefined;
  }

  const start = mentionMatch.index!;
  const cleaned = `${body.slice(0, start)}${body.slice(start + mentionMatch[0].length)}`
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'Please help with this ticket.';
}

let deactivateHandler: (() => Promise<void>) | undefined;

const DELIVERY_FORWARD_STATUS_PREFERENCES = [
  'ready for qa',
  'qa ready',
  'ready for test',
  'ready for testing',
  'testing',
  'in review',
  'review',
  'ready for validation',
  'resolved',
  'closed',
  'done'
] as const;
const DELIVERY_NON_PROGRESS_PATTERNS = [
  /block/i,
  /backlog/i,
  /^to do$/i,
  /^todo$/i,
  /selected for development/i,
  /^open$/i,
  /^new$/i,
  /cancel/i,
  /reject/i,
  /resume/i,
  /reopen/i,
  /hold/i
] as const;

interface ResolvedGitLabAutomation {
  client: GitLabApiService;
  baseUrl: string;
  projectPath: string;
}

function buildMergeRequestDescription(
  issue: IssueDetails,
  record: AgentSessionRecord & { delivery: NonNullable<AgentSessionRecord['delivery']> }
): string {
  const lines = [
    `Jira ticket: ${issue.key}`,
    `Summary: ${issue.summary}`,
    `Base branch: ${record.delivery.baseBranch}`,
    `Delivery branch: ${record.delivery.createdBranch}`
  ];
  if (issue.description?.trim()) {
    lines.push('', issue.description.trim().slice(0, 4000));
  }
  return lines.join('\n');
}

function filterGitLabNotesForAutomation(notes: GitLabDiscussionNote[]): GitLabDiscussionNote[] {
  return notes.filter(note =>
    !note.system &&
    note.body.trim().length > 0 &&
    !isTicketManagerManagedMergeRequestNote(note.body)
  );
}

function normalizeTransitionLabel(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function isNonProgressTransitionLabel(value: string): boolean {
  return DELIVERY_NON_PROGRESS_PATTERNS.some(pattern => pattern.test(value));
}

export function selectNextDeliveryTransition(
  issue: Pick<IssueDetails, 'status' | 'statusCategory' | 'transitions'>
): WorkflowTransition | undefined {
  if (issue.statusCategory?.trim().toLowerCase() === 'done') {
    return undefined;
  }

  const currentStatus = normalizeTransitionLabel(issue.status);
  const candidates = (issue.transitions ?? [])
    .map((transition, index) => ({
      transition,
      index,
      targetStatus: normalizeTransitionLabel(transition.toStatus || transition.name),
      transitionName: normalizeTransitionLabel(transition.name)
    }))
    .filter(candidate => candidate.targetStatus.length > 0 && candidate.targetStatus !== currentStatus)
    .map(candidate => {
      const preferredIndex = DELIVERY_FORWARD_STATUS_PREFERENCES.indexOf(
        candidate.targetStatus as (typeof DELIVERY_FORWARD_STATUS_PREFERENCES)[number]
      );
      const isNonProgress =
        isNonProgressTransitionLabel(candidate.targetStatus) ||
        isNonProgressTransitionLabel(candidate.transitionName);
      const score = preferredIndex >= 0
        ? 100 - preferredIndex
        : isNonProgress
          ? -10
          : 50;

      return {
        ...candidate,
        score
      };
    })
    .filter(candidate => candidate.score >= 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);

  return candidates[0]?.transition;
}

export async function activate(
  context: vscode.ExtensionContext
): Promise<TicketManagerExtensionApi> {
  initializeMcpOAuthManager(context);
  // Let the core MCP client reach the extension's UriHandler-backed OAuth flow.
  setMcpOAuthProviderSource(() => getMcpOAuthManager());

  const outputChannel = vscode.window.createOutputChannel('Ticket Manager');
  const configStore = new AppConfigStore();
  configStore.bindExtensionSecrets(context.secrets);
  await configStore.refreshVercelApiKeyCache();
  await configStore.migrateAiProviderSettings();
  const aiSessionManager = new AiSessionManager(new VsCodeMementoStore(context.workspaceState));
  const connectionStore = new ConnectionStore(
    new VsCodeSettingsStore('ticketManager'),
    new VsCodeSecretsStore(context.secrets)
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      if (
        event.affectsConfiguration('ticketManager.connections') ||
        event.affectsConfiguration('ticketManager.boards')
      ) {
        connectionStore.notifyChanged();
      }
    })
  );
  const vercelAgentLogger: VercelAgentLogger = {
    appendLine(message: string): void {
      outputChannel.appendLine(message);
    }
  };
  const vercelAgentService = new VercelAgentService(aiSessionManager, vercelAgentLogger);
  const agentSessionController: AgentSessionController = {
    onDidChangeActiveTask(listener) {
      return vercelAgentService.onDidChangeActiveTask(listener);
    },
    respondToInput(issueKey, response) {
      vercelAgentService.respondToInput(issueKey, response);
    },
    respondToPermission(issueKey, decision) {
      vercelAgentService.respondToPermission(issueKey, decision);
    },
    hasActiveTask(issueKey) {
      return vercelAgentService.hasActiveTask(issueKey);
    },
    getPendingPermissionDescriptions(issueKey) {
      return vercelAgentService.getPendingPermissionDescriptions(issueKey);
    },
    getPendingPermissions(issueKey) {
      return vercelAgentService.getPendingPermissions(issueKey);
    }
  };
  const copilotSessionPanelManager = new CopilotSessionPanelManager(
    aiSessionManager,
    agentSessionController,
    async issueKey => {
      await abandonAiSession(issueKey);
    },
    async issueKey => {
      await resumeCopilotSession(issueKey);
    },
    async issueKey => {
      await startNewCopilotSession(issueKey);
    }
  );
  const filterStore = new FilterStore(context);
  const boardStore = new BoardStore(context);
  const boardColumnStore = new BoardColumnStore(context);
  const boardColumnConfigPanel = new BoardColumnConfigPanel(boardColumnStore);
  const newProjectWizardPanel = new NewProjectWizardPanel();
  const setupWizardPanel = new SetupWizardPanel();
  const userWorkspaceBoardWizardPanel = new UserWorkspaceBoardWizardPanel();
  const setupSidebarViewProvider = new SetupSidebarViewProvider(context);
  const workModeSetupSidebarViewProvider = new SetupSidebarViewProvider(context);
  context.subscriptions.push(connectionStore);
  const backendService = new BackendRouter(context, configStore, outputChannel, connectionStore);
  const connectionsManagerPanel = new ConnectionsManagerPanel(
    context,
    connectionStore,
    backendService
  );
  const aiGatewaySettingsPanel = new AiGatewaySettingsPanel(context, configStore, () => {
    refreshAiAssignmentMenus();
    refreshStatusBarInBackground();
    void refreshGatewayModelCache(getVercelGatewayOptions(), message =>
      outputChannel.appendLine(message)
    );
  });
  context.subscriptions.push(connectionsManagerPanel, aiGatewaySettingsPanel);
  context.subscriptions.push(
    vscode.commands.registerCommand('ticketManager.openConnectionsManager', () => {
      connectionsManagerPanel.open();
    }),
    vscode.commands.registerCommand('ticketManager.openAiGatewaySettings', () => {
      void aiGatewaySettingsPanel.open();
    }),
    vscode.commands.registerCommand('ticketManager.addConnection', () => {
      connectionsManagerPanel.open({ kind: 'addConnection' });
    }),
    vscode.commands.registerCommand('ticketManager.addBoard', async (connectionId?: string) => {
      let targetId = connectionId;
      if (!targetId) {
        const connections = connectionStore.getConnections();
        if (connections.length === 0) {
          connectionsManagerPanel.open({ kind: 'addConnection' });
          return;
        }
        const pick = await vscode.window.showQuickPick(
          connections.map(c => ({ label: c.name, description: c.id, id: c.id })),
          { placeHolder: 'Pick a connection for the new board' }
        );
        if (!pick) {
          return;
        }
        targetId = pick.id;
      }
      connectionsManagerPanel.open({ kind: 'addBoard', connectionId: targetId });
    })
  );
  // First-run: auto-open the manager if no connections exist yet.
  if (!connectionStore.hasConnections()) {
    connectionsManagerPanel.open({ kind: 'addConnection' });
  } else {
    // Drop legacy placeholder tracked boards (boardId === connection id) that
    // older builds invented for User Workspace and that cannot be opened.
    void (async () => {
      let removedSelected = false;
      const selectedId = boardStore.getLastSelectedBoardId();
      for (const connection of connectionStore.getConnections()) {
        if (connection.mode !== 'userworkspace') {
          continue;
        }
        for (const board of connectionStore.getTrackedBoardsForConnection(connection.id)) {
          if (board.boardId === connection.id) {
            await connectionStore.removeTrackedBoard({
              connectionId: connection.id,
              boardId: board.boardId
            });
            if (selectedId === board.boardId) {
              removedSelected = true;
            }
          }
        }
      }
      if (removedSelected) {
        await boardStore.setLastSelectedTrackedBoard(undefined);
      }
    })().catch(error => {
      outputChannel.appendLine(
        `[prune-userworkspace-placeholders] ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }
  // Initialise active-connection routing from persisted last-selected board.
  {
    const initialTrackedRef = boardStore.getLastSelectedTrackedBoard();
    if (initialTrackedRef) {
      backendService.setActiveConnection(initialTrackedRef.connectionId);
    }
  }
  const ticketManagerStatusBar = new TicketManagerStatusBar(
    configStore,
    backendService,
    aiSessionManager,
    connectionStore,
    backendService
  );
  const workingDirectory = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const gitWorktreeManager = workingDirectory ? new GitWorktreeManager(outputChannel) : undefined;
  let suppressCloseWarning = false;
  let lastCloseWarningSignature: string | undefined;
  const permissionPromptSignatures = new Map<string, string>();
  const permissionPromptInFlight = new Set<string>();
  const deliveryFinalizationInFlight = new Set<string>();
  const mergeRequestAutomationInFlight = new Set<string>();
  let cachedGitLabAutomationKey: string | undefined;
  let cachedGitLabAutomation: ResolvedGitLabAutomation | undefined;
  let lastGitLabAutomationSkipReason: string | undefined;

  function reportError(error: unknown, scope?: string): void {
    logError(outputChannel, error, scope);
    ticketManagerStatusBar.recordError(error);
  }

  function isVercelGatewayConfigured(): boolean {
    return (
      configStore.getActiveAiProvider() === 'vercel-gateway' &&
      configStore.getConfiguredAiProviders().includes('vercel-gateway')
    );
  }

  /** @deprecated Use isVercelGatewayConfigured. */
  function isCopilotSdkConfigured(): boolean {
    return isVercelGatewayConfigured();
  }

  function getVercelGatewayOptions(): { apiKey?: string; gatewayUrl?: string } {
    return {
      apiKey: configStore.getAiVercelGatewayApiKey() || undefined,
      gatewayUrl: configStore.getAiVercelGatewayUrl() || undefined
    };
  }

  function normalizeMentionName(name: string | undefined): string | undefined {
    const trimmed = name?.trim().replace(/^@+/, '').trim();
    return trimmed || undefined;
  }

  function getProviderAgentDisplayName(provider: AiProvider): string {
    if (provider === 'vercel-gateway') {
      return configStore.getAiVercelAgentName().trim() || AI_PROVIDER_LABELS[provider];
    }
    return AI_PROVIDER_LABELS[provider] ?? provider;
  }

  function resolveActiveAgentMentionName(issueKey?: string): string | undefined {
    if (issueKey) {
      const assignment = aiSessionManager.getSession(issueKey);
      const assignmentLabel = normalizeMentionName(
        assignment?.label ?? (assignment ? getProviderAgentDisplayName(assignment.provider) : undefined)
      );
      if (assignmentLabel) {
        return assignmentLabel;
      }

      const agentRecord = aiSessionManager.getAgentSession(issueKey);
      const agentLabel = normalizeMentionName(
        agentRecord?.provider ? getProviderAgentDisplayName(agentRecord.provider) : undefined
      );
      if (agentLabel) {
        return agentLabel;
      }
    }

    const defaultOption = getConfiguredAiOptions()[0];
    return normalizeMentionName(defaultOption?.agentName ?? defaultOption?.label);
  }

  function buildCommentMentionNames(issueKey?: string): string[] {
    const names = ['copilot'];
    const activeAgentName = resolveActiveAgentMentionName(issueKey);
    if (activeAgentName) {
      names.push(activeAgentName);
    }

    const legacyMentionName = normalizeMentionName(configStore.getAiMentionName());
    if (legacyMentionName) {
      names.push(legacyMentionName);
    }

    return [...new Set(names.map(name => name.toLowerCase()))].map(lowerName =>
      names.find(name => name.toLowerCase() === lowerName) ?? lowerName
    );
  }

  function buildCommentPlaceholder(issueKey?: string): string {
    const activeAgentName = resolveActiveAgentMentionName(issueKey);
    if (activeAgentName && activeAgentName.toLowerCase() !== 'copilot') {
      return `Write a comment (mention @${activeAgentName} for a reply)`;
    }
    return 'Write a comment (mention @agent for a reply)';
  }

  function updateCommentPlaceholders(): void {
    const placeholder = buildCommentPlaceholder(detailsProvider.getActiveIssue()?.key);
    issueDetailPanelManager.setCommentPlaceholder(placeholder);
    issueDetailsSidebarViewProvider?.setCommentPlaceholder(placeholder);
  }

  async function postCopilotReply(issueKey: string, request: string): Promise<void> {
    const cliPath = getVercelGatewayApiKey();
    const issue = await backendService.getIssue(issueKey);
    const response = await respondToCopilotComment(issue, cliPath, request, workingDirectory);
    await backendService.addComment(issueKey, response);
  }

  function ensureWorkflowAssignedFromAnalysis(
    issueKey: string,
    workflowReference: string | undefined,
    availableWorkflows: AgentWorkflowReference[]
  ): void {
    if (aiSessionManager.getIssueWorkflowAssignment(issueKey)) {
      return;
    }

    const resolvedWorkflow = resolveWorkflowReference(workflowReference, availableWorkflows);

    // Workflow packs are optional. When analysis reports "ready" we always
    // record an assignment so the delivery flow sees a decision, even when
    // the ticket did not name a pack (assignment.workflow === undefined
    // represents an explicit "no workflow pack" choice).
    let reason: string;
    if (resolvedWorkflow) {
      reason = workflowReference?.trim()
        ? `Extracted from Jira during analysis: ${workflowReference.trim()}`
        : 'Extracted from Jira during analysis.';
    } else {
      reason = 'Analysis determined no workflow pack is needed.';
    }

    aiSessionManager.setIssueWorkflowAssignment(issueKey, resolvedWorkflow, {
      source: 'analysis',
      reason
    });
  }

  function isDeliveryTask(
    record: AgentSessionRecord | undefined
  ): record is AgentSessionRecord & { delivery: NonNullable<AgentSessionRecord['delivery']> } {
    return record?.taskDefinition.kind === 'jira-delivery' && Boolean(record.delivery);
  }

  function getLatestAgentFailureSummary(record: AgentSessionRecord): string | undefined {
    for (let index = record.events.length - 1; index >= 0; index -= 1) {
      const event = record.events[index];
      if (event.type === 'error' && event.summary.trim().length > 0) {
        return event.summary.trim();
      }
    }
    return undefined;
  }

  async function advanceDeliveredIssueToNextStatus(issueKey: string): Promise<string | undefined> {
    const currentIssue = await backendService.getIssue(issueKey);
    const transitions = currentIssue.transitions?.length
      ? currentIssue.transitions
      : await backendService.getTransitions(issueKey);
    const selectedTransition = selectNextDeliveryTransition({
      status: currentIssue.status,
      statusCategory: currentIssue.statusCategory,
      transitions
    });
    if (!selectedTransition) {
      return undefined;
    }

    await backendService.transitionIssue(issueKey, selectedTransition.id);
    await syncIssueAfterMutation(issueKey);
    return selectedTransition.toStatus?.trim() || selectedTransition.name.trim() || undefined;
  }

  async function startFreshDeliveryImplementationSession(
    issue: IssueDetails,
    record: AgentSessionRecord & { delivery: NonNullable<AgentSessionRecord['delivery']> },
    analysisResult: NonNullable<ReturnType<typeof parseDeliveryAnalysisResult>>
  ): Promise<void> {
    const isSubTask = Boolean(record.delivery.parentFeatureIssueKey);
    const implementationTaskDefinition = isSubTask
      ? buildSubTaskDeliveryTaskDefinition(issue, {
          baseBranch: record.delivery.baseBranch,
          branchName: record.delivery.createdBranch,
          worktreePath: record.delivery.worktreePath,
          workflow: record.taskDefinition.workflow,
          analysis: analysisResult
        })
      : buildDeliveryTaskDefinition(issue, {
          baseBranch: record.delivery.baseBranch,
          branchName: record.delivery.createdBranch,
          worktreePath: record.delivery.worktreePath,
          publishCommand: record.delivery.publishCommand,
          artifactPattern: record.delivery.artifactPattern,
          workflow: record.taskDefinition.workflow,
          analysis: analysisResult
        });
    const taskDefinitionWithAttachments = record.taskDefinition.attachments?.length
      ? { ...implementationTaskDefinition, attachments: record.taskDefinition.attachments }
      : implementationTaskDefinition;

    const provider = await startAgentTask(
      {
        ...issue,
        branch: record.delivery.createdBranch
      },
      taskDefinitionWithAttachments,
      {
        provider: resolvePreferredAgentProvider(issue.key, record, issue),
        workingDirectory: record.delivery.worktreePath
      }
    );

    aiSessionManager.updateAgentDelivery(
      issue.key,
      {
        ...record.delivery,
        phase: 'implementation',
        analysisSummary: analysisResult.summary,
        analysisPlan: analysisResult.implementationPlan,
        finalizationState: 'pending',
        finalizationMessage: 'Fresh implementation session started after delivery analysis.'
      },
      { replace: true }
    );

    try {
      await backendService.addComment(
        issue.key,
        buildDeliveryStartedComment({
          agentLabel: getAgentDisplayName(provider),
          baseBranch: record.delivery.baseBranch,
          branchName: record.delivery.createdBranch,
          worktreeName: record.delivery.worktreeName,
          workflow: taskDefinitionWithAttachments.workflow
        })
      );
    } catch (error) {
      reportError(error, `deliveryStartComment:${issue.key}`);
    }
  }

  async function postAgentInputRequestComment(
    record: AgentSessionRecord & { delivery: NonNullable<AgentSessionRecord['delivery']> }
  ): Promise<void> {
    const { issueKey } = record;
    const lastInputEvent = [...record.events]
      .reverse()
      .find(event => event.type === 'user_input_requested');
    const question = lastInputEvent?.summary ?? 'The AI agent needs your input to continue.';
    const issue = await backendService.getIssue(issueKey);
    const mentionLine = issue.reporterMention ? `${issue.reporterMention},\n\n` : '';
    const commentBody = [
      AI_COMMENT_HEADER,
      COPILOT_AGENT_INPUT_REQUEST_MARKER,
      '',
      `${mentionLine}${question}`,
      '',
      'Reply with "#AIbot <your answer>" so the bot sees your response.'
    ].join('\n');

    try {
      await backendService.addComment(issueKey, commentBody);
      outputChannel.appendLine(
        `[Agent Input] Posted input request comment on ${issueKey}: ${question.slice(0, 120)}`
      );
    } catch (error) {
      reportError(error, `agentInputComment:${issueKey}`);
    }
  }

  /**
   * Recover in-flight delivery sessions after an extension restart.
   * Scans all persisted agent sessions and processes any that were interrupted:
   * 0. Sessions that were paused by deactivation while actively running → auto-resume
   * 1. Sessions with finalizationState='pending' that completed/failed → finalize them
   * 2. Sub-task deliveries that finalized but never created an MR → create MR
   * 3. Sub-task MRs that were merged but next sub-task wasn't started → advance
   */
  async function recoverPendingDeliverySessions(): Promise<void> {
    const allSessions = aiSessionManager.getAllAgentSessions();
    let recoveredCount = 0;

    // First pass: auto-resume paused delivery sessions
    for (const [issueKey, record] of allSessions) {
      if (!isDeliveryTask(record)) {
        continue;
      }

      if (
        record.state === 'paused' &&
        record.delivery.source === 'jira-polling' &&
        record.delivery.finalizationState === 'pending'
      ) {
        outputChannel.appendLine(
          `[Recovery] Found paused delivery session for ${issueKey} (phase: ${record.delivery.phase}). Auto-resuming.`
        );
        try {
          await resumeAgentTask(issueKey, record);
          outputChannel.appendLine(`[Recovery] Successfully resumed session for ${issueKey}.`);
          recoveredCount++;
        } catch (error) {
          outputChannel.appendLine(
            `[Recovery] Failed to resume session for ${issueKey}: ${error instanceof Error ? error.message : String(error)}. Will attempt restart.`
          );
          // If resume fails (e.g. SDK session expired), restart the delivery
          // from the current phase with a fresh agent task.
          try {
            await restartPausedDeliverySession(issueKey, record);
            recoveredCount++;
          } catch (restartError) {
            reportError(restartError, `recovery:restart:${issueKey}`);
          }
        }
        continue;
      }
    }

    // Second pass: handle completed/failed sessions that need finalization or advancement
    for (const [issueKey, record] of allSessions) {
      if (!isDeliveryTask(record)) {
        continue;
      }
      const delivery = record.delivery;

      // Skip sessions we just resumed above
      if (record.state === 'paused') {
        continue;
      }

      // Case 1: Session completed/failed but finalization never ran (e.g. restart mid-flight)
      if (
        delivery.finalizationState === 'pending' &&
        (record.state === 'completed' || record.state === 'failed')
      ) {
        outputChannel.appendLine(
          `[Recovery] Found pending finalization for ${issueKey} (state: ${record.state}, phase: ${delivery.phase}). Re-triggering finalization.`
        );
        void finalizeDeliverySession(record);
        recoveredCount++;
        continue;
      }

      // Case 2: Sub-task delivery finalized but wasn't properly completed
      // under the new flow (transition to Done + MR creation). This handles
      // sub-tasks that completed under older code or where the finalization
      // was interrupted between steps.
      if (
        delivery.parentFeatureIssueKey &&
        delivery.finalizationState === 'completed'
      ) {
        try {
          // Ensure the parent's sub-task tracking reflects completion
          updateParentSubTaskState(delivery.parentFeatureIssueKey, issueKey, 'completed');

          // Ensure the sub-task is transitioned to Done in Jira
          const subTaskIssue = await backendService.getIssue(issueKey);
          if (subTaskIssue.status !== 'Done') {
            const doneTransitionId = await findTransitionIdForStatus(issueKey, 'Done');
            if (doneTransitionId) {
              await backendService.transitionIssue(issueKey, doneTransitionId);
              outputChannel.appendLine(
                `[Recovery] Transitioned sub-task ${issueKey} to Done.`
              );
            }
          }

          // Ensure the MR exists
          if (!delivery.mergeRequest?.iid) {
            outputChannel.appendLine(
              `[Recovery] Sub-task ${issueKey} completed but has no merge request. Creating MR.`
            );
            await ensureMergeRequestForDoneIssue(issueKey);
          }
          recoveredCount++;
        } catch (error) {
          reportError(error, `recovery:subTaskComplete:${issueKey}`);
        }
        continue;
      }

      // Case 3: Sub-task MR was merged but next sub-task was never started
      if (
        delivery.parentFeatureIssueKey &&
        delivery.mergeRequest?.state === 'merged'
      ) {
        const parentRecord = aiSessionManager.getAgentSession(delivery.parentFeatureIssueKey);
        const featureDecomp = parentRecord?.delivery?.featureDecomposition;
        if (featureDecomp) {
          const hasNextPending = featureDecomp.subTasks
            .sort((a, b) => a.order - b.order)
            .some(st => st.deliveryState === 'pending');
          const hasInProgress = featureDecomp.subTasks
            .some(st => st.deliveryState === 'in-progress');
          // Only advance if there's a pending sub-task but none currently in-progress
          if (hasNextPending && !hasInProgress) {
            outputChannel.appendLine(
              `[Recovery] Sub-task ${issueKey} MR merged but next sub-task not started. Advancing.`
            );
            try {
              await advanceToNextSubTask(delivery.parentFeatureIssueKey);
              recoveredCount++;
            } catch (error) {
              reportError(error, `recovery:advanceSubTask:${issueKey}`);
            }
          }
        }
      }
    }

    if (recoveredCount > 0) {
      outputChannel.appendLine(
        `[Recovery] Recovered ${recoveredCount} delivery session(s) from previous run.`
      );
    }
  }

  /**
   * When a paused delivery session cannot be resumed (e.g. SDK session expired),
   * restart the delivery from scratch using the persisted metadata. The existing
   * worktree and branch are reused — only the agent task is recreated.
   */
  async function restartPausedDeliverySession(
    issueKey: string,
    record: AgentSessionRecord & { delivery: NonNullable<AgentSessionRecord['delivery']> }
  ): Promise<void> {
    const delivery = record.delivery;
    const issue = await backendService.getIssue(issueKey);

    // Determine whether this is a sub-task delivery
    const isSubTask = Boolean(delivery.parentFeatureIssueKey);

    // Rebuild the task definition based on the delivery phase
    let taskDefinition: AgentTaskDefinition;
    if (delivery.phase === 'analysis') {
      taskDefinition = isSubTask
        ? buildSubTaskAnalysisTaskDefinition(issue, {
            baseBranch: delivery.baseBranch,
            branchName: delivery.createdBranch,
            worktreePath: delivery.worktreePath,
            workflow: record.taskDefinition.workflow
          })
        : buildDeliveryAnalysisTaskDefinition(issue, {
            baseBranch: delivery.baseBranch,
            branchName: delivery.createdBranch,
            worktreePath: delivery.worktreePath,
            publishCommand: delivery.publishCommand,
            artifactPattern: delivery.artifactPattern,
            workflow: record.taskDefinition.workflow
          });
    } else if (delivery.phase === 'implementation') {
      const analysis = delivery.analysisSummary
        ? { status: 'ready' as const, summary: delivery.analysisSummary, implementationPlan: delivery.analysisPlan, blockers: [] }
        : undefined;
      taskDefinition = isSubTask
        ? buildSubTaskDeliveryTaskDefinition(issue, {
            baseBranch: delivery.baseBranch,
            branchName: delivery.createdBranch,
            worktreePath: delivery.worktreePath,
            workflow: record.taskDefinition.workflow,
            analysis
          })
        : buildDeliveryTaskDefinition(issue, {
            baseBranch: delivery.baseBranch,
            branchName: delivery.createdBranch,
            worktreePath: delivery.worktreePath,
            publishCommand: delivery.publishCommand,
            artifactPattern: delivery.artifactPattern,
            workflow: record.taskDefinition.workflow,
            analysis
          });
    } else {
      outputChannel.appendLine(
        `[Recovery] Cannot restart ${issueKey}: unsupported phase '${delivery.phase}'.`
      );
      return;
    }

    // Carry over any attachments from the original task
    if (record.taskDefinition.attachments?.length) {
      taskDefinition.attachments = record.taskDefinition.attachments;
    }

    const provider = await startAgentTask(
      { ...issue, branch: delivery.createdBranch },
      taskDefinition,
      {
        provider: resolvePreferredAgentProvider(issueKey, record, issue),
        workingDirectory: delivery.worktreePath
      }
    );

    // Preserve the existing delivery metadata (worktree, branches, parent reference, etc.)
    aiSessionManager.updateAgentDelivery(issueKey, {
      ...delivery,
      finalizationState: 'pending',
      finalizationMessage: `Session restarted after VS Code restart (phase: ${delivery.phase}).`
    }, { replace: true });

    outputChannel.appendLine(
      `[Recovery] Restarted delivery for ${issueKey} in ${delivery.phase} phase using ${getAgentDisplayName(provider)}.`
    );
  }

  async function finalizeDeliverySession(record: AgentSessionRecord): Promise<void> {
    if (!isDeliveryTask(record) || record.delivery.finalizationState !== 'pending') {
      return;
    }
    const delivery = record.delivery;
    if (deliveryFinalizationInFlight.has(record.issueKey)) {
      return;
    }

    deliveryFinalizationInFlight.add(record.issueKey);
    try {
      if (record.state === 'completed') {
          if (delivery.phase === 'merge-request-feedback') {
            const mergeRequest = delivery.mergeRequest;
          if (!mergeRequest) {
              throw new Error('The AI agent completed a merge request feedback task but no merge request metadata is attached to the delivery session.');
          }

          const feedbackResult = parseMergeRequestFeedbackResult(record.responseText);
          if (!feedbackResult) {
            throw new Error(
                'The AI agent completed the merge request feedback task but did not return a valid MERGE_REQUEST_FEEDBACK_RESULT payload.'
            );
          }

          const gitLabAutomation = await resolveGitLabAutomation();
          if (!gitLabAutomation) {
            throw new Error('GitLab MR automation is not configured, so the feedback reply could not be posted.');
          }

          const replyBody = wrapTicketManagerManagedMergeRequestNote(buildMergeRequestReplyComment(feedbackResult));
          const triggeringDiscussionIds = [
            ...new Set(
              (mergeRequest.pendingFeedback?.notes ?? [])
                .map(note => note.discussionId)
                .filter((id): id is string => typeof id === 'string' && id.length > 0)
            )
          ];
          if (triggeringDiscussionIds.length === 1) {
            try {
              await gitLabAutomation.client.replyToMergeRequestDiscussion(
                mergeRequest.iid,
                triggeringDiscussionIds[0],
                replyBody
              );
            } catch {
              await gitLabAutomation.client.addMergeRequestNote(mergeRequest.iid, replyBody);
            }
          } else {
            await gitLabAutomation.client.addMergeRequestNote(mergeRequest.iid, replyBody);
          }
          aiSessionManager.updateAgentDelivery(record.issueKey, {
            ...delivery,
            phase: 'implementation',
            finalizationState: 'completed',
            finalizationMessage: 'Posted a merge request reply after processing review feedback.',
            mergeRequest: {
              ...mergeRequest,
              pendingFeedback: undefined,
              buildRequiredOnMerge: mergeRequest.buildRequiredOnMerge || feedbackResult.didEditCode
            }
          }, { replace: true });
          outputChannel.appendLine(`[GitLab MR] Posted automated merge request reply for ${record.issueKey}.`);
          return;
        }

        if (delivery.phase === 'analysis') {
          const analysisResult = parseDeliveryAnalysisResult(record.responseText);
          if (!analysisResult) {
            throw new Error(
              'The AI agent completed the delivery analysis session but did not return a valid DELIVERY_ANALYSIS_RESULT payload.'
            );
          }

          if (analysisResult.status === 'blocked') {
            await backendService.addComment(
              record.issueKey,
              buildDeliveryAnalysisBlockedComment(analysisResult)
            );
            aiSessionManager.updateAgentDelivery(record.issueKey, {
              finalizationState: 'failed',
              finalizationMessage: analysisResult.summary,
              analysisSummary: analysisResult.summary,
              analysisPlan: undefined
            });
            outputChannel.appendLine(`[Delivery] Delivery analysis blocked ${record.issueKey}.`);
            return;
          }

          await backendService.addComment(
            record.issueKey,
            buildPollingAnalysisReadyComment()
          );
          const refreshedIssue = await backendService.getIssue(record.issueKey);
          await startFreshDeliveryImplementationSession(refreshedIssue, record, analysisResult);
          outputChannel.appendLine(
            `[Delivery] Started fresh implementation session for ${record.issueKey} after delivery analysis.`
          );
          return;
        }

        if (delivery.phase === 'feature-decomposition') {
          await finalizeFeatureDecomposition(record);
          return;
        }

        let result = parseDeliveryTaskResult(record.responseText);

        // Sub-task deliveries: skip publish/artifact upload, transition to Done.
        // Either auto-merge into feature branch or create MR, depending on config.
        // If the agent didn't return a valid DELIVERY_RESULT, synthesize one from
        // delivery metadata so the chain can proceed (the branch/commit info is
        // already known from the worktree setup).
        if (delivery.parentFeatureIssueKey) {
          if (!result) {
            outputChannel.appendLine(
              `[Feature Sub-task] Agent for ${record.issueKey} did not return a DELIVERY_RESULT payload. Synthesizing result from delivery metadata.`
            );
            result = {
              status: record.state === 'completed' ? 'success' : 'failure',
              summary: record.responseText?.trim().slice(-500) || 'Sub-task delivery completed (no structured result returned by agent).',
              branch: delivery.createdBranch,
              artifactPaths: [],
              failureReason: record.state !== 'completed' ? 'Agent did not return a structured DELIVERY_RESULT payload.' : undefined
            };
          }
          const currentIssue = await backendService.getIssue(record.issueKey);
          const autoMerge = configStore.isAutoMergeSubTasksEnabled();

          await backendService.addComment(
            record.issueKey,
            buildDeliverySuccessComment(result, {
              template: delivery.summaryTemplate,
              attachedArtifactNames: [],
              reporterMention: currentIssue.reporterMention,
              reporterName: currentIssue.reporter
            })
          );

          // Transition sub-task to Done
          let advancedStatus: string | undefined;
          try {
            const doneTransitionId = await findTransitionIdForStatus(record.issueKey, 'Done');
            if (doneTransitionId) {
              await backendService.transitionIssue(record.issueKey, doneTransitionId);
              advancedStatus = 'Done';
              outputChannel.appendLine(
                `[Feature Sub-task] Transitioned ${record.issueKey} to Done.`
              );
            } else {
              advancedStatus = await advanceDeliveredIssueToNextStatus(record.issueKey);
            }
          } catch (transitionError) {
            reportError(transitionError, `subTaskDeliveryAdvance:${record.issueKey}`);
          }

          updateParentSubTaskState(delivery.parentFeatureIssueKey, record.issueKey, 'completed');

          if (autoMerge) {
            // Auto-merge: merge sub-task branch into the feature branch directly
            try {
              // Build git auth args from GITLAB_TOKEN if available
              const gitExtraArgs: string[] = [];
              const gitlabToken = process.env.GITLAB_TOKEN;
              if (gitlabToken) {
                const auth = Buffer.from(`oauth2:${gitlabToken}`).toString('base64');
                gitExtraArgs.push('-c', `http.extraHeader=Authorization: Basic ${auth}`);
              }

              const mergeResult = await gitWorktreeManager!.mergeSubTaskBranch(
                workingDirectory!,
                delivery.createdBranch,
                delivery.baseBranch,
                delivery.worktreePath,
                { gitExtraArgs }
              );
              outputChannel.appendLine(
                `[Feature Sub-task] Auto-merged ${record.issueKey} into ${delivery.baseBranch} (commit: ${mergeResult.mergeCommit.slice(0, 8)}).`
              );

              aiSessionManager.updateAgentDelivery(record.issueKey, {
                finalizationState: 'completed',
                finalizationMessage: advancedStatus
                  ? `Posted summary, moved to ${advancedStatus}, and auto-merged into ${delivery.baseBranch}.`
                  : `Posted summary and auto-merged into ${delivery.baseBranch}.`,
                result
              });

              // Immediately advance to the next sub-task
              await advanceToNextSubTask(delivery.parentFeatureIssueKey);
            } catch (mergeError) {
              reportError(mergeError, `subTaskAutoMerge:${record.issueKey}`);
              outputChannel.appendLine(
                `[Feature Sub-task] Auto-merge failed for ${record.issueKey}: ${mergeError instanceof Error ? mergeError.message : String(mergeError)}. Falling back to MR.`
              );
              // Fallback: create MR if auto-merge fails (e.g. merge conflict)
              try {
                await ensureMergeRequestForDoneIssue(record.issueKey);
              } catch (mrError) {
                reportError(mrError, `subTaskMergeRequestFallback:${record.issueKey}`);
              }
              aiSessionManager.updateAgentDelivery(record.issueKey, {
                finalizationState: 'completed',
                finalizationMessage: `Auto-merge failed. Created merge request instead. Next sub-task starts after MR merge.`,
                result
              });
            }
          } else {
            // MR mode: create MR targeting the feature branch, wait for merge
            try {
              await ensureMergeRequestForDoneIssue(record.issueKey);
              outputChannel.appendLine(
                `[Feature Sub-task] Created/ensured MR for sub-task ${record.issueKey}. Next sub-task will start when this MR is merged.`
              );
            } catch (mrError) {
              reportError(mrError, `subTaskMergeRequest:${record.issueKey}`);
            }

            aiSessionManager.updateAgentDelivery(record.issueKey, {
              finalizationState: 'completed',
              finalizationMessage: advancedStatus
                ? `Posted summary, moved to ${advancedStatus}, and created merge request. Next sub-task starts after MR merge.`
                : 'Posted summary and created merge request. Next sub-task starts after MR merge.',
              result
            });
          }

          outputChannel.appendLine(`[Feature Sub-task] Finalized sub-task delivery for ${record.issueKey}.`);
          return;
        }

        // Non-sub-task deliveries require a valid DELIVERY_RESULT
        if (!result) {
          throw new Error(
            'The AI agent completed the delivery task but did not return a valid DELIVERY_RESULT payload.'
          );
        }

        const attachedArtifactNames: string[] = [];
        const previouslyUploaded = new Set(
          (delivery.uploadedArtifactNames ?? []).map(n => n.toLowerCase())
        );
        const seenArtifactPaths = new Set<string>();
        for (const [artifactIndex, artifactPath] of result.artifactPaths.entries()) {
          const resolvedArtifactPath = path.isAbsolute(artifactPath)
            ? artifactPath
            : path.resolve(delivery.worktreePath, artifactPath);
          const normalizedArtifactPath = path.normalize(resolvedArtifactPath).toLowerCase();
          if (seenArtifactPaths.has(normalizedArtifactPath)) {
            outputChannel.appendLine(
              `[Delivery] Skipping duplicate artifact path for ${record.issueKey}: ${artifactPath}`
            );
            continue;
          }
          seenArtifactPaths.add(normalizedArtifactPath);
          const preparedUpload = await prepareArtifactForJiraUpload(resolvedArtifactPath, {
            issueKey: record.issueKey,
            buildIdentifier: result.buildIdentifier,
            artifactIndex
          });
          if (previouslyUploaded.has(preparedUpload.attachmentName.toLowerCase())) {
            outputChannel.appendLine(
              `[Delivery] Skipping already-uploaded artifact for ${record.issueKey}: ${preparedUpload.attachmentName}`
            );
            await preparedUpload.cleanup?.();
            attachedArtifactNames.push(preparedUpload.attachmentName);
            continue;
          }
          try {
            await backendService.attachFile(
              record.issueKey,
              preparedUpload.uploadPath,
              preparedUpload.attachmentName
            );
            attachedArtifactNames.push(preparedUpload.attachmentName);
            // Persist after each successful upload so recovery skips it
            aiSessionManager.updateAgentDelivery(record.issueKey, {
              uploadedArtifactNames: [...attachedArtifactNames]
            });
          } finally {
            await preparedUpload.cleanup?.();
          }
        }

        const currentIssue = await backendService.getIssue(record.issueKey);

        await backendService.addComment(
          record.issueKey,
          buildDeliverySuccessComment(result, {
            template: delivery.summaryTemplate,
            attachedArtifactNames,
            reporterMention: currentIssue.reporterMention,
            reporterName: currentIssue.reporter
          })
        );

        let advancedStatus: string | undefined;
        try {
          advancedStatus = await advanceDeliveredIssueToNextStatus(record.issueKey);
          if (advancedStatus) {
            outputChannel.appendLine(
              `[Delivery] Advanced ${record.issueKey} to ${advancedStatus} after successful delivery finalization.`
            );
          }
        } catch (transitionError) {
          reportError(transitionError, `deliveryAdvance:${record.issueKey}`);
        }

        aiSessionManager.updateAgentDelivery(record.issueKey, {
          finalizationState: 'completed',
          finalizationMessage: advancedStatus
            ? `Attached delivery artifacts, posted summary comment, and moved the ticket to ${advancedStatus}.`
            : 'Attached delivery artifacts and posted summary comment.',
          result
        });
        outputChannel.appendLine(`[Delivery] Finalized Jira delivery workflow for ${record.issueKey}.`);
        return;
      }

      const failureReason =
        getLatestAgentFailureSummary(record) ??
        (delivery.phase === 'analysis'
          ? 'The AI delivery analysis stopped before it determined whether implementation could start.'
          : delivery.phase === 'merge-request-feedback'
            ? 'The AI agent stopped before it could process the latest merge request feedback.'
          : 'The AI delivery workflow stopped before it completed the implementation work.');
      if (delivery.phase === 'merge-request-feedback' && delivery.mergeRequest) {
        const gitLabAutomation = await resolveGitLabAutomation();
        if (gitLabAutomation) {
          await gitLabAutomation.client.addMergeRequestNote(
            delivery.mergeRequest.iid,
            wrapTicketManagerManagedMergeRequestNote(buildMergeRequestFailureReplyComment(failureReason))
          );
        }
      }
      await backendService.addComment(
        record.issueKey,
        buildDeliveryFailureComment(failureReason, {
          template: delivery.failureTemplate,
          branch: delivery.createdBranch,
          commitHash: delivery.result?.commitHash,
          pushedRef: delivery.result?.pushedRef
        })
      );
      aiSessionManager.updateAgentDelivery(record.issueKey, {
        finalizationState: 'failed',
        finalizationMessage: failureReason
      });
      outputChannel.appendLine(`[Delivery] Posted Jira failure summary for ${record.issueKey}.`);

      // If this is a sub-task delivery, update parent state (do not advance — the
      // next sub-task only starts after MR merge, and failures halt the chain).
      if (delivery.parentFeatureIssueKey) {
        updateParentSubTaskState(delivery.parentFeatureIssueKey, record.issueKey, 'failed');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      aiSessionManager.updateAgentDelivery(record.issueKey, {
        finalizationState: 'failed',
        finalizationMessage: message
      });
      if (delivery.phase === 'merge-request-feedback' && delivery.mergeRequest) {
        try {
          const gitLabAutomation = await resolveGitLabAutomation();
          if (gitLabAutomation) {
            await gitLabAutomation.client.addMergeRequestNote(
              delivery.mergeRequest.iid,
              wrapTicketManagerManagedMergeRequestNote(buildMergeRequestFailureReplyComment(message))
            );
          }
        } catch (mergeRequestCommentError) {
          reportError(mergeRequestCommentError, `gitlabMergeRequestReply:${record.issueKey}`);
        }
      }
      try {
        await backendService.addComment(
          record.issueKey,
          buildDeliveryFailureComment(message, {
            template: delivery.failureTemplate,
            branch: delivery.createdBranch,
            commitHash: delivery.result?.commitHash,
            pushedRef: delivery.result?.pushedRef
          })
        );
      } catch (commentError) {
        reportError(commentError, `deliveryFinalizeComment:${record.issueKey}`);
      }
      reportError(error, `deliveryFinalize:${record.issueKey}`);

      // If this is a sub-task delivery, update parent state.
      if (delivery.parentFeatureIssueKey) {
        updateParentSubTaskState(delivery.parentFeatureIssueKey, record.issueKey, 'failed');
      }
    } finally {
      deliveryFinalizationInFlight.delete(record.issueKey);
    }
  }

  async function startPollingDeliveryWorkflow(
    issue: IssueDetails,
    options?: {
      preTransitionComment?: string;
      forceCleanWorktree?: boolean;
    }
  ): Promise<boolean> {
    const currentIssue = await backendService.getIssue(issue.key);
    const deliverySettings = configStore.getAiDeliveryWorkflowSettings();
    const settingsErrors = validateDeliveryWorkflowSettings(deliverySettings);
    if (!workingDirectory || !gitWorktreeManager) {
      settingsErrors.push('Open the repository workspace before starting automatic delivery.');
    }
    if (settingsErrors.length > 0) {
      await backendService.addComment(
        issue.key,
        buildDeliveryFailureComment(
          `Implementation is ready, but the delivery workflow is not configured: ${settingsErrors.join(' ')}`,
          { template: deliverySettings.failureTemplate }
        )
      );
      return false;
    }
    const deliveryWorkingDirectory = workingDirectory!;
    const deliveryWorktreeManager = gitWorktreeManager!;
    const issueWorkflowAssignment = aiSessionManager.getIssueWorkflowAssignment(currentIssue.key);
    const discoveredWorkflows = await discoverWorkspaceAgentWorkflows(deliveryWorkingDirectory);
    const assignedWorkflow = issueWorkflowAssignment?.workflow;
    if (!issueWorkflowAssignment) {
      // No choice has been recorded yet — ask the user. An assignment with
      // `workflow === undefined` is treated as an explicit "no workflow pack"
      // decision and allowed to proceed.
      await backendService.addComment(
        currentIssue.key,
        buildMissingWorkflowComment(
          discoveredWorkflows.map(workflow => `${workflow.name} (${workflow.id}) — ${workflow.instructionsPath}`)
        )
      );
      return false;
    }

    const baseBranch = extractDeliveryBaseBranch(currentIssue) ?? configStore.getDeliveryDefaultBaseBranch();
    if (!baseBranch) {
      await backendService.addComment(currentIssue.key, buildMissingBaseBranchClarificationComment());
      return false;
    }

    let issueAttachments;
    try {
      issueAttachments = await stageIssueAttachments({
        issue: currentIssue,
        backendService,
        logger: outputChannel
      });
    } catch (error) {
      await backendService.addComment(
        currentIssue.key,
        buildDeliveryFailureComment(
          `Implementation is blocked because issue attachments could not be downloaded: ${error instanceof Error ? error.message : String(error)}`,
          { template: deliverySettings.failureTemplate }
        )
      );
      return false;
    }

    const worktree = await deliveryWorktreeManager.prepareDeliveryWorktree(
      currentIssue,
      baseBranch,
      deliveryWorkingDirectory,
      { forceClean: options?.forceCleanWorktree }
    );
    const scopedPublishCommand = resolveDeliveryPublishCommand(
      deliverySettings.publishCommand,
      worktree.worktreePath
    );

    if (options?.preTransitionComment?.trim()) {
      await backendService.addComment(currentIssue.key, options.preTransitionComment.trim());
    }

    const transitionId = await findTransitionIdForStatus(currentIssue.key, 'In Progress');
    if (transitionId) {
      await backendService.transitionIssue(currentIssue.key, transitionId);
    }

    const taskDefinition = buildDeliveryAnalysisTaskDefinition(currentIssue, {
      baseBranch,
      branchName: worktree.branchName,
      worktreePath: worktree.worktreePath,
      publishCommand: scopedPublishCommand,
      artifactPattern: deliverySettings.artifactPattern,
      workflow: assignedWorkflow
    });
    const taskDefinitionWithAttachments = issueAttachments.length > 0
      ? { ...taskDefinition, attachments: issueAttachments }
      : taskDefinition;

    const provider = await startAgentTask(
      {
        ...currentIssue,
        branch: worktree.branchName
      },
      taskDefinitionWithAttachments,
      {
        provider: resolvePreferredAgentProvider(currentIssue.key, undefined, currentIssue),
        workingDirectory: worktree.worktreePath
      }
    );

    aiSessionManager.updateAgentDelivery(
      issue.key,
      {
        source: 'jira-polling',
        phase: 'analysis',
        baseBranch,
        worktreeName: worktree.worktreeName,
        worktreePath: worktree.worktreePath,
        createdBranch: worktree.branchName,
        publishCommand: scopedPublishCommand,
        artifactPattern: deliverySettings.artifactPattern,
        summaryTemplate: deliverySettings.summaryTemplate,
        failureTemplate: deliverySettings.failureTemplate,
        finalizationState: 'pending'
      },
      { replace: true }
    );
    await activeSessionsSidebarViewProvider?.refresh();
    outputChannel.appendLine(
      `[Delivery] Started Jira delivery workflow for ${currentIssue.key} from base branch ${baseBranch} using ${getAgentDisplayName(provider)}.`
    );
    return true;
  }

  /**
   * Start the feature decomposition workflow for a feature request ticket.
   * Creates a worktree, runs the decomposition agent, creates sub-tasks in Jira,
   * and sets up the feature branch structure.
   */
  async function startFeatureDecompositionWorkflow(
    issue: IssueDetails,
    options?: { forceCleanWorktree?: boolean }
  ): Promise<boolean> {
    const currentIssue = await backendService.getIssue(issue.key);
    const deliverySettings = configStore.getAiDeliveryWorkflowSettings();
    const settingsErrors = validateDeliveryWorkflowSettings(deliverySettings);
    if (!workingDirectory || !gitWorktreeManager) {
      settingsErrors.push('Open the repository workspace before starting feature decomposition.');
    }
    if (settingsErrors.length > 0) {
      await backendService.addComment(
        issue.key,
        buildDeliveryFailureComment(
          `Feature decomposition is blocked: ${settingsErrors.join(' ')}`,
          { template: deliverySettings.failureTemplate }
        )
      );
      return false;
    }
    const deliveryWorkingDirectory = workingDirectory!;
    const deliveryWorktreeManager = gitWorktreeManager!;

    const baseBranch = extractDeliveryBaseBranch(currentIssue) ?? configStore.getDeliveryDefaultBaseBranch();
    if (!baseBranch) {
      await backendService.addComment(currentIssue.key, buildMissingBaseBranchClarificationComment());
      return false;
    }

    let issueAttachments: Awaited<ReturnType<typeof stageIssueAttachments>> | undefined;
    try {
      issueAttachments = await stageIssueAttachments({
        issue: currentIssue,
        backendService,
        logger: outputChannel
      });
    } catch (error) {
      outputChannel.appendLine(
        `[Feature Decomposition] Warning: could not stage attachments for ${currentIssue.key}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const worktree = await deliveryWorktreeManager.prepareDeliveryWorktree(
      currentIssue,
      baseBranch,
      deliveryWorkingDirectory,
      { forceClean: options?.forceCleanWorktree }
    );

    const availableWorkflows = await discoverWorkspaceAgentWorkflows(deliveryWorkingDirectory);
    const assignedWorkflow = aiSessionManager.getIssueWorkflowAssignment(currentIssue.key)?.workflow;

    const scopedPublishCommand = resolveDeliveryPublishCommand(
      deliverySettings.publishCommand,
      worktree.worktreePath
    );

    const taskDefinition = buildFeatureDecompositionTaskDefinition(currentIssue, {
      baseBranch,
      worktreePath: worktree.worktreePath,
      availableWorkflows,
      workflow: assignedWorkflow
    });
    const taskDefinitionWithAttachments = issueAttachments?.length
      ? { ...taskDefinition, attachments: issueAttachments }
      : taskDefinition;

    const transitionId = await findTransitionIdForStatus(currentIssue.key, 'In Progress');
    if (transitionId) {
      await backendService.transitionIssue(currentIssue.key, transitionId);
    }

    const provider = await startAgentTask(
      {
        ...currentIssue,
        branch: worktree.branchName
      },
      taskDefinitionWithAttachments,
      {
        provider: resolvePreferredAgentProvider(currentIssue.key, undefined, currentIssue),
        workingDirectory: worktree.worktreePath
      }
    );

    aiSessionManager.updateAgentDelivery(
      issue.key,
      {
        source: 'jira-polling',
        phase: 'feature-decomposition',
        baseBranch,
        worktreeName: worktree.worktreeName,
        worktreePath: worktree.worktreePath,
        createdBranch: worktree.branchName,
        publishCommand: scopedPublishCommand,
        artifactPattern: deliverySettings.artifactPattern,
        summaryTemplate: deliverySettings.summaryTemplate,
        failureTemplate: deliverySettings.failureTemplate,
        finalizationState: 'pending'
      },
      { replace: true }
    );

    try {
      await backendService.addComment(
        issue.key,
        buildFeatureDecompositionStartedComment({
          agentLabel: getAgentDisplayName(provider),
          baseBranch,
          worktreeName: worktree.worktreeName
        })
      );
    } catch (error) {
      reportError(error, `featureDecompositionStartComment:${issue.key}`);
    }

    await activeSessionsSidebarViewProvider?.refresh();
    outputChannel.appendLine(
      `[Feature Decomposition] Started decomposition workflow for ${currentIssue.key} from base branch ${baseBranch} using ${getAgentDisplayName(provider)}.`
    );
    return true;
  }

  /**
   * Finalize a feature decomposition session: parse the result, create sub-tasks
   * in Jira, and set up the feature branch.
   */
  async function finalizeFeatureDecomposition(
    record: AgentSessionRecord & { delivery: NonNullable<AgentSessionRecord['delivery']> }
  ): Promise<void> {
    const decompositionResult = parseFeatureDecompositionResult(record.responseText);
    if (!decompositionResult) {
      throw new Error(
        'The AI agent completed the feature decomposition session but did not return a valid FEATURE_DECOMPOSITION_RESULT payload.'
      );
    }

    if (decompositionResult.status === 'blocked') {
      const issue = await backendService.getIssue(record.issueKey);
      await backendService.addComment(
        record.issueKey,
        buildFeatureDecompositionBlockedComment(decompositionResult, issue.reporterMention)
      );
      aiSessionManager.updateAgentDelivery(record.issueKey, {
        finalizationState: 'failed',
        finalizationMessage: decompositionResult.summary
      });
      outputChannel.appendLine(`[Feature Decomposition] Decomposition blocked for ${record.issueKey}.`);
      return;
    }

    // Create feature branch from base branch
    const featureBranch = decompositionResult.featureBranch;
    if (workingDirectory) {
      try {
        const { execFile: execFileCb } = require('node:child_process');
        const { promisify } = require('node:util');
        const execFileAsync = promisify(execFileCb);
        // Create the feature branch from the base branch
        await execFileAsync('git', ['branch', featureBranch, record.delivery.baseBranch], {
          cwd: workingDirectory,
          windowsHide: true
        });
        // Push the feature branch to origin
        const auth = process.env.GITLAB_TOKEN
          ? Buffer.from(`oauth2:${process.env.GITLAB_TOKEN}`).toString('base64')
          : undefined;
        const pushArgs = auth
          ? ['-c', `http.extraHeader=Authorization: Basic ${auth}`, 'push', '-u', 'origin', featureBranch]
          : ['push', '-u', 'origin', featureBranch];
        await execFileAsync('git', pushArgs, {
          cwd: workingDirectory,
          windowsHide: true
        });
        outputChannel.appendLine(`[Feature Decomposition] Created and pushed feature branch ${featureBranch} from ${record.delivery.baseBranch}.`);
      } catch (error) {
        outputChannel.appendLine(
          `[Feature Decomposition] Warning: could not create feature branch ${featureBranch}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    // Create sub-tasks in Jira
    const issue = await backendService.getIssue(record.issueKey);
    const subTaskRecords: FeatureSubTaskRecord[] = [];

    if (backendService.createSubTasks) {
      const createdKeys = await backendService.createSubTasks(
        record.issueKey,
        issue.projectKey,
        decompositionResult.subTasks.map(st => ({
          summary: st.summary,
          description: st.description,
          issueType: st.issueType
        }))
      );

      const availableWorkflows = await discoverWorkspaceAgentWorkflows(workingDirectory);

      for (const [index, key] of createdKeys.entries()) {
        const subTaskDef = decompositionResult.subTasks[index];
        const subTaskRecord: FeatureSubTaskRecord = {
          issueKey: key,
          summary: subTaskDef.summary,
          order: subTaskDef.order,
          deliveryState: 'pending'
        };

        // Auto-assign workflow if suggested
        if (subTaskDef.suggestedWorkflow) {
          const resolvedWorkflow = resolveWorkflowReference(subTaskDef.suggestedWorkflow, availableWorkflows);
          if (resolvedWorkflow) {
            aiSessionManager.setIssueWorkflowAssignment(key, resolvedWorkflow, {
              source: 'analysis',
              reason: `Suggested by feature decomposition of ${record.issueKey}.`
            });
            subTaskRecord.workflow = resolvedWorkflow;
          }
        }

        subTaskRecords.push(subTaskRecord);
      }
    }

    // Update delivery metadata with feature decomposition info
    aiSessionManager.updateAgentDelivery(record.issueKey, {
      finalizationState: 'completed',
      finalizationMessage: `Feature decomposed into ${subTaskRecords.length} sub-tasks on branch ${featureBranch}.`,
      featureDecomposition: {
        parentIssueKey: record.issueKey,
        featureBranch,
        baseBranch: record.delivery.baseBranch,
        subTasks: subTaskRecords,
        decompositionSummary: decompositionResult.summary
      }
    });

    // Add base branch info to each sub-task description in Jira
    for (const subTaskRecord of subTaskRecords) {
      try {
        await backendService.addComment(
          subTaskRecord.issueKey,
          `**Base branch:** ${featureBranch}\n\nThis sub-task is part of feature ${record.issueKey}. Changes should be merged into the feature branch \`${featureBranch}\`.`
        );
      } catch (error) {
        reportError(error, `featureSubTaskComment:${subTaskRecord.issueKey}`);
      }
    }

    await backendService.addComment(
      record.issueKey,
      buildFeatureDecompositionCompleteComment(decompositionResult)
    );

    outputChannel.appendLine(
      `[Feature Decomposition] Created ${subTaskRecords.length} sub-tasks for ${record.issueKey} on feature branch ${featureBranch}.`
    );

    // Automatically start the first sub-task
    await advanceToNextSubTask(record.issueKey);
  }

  /**
   * Update a sub-task's deliveryState in the parent's feature decomposition metadata.
   */
  function updateParentSubTaskState(
    parentIssueKey: string,
    subTaskKey: string,
    state: 'pending' | 'in-progress' | 'completed' | 'failed'
  ): void {
    const parentRecord = aiSessionManager.getAgentSession(parentIssueKey);
    if (!parentRecord?.delivery?.featureDecomposition) {
      return;
    }
    const featureDecomp = parentRecord.delivery.featureDecomposition;
    const updatedSubTasks = featureDecomp.subTasks.map(st =>
      st.issueKey === subTaskKey ? { ...st, deliveryState: state } : st
    );
    aiSessionManager.updateAgentDelivery(parentIssueKey, {
      featureDecomposition: { ...featureDecomp, subTasks: updatedSubTasks }
    });
  }

  /**
   * Find and start the next pending sub-task in a feature decomposition.
   * Called after the decomposition finishes and after each sub-task delivery
   * completes (success or failure) to automatically chain execution.
   */
  async function advanceToNextSubTask(parentIssueKey: string): Promise<void> {
    const parentRecord = aiSessionManager.getAgentSession(parentIssueKey);
    if (!parentRecord?.delivery?.featureDecomposition) {
      return;
    }

    const featureDecomp = parentRecord.delivery.featureDecomposition;
    const nextPending = featureDecomp.subTasks
      .sort((a, b) => a.order - b.order)
      .find(st => st.deliveryState === 'pending');

    if (!nextPending) {
      const allCompleted = featureDecomp.subTasks.every(st => st.deliveryState === 'completed');
      if (allCompleted) {
        outputChannel.appendLine(
          `[Feature Decomposition] All sub-tasks for ${parentIssueKey} have been completed.`
        );

        // Create MR from feature branch to base branch
        let mrUrl: string | undefined;
        try {
          const gitLabAutomation = await resolveGitLabAutomation();
          if (gitLabAutomation) {
            const parentIssue = await backendService.getIssue(parentIssueKey);
            const existingMRs = await gitLabAutomation.client.listMergeRequestsForSourceBranch(featureDecomp.featureBranch);
            let featureMR = existingMRs.find(mr => mr.sourceBranch === featureDecomp.featureBranch && mr.state === 'opened');
            if (!featureMR) {
              featureMR = await gitLabAutomation.client.createMergeRequest({
                sourceBranch: featureDecomp.featureBranch,
                targetBranch: featureDecomp.baseBranch,
                title: `${parentIssueKey}: ${parentIssue.summary}`,
                description: [
                  `Implements ${parentIssueKey}: ${parentIssue.summary}`,
                  '',
                  `This feature was decomposed into ${featureDecomp.subTasks.length} sub-tasks:`,
                  ...featureDecomp.subTasks.map(st => `- ${st.issueKey}: ${st.summary}`),
                  '',
                  `Feature branch: \`${featureDecomp.featureBranch}\``,
                  `Target branch: \`${featureDecomp.baseBranch}\``
                ].join('\n'),
                removeSourceBranch: true
              });
              outputChannel.appendLine(
                `[Feature Decomposition] Created MR !${featureMR.iid} from ${featureDecomp.featureBranch} to ${featureDecomp.baseBranch}.`
              );
            }
            mrUrl = featureMR.webUrl;

            // Store MR metadata on the parent delivery record
            aiSessionManager.updateAgentDelivery(parentIssueKey, {
              mergeRequest: {
                iid: featureMR.iid,
                webUrl: featureMR.webUrl,
                title: featureMR.title,
                sourceBranch: featureMR.sourceBranch,
                targetBranch: featureMR.targetBranch,
                state: featureMR.state
              }
            });
          }
        } catch (error) {
          reportError(error, `featureBranchMR:${parentIssueKey}`);
        }

        try {
          const mrLine = mrUrl ? `\n\nMerge request: ${mrUrl}` : '';
          await backendService.addComment(
            parentIssueKey,
            `All ${featureDecomp.subTasks.length} sub-tasks have been completed. The feature branch \`${featureDecomp.featureBranch}\` is ready for final review and merge into \`${featureDecomp.baseBranch}\`.${mrLine}`
          );
        } catch (error) {
          reportError(error, `featureAllSubTasksComplete:${parentIssueKey}`);
        }
      } else {
        const summary = featureDecomp.subTasks.reduce(
          (acc, st) => { acc[st.deliveryState ?? 'pending'] = (acc[st.deliveryState ?? 'pending'] ?? 0) + 1; return acc; },
          {} as Record<string, number>
        );
        outputChannel.appendLine(
          `[Feature Decomposition] No more pending sub-tasks for ${parentIssueKey}. Status: ${JSON.stringify(summary)}`
        );
      }
      return;
    }

    outputChannel.appendLine(
      `[Feature Decomposition] Advancing to next sub-task ${nextPending.issueKey} (order: ${nextPending.order}) for ${parentIssueKey}.`
    );

    try {
      await startSubTaskDelivery(parentIssueKey, nextPending.issueKey);
    } catch (error) {
      if (error instanceof WorktreeConflictError) {
        outputChannel.appendLine(
          `[Feature Decomposition] Worktree conflict for sub-task ${nextPending.issueKey}: ${error.worktreeName} already exists. Posting clarification comment.`
        );
        await backendService.addComment(
          parentIssueKey,
          buildWorktreeConflictClarificationComment(error.worktreeName)
        );
        return;
      }
      reportError(error, `advanceSubTask:${nextPending.issueKey}`);
      outputChannel.appendLine(
        `[Feature Decomposition] Failed to start sub-task ${nextPending.issueKey}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Start the delivery workflow for a specific sub-task of a feature request.
   * The sub-task worktree branches off the feature branch, and the MR targets
   * the feature branch.
   */
  async function startSubTaskDelivery(
    parentIssueKey: string,
    subTaskKey: string,
    options?: { forceCleanWorktree?: boolean }
  ): Promise<boolean> {
    const parentRecord = aiSessionManager.getAgentSession(parentIssueKey);
    if (!parentRecord?.delivery?.featureDecomposition) {
      throw new Error(`No feature decomposition found for ${parentIssueKey}.`);
    }

    const featureDecomp = parentRecord.delivery.featureDecomposition;
    const subTaskRecord = featureDecomp.subTasks.find(st => st.issueKey === subTaskKey);
    if (!subTaskRecord) {
      throw new Error(`Sub-task ${subTaskKey} not found in feature decomposition of ${parentIssueKey}.`);
    }

    const deliverySettings = configStore.getAiDeliveryWorkflowSettings();
    if (!workingDirectory || !gitWorktreeManager) {
      throw new Error('Open the repository workspace before starting sub-task delivery.');
    }

    const subTaskIssue = await backendService.getIssue(subTaskKey);

    // The sub-task branches off the feature branch, not the base branch
    const featureBranch = featureDecomp.featureBranch;
    const worktree = await gitWorktreeManager.prepareDeliveryWorktree(
      subTaskIssue,
      featureBranch,
      workingDirectory,
      { forceClean: options?.forceCleanWorktree }
    );

    const workflow = aiSessionManager.getIssueWorkflowAssignment(subTaskKey)?.workflow ?? subTaskRecord.workflow;
    const taskDefinition = buildSubTaskAnalysisTaskDefinition(subTaskIssue, {
      baseBranch: featureBranch,
      branchName: worktree.branchName,
      worktreePath: worktree.worktreePath,
      workflow
    });

    // Transition sub-task to In Progress
    const transitionId = await findTransitionIdForStatus(subTaskKey, 'In Progress');
    if (transitionId) {
      await backendService.transitionIssue(subTaskKey, transitionId);
    }

    const provider = await startAgentTask(
      {
        ...subTaskIssue,
        branch: worktree.branchName
      },
      taskDefinition,
      {
        provider: resolvePreferredAgentProvider(subTaskKey, undefined, subTaskIssue),
        workingDirectory: worktree.worktreePath
      }
    );

    aiSessionManager.updateAgentDelivery(
      subTaskKey,
      {
        source: 'jira-polling',
        phase: 'analysis',
        baseBranch: featureBranch,
        worktreeName: worktree.worktreeName,
        worktreePath: worktree.worktreePath,
        createdBranch: worktree.branchName,
        publishCommand: '',
        artifactPattern: '',
        summaryTemplate: deliverySettings.summaryTemplate,
        failureTemplate: deliverySettings.failureTemplate,
        finalizationState: 'pending',
        parentFeatureIssueKey: parentIssueKey
      },
      { replace: true }
    );

    // Update the parent's feature decomposition record
    const updatedSubTasks = featureDecomp.subTasks.map(st =>
      st.issueKey === subTaskKey
        ? { ...st, deliveryState: 'in-progress' as const, worktreeBranch: worktree.branchName }
        : st
    );
    aiSessionManager.updateAgentDelivery(parentIssueKey, {
      featureDecomposition: {
        ...featureDecomp,
        subTasks: updatedSubTasks
      }
    });

    try {
      await backendService.addComment(
        subTaskKey,
        buildDeliveryStartedComment({
          agentLabel: getAgentDisplayName(provider),
          baseBranch: featureBranch,
          branchName: worktree.branchName,
          worktreeName: worktree.worktreeName,
          workflow
        })
      );
    } catch (error) {
      reportError(error, `subTaskDeliveryStartComment:${subTaskKey}`);
    }

    await activeSessionsSidebarViewProvider?.refresh();
    outputChannel.appendLine(
      `[Feature Sub-task] Started delivery workflow for sub-task ${subTaskKey} (parent: ${parentIssueKey}) from feature branch ${featureBranch} using ${getAgentDisplayName(provider)}.`
    );
    return true;
  }

  async function revealActiveSessionsView(): Promise<void> {
    try {
      await vscode.commands.executeCommand('workbench.view.extension.ticketManager');
      await vscode.commands.executeCommand('ticketManager.activeSessions.focus');
    } catch {
      // View focus can fail while the workbench is closing or not ready yet.
    }
  }

  function getLatestPermissionRequestSummary(issueKey: string): string | undefined {
    const record = aiSessionManager.getAgentSession(issueKey);
    if (!record) {
      return undefined;
    }

    for (let index = record.events.length - 1; index >= 0; index -= 1) {
      const event = record.events[index];
      if (event.type === 'permission_requested') {
        return event.summary;
      }
    }
    return undefined;
  }

  function buildPermissionPromptSnapshot(issueKey: string): {
    signature?: string;
    detail?: string;
  } {
    const descriptions = vercelAgentService
      .getPendingPermissionDescriptions(issueKey)
      .filter(description => description.trim().length > 0);
    if (descriptions.length > 0) {
      const additionalCount = descriptions.length - 1;
      return {
        signature: descriptions.join('\n'),
        detail:
          additionalCount > 0
            ? `${descriptions[0]}\n\n${additionalCount} more queued request${additionalCount === 1 ? '' : 's'} pending.`
            : descriptions[0]
      };
    }

    const fallback = getLatestPermissionRequestSummary(issueKey);
    return fallback
      ? {
          signature: `fallback:${fallback}`,
          detail: fallback
        }
      : {};
  }

  async function openAiSession(issueKey: string): Promise<void> {
    activeSessionsSidebarViewProvider?.setSelectedIssueKey(issueKey);
    copilotSessionPanelManager.open(issueKey);
  }

  function clearPermissionPromptTracking(issueKey: string): void {
    permissionPromptSignatures.delete(issueKey);
    permissionPromptInFlight.delete(issueKey);
  }

  async function promptForPendingPermission(issueKey: string): Promise<void> {
    // Autopilot mode: Ticket Manager agents auto-approve every Copilot SDK
    // permission request, so a user-facing permission modal must never fire.
    // Kept as a no-op so legacy call sites compile without reintroducing the
    // prompt.
    clearPermissionPromptTracking(issueKey);
    return Promise.resolve();
  }

  function getVercelGatewayApiKey(options?: { showWarning?: boolean }): string | undefined {
    const apiKey = getVercelGatewayOptions().apiKey;
    if (!apiKey && options?.showWarning) {
      void vscode.window.showWarningMessage(
        'Vercel AI Gateway API key is not configured. Run Ticket Manager: Configure AI.'
      );
    }
    return apiKey;
  }

  type AgentRuntimeProvider = AiProvider;

  function isAgentRuntimeProvider(provider: AiProvider | undefined): provider is AgentRuntimeProvider {
    return provider === 'vercel-gateway';
  }

  function resolvePreferredAgentProvider(
    issueKey: string,
    record?: AgentSessionRecord,
    issue?: Pick<IssueDetails, 'description' | 'comments'>
  ): AgentRuntimeProvider | undefined {
    if (!isCopilotSdkConfigured()) {
      return undefined;
    }

    const assignmentProvider = aiSessionManager.getSession(issueKey)?.provider;
    if (isAgentRuntimeProvider(assignmentProvider)) {
      return assignmentProvider;
    }

    if (record?.provider && isAgentRuntimeProvider(record.provider)) {
      return record.provider;
    }

    if (issue) {
      const ticketDirective = extractAgentProviderDirective(issue);
      if (ticketDirective) {
        return ticketDirective;
      }
    }

    const defaultProvider = configStore.getAiDefaultProvider();
    if (defaultProvider !== 'none' && isAgentRuntimeProvider(defaultProvider)) {
      return defaultProvider;
    }

    return 'vercel-gateway';
  }

  function getAgentDisplayName(_provider: AgentRuntimeProvider): string {
    return 'Vercel AI Gateway';
  }

  function hasActiveAgentTask(issueKey: string): boolean {
    return vercelAgentService.hasActiveTask(issueKey);
  }

  function getActiveAgentTaskIssueKeys(): string[] {
    return vercelAgentService.getActiveTaskIssueKeys();
  }

  async function abortActiveAgentTask(issueKey: string): Promise<void> {
    if (vercelAgentService.hasActiveTask(issueKey)) {
      await vercelAgentService.abortTask(issueKey);
    }
  }

  async function pauseAllAgentTasks(reason: string): Promise<void> {
    await vercelAgentService.pauseAllTasks(reason);
  }

  function resolveModelOverride(
    issueKey: string,
    issue?: Pick<IssueDetails, 'description' | 'comments'>
  ): string | undefined {
    // 1. Explicit UI override stored in session manager
    const uiOverride = aiSessionManager.getIssueModelOverride(issueKey);
    if (uiOverride) {
      return uiOverride;
    }
    // 2. Ticket description / comment directive
    if (issue) {
      const ticketModel = extractModelDirective(issue);
      if (ticketModel) {
        return ticketModel;
      }
    }
    return undefined;
  }

  async function startAgentTask(
    issue: IssueDetails,
    taskDefinition: AgentTaskDefinition,
    options?: {
      provider?: AgentRuntimeProvider;
      workingDirectory?: string;
    }
  ): Promise<AgentRuntimeProvider> {
    const provider = options?.provider ?? resolvePreferredAgentProvider(issue.key, undefined, issue);
    if (!provider) {
      throw new Error('No AI agent is configured. Run Ticket Manager: Configure AI to set up Vercel AI Gateway.');
    }

    const model = resolveModelOverride(issue.key, issue);
    if (model) {
      outputChannel.appendLine(`[Agent] Using model override '${model}' for ${issue.key}.`);
    }

    const gateway = getVercelGatewayOptions();
    await vercelAgentService.startTask(issue, taskDefinition, {
      apiKey: gateway.apiKey,
      gatewayUrl: gateway.gatewayUrl,
      workingDirectory: options?.workingDirectory,
      model
    });
    return provider;
  }

  async function resumeAgentTask(
    issueKey: string,
    record: AgentSessionRecord
  ): Promise<AgentRuntimeProvider> {
    const provider = resolvePreferredAgentProvider(issueKey, record);
    if (!provider) {
      throw new Error('No AI agent is configured. Run Ticket Manager: Configure AI to set up Vercel AI Gateway.');
    }

    const model = resolveModelOverride(issueKey);
    const workingDirectory = resolveAgentWorkingDirectory(record);
    const gateway = getVercelGatewayOptions();
    await vercelAgentService.resumeTask(issueKey, {
      apiKey: gateway.apiKey,
      gatewayUrl: gateway.gatewayUrl,
      workingDirectory,
      model
    });
    return provider;
  }

  async function resolveGitLabAutomation(): Promise<ResolvedGitLabAutomation | undefined> {
    let skipReason: string | undefined;

    if (!workingDirectory) {
      skipReason = 'GitLab MR automation skipped: open the repository workspace first.';
    }

    if (skipReason) {
      if (skipReason !== lastGitLabAutomationSkipReason) {
        outputChannel.appendLine(`[GitLab MR] ${skipReason}`);
        lastGitLabAutomationSkipReason = skipReason;
      }
      return undefined;
    }

    let inferredRemote;
    try {
      inferredRemote = await inferGitLabProjectFromRepo(workingDirectory!);
    } catch (error) {
      skipReason = `GitLab MR automation skipped: could not infer the GitLab project from origin: ${error instanceof Error ? error.message : String(error)}`;
      if (skipReason !== lastGitLabAutomationSkipReason) {
        outputChannel.appendLine(`[GitLab MR] ${skipReason}`);
        lastGitLabAutomationSkipReason = skipReason;
      }
      return undefined;
    }

    const baseUrl = inferredRemote.baseUrl;
    const token = (await configStore.getGitLabApiKeyFromSecrets(context)).trim() || process.env.GITLAB_TOKEN?.trim() || '';
    if (!token) {
      skipReason = 'GitLab MR automation skipped: configure a GitLab API key via Setup or set GITLAB_TOKEN.';
      if (skipReason !== lastGitLabAutomationSkipReason) {
        outputChannel.appendLine(`[GitLab MR] ${skipReason}`);
        lastGitLabAutomationSkipReason = skipReason;
      }
      return undefined;
    }

    const cacheKey = JSON.stringify({
      baseUrl,
      projectPath: inferredRemote.projectPath,
      tokenHash: createHash('sha1').update(token).digest('hex')
    });
    if (cachedGitLabAutomation && cachedGitLabAutomationKey === cacheKey) {
      return cachedGitLabAutomation;
    }

    cachedGitLabAutomation = {
      client: new GitLabApiService({
        baseUrl,
        projectPath: inferredRemote.projectPath,
        token
      }),
      baseUrl,
      projectPath: inferredRemote.projectPath
    };
    cachedGitLabAutomationKey = cacheKey;
    lastGitLabAutomationSkipReason = undefined;
    return cachedGitLabAutomation;
  }

  function mapMergeRequestMetadata(
    mergeRequest: GitLabMergeRequest,
    existing?: NonNullable<NonNullable<AgentSessionRecord['delivery']>['mergeRequest']>,
    handledNotes?: Record<string, string>,
    pendingFeedback?: NonNullable<NonNullable<AgentSessionRecord['delivery']>['mergeRequest']>['pendingFeedback']
  ): NonNullable<NonNullable<AgentSessionRecord['delivery']>['mergeRequest']> {
    return {
      iid: mergeRequest.iid,
      webUrl: mergeRequest.webUrl,
      title: mergeRequest.title,
      sourceBranch: mergeRequest.sourceBranch,
      targetBranch: mergeRequest.targetBranch,
      state: mergeRequest.state,
      createdAt: mergeRequest.createdAt,
      updatedAt: mergeRequest.updatedAt,
      mergeCommitSha: mergeRequest.mergeCommitSha,
      handledNotes: handledNotes ?? existing?.handledNotes,
      lastSeenAt: new Date().toISOString(),
      pendingFeedback,
      buildRequiredOnMerge: existing?.buildRequiredOnMerge ?? false
    };
  }

  async function ensureMergeRequestForDoneIssue(issueKey: string): Promise<void> {
    const record = aiSessionManager.getAgentSession(issueKey);
    if (!isDeliveryTask(record)) {
      return;
    }

    const sourceBranch = record.delivery.createdBranch.trim();
    if (!sourceBranch || record.delivery.mergeRequest?.iid) {
      return;
    }

    const gitLabAutomation = await resolveGitLabAutomation();
    if (!gitLabAutomation) {
      return;
    }

    const issue = await backendService.getIssue(issueKey);
    const existingMergeRequests = await gitLabAutomation.client.listMergeRequestsForSourceBranch(sourceBranch);
    let mergeRequest = existingMergeRequests.find(candidate => mergeRequestMatchesIssueKey(candidate, issue.key))
      ?? existingMergeRequests[0];
    let created = false;
    if (!mergeRequest) {
      mergeRequest = await gitLabAutomation.client.createMergeRequest({
        sourceBranch,
        targetBranch: record.delivery.baseBranch,
        title: `${issue.key}: ${issue.summary}`,
        description: buildMergeRequestDescription(issue, record),
        removeSourceBranch: true
      });
      created = true;
    }

    const notes = filterGitLabNotesForAutomation(
      await gitLabAutomation.client.listMergeRequestDiscussions(mergeRequest.iid)
    );

    aiSessionManager.updateAgentDelivery(issueKey, {
      mergeRequest: mapMergeRequestMetadata(
        mergeRequest,
        record.delivery.mergeRequest,
        createGitLabHandledNoteState(notes),
        record.delivery.mergeRequest?.pendingFeedback
      )
    });

    if (created) {
      await backendService.addComment(issueKey, buildMergeRequestCreatedComment(mergeRequest.webUrl));
      outputChannel.appendLine(`[GitLab MR] Created merge request !${mergeRequest.iid} for ${issueKey} on ${sourceBranch}.`);
    } else {
      outputChannel.appendLine(`[GitLab MR] Reusing merge request !${mergeRequest.iid} for ${issueKey} on ${sourceBranch}.`);
    }
  }

  async function startMergeRequestFeedbackSession(
    issue: IssueDetails,
    record: AgentSessionRecord & { delivery: NonNullable<AgentSessionRecord['delivery']> },
    mergeRequest: GitLabMergeRequest,
    currentNotes: GitLabDiscussionNote[],
    changedNotes: GitLabDiscussionNote[]
  ): Promise<void> {
    const taskDefinition = buildMergeRequestFeedbackTaskDefinition(issue, {
      branchName: record.delivery.createdBranch,
      worktreePath: record.delivery.worktreePath,
      mergeRequestUrl: mergeRequest.webUrl,
      sourceBranch: mergeRequest.sourceBranch,
      targetBranch: mergeRequest.targetBranch,
      notes: changedNotes.map(note => ({
        author: note.author,
        body: note.body,
        updatedAt: note.updatedAt
      })),
      workflow: record.taskDefinition.workflow
    });

    await startAgentTask(
      {
        ...issue,
        branch: record.delivery.createdBranch
      },
      taskDefinition,
      {
        provider: resolvePreferredAgentProvider(issue.key, record, issue),
        workingDirectory: record.delivery.worktreePath
      }
    );

    aiSessionManager.updateAgentDelivery(issue.key, {
      ...record.delivery,
      phase: 'merge-request-feedback',
      finalizationState: 'pending',
      finalizationMessage: `Processing ${changedNotes.length} merge request comment(s).`,
      mergeRequest: mapMergeRequestMetadata(
        mergeRequest,
        record.delivery.mergeRequest,
        createGitLabHandledNoteState(currentNotes),
        {
          triggeredAt: new Date().toISOString(),
          notes: changedNotes.map(note => ({
            id: note.id,
            discussionId: note.discussionId,
            author: note.author,
            body: note.body,
            createdAt: note.createdAt,
            updatedAt: note.updatedAt
          }))
        }
      )
    }, { replace: true });

    outputChannel.appendLine(
      `[GitLab MR] Started merge request feedback session for ${issue.key} covering ${changedNotes.length} note(s).`
    );
  }

  async function syncTrackedMergeRequest(
    record: AgentSessionRecord & { delivery: NonNullable<AgentSessionRecord['delivery']> },
    gitLabAutomation: ResolvedGitLabAutomation
  ): Promise<void> {
    const mergeRequestState = record.delivery.mergeRequest;
    if (!mergeRequestState) {
      return;
    }

    const mergeRequest = await gitLabAutomation.client.getMergeRequest(mergeRequestState.iid);
    const notes = filterGitLabNotesForAutomation(
      await gitLabAutomation.client.listMergeRequestDiscussions(mergeRequest.iid)
    );
    const { newNotes, updatedNotes } = diffGitLabDiscussionNotes(
      mergeRequestState.handledNotes,
      notes,
      !mergeRequestState.lastSeenAt
    );

    if (mergeRequest.state !== 'opened') {
      aiSessionManager.updateAgentDelivery(record.issueKey, {
        mergeRequest: mapMergeRequestMetadata(
          mergeRequest,
          mergeRequestState,
          createGitLabHandledNoteState(notes),
          mergeRequestState.pendingFeedback
        )
      });

      // When a sub-task MR is merged, advance to the next sub-task.
      // Guard against re-triggering: only advance if we haven't already recorded the merge.
      if (
        mergeRequest.state === 'merged'
        && record.delivery.parentFeatureIssueKey
        && mergeRequestState.state !== 'merged'
      ) {
        outputChannel.appendLine(
          `[Feature Sub-task] MR !${mergeRequest.iid} for sub-task ${record.issueKey} has been merged. Advancing to next sub-task.`
        );
        try {
          await advanceToNextSubTask(record.delivery.parentFeatureIssueKey);
        } catch (advanceError) {
          reportError(advanceError, `advanceSubTaskAfterMerge:${record.issueKey}`);
        }
      }
      return;
    }

    if (newNotes.length === 0 && updatedNotes.length === 0) {
      aiSessionManager.updateAgentDelivery(record.issueKey, {
        mergeRequest: mapMergeRequestMetadata(
          mergeRequest,
          mergeRequestState,
          createGitLabHandledNoteState(notes),
          mergeRequestState.pendingFeedback
        )
      });
      return;
    }

    if (hasActiveAgentTask(record.issueKey) || record.delivery.finalizationState === 'pending') {
      outputChannel.appendLine(
        `[GitLab MR] Skipping feedback session for ${record.issueKey}: ${newNotes.length + updatedNotes.length} note(s) changed while a task is already active.`
      );
      aiSessionManager.updateAgentDelivery(record.issueKey, {
        mergeRequest: mapMergeRequestMetadata(
          mergeRequest,
          mergeRequestState,
          mergeRequestState.handledNotes,
          mergeRequestState.pendingFeedback
        )
      });
      return;
    }

    outputChannel.appendLine(
      `[GitLab MR] Detected ${newNotes.length} new and ${updatedNotes.length} updated merge request note(s) for ${record.issueKey}.`
    );
    const issue = await backendService.getIssue(record.issueKey);
    await startMergeRequestFeedbackSession(issue, record, mergeRequest, notes, [...newNotes, ...updatedNotes]);
  }

  async function syncTrackedMergeRequests(): Promise<void> {
    const gitLabAutomation = await resolveGitLabAutomation();
    if (!gitLabAutomation) {
      return;
    }

    for (const record of aiSessionManager.getAllAgentSessions().values()) {
      if (!isDeliveryTask(record) || !record.delivery.mergeRequest?.iid) {
        continue;
      }
      if (mergeRequestAutomationInFlight.has(record.issueKey)) {
        continue;
      }

      mergeRequestAutomationInFlight.add(record.issueKey);
      try {
        await syncTrackedMergeRequest(record, gitLabAutomation);
      } catch (error) {
        reportError(error, `gitlabMergeRequestSync:${record.issueKey}`);
      } finally {
        mergeRequestAutomationInFlight.delete(record.issueKey);
      }
    }
  }

  // Set mode context early so when-clauses on views evaluate correctly
  // before VS Code tries to resolve them.
  // !ticketManager.configured is true when the key is false OR doesn't exist,
  // which means the setup view shows by default before activate() even runs.
  const getModeContextState = async (): Promise<BackendModeContextState> => {
    // Connections & Boards is the canonical setup path. Any saved connection
    // means the sidebar should leave the "Configure Project" welcome state.
    if (connectionStore.hasConnections()) {
      const trackedRef = boardStore.getLastSelectedTrackedBoard();
      const connection =
        (trackedRef ? connectionStore.getConnection(trackedRef.connectionId) : undefined) ??
        connectionStore.getConnections()[0];
      return {
        mode: connection?.mode,
        configured: true
      };
    }

    const resolved = resolveBackendModeContextState(
      configStore.getBackendMode(),
      configStore.hasJiraConnectionConfig(),
      await configStore.hasJiraMcpConfigPublic()
    );
    if (resolved.mode === 'livefolder' && configStore.getLiveFolderPath().trim().length === 0) {
      return { ...resolved, configured: false };
    }
    return resolved;
  };
  const JIRA_MCP_SCOPE_MIGRATION_KEY = 'ticketManager.jiraMcpEpicIssueScopeMigrated';
  const initialModeContext = await getModeContextState();
  await vscode.commands.executeCommand(
    'setContext', 'ticketManager.mode',
    initialModeContext.mode ?? 'unconfigured'
  );
  await vscode.commands.executeCommand(
    'setContext', 'ticketManager.configured',
    initialModeContext.configured
  );
  type BoardsSidebarMode = 'classic' | 'work';
  const getBoardsSidebarMode = (): BoardsSidebarMode => {
    const configuration = vscode.workspace.getConfiguration('ticketManager');
    return configuration.get<string>('boardsSidebarPreviewMode') === 'work'
      ? 'work'
      : 'classic';
  };

  const getBoardsSidebarSettingsTarget = (): vscode.ConfigurationTarget =>
    vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;

  const setBoardsSidebarMode = async (mode: BoardsSidebarMode): Promise<void> => {
    const configuration = vscode.workspace.getConfiguration('ticketManager');
    const target = getBoardsSidebarSettingsTarget();
    await configuration.update('boardsSidebarPreviewMode', mode, target);
  };

  const getBoardsContainerCommand = (): string =>
    getBoardsSidebarMode() === 'work'
      ? 'workbench.view.extension.ticketManagerWorkMode'
      : 'workbench.view.extension.ticketManager';

  const getSetupViewId = (): string =>
    getBoardsSidebarMode() === 'work' ? 'ticketManager.workModeSetup' : 'ticketManager.setup';
  await vscode.commands.executeCommand('setContext', 'ticketManager.boardsSidebarMode', getBoardsSidebarMode());

  const updateAnalysisContext = async (): Promise<void> => {
    await vscode.commands.executeCommand(
      'setContext',
      'ticketManager.analysisGateEnabled',
      configStore.isAiAnalysisGateEnabled()
    );
  };
  await updateAnalysisContext();

  const resolveBoardService = async (board: Board): Promise<IssueTrackerService> =>
    board.connectionId ? backendService.serviceFor(board.connectionId) : backendService;
  const issuesProvider = new IssuesTreeProvider(
    backendService,
    filterStore,
    aiSessionManager,
    resolveBoardService
  );
  const boardsProvider = new BoardsTreeProvider(backendService, boardStore, connectionStore, backendService);
  const detailsProvider = new DetailsViewProvider(backendService);
  let issuesSidebarViewProvider: IssuesSidebarViewProvider;
  let epicsSidebarViewProvider: EpicsSidebarViewProvider;
  let boardsSidebarViewProvider: ClassicBoardsSidebarViewProvider;
  let workModeBoardsSidebarViewProvider: WorkModeBoardsSidebarViewProvider;
  let issueDetailsSidebarViewProvider: IssueDetailsSidebarViewProvider;
  let activeSessionsSidebarViewProvider: ActiveSessionsSidebarViewProvider;
  let issueDetailPanelManager: IssueDetailPanelManager;
  let issueAnalysisPanelManager: IssueAnalysisPanelManager;
  const boardPanelManager = new BoardPanelManager(
    backendService,
    async issue => {
      await selectIssue(issue);
    },
    async () => {
      await Promise.all([issuesProvider.refresh(), boardsProvider.refresh()]);
      const active = detailsProvider.getActiveIssue();
      if (active) {
        const refreshedIssue = issuesProvider.getIssueByKey(active.key);
        await detailsProvider.setIssue(refreshedIssue ?? undefined);
      } else {
        await detailsProvider.refresh();
      }
      issuesSidebarViewProvider.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
      epicsSidebarViewProvider.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
      activeSessionsSidebarViewProvider?.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
      await issueDetailPanelManager.refreshIfShowing(
        detailsProvider.getActiveIssue()?.key ?? ''
      );
    },
    boardColumnStore,
    async board => (board.connectionId ? backendService.serviceFor(board.connectionId) : backendService)
  );
  boardColumnConfigPanel.setBoardSettingsUpdater(async (boardId, input) => {
    // Route the update through the board's own connection so per-connection
    // Jira MCP config (workspace JQL/epic) is read and written correctly.
    const board = await resolveBoardById(boardId);
    const service = board ? await resolveBoardService(board) : backendService;
    const updatedBoard = await service.updateBoard(boardId, input);
    await boardsProvider.refresh();
    if (boardPanelManager.getActiveBoard()?.id === boardId) {
      await boardPanelManager.openBoard(updatedBoard);
    }
  });
  issueDetailPanelManager = new IssueDetailPanelManager(backendService, aiSessionManager, async () => {
    await Promise.all([issuesProvider.refresh(), boardsProvider.refresh()]);
    const active = detailsProvider.getActiveIssue();
    if (active) {
      const refreshedIssue = issuesProvider.getIssueByKey(active.key);
      await detailsProvider.setIssue(refreshedIssue ?? undefined);
    } else {
      await detailsProvider.refresh();
    }
    issuesSidebarViewProvider.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
    epicsSidebarViewProvider.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
    activeSessionsSidebarViewProvider?.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
    await boardPanelManager.refresh();
    await issueDetailPanelManager.refreshIfShowing(detailsProvider.getActiveIssue()?.key ?? '');
  }, async boardId => {
    // Draft creation must reach the connection that owns the board, not just the
    // router's active one. The active board is checked first so a board opened
    // from a connection the tree has not loaded still resolves.
    const activeBoard = boardPanelManager.getActiveBoard();
    const board =
      activeBoard?.id === boardId ? activeBoard : boardsProvider.getBoardById(boardId);
    return board ? resolveBoardService(board) : undefined;
  });
  updateCommentPlaceholders();
  const taskDesignerPanelManager = new TaskDesignerPanelManager(
    backendService,
    context.workspaceState,
    async (nodes, connectors) => recommendTaskDesignerFlowWithCopilot(nodes, connectors, {
      apiKey: getVercelGatewayApiKey(),
      gatewayUrl: getVercelGatewayOptions().gatewayUrl
    }),
    async (boardId) => {
      const activeBoard = boardPanelManager.getActiveBoard();
      if (!activeBoard || (boardId && activeBoard.id !== boardId)) {
        return undefined;
      }

      const displayDetails = await boardPanelManager.getActiveBoardDisplayDetails();
      return {
        boardName: activeBoard.name,
        issues: displayDetails?.issues ?? []
      };
    },
    (boardId) => {
      if (!boardId) {
        return undefined;
      }

      const activeBoard = boardPanelManager.getActiveBoard();
      if (!activeBoard || activeBoard.id !== boardId) {
        return boardColumnStore.getPreferences(boardId).issueTypeColors;
      }

      const prefs = boardColumnStore.getPreferences(boardId);
      const displayDetails = boardPanelManager.getCurrentDisplayDetails();
      const issueTypes = new Set<string>(Object.keys(prefs.issueTypeColors ?? {}));
      for (const issue of displayDetails?.issues ?? []) {
        if (issue.issueType.trim()) {
          issueTypes.add(issue.issueType.trim());
        }
      }

      const resolvedColors: Record<string, string> = {};
      for (const issueType of issueTypes) {
        resolvedColors[issueType] = issueTypeHex(issueType, prefs.issueTypeColors);
      }

      return Object.keys(resolvedColors).length > 0 ? resolvedColors : prefs.issueTypeColors;
    }
  );

  const localPeerReviewPanel = new LocalPeerReviewPanel(async (issue) => {
    const options = getConfiguredAiOptions();
    if (options.length === 0) {
      throw new Error('No AI providers configured. Run Ticket Manager: Configure AI.');
    }
    let chosen = options[0];
    if (options.length > 1) {
      const picked = await vscode.window.showQuickPick(
        options.map(opt => ({ label: opt.label, description: opt.description, option: opt })),
        { title: `Run Local Peer Review with` }
      );
      if (!picked) {
        throw new Error('Review cancelled.');
      }
      chosen = picked.option;
    }
    return runLocalPeerReview(issue, {
      provider: chosen.provider,
      credential: chosen.credential ?? getVercelGatewayApiKey(),
      agentName: chosen.agentName ?? chosen.label,
      gatewayUrl: getVercelGatewayOptions().gatewayUrl,
      workingDirectory
    });
  });

  issueAnalysisPanelManager = new IssueAnalysisPanelManager(
    context.workspaceState,
    aiSessionManager,
    () => configStore.getAiAnalysisDefaultPrompt(),
    () => configStore.getAiAnalysisDefaultModel(),
    () => {
      const options = getConfiguredAiOptions();
      return options[0]?.label ?? 'No provider configured';
    },
    () => getAnalysisModelOptions(),
    () => vscode.workspace.workspaceFolders?.map(f => ({ uri: f.uri.fsPath, name: f.name })) ?? [],
    issueKey => backendService.getIssue(issueKey),
    message => outputChannel.appendLine(message),
    async input => {
      const options = getConfiguredAiOptions();
      if (options.length === 0) {
        throw new Error('No AI providers are configured. Run Ticket Manager: Configure AI.');
      }

      const chosen = options[0];
      const referencedIssueContext = await buildReferencedIssueAnalysisContext(
        input.issue,
        issueKey => backendService.getIssue(issueKey)
      );

      const issueTexts = [
        input.issue.description,
        ...(input.issue.comments ?? []).map(c => c.body)
      ].filter((t): t is string => Boolean(t));

      // Auto-populate repositories from ticket text when none are explicitly attached.
      let effectiveRepositories = input.repositories;
      if (!effectiveRepositories || effectiveRepositories.length === 0) {
        const discoveredRefs = issueTexts.flatMap(t => extractAllGitReferencesFromText(t));
        if (discoveredRefs.length > 0) {
          const seen = new Set<string>();
          effectiveRepositories = discoveredRefs
            .filter(ref => { const dup = seen.has(ref); seen.add(ref); return !dup; })
            .slice(0, 5)
            .map(ref => {
              const label = ref.replace(/\.git$/, '').split('/').pop() ?? ref;
              return { source: ref, label } satisfies AnalysisRepositoryEntry;
            });
          outputChannel.appendLine(
            `[IssueAnalysis] Auto-discovered ${effectiveRepositories.length} repository reference(s) from ticket text for ${input.issue.key}.`
          );
        }
      }

      const repositoryContext = await resolveAnalysisRepositoryContext({
        issueKey: input.issue.key,
        question: input.question,
        history: input.history,
        workingDirectory,
        globalStoragePath: context.globalStorageUri.fsPath,
        repositories: effectiveRepositories,
        issueTexts
      });
      const historyText = input.history
        .map(entry => `${entry.role.toUpperCase()}: ${entry.text}`)
        .join('\n\n');
      const appendedPrompt = [
        repositoryContext.promptContext,
        `Question: ${input.question}`,
        historyText ? `Conversation so far:\n${historyText}` : undefined
      ]
        .filter((part): part is string => Boolean(part))
        .join('\n\n');

      const issueForAnalysis: IssueDetails = {
        ...input.issue,
        description: [input.issue.description ?? '', referencedIssueContext, appendedPrompt].filter(Boolean).join('\n\n')
      };

      const reviewOptions: { onUpdate?: (content: string) => void; model: string; systemPrompt: string; signal?: AbortSignal } = {
        onUpdate: input.onUpdate,
        model: input.model,
        systemPrompt: input.defaultPrompt,
        signal: input.signal
      };

      if (chosen.provider === 'vercel-gateway') {
        return reviewTicketWithCopilot(
          issueForAnalysis,
          getVercelGatewayApiKey(),
          chosen.agentName ?? chosen.label,
          undefined,
          {
            ...reviewOptions,
            apiKey: getVercelGatewayApiKey(),
            gatewayUrl: getVercelGatewayOptions().gatewayUrl
          }
        );
      }

      throw new Error(
        `${AI_PROVIDER_LABELS[chosen.provider] ?? chosen.provider} is not supported in the analysis chat.`
      );
    }
  );

  context.subscriptions.push(
    outputChannel,
    filterStore,
    boardStore,
    backendService,
    issuesProvider,
    boardsProvider,
    detailsProvider,
    boardPanelManager,
    issueDetailPanelManager,
    localPeerReviewPanel,
    issueAnalysisPanelManager,
    boardColumnStore,
    boardColumnConfigPanel,
    newProjectWizardPanel,
    taskDesignerPanelManager,
    aiSessionManager.onDidChangeAgentSession(record => {
      if (
        isDeliveryTask(record) &&
        record.delivery.finalizationState === 'pending' &&
        (record.state === 'completed' || record.state === 'failed')
      ) {
        void finalizeDeliverySession(record);
      }

      if (record.state === 'awaiting_input' && isDeliveryTask(record)) {
        void postAgentInputRequestComment(record);
      }

      if (record.state === 'awaiting_approval' && vercelAgentService.hasActiveTask(record.issueKey)) {
        void promptForPendingPermission(record.issueKey);
        return;
      }

      clearPermissionPromptTracking(record.issueKey);
    }),
    vscode.window.onDidChangeWindowState(windowState => {
      if (windowState.focused) {
        return;
      }

      const activeIssueKeys = getActiveAgentTaskIssueKeys().sort((left, right) => left.localeCompare(right));
      if (activeIssueKeys.length === 0 || suppressCloseWarning) {
        if (activeIssueKeys.length === 0) {
          lastCloseWarningSignature = undefined;
        }
        return;
      }

      const signature = activeIssueKeys.join('|');
      if (signature === lastCloseWarningSignature) {
        return;
      }
      lastCloseWarningSignature = signature;

      const sessionSummary = activeIssueKeys.length === 1
        ? `${activeIssueKeys[0]} has an active AI session`
        : `${activeIssueKeys.length} active AI sessions are running`;
      void vscode.window.showWarningMessage(
        `${sessionSummary}. Closing VS Code will pause them so you can resume later.`,
        'Show Sessions',
        'Do Not Warn Again'
      ).then(selection => {
        if (selection === 'Show Sessions') {
          void revealActiveSessionsView();
        } else if (selection === 'Do Not Warn Again') {
          suppressCloseWarning = true;
        }
      });
    }),
    boardColumnStore.onDidChange(() => {
      boardPanelManager.refreshColumnLayout();
      void issuesSidebarViewProvider.refresh();
      taskDesignerPanelManager.refreshIfOpen();
    })
  );

  async function revealIssueDetailsInSidebar(options: { focus: boolean }): Promise<void> {
    if (!detailsProvider.getActiveIssue()) {
      return;
    }

    // The issueDetails sidebar view only exists in classic mode (all classic views are
    // gated `when boardsSidebarMode == classic`). In work mode the detail is shown in the
    // editor panel, so switching the activity bar to the classic "Tickets" container would
    // blank the Work Mode sidebar — i.e. the side menu would disappear.
    if (getBoardsSidebarMode() === 'work') {
      return;
    }

    try {
      await vscode.commands.executeCommand('workbench.view.extension.ticketManager');
      if (options.focus) {
        await vscode.commands.executeCommand('ticketManager.issueDetails.focus');
      }
    } catch {
      // focusing can fail if the view is not ready
    }
  }

  async function setModeContext(): Promise<void> {
    const modeContext = await getModeContextState();
    await vscode.commands.executeCommand('setContext', 'ticketManager.mode', modeContext.mode ?? 'unconfigured');
    await vscode.commands.executeCommand('setContext', 'ticketManager.configured', modeContext.configured);
    await vscode.commands.executeCommand('setContext', 'ticketManager.boardsSidebarMode', getBoardsSidebarMode());
    await updateAnalysisContext();
  }

  async function revealSetupView(): Promise<void> {
    setupSidebarViewProvider.resetToModeSelection();
    workModeSetupSidebarViewProvider.resetToModeSelection();
    try {
      await vscode.commands.executeCommand(getBoardsContainerCommand());
      await vscode.commands.executeCommand(`${getSetupViewId()}.focus`);
    } catch (error) {
      reportError(error, 'reveal-setup');
    }
  }

  async function ensureBoardsContainerVisibleOnStartup(): Promise<void> {
    if (getBoardsSidebarMode() !== 'work') {
      return;
    }

    try {
      await vscode.commands.executeCommand(getBoardsContainerCommand());
    } catch (error) {
      reportError(error, 'reveal-workmode-startup');
    }
  }

  function refreshStatusBarInBackground(): void {
    void ticketManagerStatusBar.refresh().catch(error => reportError(error, 'status-bar-refresh'));
  }

  function refreshBoardsInBackgroundAfterStartup(): void {
    void (async () => {
      const modeContext = await getModeContextState();
      if (!modeContext.configured) {
        return;
      }
      try {
        await boardsProvider.refresh();
        await boardPanelManager.refresh();
      } catch (error) {
        reportError(error, 'startup-board-refresh');
      }
    })();
  }

  async function clearActiveSelectionState(): Promise<void> {
    await filterStore.setLastSelectedIssueKey(undefined);
    await detailsProvider.setIssue(undefined);
    issuesSidebarViewProvider.setSelectedIssueKey(undefined);
    epicsSidebarViewProvider.setSelectedIssueKey(undefined);
    activeSessionsSidebarViewProvider?.setSelectedIssueKey(undefined);
    boardsSidebarViewProvider.setSelectedBoardId(undefined);
    workModeBoardsSidebarViewProvider.setSelectedBoardId(undefined);
    boardPanelManager.setSelectedIssueKey(undefined);
    boardPanelManager.clear();
    issueDetailPanelManager.clear();
  }

  async function resetToSetupAfterStartupLoadFailure(reason: 'cancelled' | 'timed-out'): Promise<void> {
    try {
      await backendService.reset();
    } catch (error) {
      reportError(error, 'startup-load-reset');
    }

    await vscode.workspace
      .getConfiguration('ticketManager')
      .update(
        'backendMode',
        undefined,
        vscode.workspace.workspaceFolders?.length
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global
      );

    await clearActiveSelectionState();
    await setModeContext();
    await revealSetupView();

    void vscode.window.showWarningMessage(
      reason === 'cancelled'
        ? 'Ticket Manager startup was cancelled. Configure Project to choose or fix the backend connection.'
        : 'Ticket Manager startup timed out waiting for the backend. Configure Project to choose or fix the backend connection.'
    );
  }

  async function refreshStartupSelectionWithProgress(): Promise<void> {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Ticket Manager is connecting to the configured backend…',
        cancellable: true
      },
      async (_progress, token) => {
        const startupTimeout = createStartupLoadTimedOutPromise(
          Math.max(STARTUP_BACKEND_LOAD_TIMEOUT_MS, configStore.getRequestTimeoutMs())
        );
        try {
          await Promise.race([
            refreshAndRestoreSelection({ skipBoards: true }),
            createStartupLoadCancelledPromise(token),
            startupTimeout.promise
          ]);
        } finally {
          clearTimeout(startupTimeout.handle);
        }
      }
    );
  }

  async function ensureJiraMcpIssueScopeVisibility(modeContext: BackendModeContextState): Promise<void> {
    if (modeContext.mode !== 'jiracloud' || !modeContext.configured) {
      return;
    }

    if (configStore.getJiraMcpEpicKey().trim().length === 0) {
      return;
    }

    if (context.workspaceState.get<boolean>(JIRA_MCP_SCOPE_MIGRATION_KEY) === true) {
      return;
    }

    const filters = filterStore.getFilters();
    if (!shouldAdoptJiraMcpEpicIssueScope(filters)) {
      await context.workspaceState.update(JIRA_MCP_SCOPE_MIGRATION_KEY, true);
      return;
    }

    await filterStore.updateFilters({ assigneeMode: 'all' });
    await context.workspaceState.update(JIRA_MCP_SCOPE_MIGRATION_KEY, true);
  }

  async function refreshSearchActionContexts(): Promise<void> {
    await Promise.all([
      vscode.commands.executeCommand(
        'setContext',
        'ticketManager.issuesSearchActive',
        filterStore.getFilters().searchText.trim().length > 0
      ),
      vscode.commands.executeCommand(
        'setContext',
        'ticketManager.epicsSearchActive',
        epicsSidebarViewProvider?.getSearchText().trim().length > 0
      ),
      vscode.commands.executeCommand(
        'setContext',
        'ticketManager.boardsSearchActive',
        boardStore.getFilters().searchText.trim().length > 0
      )
    ]);
  }

  async function setDefaultEpicForWorkspace(issueKey: string): Promise<void> {
    if (backendService.mode !== 'jiracloud') {
      void vscode.window.showWarningMessage('Epic linking from the Epics view is available in Jira MCP mode only.');
      return;
    }

    const currentLinkedEpicKey = configStore.getJiraMcpEpicKey();
    if (currentLinkedEpicKey === issueKey) {
      void vscode.window.showInformationMessage(`${issueKey} is already set as the default EPIC for this workspace.`);
      return;
    }

    const confirmation = await vscode.window.showInformationMessage(
      `Set ${issueKey} as the default EPIC for this repo?`,
      {
        modal: true,
        detail: 'This sets the workspace Jira MCP epic link. New Jira issue creation will use this epic as the default parent.'
      },
      'Set Default EPIC',
      'Cancel'
    );
    if (confirmation !== 'Set Default EPIC') {
      return;
    }

    await configStore.setJiraMcpEpicKey(issueKey);
    epicsSidebarViewProvider.setDefaultEpicKey(issueKey);
    await Promise.all([
      issuesProvider.refresh(),
      boardsProvider.refresh(),
      epicsSidebarViewProvider.refresh()
    ]);
    await selectBoard(await resolveBoardById(`epic:${issueKey}`));
    await boardPanelManager.refresh();
    await ticketManagerStatusBar.refresh();
    void vscode.window.showInformationMessage(`${issueKey} is now the default EPIC for this repo.`);
  }

  async function promptForBackendMode(): Promise<BackendMode | undefined> {
    const options: Array<{ label: string; description: string; mode: BackendMode }> = [
      {
        label: 'Jira MCP',
        description: 'Connect to a Jira server via the configured MCP server.',
        mode: 'jiracloud'
      },
      {
        label: 'Demo',
        description: 'Use built-in demo data.',
        mode: 'demo'
      },
      {
        label: 'Live Folder',
        description: 'Two-way sync with a markdown plans folder.',
        mode: 'livefolder'
      }
    ];
    if (!vscode.workspace.workspaceFolders?.length) {
      options.splice(2, 0, {
        label: 'User Workspace',
        description: 'Store boards outside VS Code workspaces and add plan folders as boards.',
        mode: 'userworkspace'
      });
    }

    const picked = await vscode.window.showQuickPick<
      { label: string; description: string; mode: BackendMode }
    >(
      options,
      {
        title: 'Choose Backend Mode',
        ignoreFocusOut: true
      }
    );

    return picked?.mode;
  }

  async function ensureStartupConfiguration(): Promise<void> {
    if (context.extensionMode === vscode.ExtensionMode.Test) {
      await setModeContext();
      return;
    }

    let modeContext = await getModeContextState();
    await setModeContext();

    if (!modeContext.configured) {
      await revealSetupView();
    }
  }

  async function selectIssue(
    issue: IssueSummary | undefined,
    options?: { openFullPanel?: boolean }
  ): Promise<void> {
    await filterStore.setLastSelectedIssueKey(issue?.key);
    await detailsProvider.setIssue(issue);
    updateCommentPlaceholders();
    boardPanelManager.setSelectedIssueKey(issue?.key);
    issuesSidebarViewProvider.setSelectedIssueKey(issue?.key);
    epicsSidebarViewProvider.setSelectedIssueKey(issue?.key);
    activeSessionsSidebarViewProvider?.setSelectedIssueKey(issue?.key);

    if (!issue) {
      issueDetailPanelManager.clear();
      return;
    }

    // In work mode there is no issueDetails sidebar view, so the detail must be shown in the
    // editor panel. Force the full panel to avoid a no-op (and a blank sidebar) on click.
    const openFullPanel = options?.openFullPanel || getBoardsSidebarMode() === 'work';

    if (openFullPanel) {
      await issueDetailPanelManager.open(issue.key);
      await revealIssueDetailsInSidebar({ focus: false });
    } else {
      await revealIssueDetailsInSidebar({ focus: true });
    }
  }

  async function selectBoard(
    board: Board | undefined,
    options?: { forceRecreatePanel?: boolean }
  ): Promise<void> {
    outputChannel.appendLine(`[selectBoard] called with boardId: ${board?.id ?? 'undefined'}`);
    if (!board) {
      await boardStore.setLastSelectedBoardId(undefined);
      await boardStore.setLastSelectedTrackedBoard(undefined);
      boardsSidebarViewProvider.setSelectedBoardId(undefined);
      workModeBoardsSidebarViewProvider.setSelectedBoardId(undefined);
      issuesProvider.setBoardScope(undefined);
      epicsSidebarViewProvider.setBoardScope(undefined);
      boardPanelManager.clear();
      return;
    }

    await boardStore.setLastSelectedBoardId(board.id);
    let resolvedConnectionId: string | undefined = board.connectionId;
    if (!resolvedConnectionId) {
      const tracked = connectionStore.getTrackedBoards().filter(t => t.boardId === board.id);
      if (tracked.length > 0) {
        const activeId = backendService.getActiveConnectionId();
        resolvedConnectionId = (tracked.find(t => t.connectionId === activeId) ?? tracked[0]).connectionId;
      }
    }
    if (resolvedConnectionId) {
      await boardStore.setLastSelectedTrackedBoard({
        connectionId: resolvedConnectionId,
        boardId: board.id
      });
      if (backendService.getActiveConnectionId() !== resolvedConnectionId) {
        backendService.setActiveConnection(resolvedConnectionId);
      }
    }
    // Scope the classic EPIC and My Issues sidebars to this board so they query
    // the board's own connection. Ensure the board carries the resolved
    // connectionId so the per-connection service is used.
    const scopedBoard: Board = resolvedConnectionId
      ? { ...board, connectionId: resolvedConnectionId }
      : board;
    issuesProvider.setBoardScope(scopedBoard);
    epicsSidebarViewProvider.setBoardScope(scopedBoard);
    boardsSidebarViewProvider.setSelectedBoardId(board.id);
    workModeBoardsSidebarViewProvider.setSelectedBoardId(board.id);
    outputChannel.appendLine(`[selectBoard] about to open board panel for: ${board.id}`);
    try {
      await boardPanelManager.openBoard(board, options);
      try {
        const active = boardPanelManager.getActiveBoard?.();
        if (!active || active.id !== board.id) {
          outputChannel.appendLine(`[selectBoard] warning: boardPanelManager active board mismatch after open. expected=${board.id} actual=${active?.id ?? 'none'}`);
        }
      } catch (_) {}
      outputChannel.appendLine(`[selectBoard] board panel opened for: ${board.id}`);
    } catch (err) {
      outputChannel.appendLine(`[selectBoard] openBoard failed: ${err instanceof Error ? err.message : String(err)} - retrying once`);
      try {
        // attempt to recover: force a fresh panel and retry once after short delay
        await new Promise(resolve => setTimeout(resolve, 250));
        await boardPanelManager.openBoard(board, { forceRecreatePanel: true });
        outputChannel.appendLine(`[selectBoard] board panel opened on retry for: ${board.id}`);
      } catch (err2) {
        outputChannel.appendLine(`[selectBoard] openBoard retry failed: ${err2 instanceof Error ? err2.message : String(err2)}`);
        try { void vscode.window.showErrorMessage(`Could not open board: ${board.name}`); } catch (_) {}
      }
    }
  }

  async function selectIssueByKey(
    issueKey: string,
    options?: { openFullPanel?: boolean }
  ): Promise<void> {
    const issue = issuesProvider.getIssueByKey(issueKey) ?? (await backendService.getIssue(issueKey));
    await selectIssue(issue, options);
  }

  async function searchIssues(): Promise<void> {
    const filters = filterStore.getFilters();
    const searchText = await vscode.window.showInputBox({
      title: 'Search Issues',
      prompt: 'Filter the My Issues list by issue text.',
      value: filters.searchText,
      ignoreFocusOut: true
    });
    if (searchText === undefined) {
      return;
    }
    await filterStore.updateFilters({
      searchText
    });
    await refreshSearchActionContexts();
  }

  async function searchEpics(): Promise<void> {
    const searchText = await vscode.window.showInputBox({
      title: 'Search EPICs',
      prompt: 'Filter the EPICs list by issue text.',
      value: epicsSidebarViewProvider.getSearchText(),
      ignoreFocusOut: true
    });
    if (searchText === undefined) {
      return;
    }
    await epicsSidebarViewProvider.setSearchText(searchText);
    await refreshSearchActionContexts();
  }

  async function searchBoards(): Promise<void> {
    const filters = boardStore.getFilters();
    const searchText = await vscode.window.showInputBox({
      title: 'Search Boards',
      prompt: 'Filter the Boards list by board text.',
      value: filters.searchText,
      ignoreFocusOut: true
    });
    if (searchText === undefined) {
      return;
    }
    await boardStore.updateFilters({
      searchText
    });
    await refreshSearchActionContexts();
  }

  function getEpicIssueType(mode: BackendMode): string {
    return mode === 'jiracloud' ? 'Epic' : 'Feature';
  }

  async function reportActionError(error: unknown): Promise<void> {
    reportError(error);
    await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }

  function getConnectionStringSetting(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
  }

  function inferTrackedBoardType(boardId: string, mode: string | undefined): string {
    if (boardId.startsWith('epic:')) {
      return 'epic';
    }
    if (boardId.startsWith('jql:') || boardId.startsWith('jql-custom:')) {
      return 'jql';
    }
    if (boardId.startsWith('gitlab:') || mode === 'gitlab') {
      return 'issue-board';
    }
    if (boardId.startsWith('agile:')) {
      return 'board';
    }
    return 'board';
  }

  function resolveTrackedBoardById(boardId: string): Board | undefined {
    const directMatch = connectionStore.getTrackedBoards().find(candidate => candidate.boardId === boardId);
    if (directMatch) {
      const connection = connectionStore.getConnection(directMatch.connectionId);
      return {
        id: boardId,
        name: directMatch.displayName ?? boardId,
        type: inferTrackedBoardType(boardId, connection?.mode),
        locationName: connection?.name,
        connectionId: directMatch.connectionId
      } satisfies Board;
    }

    for (const connection of connectionStore.getConnections()) {
      if (connection.mode !== 'livefolder') {
        continue;
      }

      const projectKey = getConnectionStringSetting(connection.settings?.projectKey) || 'LIVE';
      const normalizedBoardId = `livefolder-${projectKey.toLowerCase()}`;
      if (normalizedBoardId !== boardId) {
        continue;
      }

      const projectName = getConnectionStringSetting(connection.settings?.projectName) || 'Live Folder';
      return {
        id: normalizedBoardId,
        name: `${projectName} (Live)`,
        type: 'board',
        locationName: connection.name,
        projectKey,
        projectName,
        connectionId: connection.id
      } satisfies Board;
    }

    return undefined;
  }

  async function resolveBoardById(boardId: string): Promise<Board | undefined> {
    const trackedRef = boardStore.getLastSelectedTrackedBoard();
    if (trackedRef?.boardId === boardId) {
      const trackedMatch = boardsProvider
        .getCurrentBoards()
        .find(candidate => candidate.id === boardId && candidate.connectionId === trackedRef.connectionId);
      if (trackedMatch) {
        return trackedMatch;
      }
    }

    return (
      boardsProvider.getBoardById(boardId) ??
      resolveTrackedBoardById(boardId) ??
      (await backendService.getBoards(boardStore.getFilters())).find(candidate => candidate.id === boardId)
    );
  }

  async function pickProject(defaultProjectKey?: string) {
    const projects = await backendService.getProjects();
    if (projects.length === 0) {
      await vscode.window.showWarningMessage('No projects are available.');
      return undefined;
    }

    if (defaultProjectKey) {
      const defaultProject = projects.find(project => project.key === defaultProjectKey);
      if (defaultProject) {
        return defaultProject;
      }
    }

    if (projects.length === 1) {
      return projects[0];
    }

    const picked = await vscode.window.showQuickPick(
      projects.map(project => ({
        label: project.key,
        description: project.name,
        project
      })),
      {
        title: 'Project'
      }
    );
    return picked?.project;
  }

  async function createEpic(): Promise<void> {
    const filters = filterStore.getFilters();
    const defaultProjectKey =
      filters.projectKeys.length === 1
        ? filters.projectKeys[0]
        : detailsProvider.getActiveIssue()?.projectKey;
    const project = await pickProject(defaultProjectKey);
    if (!project) {
      return;
    }

    const summary = await vscode.window.showInputBox({
      title: 'Create EPIC',
      prompt: 'Enter a short summary for the new EPIC.',
      ignoreFocusOut: true,
      validateInput: value => (value.trim().length === 0 ? 'Summary is required.' : undefined)
    });
    if (summary === undefined) {
      return;
    }

    const description = await vscode.window.showInputBox({
      title: 'EPIC Description',
      prompt: 'Optional description for the EPIC.',
      ignoreFocusOut: true
    });
    if (description === undefined) {
      return;
    }

    const created = await backendService.createIssue({
      projectKey: project.key,
      issueType: getEpicIssueType(backendService.mode),
      summary: summary.trim(),
      description: description.trim() || undefined
    });

    await refreshAndRestoreSelection();
    await selectIssueByKey(created.key, { openFullPanel: true });
  }

  async function editIssue(issueKey: string): Promise<void> {
    try {
      const issue = await backendService.getIssue(issueKey);
      const label = issue.issueType?.trim() || 'Issue';
      const summary = await vscode.window.showInputBox({
        title: `Edit ${label} (${issue.key})`,
        prompt: 'Update the summary.',
        value: issue.summary,
        ignoreFocusOut: true,
        validateInput: value => (value.trim().length === 0 ? 'Summary is required.' : undefined)
      });
      if (summary === undefined) {
        return;
      }

      const description = await vscode.window.showInputBox({
        title: `Description (${issue.key})`,
        prompt: 'Update the description.',
        value: issue.description ?? '',
        ignoreFocusOut: true
      });
      if (description === undefined) {
        return;
      }

      const parentRule = getParentRule(issue.issueType, backendService.mode);
      let parentKey: string | null = null;
      if (parentRule.canHaveParent) {
        const currentParentDescription = issue.parentIssue
          ? `${issue.parentIssue.key} ${issue.parentIssue.summary ?? ''}`.trim()
          : undefined;
        const pickedParentKey = await vscode.window.showInputBox({
          title: `${parentRule.defaultLabel} (${issue.key})`,
          prompt: currentParentDescription
            ? `Current ${issue.parentIssue?.issueType ?? parentRule.defaultLabel}: ${currentParentDescription}`
            : parentRule.helperText,
          value: issue.parentKey ?? '',
          ignoreFocusOut: true,
          validateInput: value =>
            parentRule.requiresParent && value.trim().length === 0
              ? `${parentRule.defaultLabel} is required.`
              : undefined
        });
        if (pickedParentKey === undefined) {
          return;
        }
        parentKey = pickedParentKey.trim() || null;
      }

      await updateIssueAndRefresh(
        issueKey,
        {
          summary: summary.trim(),
          description,
          parentKey
        },
        undefined,
        { openFullPanel: true }
      );
    } catch (error) {
      await reportActionError(error);
    }
  }

  async function editEpic(issueKey: string): Promise<void> {
    await editIssue(issueKey);
  }

  async function deleteIssue(issueKey: string): Promise<void> {
    try {
      const confirmed = await vscode.window.showWarningMessage(
        `Delete ${issueKey}?`,
        { modal: true },
        'Delete'
      );
      if (confirmed !== 'Delete') {
        return;
      }

      if (filterStore.getFilters().parentKey === issueKey) {
        await filterStore.updateFilters({ parentKey: undefined });
      }
      if (filterStore.getLastSelectedIssueKey() === issueKey) {
        await filterStore.setLastSelectedIssueKey(undefined);
        await detailsProvider.setIssue(undefined);
        boardPanelManager.setSelectedIssueKey(undefined);
        issuesSidebarViewProvider.setSelectedIssueKey(undefined);
        epicsSidebarViewProvider.setSelectedIssueKey(undefined);
        issueDetailPanelManager.clear();
      }

      await backendService.deleteIssue(issueKey);
      await refreshAndRestoreSelection();
    } catch (error) {
      await reportActionError(error);
    }
  }

  async function editBoard(boardId: string): Promise<void> {
    try {
      const board = await resolveBoardById(boardId);
      if (!board) {
        await vscode.window.showInformationMessage('Select a board first.');
        return;
      }
      // Route through the board's own connection so per-connection config (e.g.
      // the workspace JQL/epic that backs a Jira MCP board) resolves correctly.
      // Using the shared router would read the global config and fail with
      // "Invalid Jira MCP board identifier." for connection-scoped boards.
      const service = await resolveBoardService(board);
      const details = await service.getBoardDetails(board);
      const metadata = await service.getFilterMetadata({
        projectKeys: board.projectKey ? [board.projectKey] : [],
        statuses: [],
        issueTypes: [],
        searchText: '',
        assigneeMode: 'all',
        boardId: board.id,
        grouping: 'none'
      }).catch(() => undefined);
      await boardColumnConfigPanel.open(board, details, metadata?.issueTypes ?? []);
    } catch (error) {
      await reportActionError(error);
    }
  }

  function boardRemovalActionLabel(): 'Delete' | 'Close' {
    return backendService.mode === 'demo' || backendService.mode === 'userworkspace' ? 'Delete' : 'Close';
  }

  async function closeGitLabBoard(board: Board): Promise<void> {
    const currentRefs = configStore.getGitLabSelectedBoardRefs().map(value => value.trim()).filter(Boolean);
    const nextRefs = currentRefs.filter(value => value !== board.id.trim());
    if (nextRefs.length === currentRefs.length) {
      await vscode.window.showInformationMessage(
        `"${board.name}" is auto-discovered from the GitLab project listing and cannot be removed individually. Use the board filter settings to limit which boards appear.`
      );
      return;
    }

    await configStore.setGitLabSelectedBoardRefs(nextRefs);
  }

  async function closeJiraMcpBoard(board: Board): Promise<void> {
    if (board.id.startsWith('epic:')) {
      const epicKey = board.id.slice('epic:'.length).trim();
      if (!epicKey || configStore.getJiraMcpEpicKey() !== epicKey) {
        throw new Error('This Jira MCP epic board is not linked through Ticket Manager settings.');
      }

      await configStore.setJiraMcpEpicKey(undefined);
      await configStore.setJiraMcpEpicBoardName(undefined);
      return;
    }

    if (board.id === 'jql:workspace') {
      await configStore.setJiraMcpBoardJql(undefined);
      await configStore.setJiraMcpBoardName(undefined);
      return;
    }

    throw new Error('This Jira MCP board cannot be closed individually.');
  }

  async function removeBoardFromTicketManager(board: Board): Promise<void> {
    // In connections mode a board is tracked against a specific connection.
    // Removing it just untracks it from that connection; the underlying backend
    // config is owned by the connection, not the global config store.
    const trackedRef = resolveTrackedRefForBoard(board);
    if (trackedRef) {
      await connectionStore.removeTrackedBoard(trackedRef);
      return;
    }

    // Legacy single-backend mode: fall back to the global backend/config.
    switch (backendService.mode) {
      case 'gitlab':
        await closeGitLabBoard(board);
        return;
      case 'jiracloud':
        await closeJiraMcpBoard(board);
        return;
      default:
        await backendService.deleteBoard(board.id);
    }
  }

  function resolveTrackedRefForBoard(board: Board): { connectionId: string; boardId: string } | undefined {
    const connectionId =
      board.connectionId ??
      connectionStore.getTrackedBoards().find(t => t.boardId === board.id)?.connectionId;
    return connectionId ? { connectionId, boardId: board.id } : undefined;
  }

  async function deleteBoard(boardId: string): Promise<void> {
    try {
      const board = await resolveBoardById(boardId);
      if (!board) {
        await vscode.window.showInformationMessage('Select a board first.');
        return;
      }

      await removeBoardFromTicketManager(board);
      if (
        boardStore.getLastSelectedBoardId() === boardId ||
        boardPanelManager.getActiveBoard()?.id === boardId
      ) {
        await boardStore.setLastSelectedBoardId(undefined);
        boardsSidebarViewProvider.setSelectedBoardId(undefined);
        workModeBoardsSidebarViewProvider.setSelectedBoardId(undefined);
        boardPanelManager.clear();
      }

      await boardsProvider.refresh();
    } catch (error) {
      await reportActionError(error);
    }
  }

  async function removeAllBoards(): Promise<void> {
    try {
      const snapshot = boardsProvider.getSnapshot();
      if (snapshot.boards.length === 0) {
        return;
      }

      // Connections mode: untrack every board from its connection.
      const trackedRefs = snapshot.boards
        .map(board => resolveTrackedRefForBoard(board))
        .filter((ref): ref is { connectionId: string; boardId: string } => ref !== undefined);
      if (trackedRefs.length > 0) {
        await Promise.all(trackedRefs.map(ref => connectionStore.removeTrackedBoard(ref)));
      } else {
        // Legacy single-backend mode.
        switch (backendService.mode) {
          case 'gitlab':
            await configStore.setGitLabSelectedBoardRefs([]);
            break;
          case 'jiracloud':
            await Promise.all([
              configStore.setJiraMcpBoardJql(undefined),
              configStore.setJiraMcpBoardName(undefined),
              configStore.setJiraMcpEpicKey(undefined),
              configStore.setJiraMcpEpicBoardName(undefined)
            ]);
            break;
          default:
            await Promise.all(snapshot.boards.map(board => backendService.deleteBoard(board.id)));
        }
      }

      await boardStore.setLastSelectedBoardId(undefined);
      boardsSidebarViewProvider.setSelectedBoardId(undefined);
      workModeBoardsSidebarViewProvider.setSelectedBoardId(undefined);
      boardPanelManager.clear();
      await boardsProvider.refresh();
    } catch (error) {
      await reportActionError(error);
    }
  }

  async function resetGitLabConfig(): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
      'Reset all GitLab configuration? This clears the URL, API key, project path, and selected boards.',
      { modal: true },
      'Reset'
    );
    if (confirm !== 'Reset') {
      return;
    }
    try {
      const config = vscode.workspace.getConfiguration('ticketManager');
      const target = vscode.workspace.workspaceFolders?.length
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
      await Promise.all([
        config.update('gitlabProjectPath', undefined, target),
        config.update('gitlabListAllAccessibleBoards', undefined, target),
        config.update('gitlabSelectedBoardRefs', undefined, target),
        config.update('backendMode', undefined, target)
      ]);
      await boardStore.setLastSelectedBoardId(undefined);
      boardsSidebarViewProvider.setSelectedBoardId(undefined);
      workModeBoardsSidebarViewProvider.setSelectedBoardId(undefined);
      boardPanelManager.clear();
      await backendService.reset();
      await boardsProvider.refresh();
      setupSidebarViewProvider.resetToModeSelection();
      workModeSetupSidebarViewProvider.resetToModeSelection();
      void vscode.window.showInformationMessage('GitLab configuration has been reset.');
    } catch (error) {
      await reportActionError(error);
    }
  }

  async function updateIssueAndRefresh(
    issueKey: string,
    input: UpdateIssueInput,
    transitionId?: string,
    options?: { openFullPanel?: boolean }
  ): Promise<void> {
    const normalizedInput: UpdateIssueInput = {};
    if (typeof input.summary === 'string') {
      normalizedInput.summary = input.summary;
    }
    if (typeof input.description === 'string') {
      normalizedInput.description = input.description;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'parentKey')) {
      normalizedInput.parentKey = input.parentKey?.trim() || null;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'assignee')) {
      normalizedInput.assignee = input.assignee?.trim() || null;
    }
    if (typeof input.priority === 'string') {
      normalizedInput.priority = input.priority;
    }
    if (typeof input.issueType === 'string') {
      normalizedInput.issueType = input.issueType;
    }

    await backendService.updateIssue(issueKey, normalizedInput);
    if (transitionId) {
      await backendService.transitionIssue(issueKey, transitionId);
    }
    await syncIssueAfterMutation(issueKey, options);
  }

  async function addCommentAndRefresh(issueKey: string, body: string): Promise<void> {
    await backendService.addComment(issueKey, body);
    const copilotRequest = extractCopilotRequest(body, buildCommentMentionNames(issueKey));
    if (copilotRequest) {
      if (!isCopilotSdkConfigured()) {
        void vscode.window.showWarningMessage(
          'Comment added, but Vercel AI Gateway is not configured for @agent replies. Run Ticket Manager: Configure AI.'
        );
      } else {
        try {
          await postCopilotReply(issueKey, copilotRequest);
        } catch (error) {
          reportError(error);
          void vscode.window.showWarningMessage(
            `Comment added, but @agent could not respond: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }
    }
    await syncIssueAfterMutation(issueKey);
  }

  context.subscriptions.push(
    backendService.onDidReceiveExternalComment(async event => {
      const copilotRequest = extractCopilotRequest(event.body, buildCommentMentionNames(event.issueKey));
      if (!copilotRequest) {
        return;
      }
      outputChannel.appendLine(`[Agent] External comment detected on ${event.issueKey} by ${event.author}`);
      if (!isCopilotSdkConfigured()) {
        outputChannel.appendLine('[Agent] Copilot SDK not configured - skipping external comment reply.');
        return;
      }
      try {
        await postCopilotReply(event.issueKey, copilotRequest);
        await syncIssueAfterMutation(event.issueKey);
      } catch (error) {
        reportError(error);
        outputChannel.appendLine(
          `[Agent] Could not respond to external comment on ${event.issueKey}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })
  );

  function getConfiguredAiOptions(): AiOptionPick[] {
    const registeredAgents = configStore.getConfiguredAiAgents();
    const providers = configStore.getConfiguredAiProviders();
    const configuredProviders = new Set(registeredAgents.map(agent => agent.provider));
    const options = [
      ...registeredAgents.map(agent => ({
        provider: agent.provider,
        label: agent.name,
        description: getProviderAgentDisplayName(agent.provider),
        agentName: agent.name,
        credential: agent.apiKey
      })),
      ...providers
        .filter(provider => !configuredProviders.has(provider))
        .map(provider => ({
          provider,
          label: getProviderAgentDisplayName(provider),
          description: provider
        }))
    ];

    return sortAiOptionsByDefaultProvider(options, configStore.getAiDefaultProvider());
  }

  function getAiAssignmentMenuOptions(): AiAssignmentMenuOption[] {
    return getConfiguredAiOptions().map(option => ({
      provider: option.provider,
      label: option.label
    }));
  }

  function getAnalysisModelOptions(): AiModelOption[] {
    const provider = getConfiguredAiOptions()[0]?.provider;
    if (!provider) {
      return [];
    }
    return getModelOptionsForProvider(provider);
  }

  function refreshAiAssignmentMenus(): void {
    const options = getAiAssignmentMenuOptions();
    boardPanelManager.setAiAssignOptions(options);
    issuesSidebarViewProvider?.setAiAssignOptions(options);
    issueDetailPanelManager.setAiAssignOptions(options);
    issueDetailsSidebarViewProvider?.setAiAssignOptions(options);
  }

  function isTerminalAgentState(state: string | undefined): boolean {
    return state === 'completed' || state === 'failed' || state === 'aborted';
  }

  async function findTransitionIdForStatus(
    issueKey: string,
    targetStatus: string
  ): Promise<string | undefined> {
    const issue = await backendService.getIssue(issueKey);
    if (
      issue.status.trim().toLowerCase() === targetStatus.trim().toLowerCase() ||
      issue.statusCategory?.toLowerCase() === 'done'
    ) {
      return undefined;
    }
    const transitions = issue.transitions?.length
      ? issue.transitions
      : await backendService.getTransitions(issueKey);
    return transitions.find(
      transition => transition.toStatus?.trim().toLowerCase() === targetStatus.trim().toLowerCase()
    )?.id;
  }

  async function promptForAiAssignmentOption(issueKey: string): Promise<AiOptionPick | undefined> {
    const options = getConfiguredAiOptions();
    if (options.length === 0) {
      await vscode.window.showWarningMessage(
        'No AI provider is configured. Run Ticket Manager: Configure AI to set up Vercel AI Gateway.'
      );
      return undefined;
    }

    if (options.length === 1) {
      return options[0];
    }

    const picked = await vscode.window.showQuickPick(
      options.map(option => ({
        label: option.label,
        description: option.description,
        option
      })),
      {
        title: `Delegate ${issueKey} to AI Agent`
      }
    );
    return picked?.option;
  }

  async function ensureIssueCanBeDelegated(issueKey: string): Promise<boolean> {
    const issue = await backendService.getIssue(issueKey);
    if (issue.assignee?.trim()) {
      return true;
    }

    await vscode.window.showWarningMessage(
      `${issueKey} must have an assignee before it can be delegated to AI.`
    );
    return false;
  }

  async function refreshIssueAiPresentation(issueKey: string): Promise<void> {
    await issuesSidebarViewProvider.refresh();
    await activeSessionsSidebarViewProvider?.refresh();
    if (detailsProvider.getActiveIssue()?.key === issueKey) {
      const activeIssue = detailsProvider.getActiveIssue();
      if (activeIssue) {
        activeIssue.aiAssignment = aiSessionManager.getSession(issueKey);
        await detailsProvider.setIssue(activeIssue);
        updateCommentPlaceholders();
      }
    }
    await issueDetailPanelManager.refreshIfShowing(issueKey);
  }

  async function abandonAiSession(
    issueKey: string,
    options?: { showMessage?: boolean; clearAssignee?: boolean }
  ): Promise<void> {
    const showMessage = options?.showMessage ?? true;
    const clearAssignee = options?.clearAssignee ?? true;
    const session = aiSessionManager.getSession(issueKey);
    const agentRecord = aiSessionManager.getAgentSession(issueKey);
    if (!session && !agentRecord) {
      if (showMessage) {
        void vscode.window.showInformationMessage(`${issueKey} has no active AI session.`);
      }
      return;
    }

    if (agentRecord && !isTerminalAgentState(agentRecord.state)) {
      if (hasActiveAgentTask(issueKey)) {
        await abortActiveAgentTask(issueKey);
      } else {
        aiSessionManager.updateAgentState(issueKey, 'aborted');
      }
    }

    aiSessionManager.removeSession(issueKey);

    if (clearAssignee) {
      try {
        const issue = await backendService.getIssue(issueKey);
        const assignedLabel =
          session?.label?.trim() ||
          (session
            ? AI_PROVIDER_LABELS[session.provider]
            : agentRecord?.provider
              ? AI_PROVIDER_LABELS[agentRecord.provider]
              : AI_PROVIDER_LABELS['vercel-gateway']);
        if (issue.assignee?.trim() === assignedLabel) {
          await updateIssueAndRefresh(issueKey, { assignee: null });
        } else {
          await refreshIssueAiPresentation(issueKey);
        }
      } catch {
        await refreshIssueAiPresentation(issueKey);
      }
    } else {
      await refreshIssueAiPresentation(issueKey);
    }

    if (showMessage) {
      void vscode.window.showInformationMessage(`AI session abandoned for ${issueKey}.`);
    }
  }

  async function assignIssueToAi(issueKey: string, chosen: AiOptionPick): Promise<void> {
    if (configStore.isAiAnalysisGateEnabled() && !issueAnalysisPanelManager.isConfirmed(issueKey)) {
      const selection = await vscode.window.showWarningMessage(
        `${issueKey} requires analysis confirmation before AI assignment.`,
        'Open Analysis Window'
      );
      if (selection === 'Open Analysis Window') {
        await issueAnalysisPanelManager.open(issueKey);
      }
      return;
    }

    if (!(await ensureIssueCanBeDelegated(issueKey))) {
      return;
    }

    const existing = aiSessionManager.getSession(issueKey);
    const existingAgentRecord = aiSessionManager.getAgentSession(issueKey);
    const existingStatus =
      existingAgentRecord && !isTerminalAgentState(existingAgentRecord.state)
        ? existingAgentRecord.state
        : existing?.status;
    if (existing || (existingAgentRecord && !isTerminalAgentState(existingAgentRecord.state))) {
      const overwrite = await vscode.window.showWarningMessage(
        `${issueKey} is already assigned to an AI agent (${existingStatus ?? 'active'}). Replace?`,
        'Replace',
        'Cancel'
      );
      if (overwrite !== 'Replace') {
        return;
      }
      await abandonAiSession(issueKey, { showMessage: false, clearAssignee: false });
    }

    const assignment = aiSessionManager.createSession(issueKey, chosen.provider, chosen.label, boardStore.getLastSelectedBoardId());
    const activeIssue = detailsProvider.getActiveIssue();
    if (activeIssue?.key === issueKey) {
      activeIssue.aiAssignment = assignment;
    }

    try {
      const transitionId = await findTransitionIdForStatus(issueKey, 'In Progress');
      if (transitionId) {
        await updateIssueAndRefresh(issueKey, {}, transitionId);
      } else {
        await refreshIssueAiPresentation(issueKey);
      }
      await refreshIssueAiPresentation(issueKey);
    } catch (error) {
      aiSessionManager.removeSession(issueKey);
      if (activeIssue?.key === issueKey) {
        activeIssue.aiAssignment = undefined;
      }
      await refreshIssueAiPresentation(issueKey);
      throw error;
    }

    void vscode.window.showInformationMessage(
      `${issueKey} delegated to ${chosen.label} (session: ${assignment.sessionId.slice(0, 8)})`
    );
  }

  async function assignIssueToAiByProvider(issueKey: string, provider: AiProvider): Promise<void> {
    const chosen = getConfiguredAiOptions().find(option => option.provider === provider);
    if (!chosen) {
      await vscode.window.showWarningMessage(
        `The AI provider ${AI_PROVIDER_LABELS[provider] ?? provider} is no longer configured.`
      );
      return;
    }

    await assignIssueToAi(issueKey, chosen);
  }

  async function assignIssueToMe(issueKey: string): Promise<void> {
    const label = await backendService.getSelfAssigneeLabel();
    if (!label) {
      void vscode.window.showWarningMessage(
        'Could not resolve the current user for assignment. For Jira, use Edit to set an assignee manually.'
      );
      return;
    }
    await abandonAiSession(issueKey, { showMessage: false, clearAssignee: false });
    await updateIssueAndRefresh(issueKey, { assignee: label });
  }

  async function promptForCopilotTaskDefinition(
    issue: IssueDetails,
    previous?: AgentTaskDefinition
  ): Promise<AgentTaskDefinition | undefined> {
    const issueWorkflowAssignment = aiSessionManager.getIssueWorkflowAssignment(issue.key);
    const defaultGoal = previous?.goal ??
      `${issue.summary}${issue.description ? '\n' + issue.description.slice(0, 200) : ''}`;

    const goal = await vscode.window.showInputBox({
      title: 'Goal',
      prompt: 'What should the agent accomplish?',
      value: defaultGoal,
      ignoreFocusOut: true
    });
    if (!goal) {
      return undefined;
    }

    const scope = await vscode.window.showInputBox({
      title: 'Scope',
      prompt: 'What files/areas should the agent focus on?',
      value: previous?.scope ?? 'This issue and related files',
      ignoreFocusOut: true
    });
    if (scope === undefined) {
      return undefined;
    }

    const definitionOfDone = await vscode.window.showInputBox({
      title: 'Definition of Done',
      prompt: 'When is this task considered complete?',
      value:
        previous?.definitionOfDone ??
        'All acceptance criteria met, code compiles, tests pass',
      ignoreFocusOut: true
    });
    if (definitionOfDone === undefined) {
      return undefined;
    }

    const workflow = await promptForAgentWorkflowSelection({
      workspaceRoot: workingDirectory,
      previous: previous?.workflow ?? issueWorkflowAssignment?.workflow,
      title: 'Workflow Pack',
      placeHolder: 'Select an optional workflow pack for this Copilot task'
    });
    if (workflow === null) {
      return undefined;
    }

    return {
      goal,
      scope: scope || 'This issue and related files',
      definitionOfDone: definitionOfDone || 'Task complete',
      workflow,
      maxSteps: previous?.maxSteps,
      timeoutMs: previous?.timeoutMs,
      nonGoals: previous?.nonGoals
    };
  }

  async function startNewCopilotSession(issueKey: string): Promise<void> {
    if (!isCopilotSdkConfigured()) {
      void vscode.window.showErrorMessage(
        'Neither Vercel AI Gateway nor Claude Code CLI is configured. Run Ticket Manager: Configure AI.'
      );
      return;
    }

    try {
      const existingRecord = aiSessionManager.getAgentSession(issueKey);
      if (hasActiveAgentTask(issueKey)) {
        const replace = await vscode.window.showWarningMessage(
          `${issueKey} already has a live AI session. Start a new one instead?`,
          'Start New',
          'Cancel'
        );
        if (replace !== 'Start New') {
          return;
        }
        await abortActiveAgentTask(issueKey);
      }

      const issue = await backendService.getIssue(issueKey);
      const taskDefinition = await promptForCopilotTaskDefinition(issue, existingRecord?.taskDefinition);
      if (!taskDefinition) {
        return;
      }

      const issueAttachments = await stageIssueAttachments({
        issue,
        backendService,
        logger: outputChannel
      });
      const taskDefinitionWithAttachments = issueAttachments.length > 0
        ? { ...taskDefinition, attachments: issueAttachments }
        : taskDefinition;

      const provider = await startAgentTask(issue, taskDefinitionWithAttachments, {
        provider: resolvePreferredAgentProvider(issueKey, existingRecord, issue),
        workingDirectory
      });
      activeSessionsSidebarViewProvider?.setSelectedIssueKey(issueKey);
      await activeSessionsSidebarViewProvider?.refresh();
      copilotSessionPanelManager.open(issueKey);
      void vscode.window.showInformationMessage(
        `${getAgentDisplayName(provider)} session started for ${issueKey}. Closing VS Code will pause it so you can resume later.`
      );
    } catch (error) {
      reportError(error, 'startNewCopilotSession');
      void vscode.window.showErrorMessage(
        `Failed to start a new AI session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  function resolveAgentWorkingDirectory(record?: AgentSessionRecord): string | undefined {
    const deliveryWorktreePath = record?.delivery?.worktreePath?.trim();
    if (deliveryWorktreePath) {
      return deliveryWorktreePath;
    }

    return workingDirectory;
  }

  async function resumeCopilotSession(issueKey: string): Promise<void> {
    if (!isCopilotSdkConfigured()) {
      void vscode.window.showErrorMessage(
        'Neither Vercel AI Gateway nor Claude Code CLI is configured. Run Ticket Manager: Configure AI.'
      );
      return;
    }

    const record = aiSessionManager.getAgentSession(issueKey);
    if (!record) {
      void vscode.window.showWarningMessage(`No resumable AI session was found for ${issueKey}.`);
      return;
    }

    if (hasActiveAgentTask(issueKey)) {
      activeSessionsSidebarViewProvider?.setSelectedIssueKey(issueKey);
      copilotSessionPanelManager.open(issueKey);
      return;
    }

    try {
      const provider = await resumeAgentTask(issueKey, record);
      activeSessionsSidebarViewProvider?.setSelectedIssueKey(issueKey);
      await activeSessionsSidebarViewProvider?.refresh();
      copilotSessionPanelManager.open(issueKey);
      void vscode.window.showInformationMessage(
        `${getAgentDisplayName(provider)} session resumed for ${issueKey}. Closing VS Code will pause it so you can resume later.`
      );
    } catch (error) {
      reportError(error, 'resumeCopilotSession');
      void vscode.window.showErrorMessage(
        `Failed to resume the AI session: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async function reviewIssueWithAi(issueKey: string): Promise<void> {
    const options = getConfiguredAiOptions();
    if (options.length === 0) {
      throw new Error(
        'No AI provider is configured. Run Ticket Manager: Configure AI to set up Vercel AI Gateway.'
      );
    }

    const chosen = options[0];
    const issue = await backendService.getIssue(issueKey);
    const reviewText = await reviewTicketWithCopilot(
      issue,
      getVercelGatewayApiKey(),
      chosen.agentName ?? AI_PROVIDER_LABELS['vercel-gateway'],
      workingDirectory
    );

    await backendService.addComment(issueKey, reviewText);
    await syncIssueAfterMutation(issueKey);
  }

  async function transitionIssueAndRefresh(issueKey: string, transitionId: string): Promise<void> {
    await backendService.transitionIssue(issueKey, transitionId);
    await syncIssueAfterMutation(issueKey);
  }

  async function syncIssueAfterMutation(
    issueKey: string,
    options?: { openFullPanel?: boolean }
  ): Promise<void> {
    await Promise.all([
      issuesProvider.refresh(),
      boardsProvider.refresh(),
      epicsSidebarViewProvider.refresh(),
      activeSessionsSidebarViewProvider?.refresh() ?? Promise.resolve()
    ]);

    const refreshedIssue =
      issuesProvider.getIssueByKey(issueKey) ?? (await backendService.getIssue(issueKey));
    await filterStore.setLastSelectedIssueKey(issueKey);
    await detailsProvider.setIssue(refreshedIssue);
    boardPanelManager.setSelectedIssueKey(issueKey);
    issuesSidebarViewProvider.setSelectedIssueKey(issueKey);
    epicsSidebarViewProvider.setSelectedIssueKey(issueKey);
    activeSessionsSidebarViewProvider?.setSelectedIssueKey(issueKey);
    await boardPanelManager.refresh();
    await issueDetailPanelManager.refreshIfShowing(issueKey);

    if (options?.openFullPanel) {
      await issueDetailPanelManager.open(issueKey);
      await revealIssueDetailsInSidebar({ focus: false });
    }
  }

  boardPanelManager.setCardActions({
    assignToMe: async issueKey => {
      await assignIssueToMe(issueKey);
    },
    assignToAi: async (issueKey, provider) => {
      await assignIssueToAiByProvider(issueKey, provider);
    },
    editIssue,
    deleteIssue
  });

  const refreshAndRestoreSelection = async (options?: { skipBoards?: boolean }): Promise<void> => {
    const modeContext = await getModeContextState();
    await setModeContext();
    await ensureJiraMcpIssueScopeVisibility(modeContext);
    epicsSidebarViewProvider.setDefaultEpicKey(configStore.getJiraMcpEpicKey());

    if (!modeContext.configured) {
      issuesSidebarViewProvider.setSelectedIssueKey(undefined);
      epicsSidebarViewProvider.setSelectedIssueKey(undefined);
      activeSessionsSidebarViewProvider?.setSelectedIssueKey(undefined);
      boardsSidebarViewProvider.setSelectedBoardId(undefined);
      workModeBoardsSidebarViewProvider.setSelectedBoardId(undefined);
      issuesProvider.setBoardScope(undefined);
      epicsSidebarViewProvider.setBoardScope(undefined);
      return;
    }

    // Restore the board scope for the EPIC and My Issues sidebars before they
    // refresh. These sidebars require a scoped board (each board carries its own
    // connection); without re-applying the last-selected board on activation /
    // refresh they would render blank until the user re-selects a board.
    const lastSelectedBoardId = boardStore.getLastSelectedBoardId();
    if (lastSelectedBoardId) {
      try {
        const restoredBoard = await resolveBoardById(lastSelectedBoardId);
        if (restoredBoard) {
          const trackedRef = boardStore.getLastSelectedTrackedBoard();
          const restoredConnectionId =
            restoredBoard.connectionId ??
            (trackedRef?.boardId === restoredBoard.id ? trackedRef.connectionId : undefined);
          const scopedBoard: Board = restoredConnectionId
            ? { ...restoredBoard, connectionId: restoredConnectionId }
            : restoredBoard;
          issuesProvider.setBoardScope(scopedBoard);
          epicsSidebarViewProvider.setBoardScope(scopedBoard);
        }
      } catch (error) {
        outputChannel.appendLine(
          `[refreshAndRestoreSelection] failed to restore board scope: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    await Promise.all([
      issuesProvider.refresh(),
      options?.skipBoards ? Promise.resolve() : boardsProvider.refresh(),
      activeSessionsSidebarViewProvider?.isViewVisible()
        ? activeSessionsSidebarViewProvider.refresh()
        : Promise.resolve()
    ]);
    const lastSelectedKey = filterStore.getLastSelectedIssueKey();
    if (lastSelectedKey) {
      const issue = issuesProvider.getIssueByKey(lastSelectedKey);
      if (issue) {
        await detailsProvider.setIssue(issue);
        await revealIssueDetailsInSidebar({ focus: false });
        boardPanelManager.setSelectedIssueKey(lastSelectedKey);
        issuesSidebarViewProvider.setSelectedIssueKey(lastSelectedKey);
        epicsSidebarViewProvider.setSelectedIssueKey(lastSelectedKey);
        activeSessionsSidebarViewProvider?.setSelectedIssueKey(lastSelectedKey);
      } else {
        await filterStore.setLastSelectedIssueKey(undefined);
        await detailsProvider.setIssue(undefined);
        boardPanelManager.setSelectedIssueKey(undefined);
        issuesSidebarViewProvider.setSelectedIssueKey(undefined);
        epicsSidebarViewProvider.setSelectedIssueKey(undefined);
        activeSessionsSidebarViewProvider?.setSelectedIssueKey(undefined);
        issueDetailPanelManager.clear();
      }
    } else {
      boardPanelManager.setSelectedIssueKey(undefined);
      issuesSidebarViewProvider.setSelectedIssueKey(undefined);
      epicsSidebarViewProvider.setSelectedIssueKey(undefined);
      activeSessionsSidebarViewProvider?.setSelectedIssueKey(undefined);
    }

    boardsSidebarViewProvider.setSelectedBoardId(boardStore.getLastSelectedBoardId());
    workModeBoardsSidebarViewProvider.setSelectedBoardId(boardStore.getLastSelectedBoardId());

    if (!options?.skipBoards) {
      await boardPanelManager.refresh();
    }
  };

  issuesSidebarViewProvider = new IssuesSidebarViewProvider(
    backendService,
    filterStore,
    issuesProvider,
    aiSessionManager,
    {
      onSelectIssue: async (issueKey, openFullPanel) => {
        await selectIssueByKey(issueKey, { openFullPanel });
      },
      onAssignToMe: async issueKey => {
        await assignIssueToMe(issueKey);
      },
      onAssignToAi: async (issueKey, provider) => {
        await assignIssueToAiByProvider(issueKey, provider);
      },
      onEditIssue: async issueKey => {
        await editIssue(issueKey);
      },
      onDeleteIssue: async issueKey => {
        await deleteIssue(issueKey);
      },
      onSetSearchText: async (searchText) => {
        await filterStore.updateFilters({ searchText });
        await refreshSearchActionContexts();
      },
      onSetStatuses: async (statuses) => {
        await filterStore.updateFilters({ statuses });
      },
      onLoadMore: async () => {
        await issuesProvider.loadMore();
      }
    },
    () => {
      const activeBoard = boardPanelManager.getActiveBoard();
      return activeBoard ? boardColumnStore.getPreferences(activeBoard.id).issueTypeColors : undefined;
    }
  );
  refreshAiAssignmentMenus();
  // Populate the live Copilot model list from VS Code's language model API in
  // the background so the model pickers match VS Code's own list. Refresh the
  // assignment menus once loaded.
  void refreshGatewayModelCache(getVercelGatewayOptions(), message => outputChannel.appendLine(message)).then(() => {
    refreshAiAssignmentMenus();
    if (gatewayModelCache.length > 0) {
      issueDetailPanelManager.setKnownModels(gatewayModelCache);
    }
  });
  epicsSidebarViewProvider = new EpicsSidebarViewProvider(
    backendService,
    filterStore,
    issuesProvider,
    {
      onSelectEpic: async (issueKey, openFullPanel) => {
        await selectIssueByKey(issueKey, { openFullPanel });
      },
      onCreateEpic: async () => {
        await createEpic();
      },
      onEditEpic: async issueKey => {
        await editEpic(issueKey);
      },
      onSetDefaultEpic: async issueKey => {
        await setDefaultEpicForWorkspace(issueKey);
      },
      onDeleteEpic: async issueKey => {
        await deleteIssue(issueKey);
      },
      onSetSearchText: async (_searchText) => {
        await refreshSearchActionContexts();
      },
      onSetStatuses: async (statuses) => {
        await filterStore.setEpicStatuses(statuses);
      }
    },
    resolveBoardService
  );
  boardsSidebarViewProvider = new ClassicBoardsSidebarViewProvider(
    backendService,
    boardStore,
    boardsProvider,
    boardColumnStore,
    () => backendService.mode,
    {
      onSelectBoard: async boardId => {
        const board = await resolveBoardById(boardId);
        if (!board) {
          // Do not call selectBoard(undefined): that clears the EPIC/My Issues
          // board scope and leaves those sidebars blank. Keep the current scope
          // and surface the failure instead.
          outputChannel.appendLine(`[selectBoard] classic board not found, keeping current scope: ${boardId}`);
          return;
        }
        await selectBoard(board);
      },
      onEditBoard: async boardId => {
        await editBoard(boardId);
      },
      onDeleteBoard: async boardId => {
        await deleteBoard(boardId);
      }
    },
    connectionStore
  );
  workModeBoardsSidebarViewProvider = new WorkModeBoardsSidebarViewProvider(
    backendService,
    boardStore,
    boardsProvider,
    aiSessionManager,
    () => backendService.mode,
    {
      onSelectBoard: async boardId => {
        try {
          outputChannel.appendLine(`[WorkMode] Board selected: ${boardId}`);
          const board = await resolveBoardById(boardId);
          if (!board) {
            outputChannel.appendLine(`[WorkMode] Board not found: ${boardId}`);
            return;
          }
          await selectBoard(board);
        } catch (error) {
          outputChannel.appendLine(`[WorkMode] onSelectBoard error: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      onEditBoard: async boardId => {
        await editBoard(boardId);
      },
      onDeleteBoard: async boardId => {
        await deleteBoard(boardId);
      },
      onRemoveAllBoards: async () => {
        await removeAllBoards();
      },
      onResetGitLabConfig: async () => {
        await resetGitLabConfig();
      },
      onAddBoard: async () => {
        // Same entry point as the classic Boards "+" toolbar action.
        await vscode.commands.executeCommand('ticketManager.createBoard');
      },
      onOpenSession: async (issueKey, boardId) => {
        const sessionBoardId =
          boardId ??
          aiSessionManager.getAgentSession(issueKey)?.boardId ??
          aiSessionManager.getSession(issueKey)?.boardId;
        if (sessionBoardId) {
          await selectBoard(await resolveBoardById(sessionBoardId));
        }
        activeSessionsSidebarViewProvider.setSelectedIssueKey(issueKey);
        copilotSessionPanelManager.open(issueKey);
      }
    },
    connectionStore,
    async board => (board.connectionId ? backendService.serviceFor(board.connectionId) : backendService)
  );
  issueDetailsSidebarViewProvider = new IssueDetailsSidebarViewProvider(
    backendService,
    detailsProvider,
    aiSessionManager,
    () => configStore.getAiAgentNames(),
    {
      onSaveIssueEdits: async (issueKey, input, transitionId) => {
        await updateIssueAndRefresh(issueKey, input, transitionId);
      },
      onAddComment: async (issueKey, body) => {
        await addCommentAndRefresh(issueKey, body);
      },
      onRequestAiReview: async (issueKey) => {
        await reviewIssueWithAi(issueKey);
      }
    }
  );
  updateCommentPlaceholders();
  activeSessionsSidebarViewProvider = new ActiveSessionsSidebarViewProvider(
    backendService,
    aiSessionManager,
    issueKey => vercelAgentService.hasActiveTask(issueKey),
    {
      onOpenSession: async issueKey => {
        const sessionBoardId =
          aiSessionManager.getAgentSession(issueKey)?.boardId ??
          aiSessionManager.getSession(issueKey)?.boardId;
        if (sessionBoardId) {
          await selectBoard(await resolveBoardById(sessionBoardId));
        }
        activeSessionsSidebarViewProvider.setSelectedIssueKey(issueKey);
        copilotSessionPanelManager.open(issueKey);
      },
      onResumeSession: async issueKey => {
        await resumeCopilotSession(issueKey);
      },
      onStartNewSession: async issueKey => {
        await startNewCopilotSession(issueKey);
      },
      onAbandonSession: async issueKey => {
        await abandonAiSession(issueKey);
      },
      onDeleteSession: async issueKey => {
        if (hasActiveAgentTask(issueKey)) {
          void vscode.window.showWarningMessage(
            `Cannot delete session for ${issueKey} because it is currently running. Stop or abandon it first.`
          );
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          `Delete session for ${issueKey}? This removes all stored session data permanently.`,
          { modal: true },
          'Delete'
        );
        if (confirm !== 'Delete') {
          return;
        }

        aiSessionManager.removeAgentSession(issueKey);
        aiSessionManager.removeSession(issueKey);
        void vscode.window.showInformationMessage(`Session for ${issueKey} deleted.`);
        await activeSessionsSidebarViewProvider.refresh();
        await issueDetailPanelManager.refreshIfShowing(issueKey);
        const activeIssue = detailsProvider.getActiveIssue();
        if (activeIssue?.key === issueKey) {
          activeIssue.aiAssignment = undefined;
          await detailsProvider.setIssue(activeIssue);
        }
      }
    }
  );

  function resolveIssueKeyFromArgOrActive(arg?: unknown): string | undefined {
    if (typeof arg === 'string' && arg.trim().length > 0) {
      return arg.trim();
    }
    if (
      arg &&
      typeof arg === 'object' &&
      'issueKey' in arg &&
      typeof (arg as { issueKey?: unknown }).issueKey === 'string'
    ) {
      return (arg as { issueKey: string }).issueKey;
    }
    return detailsProvider.getActiveIssue()?.key;
  }

  await refreshSearchActionContexts();

  context.subscriptions.push(
    vscode.commands.registerCommand('ticketManager.createEpic', async () => {
      try {
        await createEpic();
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.searchIssues', async () => {
      try {
        await searchIssues();
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.searchIssuesActive', async () => {
      try {
        await searchIssues();
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.searchEpics', async () => {
      try {
        await searchEpics();
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.searchEpicsActive', async () => {
      try {
        await searchEpics();
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.searchBoards', async () => {
      try {
        await searchBoards();
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.searchBoardsActive', async () => {
      try {
        await searchBoards();
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.assignToMe', async (arg?: unknown) => {
      try {
        const issueKey = resolveIssueKeyFromArgOrActive(arg);
        if (!issueKey) {
          await vscode.window.showInformationMessage('Select an issue first.');
          return;
        }
        await assignIssueToMe(issueKey);
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.assignToAi', async (arg?: unknown, providerArg?: unknown) => {
      try {
        const issueKey = resolveIssueKeyFromArgOrActive(arg);
        if (!issueKey) {
          await vscode.window.showInformationMessage('Select an issue first.');
          return;
        }

        if (typeof providerArg === 'string') {
          await assignIssueToAiByProvider(issueKey, providerArg as AiProvider);
          return;
        }

        const picked = await promptForAiAssignmentOption(issueKey);
        if (!picked) {
          return;
        }

        await assignIssueToAi(issueKey, picked);
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.openAnalysisWindow', async (arg?: unknown) => {
      try {
        if (!configStore.isAiAnalysisGateEnabled()) {
          await vscode.window.showInformationMessage(
            'Analysis gate is disabled. Enable Ticket Manager AI Analysis and set a default analysis prompt in Settings.'
          );
          return;
        }

        const issueKey = resolveIssueKeyFromArgOrActive(arg);
        if (!issueKey) {
          await vscode.window.showInformationMessage('Select an issue first.');
          return;
        }

        await issueAnalysisPanelManager.open(issueKey);
      } catch (error) {
        reportError(error, 'open-analysis-window');
      }
    }),
    vscode.commands.registerCommand('ticketManager.confirmAnalysisComplete', async (arg?: unknown) => {
      try {
        const issueKey = resolveIssueKeyFromArgOrActive(arg);
        if (!issueKey) {
          await vscode.window.showInformationMessage('Select an issue first.');
          return;
        }
        issueAnalysisPanelManager.markConfirmed(issueKey);
      } catch (error) {
        reportError(error, 'confirm-analysis-complete');
      }
    }),
    vscode.commands.registerCommand('ticketManager.unassignAi', async (arg?: unknown) => {
      try {
        const issueKey = resolveIssueKeyFromArgOrActive(arg);
        if (!issueKey) {
          await vscode.window.showInformationMessage('Select an issue first.');
          return;
        }
        await abandonAiSession(issueKey, { showMessage: true, clearAssignee: true });
      } catch (error) {
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.reviewWithAi', async () => {
      try {
        const issue = detailsProvider.getActiveIssue();
        if (!issue) {
          await vscode.window.showInformationMessage('Select an issue first.');
          return;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Reviewing ${issue.key} with AI…`,
            cancellable: false
          },
          async () => {
            await reviewIssueWithAi(issue.key);
          }
        );
        await vscode.window.showInformationMessage(`AI review posted as a comment on ${issue.key}.`);
      } catch (error) {
        await vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
        reportError(error);
      }
    }),
    vscode.commands.registerCommand('ticketManager.localPeerReview', async (arg?: unknown) => {
      try {
        const issueKey = resolveIssueKeyFromArgOrActive(arg);
        if (!issueKey) {
          await vscode.window.showInformationMessage('Select an issue first.');
          return;
        }
        const issue = await backendService.getIssue(issueKey);
        await localPeerReviewPanel.open(issue);
      } catch (error) {
        await vscode.window.showErrorMessage(
          `LPR failed: ${error instanceof Error ? error.message : String(error)}`
        );
        reportError(error, 'localPeerReview');
      }
    }),
    vscode.commands.registerCommand('ticketManager.startSubTaskDelivery', async (parentIssueKey?: string, subTaskKey?: string) => {
      if (!parentIssueKey || !subTaskKey) {
        void vscode.window.showErrorMessage('Parent issue key and sub-task key are required.');
        return;
      }
      try {
        await startSubTaskDelivery(parentIssueKey, subTaskKey);
        void vscode.window.showInformationMessage(`Started delivery workflow for sub-task ${subTaskKey}.`);
      } catch (error) {
        reportError(error, `startSubTaskDelivery:${subTaskKey}`);
        void vscode.window.showErrorMessage(
          `Failed to start sub-task delivery: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }),
    vscode.commands.registerCommand('ticketManager.openSettings', async () => {
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        `@ext:${context.extension.id} ticketManager`
      );
    }),
    vscode.commands.registerCommand('ticketManager.toggleWorkMode', async () => {
      try {
        const nextMode: BoardsSidebarMode = getBoardsSidebarMode() === 'work' ? 'classic' : 'work';
        // Only persist the mode change. The onDidChangeConfiguration handler
        // performs the container switch and re-opens the previously active board.
        // Doing the container switch here as well caused a double-switch race
        // that left the board editor panel unable to open.
        await setBoardsSidebarMode(nextMode);
        void vscode.window.showInformationMessage(
          nextMode === 'work' ? 'Ticket Manager switched to Work Mode.' : 'Ticket Manager switched to Classic mode.'
        );
      } catch (error) {
        reportError(error, 'toggle-work-mode');
      }
    }),
    vscode.commands.registerCommand('ticketManager.configureAi', async () => {
      try {
        const result = await promptToConfigureDefaultAiProvider({
          openVercelGatewaySettings: () => aiGatewaySettingsPanel.open(),
          configStore
        });
        refreshAiAssignmentMenus();
        refreshStatusBarInBackground();
        // Panel shows its own save confirmation; only toast when AI was disabled.
        if (result.status === 'skipped') {
          await vscode.window.showInformationMessage(describeAiConfigurationResult(result));
        }
      } catch (error) {
        await vscode.window.showErrorMessage(
          error instanceof Error ? error.message : String(error)
        );
        reportError(error);
      }
    }),
    registerImportCommand(context),
    ...registerCommands({
      context,
      configStore,
      backendService,
      filterStore,
      boardStore,
      connectionStore,
      boardColumnConfigPanel,
      newProjectWizardPanel,
      setupWizardPanel,
      userWorkspaceBoardWizardPanel,
      setupSidebarViewProvider,
      taskDesignerPanelManager,
      issuesProvider,
      boardsProvider,
      detailsProvider,
      boardPanelManager,
      issueDetailPanelManager,
      revealIssueDetailsTree: () => revealIssueDetailsInSidebar({ focus: false }),
      revealSetupView,
      // Create in the main editor pane (Issue Detail draft mode), not the
      // sidebar modal — the sidebar's own New Issue button still opens its
      // in-webview dialog for quick adds.
      openCreateIssueForm: async defaults => {
        await issueDetailPanelManager.openDraft(defaults);
        return true;
      },
      output: outputChannel,
      onConnectionCheck: result => {
        ticketManagerStatusBar.recordConnectionResult(result);
      },
      reportError,
      vercelAgentService,
      copilotSessionPanelManager,
      aiSessionManager
    }),
    vscode.window.registerWebviewViewProvider('ticketManager.myIssues', issuesSidebarViewProvider),
    vscode.window.registerWebviewViewProvider('ticketManager.epics', epicsSidebarViewProvider),
    vscode.window.registerWebviewViewProvider('ticketManager.boards', boardsSidebarViewProvider),
    vscode.window.registerWebviewViewProvider('ticketManager.workModeBoards', workModeBoardsSidebarViewProvider),
    vscode.window.registerWebviewViewProvider('ticketManager.activeSessions', activeSessionsSidebarViewProvider),
    vscode.window.registerWebviewViewProvider('ticketManager.issueDetails', issueDetailsSidebarViewProvider),
    vscode.window.registerWebviewViewProvider('ticketManager.setup', setupSidebarViewProvider),
    vscode.window.registerWebviewViewProvider('ticketManager.workModeSetup', workModeSetupSidebarViewProvider),
    setupSidebarViewProvider,
    workModeSetupSidebarViewProvider,
    issuesSidebarViewProvider,
    epicsSidebarViewProvider,
    boardsSidebarViewProvider,
    workModeBoardsSidebarViewProvider,
    activeSessionsSidebarViewProvider,
    issueDetailsSidebarViewProvider,
    ticketManagerStatusBar,
    vercelAgentService,
    copilotSessionPanelManager,
    aiSessionManager,
    filterStore.onDidChange(() => {
      void refreshSearchActionContexts().catch(error => reportError(error));
      void (async () => {
        try {
          const activeIssue = detailsProvider.getActiveIssue();
          await issuesProvider.refresh();
          if (activeIssue) {
            const refreshedIssue = issuesProvider.getIssueByKey(activeIssue.key) ?? activeIssue;
            await detailsProvider.setIssue(refreshedIssue);
          }
          boardPanelManager.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
          issuesSidebarViewProvider.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
          epicsSidebarViewProvider.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
          activeSessionsSidebarViewProvider?.setSelectedIssueKey(detailsProvider.getActiveIssue()?.key);
        } catch (error) {
          reportError(error);
        }
      })();
    }),
    boardStore.onDidChange(() => {
      void refreshSearchActionContexts().catch(error => reportError(error));
      boardsSidebarViewProvider.setSelectedBoardId(boardStore.getLastSelectedBoardId());
      workModeBoardsSidebarViewProvider.setSelectedBoardId(boardStore.getLastSelectedBoardId());
      // Keep the BackendRouter's active connection in sync with the
      // currently-selected tracked board so all existing backendService.X()
      // calls automatically route to the right connection.
      const trackedRef = boardStore.getLastSelectedTrackedBoard();
      backendService.setActiveConnection(trackedRef?.connectionId);
      ticketManagerStatusBar.resync();
      void boardsProvider.refresh().catch(error => reportError(error));
    }),
    connectionStore.onDidChange(() => {
      void (async () => {
        try {
          // Keep activity-bar when-clauses in sync (Configure Project <-> Boards).
          await setModeContext();
          if (!backendService.getActiveConnectionId() && connectionStore.hasConnections()) {
            const firstTracked = connectionStore.getTrackedBoards()[0];
            const connectionId =
              firstTracked?.connectionId ?? connectionStore.getConnections()[0]?.id;
            if (connectionId) {
              backendService.setActiveConnection(connectionId);
            }
          }
          ticketManagerStatusBar.resync();
          await boardsProvider.refresh();
        } catch (error) {
          reportError(error, 'connection-store-change');
        }
      })();
    }),
    ...(context.extensionMode !== vscode.ExtensionMode.Test
      ? [
          vscode.workspace.onDidChangeConfiguration(event => {
            if (!event.affectsConfiguration('ticketManager')) {
              return;
            }

            if (
              event.affectsConfiguration('ticketManager.ai') &&
              !event.affectsConfiguration('ticketManager.backendMode') &&
              !event.affectsConfiguration('ticketManager.connectionType') &&
              !event.affectsConfiguration('ticketManager.httpUrl') &&
              !event.affectsConfiguration('ticketManager.stdioCommand') &&
              !event.affectsConfiguration('ticketManager.stdioArgs') &&
              !event.affectsConfiguration('ticketManager.stdioCwd') &&
              !event.affectsConfiguration('ticketManager.liveFolderPath') &&
              !event.affectsConfiguration('ticketManager.liveFolderProjectKey') &&
              !event.affectsConfiguration('ticketManager.liveFolderProjectName')
            ) {
              refreshAiAssignmentMenus();
              updateCommentPlaceholders();
              void updateAnalysisContext().catch(error => reportError(error));
              void ticketManagerStatusBar.refresh().catch(error => reportError(error));
              return;
            }

            void (async () => {
              try {
                refreshAiAssignmentMenus();
                updateCommentPlaceholders();
                await updateAnalysisContext();
                const boardsModeChanged = event.affectsConfiguration('ticketManager.boardsSidebarPreviewMode');
                if (boardsModeChanged) {
                  const configuration = vscode.workspace.getConfiguration('ticketManager');
                  const desiredMode = getBoardsSidebarMode();
                  const currentPreviewMode = configuration.get<string>('boardsSidebarPreviewMode') === 'work'
                    ? 'work'
                    : 'classic';
                  if (currentPreviewMode !== desiredMode) {
                    await setBoardsSidebarMode(desiredMode);
                    return;
                  }
                }

                // A pure boards-mode preview switch (classic <-> work) does not
                // change the backend or connection, so the selected board and its
                // connection are still valid. Preserve and re-select the board so
                // the board details pane re-opens and the active connection (and
                // therefore the status bar connection check) is not lost.
                const onlyBoardsModeChanged =
                  boardsModeChanged &&
                  !event.affectsConfiguration('ticketManager.backendMode') &&
                  !event.affectsConfiguration('ticketManager.connectionType') &&
                  !event.affectsConfiguration('ticketManager.httpUrl') &&
                  !event.affectsConfiguration('ticketManager.stdioCommand') &&
                  !event.affectsConfiguration('ticketManager.stdioArgs') &&
                  !event.affectsConfiguration('ticketManager.stdioCwd') &&
                  !event.affectsConfiguration('ticketManager.liveFolderPath') &&
                  !event.affectsConfiguration('ticketManager.liveFolderProjectKey') &&
                  !event.affectsConfiguration('ticketManager.liveFolderProjectName');

                if (onlyBoardsModeChanged) {
                  // A pure classic <-> work preview switch keeps the same backend,
                  // connection, and selected board. Do NOT reset the backend or
                  // clear the selection. Re-open the previously active board and
                  // ONLY THEN switch the activity-bar container.
                  //
                  // Ordering matters: executeCommand(getBoardsContainerCommand())
                  // focuses the activity-bar/sidebar, so ViewColumn.Active no longer
                  // points at an editor group. Creating the board webview panel after
                  // that focus change leaves the editor tab unsurfaced ("no tab
                  // opens"). Opening the board first lands it in the editor group.
                  const previousBoardId = boardStore.getLastSelectedBoardId();
                  await setModeContext();
                  await boardsProvider.refresh();
                  let previousBoard = previousBoardId
                    ? await resolveBoardById(previousBoardId)
                    : undefined;
                  // Boards may not be repopulated yet right after the mode change;
                  // retry resolution briefly before giving up.
                  if (previousBoardId && !previousBoard) {
                    await new Promise(resolve => setTimeout(resolve, 150));
                    await boardsProvider.refresh();
                    previousBoard = await resolveBoardById(previousBoardId);
                  }
                  // Open the board panel FIRST (while the editor area is still the
                  // active group) so the webview lands in the editor group. Force a
                  // fresh panel because the existing one can be left detached/blank
                  // across a mode switch.
                  if (previousBoard) {
                    await selectBoard(previousBoard, { forceRecreatePanel: true });
                  }
                  // Switch the activity-bar container AFTER the board panel exists.
                  await vscode.commands.executeCommand(getBoardsContainerCommand());
                  refreshStatusBarInBackground();
                  return;
                }

                await setModeContext();
                await filterStore.setLastSelectedIssueKey(undefined);
                await boardStore.setLastSelectedBoardId(undefined);
                await detailsProvider.setIssue(undefined);
                boardsSidebarViewProvider.setSelectedBoardId(undefined);
                workModeBoardsSidebarViewProvider.setSelectedBoardId(undefined);
                await epicsSidebarViewProvider.setSearchText('');
                await refreshSearchActionContexts();
                boardPanelManager.clear();
                issueDetailPanelManager.clear();
                // reset() and refresh can fail transiently while settings are
                // being saved incrementally (e.g. backendMode written before
                // liveFolderPath).  Swallow the error; the next config-change
                // event will retry with all settings in place.
                try {
                  await backendService.reset();
                  await refreshAndRestoreSelection();
                  if (boardsModeChanged) {
                    await vscode.commands.executeCommand(getBoardsContainerCommand());
                  }
                } catch {
                  // Will be retried on the next onDidChangeConfiguration
                }

                refreshStatusBarInBackground();
              } catch (error) {
                reportError(error);
              }
            })();
          })
        ]
      : [])
  );

  try {
    await ensureStartupConfiguration();
    await ensureBoardsContainerVisibleOnStartup();
    if ((await getModeContextState()).configured) {
      try {
        await refreshStartupSelectionWithProgress();
      } catch (error) {
        if (error instanceof Error && error.message === STARTUP_BACKEND_LOAD_CANCELLED) {
          await resetToSetupAfterStartupLoadFailure('cancelled');
        } else if (
          error instanceof Error &&
          error.message === STARTUP_BACKEND_LOAD_TIMED_OUT
        ) {
          await resetToSetupAfterStartupLoadFailure('timed-out');
        } else {
          throw error;
        }
      }
    }
    refreshBoardsInBackgroundAfterStartup();
    refreshStatusBarInBackground();

    // Recover in-flight delivery sessions that were interrupted by a restart.
    // The onDidChangeAgentSession listener only fires on changes, so sessions
    // that were already pending finalization at shutdown must be re-triggered.
    void recoverPendingDeliverySessions().catch(error => reportError(error, 'startup-recovery'));
  } catch (error) {
    reportError(error);
  }

  deactivateHandler = async () => {
    await pauseAllAgentTasks(
      'Session paused because VS Code is closing. Reopen VS Code and resume to continue.'
    );
  };

  return {
    refresh: refreshAndRestoreSelection,
    backendService,
    filterStore,
    boardStore,
    boardColumnStore,
    issuesProvider,
    boardsProvider,
    detailsProvider,
    boardPanelManager,
    issueDetailPanelManager,
    configStore,
    aiSessionManager,
    outputChannel
  };
}

export async function deactivate(): Promise<void> {
  const handler = deactivateHandler;
  deactivateHandler = undefined;
  await handler?.();
}
