const fs = require('node:fs/promises');
const path = require('node:path');

function createEmptyState() {
  return {
    version: 1,
    updatedAt: '',
    issueKeys: {}
  };
}

function ensureIssueState(state, issueKey) {
  if (!state.issueKeys[issueKey]) {
    state.issueKeys[issueKey] = {
      mergeRequests: {}
    };
  }

  return state.issueKeys[issueKey];
}

function ensureMergeRequestState(state, issueKey, mergeRequestKey) {
  const issueState = ensureIssueState(state, issueKey);
  if (!issueState.mergeRequests[mergeRequestKey]) {
    issueState.mergeRequests[mergeRequestKey] = {
      notes: {},
      state: '',
      updatedAt: '',
      lastHeadSha: '',
      mergeCommitSha: '',
      editedAfterMrCreation: false,
      branchName: '',
      worktreePath: '',
      lastSeenAt: '',
      buildGeneratedAtMerge: false,
      buildArtifactPaths: []
    };
  }

  return issueState.mergeRequests[mergeRequestKey];
}

class JsonStateStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.cachedState = undefined;
  }

  async load() {
    if (this.cachedState) {
      return this.cachedState;
    }

    try {
      const rawText = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(rawText);
      this.cachedState = {
        ...createEmptyState(),
        ...parsed,
        issueKeys: parsed?.issueKeys && typeof parsed.issueKeys === 'object' ? parsed.issueKeys : {}
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }

      this.cachedState = createEmptyState();
    }

    return this.cachedState;
  }

  async save(state) {
    const nextState = state ?? await this.load();
    nextState.updatedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(nextState, null, 2), 'utf8');
    await fs.rename(tempPath, this.filePath);
    this.cachedState = nextState;
  }
}

module.exports = {
  JsonStateStore,
  createEmptyState,
  ensureIssueState,
  ensureMergeRequestState
};