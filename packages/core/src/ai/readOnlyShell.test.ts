import test from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnlyShellCommand, shellCommandOf } from './readOnlyShell';

test('commands a planner or reviewer uses to look around are read-only', () => {
  for (const command of [
    'git status --short',
    'git log --oneline -10 && git status',
    'git --no-pager diff HEAD~1 --stat',
    'git -C apps/praxis-desktop show 0944c6ac:package.json',
    'git branch --show-current',
    'ls -la apps/praxis-desktop/renderer/src/notes',
    'rg -n "sendToSession|noteHandoff" apps packages',
    'grep -rn \'NoteSendDialog\' apps/praxis-desktop/renderer/src | head -20',
    'find . -name "*.ts" -not -path "*/node_modules/*" | wc -l',
    "sed -n '1,120p' apps/praxis-desktop/renderer/src/notes/NoteSendDialog.tsx",
    'cd apps/praxis-desktop && git log -3 2>&1',
    'cat package.json 2>/dev/null | jq .scripts',
    'GIT_PAGER=cat git log -1',
    'f=apps/praxis-desktop/main/src/main; wc -l $f/teamChatCommands.ts; cat $f/teamChatCommands.ts',
    'export d=src; cat $d/index.ts'
  ]) assert.equal(isReadOnlyShellCommand(command), true, command);
});

test('anything that could write, run code or hide what it runs is refused', () => {
  for (const command of [
    'npm test',
    'node -e "require(\'fs\').writeFileSync(\'x\', \'\')"',
    'git commit -am wip',
    'git checkout -- file.ts',
    'git branch new-branch',
    'git -c core.pager=sh git log',
    'git diff --output=patch.txt',
    'echo hi > notes.md',
    'cat a >> b',
    'ls; rm -rf out',
    'find . -name "*.tmp" -delete',
    'find . -exec touch {} \;',
    "sed -i '' 's/a/b/' file",
    'sed -n \'1p;w out\' file',
    'sort -o out.txt in.txt',
    'cat $(echo /etc/passwd)',
    'cat `which ls`',
    'cat <<EOF > x',
    'sleep 100 &',
    'PATH=. ls',
    'f=apps; PATH=/bin cat $f',
    'f=apps; rm -rf $f',
    'f=apps',
    'git status "unterminated',
    ''
  ]) assert.equal(isReadOnlyShellCommand(command), false, command);
});

test('the command is read from each agent\'s rawInput shape', () => {
  assert.equal(shellCommandOf({ command: 'git status', description: 'Status' }), 'git status');
  assert.equal(shellCommandOf({ command: ['bash', '-lc', 'git log -1'] }), 'git log -1');
  assert.equal(shellCommandOf({ command: ['git', 'show', 'HEAD:a b.ts'] }), "git show 'HEAD:a b.ts'");
  assert.equal(shellCommandOf({ path: 'x' }), undefined);
  assert.equal(shellCommandOf(undefined), undefined);
});
