const fs = require('node:fs');
const path = require('node:path');
const parser = require('@babel/parser');
let failures = 0;
function visitDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { visitDir(file); continue; }
    if (!file.endsWith('.ts') || file.endsWith('.test.ts') || entry.name === 'trustedIpcMain.ts') continue;
    const source = parser.parse(fs.readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['typescript'] });
    for (const node of source.program.body) {
      if (node.type !== 'ImportDeclaration' || node.source.value !== 'electron') continue;
      if (node.specifiers.some(item => item.type === 'ImportNamespaceSpecifier' || item.imported?.name === 'ipcMain')) {
        console.error(`${file}: privileged IPC must use trustedIpcMain`); failures++;
      }
    }
  }
}
visitDir(path.join(__dirname, '../src/main'));
process.exitCode = failures ? 1 : 0;
