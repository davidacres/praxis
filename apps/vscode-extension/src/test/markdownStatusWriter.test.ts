import * as assert from 'assert';
import * as vscode from 'vscode';
import {
  writeStatusToMarkdownFile,
  writeDescriptionToMarkdownFile,
  writePriorityToMarkdownFile,
  upgradeMarkdownFile,
  planStatusToMarkdown,
  extractStatusRaw,
  mapMarkdownStatusToPlanStatus,
  extractPriorityRaw,
  extractSeverityRaw,
  extractReportedByRaw,
  setLiveFolderFs
} from '@praxis/core';
import { vsCodeLiveFolderFs } from '../adapters/vsCodeLiveFolderFs';

async function writeTextFile(uri: vscode.Uri, contents: string): Promise<void> {
  const parentUri = vscode.Uri.joinPath(uri, '..');
  await vscode.workspace.fs.createDirectory(parentUri);
  await vscode.workspace.fs.writeFile(uri, Buffer.from(contents, 'utf8'));
}

async function readTextFile(filePath: string): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(filePath));
  return new TextDecoder('utf-8').decode(bytes);
}

function tmpUri(name: string): vscode.Uri {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error('Workspace folder required');
  }
  const unique = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return vscode.Uri.joinPath(
    workspaceFolder.uri,
    '.praxis-test',
    `status-${unique}`,
    `${name}.md`
  );
}

