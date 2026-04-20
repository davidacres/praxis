const fs = require('node:fs/promises');
const path = require('node:path');
const util = require('node:util');
const { spawn, execFile: execFileCallback } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

const { createConsoleLogger, createPollingConfig, searchMatchingIssues, validatePollingConfig } = require('./polling');
const {
  GitLabClient,
  createGitLabConfig,
  flattenDiscussionNotes,
  inferGitLabProjectFromRepo,
  validateGitLabConfig
} = require('./gitlab');
const { JsonStateStore, ensureMergeRequestState } = require('./standalone-state');

const execFile = util.promisify(execFileCallback);
const EXECUTOR_RESULT_MARKER = 'STANDALONE_EXECUTOR_RESULT';

const DEFAULT_STANDALONE_CONFIG = Object.freeze({
  PollIntervalSeconds: 30,
  GitLabUrl: process.env.GITLAB_URL ?? '',
  GitLabProject: process.env.GITLAB_PROJECT ?? '',
  GitLabToken: process.env.GITLAB_TOKEN ?? '',
  RepoPath: '',
  StateFilePath: '',
  Mode: 'dry-run',
  TrackedIssueKeys: [],
  ExecutorCommand: '',
  PublishCommand: '',
  ArtifactPattern: '',
  WorktreeRoot: ''
});

function normalizeStringArray(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => String(value ?? '').trim().toUpperCase())
    .filter(Boolean))];
}

