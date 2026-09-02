import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import type { CatalogScope } from './manifest';
export interface SkillMetadata { name: string; description: string; version?: string; triggers: string[]; }
export interface DiscoveredSkill { metadata: SkillMetadata; skillPath: string; instructionsPath: string; fingerprint: string; scope: CatalogScope; trusted: boolean; error?: string; }
function parseFrontMatter(content: string): { metadata: SkillMetadata; error?: string } {
  const empty = { name: '', description: '', triggers: [] as string[] };
  if (!content.startsWith('---')) return { metadata: empty, error: 'SKILL.md must start with YAML front matter.' };
  const end = content.indexOf('\n---', 3); if (end < 0) return { metadata: empty, error: 'SKILL.md front matter is not closed.' };
  const values = new Map<string, string>();
  for (const line of content.slice(3, end).split(/\r?\n/)) { const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim()); if (match) values.set(match[1], match[2].replace(/^['"]|['"]$/g, '').trim()); }
  const name = values.get('name') ?? ''; const description = values.get('description') ?? ''; const triggers = (values.get('triggers') ?? '').split(',').map(item => item.trim()).filter(Boolean);
  if (!name || !description) return { metadata: { name, description, triggers }, error: 'name and description are required.' };
  return { metadata: { name, description, triggers, version: values.get('version') } };
}
async function skillDirectories(root: string): Promise<string[]> { try { return (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name)).sort(); } catch { return []; } }
/** Indexes metadata and fingerprints without loading instruction bodies or resources. */
export async function discoverSkills(roots: string[], trustedRoots = roots): Promise<DiscoveredSkill[]> {
  const trusted = trustedRoots.map(value => path.resolve(value));
  const result: DiscoveredSkill[] = []; const seen = new Set<string>();
  for (const root of roots.map(value => path.resolve(value))) {
    const rootIsTrusted = trusted.includes(root);
    for (const skillPath of await skillDirectories(root)) {
      const instructionsPath = path.join(skillPath, 'SKILL.md');
      try {
        const content = await readFile(instructionsPath, 'utf8'); const parsed = parseFrontMatter(content); const name = parsed.metadata.name || path.basename(skillPath);
        if (seen.has(name)) continue; seen.add(name);
        result.push({ metadata: { ...parsed.metadata, name }, skillPath, instructionsPath, fingerprint: createHash('sha256').update(content).digest('hex'), scope: rootIsTrusted ? 'global' : 'project', trusted: trusted.some(rootPath => path.resolve(skillPath).startsWith(`${rootPath}${path.sep}`)), ...(parsed.error ? { error: parsed.error } : {}) });
      } catch { /* A folder without SKILL.md is not a skill. */ }
    }
  }
  return result.sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));
}
export async function loadSkillInstructions(skill: DiscoveredSkill): Promise<string> { if (skill.error) throw new Error(`Skill ${skill.metadata.name} is invalid: ${skill.error}`); return readFile(skill.instructionsPath, 'utf8'); }
