import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  Board,
  BoardDetails,
  ConnectionCheck,
  FilterMetadata,
  PagedIssues,
  Project
} from '@praxis/core';
import { RustHostBridge, StdioRustHostTransport } from './rustHostBridge';
import {
  RustTrackerService,
  type RustTrackerConnectionPayload
} from './adapters/rustTrackerService';

function setup(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-tracker-bridge-'));
  const bridge = new RustHostBridge({
    transport: new StdioRustHostTransport({
      userDataDir: dir,
      settingsPath: path.join(dir, 'settings.json')
    })
  });
  t.after(async () => {
    await bridge.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, bridge };
}

test('rustTrackerBridge: stub backend channels parity', async t => {
  const { bridge } = setup(t);
  const conn: RustTrackerConnectionPayload = {
    mode: 'demo'
  };

  const check = await bridge.invoke<ConnectionCheck>('tracker:checkConnection', conn);
  assert.equal(check.status, 'error');
  assert.ok(check.message.includes('Demo mode is disabled'));

  const projects = await bridge.invoke<Project[]>('tracker:getProjects', conn, false);
  assert.deepEqual(projects, []);

  const boards = await bridge.invoke<Board[]>('tracker:getBoards', conn, {});
  assert.deepEqual(boards, []);
});

test('rustTrackerBridge: folder backend channels parity', async t => {
  const { dir, bridge } = setup(t);
  const plansDir = path.join(dir, 'plans');
  fs.mkdirSync(plansDir, { recursive: true });

  const boardConfig = {
    projectKey: 'TEST',
    projectName: 'Test Plans',
    allowIssueCreation: true,
    workflow: [
      { id: 'todo', name: 'Todo', category: 'todo' },
      { id: 'progress', name: 'In Progress', category: 'indeterminate' },
      { id: 'done', name: 'Done', category: 'done' }
    ]
  };
  fs.writeFileSync(path.join(plansDir, 'board.praxis.json'), JSON.stringify(boardConfig, null, 2));

  const planMarkdown = [
    '# TEST-1: First Test Plan',
    '',
    '**Status:** Todo',
    '**Type:** Feature',
    '**Priority:** High',
    '',
    '## Description',
    'This is a sample plan for parity verification.'
  ].join('\n');
  fs.writeFileSync(path.join(plansDir, 'TEST-1.praxis.md'), planMarkdown);

  const conn: RustTrackerConnectionPayload = {
    mode: 'folder',
    folderConfig: {
      folderRoots: [plansDir],
      projectKey: 'TEST',
      projectName: 'Test Plans',
      allowIssueCreation: true,
      defaultPageSize: 25
    }
  };

  const check = await bridge.invoke<ConnectionCheck>('tracker:checkConnection', conn);
  assert.equal(check.status, 'ok');
  assert.ok(check.message.includes('Folder: 1 items'));

  const projects = await bridge.invoke<Project[]>('tracker:getProjects', conn, false);
  assert.equal(projects.length, 1);
  assert.equal(projects[0]?.key, 'TEST');
  assert.equal(projects[0]?.name, 'Test Plans');

  const supportsBoards = await bridge.invoke<boolean>('tracker:supportsBoards', conn);
  assert.equal(supportsBoards, true);

  const boards = await bridge.invoke<Board[]>('tracker:getBoards', conn, {});
  assert.equal(boards.length, 1);
  assert.equal(boards[0]?.projectKey, 'TEST');

  const boardDetails = await bridge.invoke<BoardDetails>('tracker:getBoardDetails', conn, boards[0]);
  assert.equal(boardDetails.columns.length, 3);
  assert.equal(boardDetails.issues.length, 1);
  const issueKey = boardDetails.issues[0]?.key!;
  assert.ok(issueKey.startsWith('TEST-'));

  const pagedIssues = await bridge.invoke<PagedIssues>('tracker:getIssues', conn, {}, 0, 10);
  assert.equal(pagedIssues.total, 1);
  assert.equal(pagedIssues.issues.length, 1);
  assert.equal(pagedIssues.issues[0]?.summary, 'TEST-1: First Test Plan');

  const meta = await bridge.invoke<FilterMetadata>('tracker:getFilterMetadata', conn, {});
  assert.ok(meta.statuses.includes('Todo'));
  assert.ok(meta.issueTypes.includes('Feature'));

  const issue = await bridge.invoke<any>('tracker:getIssue', conn, issueKey);
  assert.equal(issue.key, issueKey);
  assert.equal(issue.summary, 'TEST-1: First Test Plan');
  assert.ok(issue.transitions.length >= 2);
});

test('rustTrackerBridge: github and gitlab board support check', async t => {
  const { bridge } = setup(t);
  const githubConn: RustTrackerConnectionPayload = {
    mode: 'github',
    githubConfig: {
      owner: 'acme',
      repo: 'widgets',
      apiKey: 'test-pat',
      allowIssueCreation: false
    }
  };
  const ghSupports = await bridge.invoke<boolean>('tracker:supportsBoards', githubConn);
  assert.equal(ghSupports, true);

  const gitlabConn: RustTrackerConnectionPayload = {
    mode: 'gitlab',
    gitlabConfig: {
      url: 'https://gitlab.com',
      projectPath: 'acme/widgets',
      apiKey: 'test-token',
      allowIssueCreation: false
    }
  };
  const glSupports = await bridge.invoke<boolean>('tracker:supportsBoards', gitlabConn);
  assert.equal(glSupports, true);
});
