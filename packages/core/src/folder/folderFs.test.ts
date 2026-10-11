import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { folderFs, isOwnFolderWrite } from './folderFs';

test('an edit made right after our own write is still recognised as someone else\'s', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-folderfs-'));
  try {
    const file = path.join(root, 'feature.md');
    await folderFs().writeFile(file, '# Ours\n');
    assert.equal(isOwnFolderWrite(file, fs.readFileSync(file, 'utf8')), true);
    fs.appendFileSync(file, 'Theirs.\n');
    assert.equal(isOwnFolderWrite(file, fs.readFileSync(file, 'utf8')), false);
    // A file we never wrote is never ours, and neither is one deleted by someone else.
    assert.equal(isOwnFolderWrite(path.join(root, 'other.md'), '# Ours\n'), false);
    assert.equal(isOwnFolderWrite(path.join(root, 'other.md'), undefined), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a move we made is ours at both ends', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-folderfs-'));
  try {
    const [from, to] = [path.join(root, 'task-1.md'), path.join(root, 'task-1-renamed.md')];
    await folderFs().writeFile(from, '# Task\n');
    await folderFs().moveFile(from, to);
    assert.equal(isOwnFolderWrite(from, undefined), true);
    assert.equal(isOwnFolderWrite(to, '# Task\n'), true);
    // Writing the old path again makes it a live file of ours, not a removal.
    await folderFs().writeFile(from, '# Back\n');
    assert.equal(isOwnFolderWrite(from, undefined), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
