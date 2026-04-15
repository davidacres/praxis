const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { parseArgs } = require('./cli');

const {
  JiraPollingService,
  buildJql,
  createPollingConfig,
  issueMatchesFilter,
  loadPollingConfig,
  resolveCandidateIps,
  searchMatchingIssues
} = require('./polling');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createBufferingLogger() {
  const entries = [];
  return {
    entries,
    info(message, ...args) {
      entries.push({ level: 'info', message: formatMessage(message, args) });
    },
    error(message, ...args) {
      entries.push({ level: 'error', message: formatMessage(message, args) });
    }
  };
}

function formatMessage(message, args) {
  return args.length === 0 ? String(message) : require('node:util').format(message, ...args);
}

test('parseArgs collects standalone config overrides for isolated runs', () => {
  const args = parseArgs([
    '--config',
    String.raw`.\custom-appsettings.json`,
    '--linked-epic',
    'KAMAI-123',
    '--required-label',
    'needs-ai',
    '--required-status',
    'Ready for Development',
    '--once'
  ]);

  assert.equal(args.once, true);
  assert.equal(args.configPath, path.resolve(String.raw`.\custom-appsettings.json`));
  assert.deepEqual(args.overrides, {
    LinkedEpicKey: 'KAMAI-123',
    RequiredLabel: 'needs-ai',
    RequiredStatus: 'Ready for Development'
  });
});

test('issueMatchesFilter requires an exact status-name match for AI eligibility', () => {
  const config = createPollingConfig({
    RequiredLabel: 'syscfg',
    RequiredStatus: 'To Do'
  });

  assert.equal(
    issueMatchesFilter(
      {
        fields: {
          status: {
            name: 'Selected for Development',
            statusCategory: { name: 'To Do' }
          },
          labels: ['syscfg']
        }
      },
      config
    ),
    false
  );
});

test('issueMatchesFilter accepts the exact configured status name', () => {
  const config = createPollingConfig({
    RequiredLabel: 'syscfg',
    RequiredStatus: 'Selected for Development'
  });

  assert.equal(
    issueMatchesFilter(
      {
        fields: {
          status: {
            name: 'Selected for Development',
            statusCategory: { name: 'To Do' }
          },
          labels: ['syscfg']
        }
      },
      config
    ),
    true
  );
});

test('buildJql preserves escaping rules from the .NET worker', () => {
  const config = createPollingConfig({
    LinkedEpicKey: 'KA"MAI-123',
    RequiredLabel: String.raw`sys\cfg`,
    RequiredStatus: 'To Do'
  });

  assert.equal(
    buildJql(config),
    String.raw`(parent = "KA\"MAI-123" OR "Epic Link" = "KA\"MAI-123") ORDER BY updated DESC`
  );
});

test('loadPollingConfig applies runtime overrides before validation', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-polling-'));
  const configPath = path.join(tempDir, 'appsettings.json');

  try {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        JiraPolling: {
          BaseUrl: 'https://jira.assaabloy.net',
          InternalDns: 'internal.example.local',
          ProjectKey: 'KAMAI',
          LinkedEpicKey: '',
          RequiredLabel: 'syscfg',
          RequiredStatus: 'To Do',
          PollIntervalSeconds: 30,
          MaxResults: 50
        }
      })
    );

    const config = loadPollingConfig(configPath, {
      LinkedEpicKey: 'KAMAI-123',
      RequiredLabel: 'override-label'
    });

    assert.equal(config.LinkedEpicKey, 'KAMAI-123');
    assert.equal(config.RequiredLabel, 'override-label');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('resolveCandidateIps keeps the preferred IP first and filters resolved addresses to private 10.x IPv4', async () => {
  const config = createPollingConfig({
    PreferredResolveIp: '127.0.0.1',
    InternalDns: 'internal.example.local'
  });

  const candidateIps = await resolveCandidateIps(config, {
    resolveAddresses: async hostname => {
      assert.equal(hostname, 'internal.example.local');
      return ['10.1.2.3', '192.168.1.5', '10.1.2.3', '10.4.5.6'];
    }
  });

  assert.deepEqual(candidateIps, ['127.0.0.1', '10.1.2.3', '10.4.5.6']);
});

