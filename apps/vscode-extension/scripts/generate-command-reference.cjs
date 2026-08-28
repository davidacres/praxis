const fs = require('node:fs');
const path = require('node:path');

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..', '..');
const packageJsonPath = path.join(extensionRoot, 'package.json');
const outputPath = path.join(repoRoot, 'docs', 'command-reference.md');

function readPackageJson() {
  return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
}

function iconText(icon) {
  if (!icon) {
    return '';
  }
  if (typeof icon === 'string') {
    return icon;
  }
  if (typeof icon === 'object') {
    const light = typeof icon.light === 'string' ? icon.light : '';
    const dark = typeof icon.dark === 'string' ? icon.dark : '';
    return [light, dark].filter(Boolean).join(' / ');
  }
  return '';
}

function markdownTableRow(cells) {
  return `| ${cells.map(cell => String(cell).replace(/\|/g, '\\|')).join(' | ')} |`;
}

function buildDocument(pkg) {
  const commands = Array.isArray(pkg?.contributes?.commands) ? pkg.contributes.commands : [];
  const sortedCommands = [...commands].sort((left, right) => {
    const leftTitle = typeof left?.title === 'string' ? left.title : '';
    const rightTitle = typeof right?.title === 'string' ? right.title : '';
    return leftTitle.localeCompare(rightTitle);
  });

  const lines = [
    '# Ticket Manager Command Reference',
    '',
    '> This file is generated from `apps/vscode-extension/package.json` by `npm run docs:commands` (delegates to `node apps/vscode-extension/scripts/generate-command-reference.cjs`).',
    '',
    'This document lists the user-facing commands contributed through the extension manifest.',
    '',
    `Total contributed commands: ${sortedCommands.length}`,
    '',
    markdownTableRow(['Command Title', 'Command Id', 'Category', 'Icon']),
    markdownTableRow(['---', '---', '---', '---'])
  ];

  for (const command of sortedCommands) {
    lines.push(
      markdownTableRow([
        typeof command?.title === 'string' ? command.title : '',
        typeof command?.command === 'string' ? `\`${command.command}\`` : '',
        typeof command?.category === 'string' ? command.category : '',
        iconText(command?.icon)
      ])
    );
  }

  lines.push(
    '',
    '## Notes',
    '',
    '- This reference only covers manifest-contributed commands.',
    '- Some internally registered commands and wiring helpers are intentionally not listed here.',
    ''
  );

  return `${lines.join('\n')}`;
}

function main() {
  const pkg = readPackageJson();
  const document = buildDocument(pkg);
  fs.writeFileSync(outputPath, document, 'utf8');
  process.stdout.write(`Wrote ${path.relative(repoRoot, outputPath)}\n`);
}

main();