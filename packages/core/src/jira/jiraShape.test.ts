import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  asString,
  buildBoardColumns,
  buildBoardStatusOrder,
  deriveBrowseUrl,
  extractArray,
  extractDescription,
  extractIssueKey,
  isRecord,
  normalizeAttachment,
  normalizeComment,
  normalizeIssue,
  normalizeIssueLink,
  normalizeLinkedIssueReferences,
  normalizeParentIssue,
  normalizeProject,
  normalizeRemoteIssueLink,
  normalizeTransition,
  statusCategoryRank,
  toArray
} from './jiraShape';
import type { IssueSummary } from '../types';

// These functions turn untrusted MCP tool JSON into the shapes the board UI
// reads. The fixtures follow Jira Cloud's own `/rest/api/3/*` response shape
// (and match `apps/praxis-desktop/main/e2e/mockJiraMcpServer.mjs`); they are
// NOT verified against a live Jira Cloud + MCP server — that path is still
// mock-only.

const BASE = 'https://acme.atlassian.net';

/** A realistic search hit: root-level `key`/`id`/`self`, everything else under `fields`. */
function fixtureIssue(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: '10001',
    key: 'DEMO-1',
    self: `${BASE}/rest/api/3/issue/10001`,
    fields: {
      summary: 'Bootstrap the board',
      status: { name: 'In Progress', statusCategory: { name: 'In Progress' } },
      issuetype: { name: 'Story' },
      project: { id: '1', key: 'DEMO', name: 'Demo Project' },
      assignee: { displayName: 'Alex Agent', accountId: 'aid-1' },
      reporter: { displayName: 'Sam Owner', accountId: 'aid-2' },
      priority: { name: 'High' },
      created: '2026-09-01T09:00:00.000Z',
      updated: '2026-09-05T12:30:00.000Z',
      description: 'Wire the board up.',
      ...(overrides.fields as Record<string, unknown> | undefined ?? {})
    },
    ...overrides
  };
}

// ── normalizeIssue ───────────────────────────────────────────────────────────

test('normalizeIssue maps a full Jira search hit onto IssueSummary', () => {
  const issue = normalizeIssue(fixtureIssue(), BASE);
  assert.ok(issue);
  assert.equal(issue.id, '10001');
  assert.equal(issue.key, 'DEMO-1');
  assert.equal(issue.summary, 'Bootstrap the board');
  assert.equal(issue.status, 'In Progress');
  assert.equal(issue.statusCategory, 'In Progress');
  assert.equal(issue.issueType, 'Story');
  assert.equal(issue.projectKey, 'DEMO');
  assert.equal(issue.projectName, 'Demo Project');
  assert.equal(issue.assignee, 'Alex Agent');
  assert.equal(issue.reporter, 'Sam Owner');
  assert.equal(issue.reporterMention, '[~accountid:aid-2]');
  assert.equal(issue.priority, 'High');
  assert.equal(issue.created, '2026-09-01T09:00:00.000Z');
  assert.equal(issue.updated, '2026-09-05T12:30:00.000Z');
  assert.equal(issue.selfUrl, `${BASE}/rest/api/3/issue/10001`);
  assert.equal(issue.browseUrl, `${BASE}/browse/DEMO-1`);
  assert.equal(issue.description, 'Wire the board up.');
});

test('normalizeIssue refuses a hit with no key', () => {
  const noKey = fixtureIssue();
  delete (noKey as Record<string, unknown>).key;
  assert.equal(normalizeIssue(noKey, BASE), undefined);
  assert.equal(normalizeIssue(null, BASE), undefined);
  assert.equal(normalizeIssue('DEMO-1', BASE), undefined);
});

test('normalizeIssue fills defaults for a sparse hit', () => {
  const sparse = normalizeIssue({ key: 'DEMO-9', fields: {} }, BASE);
  assert.ok(sparse);
  assert.equal(sparse.summary, '(No summary)');
  assert.equal(sparse.status, 'Unknown');
  assert.equal(sparse.issueType, 'Issue');
  assert.equal(sparse.projectKey, '');
  assert.equal(sparse.statusCategory, undefined);
  assert.equal(sparse.browseUrl, `${BASE}/browse/DEMO-9`);
});

test('normalizeIssue reads a flat hit that has no fields wrapper', () => {
  const flat = normalizeIssue(
    { key: 'DEMO-2', summary: 'Flat shape', status: { name: 'Done', statusCategory: { name: 'Done' } } },
    BASE
  );
  assert.ok(flat);
  assert.equal(flat.summary, 'Flat shape');
  assert.equal(flat.status, 'Done');
  assert.equal(flat.statusCategory, 'Done');
});

