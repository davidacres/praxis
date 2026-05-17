const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseArgs } = require('./standalone-cli');
const {
  flattenDiscussionNotes,
  mergeRequestMatchesIssueKey,
  parseGitLabRemoteUrl
} = require('./gitlab');
const {
  StandaloneJiraMrPollingService,
  diffDiscussionNotes,
  loadStandaloneConfig,
  parseExecutorResult,
  wildcardToRegExp
} = require('./standalone');

function createBufferingLogger() {
  const entries = [];
  return {
    entries,
    info(message, ...args) {
      entries.push(require('node:util').format(message, ...args));
    },
    error(message, ...args) {
      entries.push(require('node:util').format(message, ...args));
    }
  };
}

test('parseArgs captures standalone overrides for local MR polling', () => {
  const args = parseArgs([
    '--config',
    '.\\standalone-appsettings.json',
    '--issue-key',
    'KAMAI-45',
    '--repo-path',
    'C:\\dev\\system-configurator',
    '--poll-interval',
    '5',
    '--once'
  ]);

  assert.equal(args.once, true);
  assert.equal(args.overrides.RepoPath, path.resolve('C:\\dev\\system-configurator'));
  assert.equal(args.overrides.PollIntervalSeconds, 5);
  assert.deepEqual(args.overrides.TrackedIssueKeys, ['KAMAI-45']);
});

test('parseGitLabRemoteUrl handles SSH remotes', () => {
  assert.deepEqual(
    parseGitLabRemoteUrl('git@git.example.com:example/software/ai/system-configurator.git'),
    {
      baseUrl: 'https://git.example.com',
      project: 'example/software/ai/system-configurator'
    }
  );
});

test('mergeRequestMatchesIssueKey checks title, description, and source branch', () => {
  assert.equal(
    mergeRequestMatchesIssueKey(
      {
        title: 'Standalone smoke test',
        description: 'Implements KAMAI-999991 for verification',
        source_branch: 'feature/no-match'
      },
      'KAMAI-999991'
    ),
    true
  );

  assert.equal(
    mergeRequestMatchesIssueKey(
      {
        title: 'Standalone smoke test',
        description: '',
        source_branch: 'feature/no-match'
      },
      'KAMAI-999991'
    ),
    false
  );
});

test('flattenDiscussionNotes returns a sorted flat note list', () => {
  const notes = flattenDiscussionNotes([
    {
      id: 'd2',
      notes: [
        { id: 22, body: 'Later', created_at: '2026-04-15T10:00:01Z', updated_at: '2026-04-15T10:00:01Z', author: { username: 'two' } }
      ]
    },
    {
      id: 'd1',
      notes: [
        { id: 21, body: 'Earlier', created_at: '2026-04-15T10:00:00Z', updated_at: '2026-04-15T10:00:00Z', author: { username: 'one' } }
      ]
    }
  ]);

  assert.deepEqual(notes.map(note => note.id), ['21', '22']);
});

test('diffDiscussionNotes suppresses baseline comments and detects later additions', () => {
  const initialNotes = [
    { id: '1', updatedAt: '2026-04-15T10:00:00Z' }
  ];

  assert.deepEqual(diffDiscussionNotes({}, initialNotes, true), {
    newNotes: [],
    updatedNotes: []
  });

  const laterNotes = [
    { id: '1', updatedAt: '2026-04-15T10:00:00Z' },
    { id: '2', updatedAt: '2026-04-15T10:01:00Z' }
  ];

  const diff = diffDiscussionNotes({ 1: '2026-04-15T10:00:00Z' }, laterNotes, false);
  assert.equal(diff.newNotes.length, 1);
  assert.equal(diff.newNotes[0].id, '2');
});