function hasWildcard(pattern) {
  return /[*?]/.test(pattern);
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createStandaloneConfig(overrides = {}) {
  return {
    ...DEFAULT_STANDALONE_CONFIG,
    ...overrides,
    GitLabUrl: overrides.GitLabUrl ?? process.env.GITLAB_URL ?? DEFAULT_STANDALONE_CONFIG.GitLabUrl,
    GitLabProject: overrides.GitLabProject ?? process.env.GITLAB_PROJECT ?? DEFAULT_STANDALONE_CONFIG.GitLabProject,
    GitLabToken: process.env.GITLAB_TOKEN ?? overrides.GitLabToken ?? DEFAULT_STANDALONE_CONFIG.GitLabToken,
    TrackedIssueKeys: normalizeStringArray(overrides.TrackedIssueKeys ?? DEFAULT_STANDALONE_CONFIG.TrackedIssueKeys)
  };
}

async function loadStandaloneConfig(configPath, overrides = {}) {
  const resolvedConfigPath = path.resolve(configPath);
  const rawText = await fs.readFile(resolvedConfigPath, 'utf8');
  const parsed = JSON.parse(rawText);
  const configuredStandalone = parsed?.StandaloneJiraMrPolling && typeof parsed.StandaloneJiraMrPolling === 'object'
    ? parsed.StandaloneJiraMrPolling
    : {};
  const standaloneConfig = createStandaloneConfig({
    ...configuredStandalone,
    ...overrides
  });

  if (!standaloneConfig.StateFilePath) {
    standaloneConfig.StateFilePath = path.join(path.dirname(resolvedConfigPath), '.standalone-jira-mr-state.json');
  }

  if ((!standaloneConfig.GitLabUrl || !standaloneConfig.GitLabProject) && standaloneConfig.RepoPath) {
    const inferred = await inferGitLabProjectFromRepo(standaloneConfig.RepoPath);
    standaloneConfig.GitLabUrl = standaloneConfig.GitLabUrl || inferred.baseUrl;
    standaloneConfig.GitLabProject = standaloneConfig.GitLabProject || inferred.project;
  }

  const gitLabConfig = createGitLabConfig({
    BaseUrl: standaloneConfig.GitLabUrl,
    Project: standaloneConfig.GitLabProject,
    Token: standaloneConfig.GitLabToken
  });
  validateGitLabConfig(gitLabConfig);

  let jiraConfig;
  if (standaloneConfig.TrackedIssueKeys.length === 0) {
    const configuredJira = parsed?.JiraPolling && typeof parsed.JiraPolling === 'object' ? parsed.JiraPolling : {};
    jiraConfig = createPollingConfig({
      ...configuredJira,
      ...pick(overrides, ['BaseUrl', 'InternalDns', 'PreferredResolveIp', 'Token', 'ProjectKey', 'LinkedEpicKey', 'RequiredLabel', 'RequiredStatus', 'PollIntervalSeconds', 'MaxResults'])
    });
    validatePollingConfig(jiraConfig);
  }

  if (!Number.isInteger(standaloneConfig.PollIntervalSeconds) || standaloneConfig.PollIntervalSeconds < 5) {
    throw new Error('StandaloneJiraMrPolling:PollIntervalSeconds must be at least 5.');
  }

  if (!['dry-run', 'mutable'].includes(standaloneConfig.Mode)) {
    throw new Error('StandaloneJiraMrPolling:Mode must be either "dry-run" or "mutable".');
  }

  return {
    jiraConfig,
    standaloneConfig,
    gitLabConfig
  };
}

function pick(source, keys) {
  const result = {};
  for (const key of keys) {
    if (Object.hasOwn(source, key)) {
      result[key] = source[key];
    }
  }
  return result;
}

function buildMergeRequestKey(mergeRequest) {
  return `${mergeRequest.project_id}:${mergeRequest.iid}`;
}

function getMergeRequestHeadSha(mergeRequest) {
  return mergeRequest.sha ?? mergeRequest.diff_refs?.head_sha ?? '';
}

function truncateForLog(text, maxLength = 140) {
  const normalized = String(text ?? '').replaceAll(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 3)}...`;
}

function createNoteMap(notes) {
  const noteMap = {};
  for (const note of notes) {
    noteMap[note.id] = note.updatedAt;
  }
  return noteMap;
}

function diffDiscussionNotes(previousNotes, currentNotes, isBaseline) {
  if (isBaseline) {
    return {
      newNotes: [],
      updatedNotes: []
    };
  }

  const noteState = previousNotes ?? {};
  const newNotes = [];
  const updatedNotes = [];

  for (const note of currentNotes) {
    const previousUpdatedAt = noteState[note.id];
    if (!previousUpdatedAt) {
      newNotes.push(note);
      continue;
    }

    if (previousUpdatedAt !== note.updatedAt) {
      updatedNotes.push(note);
    }
  }

  return {
    newNotes,
    updatedNotes
  };
}

function parseExecutorResult(outputText) {
  const lines = String(outputText ?? '').split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const markerIndex = line.indexOf(EXECUTOR_RESULT_MARKER);
    if (markerIndex < 0) {
      continue;
    }

    const jsonText = line.slice(markerIndex + EXECUTOR_RESULT_MARKER.length).trim();
    if (!jsonText) {
      continue;
    }

    try {
      const parsed = JSON.parse(jsonText);
      return {
        didEditCode: parsed.didEditCode === true,
        pushedBranch: typeof parsed.pushedBranch === 'string' ? parsed.pushedBranch : '',
        commitHash: typeof parsed.commitHash === 'string' ? parsed.commitHash : '',
        worktreePath: typeof parsed.worktreePath === 'string' ? parsed.worktreePath : '',
        artifactPaths: Array.isArray(parsed.artifactPaths)
          ? parsed.artifactPaths.filter(item => typeof item === 'string' && item.trim().length > 0)
          : []
      };
    } catch {
      return undefined;
    }
  }

  return undefined;
}

async function runShellCommand(command, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env
      },
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => {
      stdout += String(chunk);
    });

    child.stderr.on('data', chunk => {
      stderr += String(chunk);
    });

    child.once('error', reject);
    child.once('close', exitCode => {
      if (exitCode === 0) {
        resolve({ stdout, stderr, exitCode });
        return;
      }

      reject(
        new Error(
          `Command failed with exit code ${exitCode}: ${command}\n${stderr || stdout}`
        )
      );
    });
  });
}

async function listFilesRecursively(rootPath) {
  const entries = await fs.readdir(rootPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursively(fullPath));
      continue;
    }

    if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function wildcardToRegExp(pattern) {
  const normalized = pattern.replaceAll('\\', '/');
  let result = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];
    const next = normalized[index + 1];
    if (current === '*' && next === '*') {
      result += '.*';
      index += 1;
      continue;
    }
    if (current === '*') {
      result += '[^/]*';
      continue;
    }
    if (current === '?') {
      result += '[^/]';
      continue;
    }
    result += escapeRegExp(current);
  }
  result += '$';
  return new RegExp(result, 'i');
}

async function findArtifacts(basePath, artifactPattern) {
  if (!artifactPattern) {
    return [];
  }

  if (!hasWildcard(artifactPattern)) {
    const absolutePath = path.resolve(basePath, artifactPattern);
    try {
      const fileStat = await fs.stat(absolutePath);
      return fileStat.isFile() ? [absolutePath] : [];
    } catch {
      return [];
    }
  }

  const matcher = wildcardToRegExp(artifactPattern);
  const allFiles = await listFilesRecursively(basePath);
  return allFiles.filter(filePath => {
    const relativePath = path.relative(basePath, filePath).replaceAll('\\', '/');
    return matcher.test(relativePath);
  });
}

class StandaloneExecutor {
  constructor(config, options = {}) {
    this.config = config;
    this.logger = options.logger ?? createConsoleLogger();
  }

  async handleMergeRequestNotes(context) {
    if (this.config.Mode !== 'mutable' || !this.config.ExecutorCommand) {
      this.logger.info(
        '[Standalone] Dry-run executor observed %d comment update(s) on !%s for %s.',
        context.newNotes.length + context.updatedNotes.length,
        context.mergeRequest.iid,
        context.issueKey
      );
      return {
        didEditCode: false,
        artifactPaths: []
      };
    }

    const env = {
      STANDALONE_ISSUE_KEY: context.issueKey,
      STANDALONE_MR_IID: String(context.mergeRequest.iid),
      STANDALONE_MR_TITLE: context.mergeRequest.title ?? '',
      STANDALONE_MR_URL: context.mergeRequest.web_url ?? '',
      STANDALONE_MR_SOURCE_BRANCH: context.mergeRequest.source_branch ?? '',
      STANDALONE_COMMENT_JSON: JSON.stringify({
        newNotes: context.newNotes,
        updatedNotes: context.updatedNotes
      })
    };
    const execution = await runShellCommand(this.config.ExecutorCommand, {
      cwd: this.config.RepoPath || process.cwd(),
      env
    });
    return parseExecutorResult(`${execution.stdout}\n${execution.stderr}`) ?? {
      didEditCode: false,
      artifactPaths: []
    };
  }

  async handleMergedMergeRequest(context) {
    if (!context.mergeRequestState.editedAfterMrCreation) {
      this.logger.info(
        '[Standalone] Merge detected for !%s (%s) with no post-MR service edits. MSI generation skipped.',
        context.mergeRequest.iid,
        context.issueKey
      );
      return {
        generatedBuild: false,
        artifactPaths: []
      };
    }

    if (!this.config.PublishCommand) {
      this.logger.info(
        '[Standalone] Merge detected for !%s (%s), but no publish command is configured. MSI generation skipped.',
        context.mergeRequest.iid,
        context.issueKey
      );
      return {
        generatedBuild: false,
        artifactPaths: []
      };
    }

    const workingDirectory = context.mergeRequestState.worktreePath || this.config.RepoPath || process.cwd();
    await runShellCommand(this.config.PublishCommand, {
      cwd: workingDirectory
    });
    const artifactPaths = await findArtifacts(workingDirectory, this.config.ArtifactPattern);
    this.logger.info(
      '[Standalone] Merge-triggered build completed for !%s (%s). Found %d artifact(s).',
      context.mergeRequest.iid,
      context.issueKey,
      artifactPaths.length
    );
    return {
      generatedBuild: artifactPaths.length > 0,
      artifactPaths
    };
  }
}

class StandaloneJiraMrPollingService {
  constructor(config, options = {}) {
    this.config = config;
    this.logger = options.logger ?? createConsoleLogger();
    this.searchIssues = options.searchIssues ?? searchMatchingIssues;
    this.gitLabClient = options.gitLabClient ?? new GitLabClient(config.gitLabConfig);
    this.stateStore = options.stateStore ?? new JsonStateStore(config.standaloneConfig.StateFilePath);
    this.executor = options.executor ?? new StandaloneExecutor(config.standaloneConfig, { logger: this.logger });
    this.onSync = options.onSync;
  }

  async start(options = {}) {
    const once = options.once === true;
    const signal = options.signal;

    this.logger.info(
      '[Standalone] Starting Jira MR polling service for project %s on %s. Polling every %d seconds.',
      this.config.gitLabConfig.Project,
      this.config.gitLabConfig.BaseUrl,
      this.config.standaloneConfig.PollIntervalSeconds
    );

    await this.pollOnce(signal);
    if (once) {
      return;
    }

    while (!signal?.aborted) {
      await delay(this.config.standaloneConfig.PollIntervalSeconds * 1000, undefined, { signal });
      await this.pollOnce(signal);
    }
  }

  async resolveTrackedIssueKeys() {
    if (this.config.standaloneConfig.TrackedIssueKeys.length > 0) {
      return this.config.standaloneConfig.TrackedIssueKeys;
    }

    const issues = await this.searchIssues(this.config.jiraConfig, {
      logger: this.logger
    });
    return issues.map(issue => String(issue.key).trim().toUpperCase()).filter(Boolean);
  }

  async pollOnce(signal) {
    if (signal?.aborted) {
      throw new Error('Polling aborted before request started.');
    }

    const state = await this.stateStore.load();
    const trackedIssueKeys = await this.resolveTrackedIssueKeys();
    const syncEvent = {
      trackedIssueKeys,
      mergeRequestEvents: []
    };

    for (const issueKey of trackedIssueKeys) {
      const mergeRequests = await this.gitLabClient.listMergeRequestsForIssue(issueKey, { state: 'all' });
      this.logger.info('[Standalone] %s currently has %d matching merge request(s).', issueKey, mergeRequests.length);

      for (const mergeRequest of mergeRequests) {
        const mergeRequestKey = buildMergeRequestKey(mergeRequest);
        const discussions = await this.gitLabClient.listMergeRequestDiscussions(mergeRequest.iid);
        const notes = flattenDiscussionNotes(discussions).filter(note => !note.system && note.body.trim().length > 0);
        const mergeRequestState = ensureMergeRequestState(state, issueKey, mergeRequestKey);
        const isBaseline = !mergeRequestState.lastSeenAt;
        const { newNotes, updatedNotes } = diffDiscussionNotes(mergeRequestState.notes, notes, isBaseline);
        const mergedNow = mergeRequest.state === 'merged' && mergeRequestState.state !== 'merged';
        const firstSeen = isBaseline;

        if (firstSeen) {
          this.logger.info(
            '[Standalone] Baseline established for %s -> !%s (%s).',
            issueKey,
            mergeRequest.iid,
            mergeRequest.title ?? '(no title)'
          );
        }

        if (newNotes.length > 0 || updatedNotes.length > 0) {
          this.logger.info(
            '[Standalone] Detected %d new and %d updated comment(s) on !%s for %s.',
            newNotes.length,
            updatedNotes.length,
            mergeRequest.iid,
            issueKey
          );
          for (const note of [...newNotes, ...updatedNotes]) {
            this.logger.info(
              '[Standalone] Comment on !%s by %s: %s',
              mergeRequest.iid,
              note.author,
              truncateForLog(note.body)
            );
          }

          const executorResult = await this.executor.handleMergeRequestNotes({
            issueKey,
            mergeRequest,
            mergeRequestState,
            notes,
            newNotes,
            updatedNotes
          });

          if (executorResult?.didEditCode) {
            mergeRequestState.editedAfterMrCreation = true;
            mergeRequestState.branchName = executorResult.pushedBranch || mergeRequestState.branchName || mergeRequest.source_branch || '';
            mergeRequestState.worktreePath = executorResult.worktreePath || mergeRequestState.worktreePath || '';
            this.logger.info(
              '[Standalone] Service edits were recorded for !%s (%s); merge-triggered MSI generation is now armed.',
              mergeRequest.iid,
              issueKey
            );
          }
        }

        if (mergedNow) {
          const mergeResult = await this.executor.handleMergedMergeRequest({
            issueKey,
            mergeRequest,
            mergeRequestState
          });
          mergeRequestState.buildGeneratedAtMerge = mergeResult.generatedBuild === true;
          mergeRequestState.buildArtifactPaths = Array.isArray(mergeResult.artifactPaths)
            ? mergeResult.artifactPaths
            : [];
          if (mergeResult.generatedBuild === true) {
            mergeRequestState.editedAfterMrCreation = false;
          }
        }

        mergeRequestState.notes = createNoteMap(notes);
        mergeRequestState.state = mergeRequest.state ?? '';
        mergeRequestState.updatedAt = mergeRequest.updated_at ?? '';
        mergeRequestState.lastHeadSha = getMergeRequestHeadSha(mergeRequest);
        mergeRequestState.mergeCommitSha = mergeRequest.merge_commit_sha ?? '';
        mergeRequestState.lastSeenAt = new Date().toISOString();

        syncEvent.mergeRequestEvents.push({
          issueKey,
          mergeRequest,
          newNotes,
          updatedNotes,
          mergedNow,
          firstSeen
        });
      }
    }

    await this.stateStore.save(state);
    await this.onSync?.(syncEvent);
  }
}

module.exports = {
  DEFAULT_STANDALONE_CONFIG,
  EXECUTOR_RESULT_MARKER,
  StandaloneExecutor,
  StandaloneJiraMrPollingService,
  buildMergeRequestKey,
  createStandaloneConfig,
  diffDiscussionNotes,
  findArtifacts,
  loadStandaloneConfig,
  parseExecutorResult,
  runShellCommand,
  wildcardToRegExp
};