test('normalizeIssue tolerates string-valued status / issuetype (some MCP tools flatten them)', () => {
  const flatEnums = normalizeIssue(
    { key: 'DEMO-3', fields: { summary: 's', status: 'To Do', issuetype: 'Bug' } },
    BASE
  );
  assert.ok(flatEnums);
  assert.equal(flatEnums.status, 'To Do');
  assert.equal(flatEnums.issueType, 'Bug');
});

test('normalizeIssue flattens an ADF description', () => {
  const adf = fixtureIssue({
    fields: {
      description: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'First line.' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Second line.' }] }
        ]
      }
    }
  });
  assert.equal(normalizeIssue(adf, BASE)?.description, 'First line. Second line.');
});

// ── extractDescription ───────────────────────────────────────────────────────

test('extractDescription: strings pass through, ADF trees flatten, junk is undefined', () => {
  assert.equal(extractDescription('plain'), 'plain');
  assert.equal(
    extractDescription({ content: [{ text: 'a' }, { content: [{ text: 'b' }] }] }),
    'a b'
  );
  assert.equal(extractDescription({ text: '  spaced   out  ' }), 'spaced out');
  assert.equal(extractDescription(['x', null, { text: 'y' }]), 'x y');
  assert.equal(extractDescription(undefined), undefined);
  assert.equal(extractDescription(42), undefined);
  assert.equal(extractDescription({ text: '   ' }), undefined);
});

// ── normalizeComment ─────────────────────────────────────────────────────────

test('normalizeComment maps author, body, timestamps; drops an empty body', () => {
  const comment = normalizeComment({
    id: '5',
    author: { displayName: 'Alex Agent' },
    body: 'Looks good.',
    created: '2026-09-04T00:00:00.000Z',
    updated: '2026-09-04T01:00:00.000Z'
  });
  assert.deepEqual(comment, {
    id: '5',
    author: 'Alex Agent',
    body: 'Looks good.',
    created: '2026-09-04T00:00:00.000Z',
    updated: '2026-09-04T01:00:00.000Z',
    raw: {
      id: '5',
      author: { displayName: 'Alex Agent' },
      body: 'Looks good.',
      created: '2026-09-04T00:00:00.000Z',
      updated: '2026-09-04T01:00:00.000Z'
    }
  });
  assert.equal(normalizeComment({ id: '6', body: '   ' }), undefined);
  assert.equal(normalizeComment({ id: '7' }), undefined);
});

test('normalizeComment flattens an ADF body', () => {
  const comment = normalizeComment({
    id: '8',
    author: { name: 'jsmith' },
    body: { content: [{ content: [{ text: 'From' }, { text: 'ADF' }] }] }
  });
  assert.equal(comment?.author, 'jsmith');
  assert.equal(comment?.body, 'From ADF');
});

// ── normalizeTransition ──────────────────────────────────────────────────────

test('normalizeTransition needs an id and a name, and reads toStatus from `to.name`', () => {
  assert.deepEqual(
    normalizeTransition({ id: '31', name: 'Start progress', to: { name: 'In Progress' } }),
    { id: '31', name: 'Start progress', toStatus: 'In Progress', raw: { id: '31', name: 'Start progress', to: { name: 'In Progress' } } }
  );
  assert.equal(normalizeTransition({ id: '31' }), undefined);
  assert.equal(normalizeTransition({ name: 'Start progress' }), undefined);
  assert.equal(normalizeTransition(normalizeTransition({ id: '9', name: 'X' })?.toStatus), undefined);
});

// ── normalizeParentIssue ─────────────────────────────────────────────────────

test('normalizeParentIssue: key required; reads summary / issuetype from fields or root', () => {
  assert.deepEqual(
    normalizeParentIssue({ key: 'DEMO-1', fields: { summary: 'Epic', issuetype: { name: 'Epic' } } }),
    { key: 'DEMO-1', summary: 'Epic', issueType: 'Epic', description: undefined }
  );
  assert.equal(
    normalizeParentIssue({ key: 'DEMO-1', summary: 'Flat parent', issuetype: 'Task' })?.issueType,
    'Task'
  );
  assert.equal(normalizeParentIssue({ fields: { summary: 'no key' } }), undefined);
});

// ── normalizeProject ─────────────────────────────────────────────────────────