test('searchMatchingIssues posts linked-epic JQL and returns all synced issues sorted by key', async () => {
  const capturedRequests = [];
  const server = http.createServer((request, response) => {
    let requestBody = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      requestBody += chunk;
    });
    request.on('end', () => {
      capturedRequests.push({
        method: request.method,
        url: request.url,
        host: request.headers.host,
        authorization: request.headers.authorization,
        body: JSON.parse(requestBody)
      });

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          total: 3,
          issues: [
            {
              id: '2',
              key: 'kamai-20',
              fields: {
                summary: 'Should match second after sorting',
                status: { name: 'To Do' },
                labels: ['syscfg'],
                updated: '2026-04-13T00:00:00Z'
              }
            },
            {
              id: '3',
              key: 'KAMAI-10',
              fields: {
                summary: 'Should match first after sorting',
                status: { name: 'To Do' },
                labels: ['SYSCFG'],
                updated: '2026-04-13T00:00:00Z'
              }
            },
            {
              id: '4',
              key: 'KAMAI-30',
              fields: {
                summary: 'Wrong status',
                status: { name: 'Done' },
                labels: ['syscfg'],
                updated: '2026-04-13T00:00:00Z'
              }
            }
          ]
        })
      );
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    const config = createPollingConfig({
      BaseUrl: `http://jira.assaabloy.net:${port}`,
      InternalDns: 'internal.example.local',
      PreferredResolveIp: '127.0.0.1',
      LinkedEpicKey: 'KAMAI-123',
      Token: 'test-token'
    });

    const issues = await searchMatchingIssues(config, {
      resolveAddresses: async () => []
    });

    assert.equal(capturedRequests.length, 1);
    assert.deepEqual(capturedRequests[0], {
      method: 'POST',
      url: '/rest/api/2/search',
      host: `jira.assaabloy.net:${port}`,
      authorization: `Bearer ${process.env.JIRA_TOKEN ?? 'test-token'}`,
      body: {
        jql: '(parent = "KAMAI-123" OR "Epic Link" = "KAMAI-123") ORDER BY updated DESC',
        startAt: 0,
        maxResults: 50,
        fields: ['summary', 'status', 'labels', 'updated']
      }
    });

    assert.deepEqual(
      issues.map(issue => issue.key),
      ['KAMAI-10', 'kamai-20', 'KAMAI-30']
    );
  } finally {
    await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
});

test('searchMatchingIssues reports a clear error when Jira returns HTML instead of JSON', async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!DOCTYPE html><html><body><!-- Copyright --><h1>Login</h1></body></html>');
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

  try {
    const { port } = server.address();
    const config = createPollingConfig({
      BaseUrl: `http://jira.assaabloy.net:${port}`,
      InternalDns: 'internal.example.local',
      PreferredResolveIp: '127.0.0.1',
      LinkedEpicKey: 'KAMAI-123',
      Token: 'test-token'
    });

    await assert.rejects(
      () => searchMatchingIssues(config, { resolveAddresses: async () => [] }),
      /Jira search returned non-JSON content \(text\/html\).*Copyright/i
    );
  } finally {
    await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
});

test('JiraPollingService tracks new, removed, changed, and AI-eligible issues across polls', async () => {
  const logger = createBufferingLogger();
  const syncEvents = [];
  const config = createPollingConfig({
    Token: 'test-token',
    LinkedEpicKey: 'KAMAI-123',
    RequiredLabel: 'syscfg',
    RequiredStatus: 'To Do'
  });
  const responses = [
    [
      {
        key: 'KAMAI-10',
        fields: {
          summary: 'First',
          status: { name: 'To Do', statusCategory: { name: 'To Do' } },
          labels: ['syscfg'],
          updated: '2026-04-13'
        }
      },
      {
        key: 'KAMAI-20',
        fields: {
          summary: 'Second',
          status: { name: 'Selected for Development', statusCategory: { name: 'To Do' } },
          labels: [],
          updated: '2026-04-13'
        }
      }
    ],
    [
      {
        key: 'KAMAI-20',
        fields: {
          summary: 'Second updated',
          status: { name: 'Selected for Development', statusCategory: { name: 'To Do' } },
          labels: ['syscfg'],
          updated: '2026-04-14'
        }
      },
      {
        key: 'KAMAI-30',
        fields: {
          summary: 'Third',
          status: { name: 'Done' },
          labels: ['syscfg'],
          updated: '2026-04-13'
        }
      }
    ]
  ];

  const service = new JiraPollingService(config, {
    logger,
    searchIssues: async () => responses.shift() ?? [],
    onSync: async event => {
      syncEvents.push(event);
    }
  });

  await service.pollOnce();
  await service.pollOnce();

  assert(logger.entries.some(entry => entry.message.includes('New matching issue detected: KAMAI-10')));
  assert(logger.entries.some(entry => entry.message.includes('New matching issue detected: KAMAI-20')));
  assert(logger.entries.some(entry => entry.message.includes('New matching issue detected: KAMAI-30')));
  assert(logger.entries.some(entry => entry.message.includes('Issue no longer matches filter: KAMAI-10')));
  assert(logger.entries.some(entry => entry.message.includes('Issue changed on linked epic: KAMAI-20')));
  assert(logger.entries.some(entry => entry.message.includes('Eligible for AI execution: KAMAI-10')));
  assert.equal(
    logger.entries.some(entry => entry.message.includes('Eligible for AI execution: KAMAI-20')),
    false
  );
  assert.deepEqual(syncEvents[0]?.eligibleIssueKeys, ['KAMAI-10']);
  assert.deepEqual(syncEvents[1]?.eligibleIssueKeys, []);
  assert.deepEqual(syncEvents[1]?.changedKeys, ['KAMAI-20']);
});