suite('markdownStatusWriter', () => {
  const createdFiles: vscode.Uri[] = [];

  suiteSetup(() => setLiveFolderFs(vsCodeLiveFolderFs));
  suiteTeardown(() => setLiveFolderFs(undefined));

  async function createFile(name: string, content: string): Promise<string> {
    const uri = tmpUri(name);
    await writeTextFile(uri, content);
    createdFiles.push(uri);
    return uri.fsPath;
  }

  teardown(async () => {
    for (const uri of createdFiles) {
      try {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(uri, '..'), { recursive: true });
      } catch {
        // Ignore cleanup failures so one test does not hide the next failure.
      }
    }
    createdFiles.length = 0;
  });

  test('planStatusToMarkdown round-trips through mapMarkdownStatusToPlanStatus', () => {
    const statuses = ['Backlog', 'To Do', 'In Progress', 'Blocked', 'Done'];
    for (const status of statuses) {
      const markdownStatus = planStatusToMarkdown(status);
      const roundTripped = mapMarkdownStatusToPlanStatus(markdownStatus);
      assert.strictEqual(roundTripped, status);
    }
  });

  test('writeStatusToMarkdownFile transitions Backlog to In Progress', async () => {
    const uri = await createFile(
      'backlog-to-inprogress',
      [
        '# Test Story',
        '',
        '**Status:** 📋 Proposed',
        '**Created:** 2026-01-01T00:00:00.000Z',
        '**Type:** Story',
        '',
        '## Summary',
        'Test story.',
        ''
      ].join('\n')
    );

    const wrote = await writeStatusToMarkdownFile(uri, 'In Progress');
    assert.strictEqual(wrote, true);

    const after = await readTextFile(uri);
    assert.ok(after.includes('**Status:** 🔄 In Progress'));
  });

  test('writeStatusToMarkdownFile transitions In Progress to Done', async () => {
    const uri = await createFile(
      'inprogress-to-done',
      [
        '# Test Story',
        '',
        '**Status:** 🔄 In Progress',
        '**Created:** 2026-01-01T00:00:00.000Z',
        '**Type:** Story',
        '',
        '## Summary',
        'Test story.',
        ''
      ].join('\n')
    );

    const wrote = await writeStatusToMarkdownFile(uri, 'Done');
    assert.strictEqual(wrote, true);

    const after = await readTextFile(uri);
    assert.ok(after.includes('**Status:** ✅ Complete'));
  });

  test('writeStatusToMarkdownFile inserts Status line if missing', async () => {
    const uri = await createFile(
      'no-status-line',
      [
        '# BUG-099 - Legacy bug without Status',
        '',
        '**Rule:** csharpsquid:S107',
        '**File:** src/Foo.cs',
        '',
        '## Context',
        'Some context.',
        ''
      ].join('\n')
    );

    const wrote = await writeStatusToMarkdownFile(uri, 'In Progress');
    assert.strictEqual(wrote, true);

    const after = await readTextFile(uri);
    assert.ok(after.includes('**Status:** 🔄 In Progress'));
    assert.ok(after.includes('**Rule:**'));
    assert.ok(after.includes('Some context.'));
  });

  test('writeStatusToMarkdownFile handles CRLF line endings', async () => {
    const uri = await createFile(
      'crlf',
      [
        '# Test Story',
        '',
        '**Status:** 📋 Proposed',
        '**Created:** 2026-01-01T00:00:00.000Z',
        '**Type:** Story',
        '',
        '## Summary',
        'Test story.',
        ''
      ].join('\r\n')
    );

    const wrote = await writeStatusToMarkdownFile(uri, 'In Progress');
    assert.strictEqual(wrote, true);

    const after = await readTextFile(uri);
    assert.ok(after.includes('**Status:** 🔄 In Progress'));
  });

  test('extractStatusRaw and mapMarkdownStatusToPlanStatus understand supported statuses', () => {
    const cases: [string, string][] = [
      ['**Status:** 📋 Proposed', 'Backlog'],
      ['**Status:** 📋 To Do', 'To Do'],
      ['**Status:** 🔄 In Progress', 'In Progress'],
      ['**Status:** ⛔ Blocked', 'Blocked'],
      ['**Status:** ✅ Complete', 'Done'],
      ['**Status:** Backlog', 'Backlog'],
      ['**Status:** To Do', 'To Do'],
      ['**Status:** In Progress', 'In Progress'],
      ['**Status:** Blocked', 'Blocked'],
      ['**Status:** Done', 'Done']
    ];

    for (const [line, expected] of cases) {
      const raw = extractStatusRaw(line);
      const plan = mapMarkdownStatusToPlanStatus(raw);
      assert.strictEqual(plan, expected);
    }
  });

  test('bug front matter extractors parse priority, severity, and reported by', () => {
    const bugContent = [
      '# Login fails on mobile',
      '',
      '**Status:** 📋 Proposed',
      '**Created:** 2026-04-18T08:00:00.000Z',
      '**Type:** Bug',
      '**Priority:** High',
      '**Severity:** Critical',
      '**Reported By:** Jane Smith',
      '**Parent:** PROJ-F01',
      '',
      '## Summary',
      'Login button does not respond on mobile Safari.',
      ''
    ].join('\n');

    assert.strictEqual(extractPriorityRaw(bugContent), 'High');
    assert.strictEqual(extractSeverityRaw(bugContent), 'Critical');
    assert.strictEqual(extractReportedByRaw(bugContent), 'Jane Smith');
  });

  test('bug front matter extractors return undefined when fields are absent', () => {
    const storyContent = [
      '# A regular story',
      '',
      '**Status:** 📋 Proposed',
      '**Created:** 2026-04-18T08:00:00.000Z',
      '**Type:** Story',
      '',
      '## Summary',
      'A story without bug fields.',
      ''
    ].join('\n');

    assert.strictEqual(extractPriorityRaw(storyContent), undefined);
    assert.strictEqual(extractSeverityRaw(storyContent), undefined);
    assert.strictEqual(extractReportedByRaw(storyContent), undefined);
  });

  test('writeStatusToMarkdownFile works on bug files with extended front matter', async () => {
    const uri = await createFile(
      'bug-transition',
      [
        '# Login fails on mobile',
        '',
        '**Status:** 📋 Proposed',
        '**Created:** 2026-04-18T08:00:00.000Z',
        '**Type:** Bug',
        '**Priority:** High',
        '**Severity:** Critical',
        '**Reported By:** Jane Smith',
        '',
        '## Summary',
        'Login button does not respond on mobile Safari.',
        '',
        '## Steps to Reproduce',
        '1. Open app on mobile Safari',
        '',
        '## Expected Behavior',
        'Login button should be tappable.',
        '',
        '## Actual Behavior',
        'Nothing happens on tap.',
        '',
        '## Dependencies',
        '',
        ''
      ].join('\n')
    );

    const wrote = await writeStatusToMarkdownFile(uri, 'In Progress');
    assert.strictEqual(wrote, true);

    const after = await readTextFile(uri);
    assert.ok(after.includes('**Status:** 🔄 In Progress'));
    assert.ok(after.includes('**Priority:** High'));
    assert.ok(after.includes('**Severity:** Critical'));
    assert.ok(after.includes('**Reported By:** Jane Smith'));
    assert.ok(after.includes('## Steps to Reproduce'));
  });

  test('writeDescriptionToMarkdownFile updates Description section', async () => {
    const uri = await createFile(
      'desc-update',
      [
        '# Test Story',
        '',
        '**Status:** 📋 Proposed',
        '**Created:** 2026-04-18T08:00:00.000Z',
        '**Type:** Story',
        '**Priority:** Medium',
        '',
        '## Description',
        'Original description.',
        '',
        '## Dependencies',
        '',
        ''
      ].join('\n')
    );

    const wrote = await writeDescriptionToMarkdownFile(uri, 'Updated description with more details.');
    assert.strictEqual(wrote, true);

    const after = await readTextFile(uri);
    assert.ok(after.includes('Updated description with more details.'));
    assert.ok(!after.includes('Original description.'));
    assert.ok(after.includes('## Dependencies'));
  });

  test('writeDescriptionToMarkdownFile works with Summary section for backward compatibility', async () => {
    const uri = await createFile(
      'summary-update',
      [
        '# Legacy Story',
        '',
        '**Status:** 📋 Proposed',
        '',
        '## Summary',
        'Old style summary.',
        '',
        '## Dependencies',
        '',
        ''
      ].join('\n')
    );

    const wrote = await writeDescriptionToMarkdownFile(uri, 'New description.');
    assert.strictEqual(wrote, true);

    const after = await readTextFile(uri);
    assert.ok(after.includes('New description.'));
    assert.ok(!after.includes('Old style summary.'));
  });

  test('writePriorityToMarkdownFile updates priority', async () => {
    const uri = await createFile(
      'priority-update',
      [
        '# Test Task',
        '',
        '**Status:** 📋 Proposed',
        '**Created:** 2026-04-18T08:00:00.000Z',
        '**Type:** Task',
        '**Priority:** Medium',
        '',
        '## Description',
        'A task.',
        ''
      ].join('\n')
    );

    const wrote = await writePriorityToMarkdownFile(uri, 'High');
    assert.strictEqual(wrote, true);

    const after = await readTextFile(uri);
    assert.ok(after.includes('**Priority:** High'));
    assert.ok(!after.includes('**Priority:** Medium'));
  });

  test('writePriorityToMarkdownFile returns false when Priority line is missing', async () => {
    const uri = await createFile(
      'no-priority',
      [
        '# No Priority',
        '',
        '**Status:** 📋 Proposed',
        '',
        '## Description',
        'No priority field.',
        ''
      ].join('\n')
    );

    const wrote = await writePriorityToMarkdownFile(uri, 'High');
    assert.strictEqual(wrote, false);
  });

  test('upgradeMarkdownFile adds missing fields and sections to old story', async () => {
    const uri = await createFile(
      'upgrade-story',
      [
        '# Old Story',
        '',
        '**Status:** 📋 Proposed',
        '**Created:** 2026-01-01T00:00:00.000Z',
        '**Type:** Story',
        '',
        '## Summary',
        'An old-format story.',
        '',
        '## Dependencies',
        '',
        ''
      ].join('\n')
    );

    const upgraded = await upgradeMarkdownFile(uri, 'Story');
    assert.strictEqual(upgraded, true);

    const after = await readTextFile(uri);
    assert.ok(after.includes('**Priority:** Medium'));
    assert.ok(after.includes('## Description'));
    assert.ok(!after.match(/^## Summary\b/m));
    assert.ok(after.includes('## Comments'));
    assert.ok(after.includes('An old-format story.'));
  });

  test('upgradeMarkdownFile adds bug-specific fields and sections', async () => {
    const uri = await createFile(
      'upgrade-bug',
      [
        '# Old Bug',
        '',
        '**Status:** 📋 Proposed',
        '**Created:** 2026-01-01T00:00:00.000Z',
        '**Type:** Bug',
        '',
        '## Summary',
        'An old-format bug.',
        ''
      ].join('\n')
    );

    const upgraded = await upgradeMarkdownFile(uri, 'Bug');
    assert.strictEqual(upgraded, true);

    const after = await readTextFile(uri);
    assert.ok(after.includes('**Priority:** Medium'));
    assert.ok(after.includes('**Severity:** Medium'));
    assert.ok(after.includes('**Reported By:**'));
    assert.ok(after.includes('## Steps to Reproduce'));
    assert.ok(after.includes('## Expected Behavior'));
    assert.ok(after.includes('## Actual Behavior'));
    assert.ok(after.includes('## Comments'));
    assert.ok(after.includes('## Dependencies'));
  });

  test('upgradeMarkdownFile adds core fields to legacy bug with no Status Created or Type', async () => {
    const uri = await createFile(
      'upgrade-legacy-bug',
      [
        '# BUG-001 - ISyncResultBuilder has 13 parameters',
        '',
        '**Rule:** `csharpsquid:S107` (MAJOR)',
        '**File:** src/SyncManager.cs line 13',
        '**Message:** Method has 13 parameters.',
        '',
        '## Resolution note',
        'This bug is resolved.',
        ''
      ].join('\n')
    );

    const upgraded = await upgradeMarkdownFile(uri, 'Bug');
    assert.strictEqual(upgraded, true);

    const after = await readTextFile(uri);
    assert.ok(after.includes('**Status:** 📋 Proposed'));
    assert.ok(after.includes('**Created:**'));
    assert.ok(after.includes('**Type:** Bug'));
    assert.ok(after.includes('**Priority:** Medium'));
    assert.ok(after.includes('**Severity:** Medium'));
    assert.ok(after.includes('**Reported By:**'));
    assert.ok(after.indexOf('**Status:**') < after.indexOf('**Rule:**'));
    assert.ok(after.includes('**Rule:**'));
    assert.ok(after.includes('This bug is resolved.'));
  });

  test('upgradeMarkdownFile is idempotent on already-upgraded files', async () => {
    const uri = await createFile(
      'upgrade-noop',
      [
        '# New Story',
        '',
        '**Status:** 📋 Proposed',
        '**Created:** 2026-01-01T00:00:00.000Z',
        '**Type:** Story',
        '**Priority:** High',
        '',
        '## Description',
        'Already new format.',
        '',
        '## Dependencies',
        '',
        '',
        '## Comments',
        '',
        ''
      ].join('\n')
    );

    const upgraded = await upgradeMarkdownFile(uri, 'Story');
    assert.strictEqual(upgraded, false);
  });
});