test('normalizeProject: name falls back to key; missing key is rejected', () => {
  assert.deepEqual(normalizeProject({ id: '1', key: 'DEMO', name: 'Demo Project' }), {
    id: '1',
    key: 'DEMO',
    name: 'Demo Project'
  });
  assert.equal(normalizeProject({ key: 'DEMO' })?.name, 'DEMO');
  assert.equal(normalizeProject({ name: 'No Key' }), undefined);
});

// ── normalizeAttachment ──────────────────────────────────────────────────────

test('normalizeAttachment accepts filename or fileName, coerces a string size, needs a name', () => {
  const att = normalizeAttachment({
    id: '90',
    filename: 'diagram.png',
    mimeType: 'image/png',
    size: '20480',
    content: `${BASE}/secure/attachment/90/diagram.png`,
    author: { displayName: 'Alex Agent' },
    created: '2026-09-02T00:00:00.000Z'
  });
  assert.equal(att?.fileName, 'diagram.png');
  assert.equal(att?.sizeBytes, 20480);
  assert.equal(att?.contentUrl, `${BASE}/secure/attachment/90/diagram.png`);
  assert.equal(normalizeAttachment({ fileName: 'a.txt' })?.fileName, 'a.txt');
  assert.equal(normalizeAttachment({ id: '91', size: 10 }), undefined);
  assert.equal(normalizeAttachment({ filename: 'x', size: 'not-a-number' })?.sizeBytes, undefined);
});

// ── normalizeIssueLink / remote / merge ──────────────────────────────────────

test('normalizeIssueLink uses the outward/inward phrasing and the linked issue key', () => {
  const outward = normalizeIssueLink(
    {
      type: { name: 'Blocks', outward: 'blocks', inward: 'is blocked by' },
      outwardIssue: { key: 'DEMO-2', fields: { summary: 'Downstream', status: { name: 'To Do' }, issuetype: { name: 'Task' } } }
    },
    BASE
  );
  assert.equal(outward?.key, 'DEMO-2');
  assert.equal(outward?.relationship, 'blocks');
  assert.equal(outward?.status, 'To Do');
  assert.equal(outward?.browseUrl, `${BASE}/browse/DEMO-2`);

  const inward = normalizeIssueLink(
    { type: { name: 'Blocks', outward: 'blocks', inward: 'is blocked by' }, inwardIssue: { key: 'DEMO-3' } },
    BASE
  );
  assert.equal(inward?.relationship, 'is blocked by');

  assert.equal(normalizeIssueLink({ type: { name: 'Blocks' } }, BASE), undefined);
  assert.equal(normalizeIssueLink({ outwardIssue: { fields: {} } }, BASE), undefined);
});

test('normalizeRemoteIssueLink derives a key from a title that carries an issue key', () => {
  const link = normalizeRemoteIssueLink({
    relationship: 'relates to',
    object: { url: 'https://example.com/ABC-42', title: 'ABC-42: upstream bug', status: { resolved: false, title: 'Open' } }
  });
  assert.equal(link?.key, 'ABC-42');
  assert.equal(link?.relationship, 'relates to');
  assert.equal(link?.browseUrl, 'https://example.com/ABC-42');
  assert.equal(link?.status, 'Open');

  const bare = normalizeRemoteIssueLink({ object: { url: 'https://example.com/page' } });
  assert.equal(bare?.key, 'page');
  assert.equal(bare?.relationship, 'Remote link');
  assert.equal(normalizeRemoteIssueLink({ object: {} }), undefined);
});

test('normalizeLinkedIssueReferences merges classic + remote links and dedupes', () => {
  const merged = normalizeLinkedIssueReferences(
    {
      issuelinks: [
        { type: { name: 'Blocks', outward: 'blocks' }, outwardIssue: { key: 'DEMO-2' } },
        { type: { name: 'Blocks', outward: 'blocks' }, outwardIssue: { key: 'DEMO-2' } } // dup
      ]
    },
    [{ relationship: 'blocks', object: { url: `${BASE}/browse/DEMO-2`, title: 'DEMO-2' } }], // same key+rel+url as classic
    BASE
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].key, 'DEMO-2');
});

// ── extractArray / extractIssueKey ───────────────────────────────────────────

test('extractArray unwraps the common MCP payload shapes', () => {
  assert.deepEqual(extractArray([1, 2], ['issues']), [1, 2]);
  assert.deepEqual(extractArray({ issues: [3], total: 1 }, ['issues']), [3]);
  assert.deepEqual(extractArray({ values: [4] }, ['issues']), [4]);
  assert.deepEqual(extractArray({ nothing: true }, ['issues']), []);
  assert.deepEqual(extractArray(null, ['issues']), []);
});

