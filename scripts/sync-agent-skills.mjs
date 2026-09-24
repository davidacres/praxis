#!/usr/bin/env node
/**
 * Repo skills are written once, in .agents/skills (Codex and Praxis read it), and
 * mirrored as plain copies to the folders other tools read: .github/skills (Copilot)
 * and .claude/skills (Claude Code). Copies, not symlinks, so a Windows checkout works.
 *
 *   node scripts/sync-agent-skills.mjs          copy .agents/skills over the mirrors
 *   node scripts/sync-agent-skills.mjs --check  exit 1 if a mirror has drifted
 *
 * Only skills that exist in .agents/skills are managed; a tool-specific skill that
 * lives only in a mirror folder is left alone.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, '.agents', 'skills');
const mirrors = [path.join(root, '.github', 'skills'), path.join(root, '.claude', 'skills')];
const check = process.argv.includes('--check');

function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full, base) : [path.relative(base, full)];
  });
}

const drift = [];
for (const skill of fs.readdirSync(source, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
  const from = path.join(source, skill.name);
  const files = listFiles(from);
  for (const mirror of mirrors) {
    const to = path.join(mirror, skill.name);
    const stale = listFiles(to).filter(file => !files.includes(file));
    for (const file of files) {
      const target = path.join(to, file);
      const wanted = fs.readFileSync(path.join(from, file));
      if (fs.existsSync(target) && fs.readFileSync(target).equals(wanted)) continue;
      drift.push(path.relative(root, target));
      if (!check) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, wanted);
      }
    }
    for (const file of stale) {
      drift.push(`${path.relative(root, path.join(to, file))} (not in .agents/skills)`);
      if (!check) fs.rmSync(path.join(to, file));
    }
  }
}

if (check && drift.length > 0) {
  console.error('Repo skill mirrors differ from .agents/skills. Edit .agents/skills, then run `npm run skills:sync`:');
  for (const line of drift) console.error(`  ${line}`);
  process.exit(1);
}
console.log(check ? 'Repo skill mirrors match .agents/skills.' : `Synced repo skills (${drift.length} file(s) written or removed).`);