test('parseExecutorResult reads the last standalone marker line', () => {
  const result = parseExecutorResult([
    'some output',
    'STANDALONE_EXECUTOR_RESULT {"didEditCode":true,"pushedBranch":"feature/test","commitHash":"abc123","worktreePath":"C:/wt"}'
  ].join('\n'));

  assert.deepEqual(result, {
    didEditCode: true,
    pushedBranch: 'feature/test',
    commitHash: 'abc123',
    worktreePath: 'C:/wt',
    artifactPaths: []
  });
});

test('wildcardToRegExp handles MSI-style artifact patterns', () => {
  const matcher = wildcardToRegExp('publish/**/*.msi');
  assert.equal(matcher.test('publish/output/SystemConfigurator.msi'), true);
  assert.equal(matcher.test('publish/output/SystemConfigurator.zip'), false);
});

test('loadStandaloneConfig infers defaults and supports static tracked issue keys without Jira validation', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-poller-'));
  const configPath = path.join(tempDir, 'standalone-appsettings.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      StandaloneJiraMrPolling: {
        PollIntervalSeconds: 5,
        GitLabUrl: 'https://gitlab.example.com',
        GitLabProject: 'team/project',
        TrackedIssueKeys: ['KAMAI-123']
      }
    })
  );

  try {
    const config = await loadStandaloneConfig(configPath, {});
    assert.equal(config.standaloneConfig.TrackedIssueKeys[0], 'KAMAI-123');
    assert.equal(config.jiraConfig, undefined);
    assert.equal(config.gitLabConfig.Project, 'team/project');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('StandaloneJiraMrPollingService detects a new comment on a later poll', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standalone-poller-state-'));
  const statePath = path.join(tempDir, 'state.json');
  const logger = createBufferingLogger();

  const mergeRequest = {
    project_id: 123,
    iid: 7,
    title: 'KAMAI-45 standalone smoke test',
    description: 'Dummy MR',
    source_branch: 'feature/kamai-45-smoke',
    state: 'opened',
    updated_at: '2026-04-15T10:00:00Z',
    sha: 'head-sha-1'
  };

  const discussionsByPoll = [
    [
      {
        id: 'd1',
        notes: [
          { id: 1, body: 'Initial body', created_at: '2026-04-15T10:00:00Z', updated_at: '2026-04-15T10:00:00Z', author: { username: 'alice' }, system: false }
        ]
      }
    ],
    [
      {
        id: 'd1',
        notes: [
          { id: 1, body: 'Initial body', created_at: '2026-04-15T10:00:00Z', updated_at: '2026-04-15T10:00:00Z', author: { username: 'alice' }, system: false },
          { id: 2, body: 'Please update the installer smoke test.', created_at: '2026-04-15T10:02:00Z', updated_at: '2026-04-15T10:02:00Z', author: { username: 'bob' }, system: false }
        ]
      }
    ]
  ];

  let pollIndex = 0;
  const service = new StandaloneJiraMrPollingService(
    {
      standaloneConfig: {
        PollIntervalSeconds: 5,
        StateFilePath: statePath,
        Mode: 'dry-run',
        RepoPath: tempDir,
        TrackedIssueKeys: ['KAMAI-45']
      },
      gitLabConfig: {
        BaseUrl: 'https://gitlab.example.com',
        Project: 'team/project',
        Token: 'token',
        MaxResults: 100
      }
    },
    {
      logger,
      gitLabClient: {
        async listMergeRequestsForIssue() {
          return [mergeRequest];
        },
        async listMergeRequestDiscussions() {
          const response = discussionsByPoll[Math.min(pollIndex, discussionsByPoll.length - 1)];
          pollIndex += 1;
          return response;
        }
      },
      executor: {
        async handleMergeRequestNotes() {
          return { didEditCode: false, artifactPaths: [] };
        },
        async handleMergedMergeRequest() {
          return { generatedBuild: false, artifactPaths: [] };
        }
      }
    }
  );

  try {
    await service.pollOnce();
    await service.pollOnce();
    assert.equal(
      logger.entries.some(entry => entry.includes('Detected 1 new and 0 updated comment(s) on !7 for KAMAI-45.')),
      true
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});