test('extractIssueKey prefers key, falls back to id', () => {
  assert.equal(extractIssueKey({ key: 'DEMO-1', id: '10001' }), 'DEMO-1');
  assert.equal(extractIssueKey({ id: '10001' }), '10001');
  assert.equal(extractIssueKey('DEMO-1'), undefined);
});

// ── statusCategoryRank ───────────────────────────────────────────────────────

test('statusCategoryRank maps every Jira category spelling, unknowns last', () => {
  assert.equal(statusCategoryRank('To Do'), 0);
  assert.equal(statusCategoryRank('todo'), 0);
  assert.equal(statusCategoryRank('In Progress'), 1);
  assert.equal(statusCategoryRank('indeterminate'), 1);
  assert.equal(statusCategoryRank('Done'), 2);
  assert.equal(statusCategoryRank('Backlog'), 3);
  assert.equal(statusCategoryRank(undefined), 3);
});

// ── buildBoardStatusOrder ────────────────────────────────────────────────────

test('buildBoardStatusOrder: configured board order wins verbatim', () => {
  assert.deepEqual(
    buildBoardStatusOrder(['A', 'B'], ['In Progress'], ['Done']),
    ['A', 'B']
  );
});

test('buildBoardStatusOrder: no configured order — Backlog first, then workflow, then leftover issue statuses, deduped', () => {
  assert.deepEqual(
    buildBoardStatusOrder(
      [],
      ['To Do', 'In Progress', 'Backlog', 'Done'],
      ['Done', 'On Hold', 'To Do']
    ),
    ['Backlog', 'To Do', 'In Progress', 'Done', 'On Hold']
  );
});

// ── buildBoardColumns ────────────────────────────────────────────────────────

function issue(key: string, status: string, statusCategory: string, updated: string): IssueSummary {
  return {
    key,
    summary: key,
    status,
    statusCategory,
    issueType: 'Task',
    projectKey: 'DEMO',
    updated,
    browseUrl: `${BASE}/browse/${key}`
  };
}

test('buildBoardColumns with a canonical order keeps every column, even the empty ones', () => {
  const columns = buildBoardColumns(
    [issue('DEMO-1', 'In Progress', 'In Progress', '2026-09-05T00:00:00Z')],
    ['Backlog', 'To Do', 'In Progress', 'Done']
  );
  assert.deepEqual(columns.map(c => c.name), ['Backlog', 'To Do', 'In Progress', 'Done']);
  assert.equal(columns.find(c => c.name === 'In Progress')?.issues.length, 1);
  assert.equal(columns.find(c => c.name === 'Backlog')?.issues.length, 0);
});

test('buildBoardColumns without an order falls back to rank-sorted columns from the issues present', () => {
  const columns = buildBoardColumns([
    issue('DEMO-1', 'Done', 'Done', '2026-09-01T00:00:00Z'),
    issue('DEMO-2', 'To Do', 'To Do', '2026-09-02T00:00:00Z'),
    issue('DEMO-3', 'In Progress', 'In Progress', '2026-09-03T00:00:00Z')
  ]);
  assert.deepEqual(columns.map(c => c.name), ['To Do', 'In Progress', 'Done']);
});

// ── primitives ───────────────────────────────────────────────────────────────

test('asString stringifies scalars and rejects the rest', () => {
  assert.equal(asString('x'), 'x');
  assert.equal(asString(3), '3');
  assert.equal(asString(false), 'false');
  assert.equal(asString(null), undefined);
  assert.equal(asString({}), undefined);
  assert.equal(asString(undefined), undefined);
});

test('deriveBrowseUrl trims exactly one trailing slash', () => {
  assert.equal(deriveBrowseUrl('https://acme.atlassian.net/', 'DEMO-1'), 'https://acme.atlassian.net/browse/DEMO-1');
  assert.equal(deriveBrowseUrl('https://acme.atlassian.net', 'DEMO-1'), 'https://acme.atlassian.net/browse/DEMO-1');
});

test('isRecord / toArray guard the shape', () => {
  assert.equal(isRecord({}), true);
  assert.equal(isRecord([]), true);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord('x'), false);
  assert.deepEqual(toArray([1]), [1]);
  assert.deepEqual(toArray('nope'), []);
  assert.deepEqual(toArray(undefined), []);
});
