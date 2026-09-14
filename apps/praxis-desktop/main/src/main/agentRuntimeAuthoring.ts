import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import {
  planNewAgent,
  planNewAgentProfile,
  planNewSkill,
  resolveImportFolder,
  safeJoin,
  validateAgentImport,
  validateAgentProfileImport,
  validateSkillImport,
  type AgentRuntimeSnapshot,
  type CatalogScope,
  type GeneratedFile,
  type ImportPreview,
  type NewAgentInput,
  type NewAgentProfileInput,
  type NewSkillInput
} from '@praxis/core';
import { getAgentRuntimeManager, getAgentRuntimeRoots } from './agentRuntimeInstance';

async function folderNames(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
  } catch {
    return [];
  }
}

async function writeFiles(targetDir: string, files: GeneratedFile[]): Promise<void> {
  // Re-check every path against the target root, then write. mkdir per unique
  // parent so package folders (scripts/, references/…) come along.
  const resolved = files.map(file => ({ full: safeJoin(targetDir, file.path), content: file.content }));
  const parents = new Set(resolved.map(file => path.dirname(file.full)));
  for (const parent of parents) await mkdir(parent, { recursive: true });
  await Promise.all(resolved.map(file => writeFile(file.full, file.content, { flag: 'wx' })));
}

async function copyTree(sourceDir: string, targetDir: string): Promise<void> {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  await mkdir(targetDir, { recursive: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.gitkeep') continue;
    const from = path.join(sourceDir, entry.name);
    const to = safeJoin(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyTree(from, to);
    } else if (entry.isFile()) {
      await writeFile(to, await readFile(from), { flag: 'wx' });
    }
  }
}

export async function createAgent(input: NewAgentInput): Promise<AgentRuntimeSnapshot> {
  const root = getAgentRuntimeRoots().agents[input.scope];
  const plan = planNewAgent(input, await folderNames(root));
  if (plan.errors.length > 0) throw new Error(plan.errors.join('; '));
  await writeFiles(safeJoin(root, plan.folder), plan.files);
  return getAgentRuntimeManager().refresh();
}


export async function createAgentProfile(input: NewAgentProfileInput): Promise<AgentRuntimeSnapshot> {
  const root = getAgentRuntimeRoots().profiles[input.scope];
  const plan = planNewAgentProfile(input, await folderNames(root));
  if (plan.errors.length > 0) throw new Error(plan.errors.join('; '));
  await writeFiles(safeJoin(root, plan.folder), plan.files);
  return getAgentRuntimeManager().refresh();
}

export async function createSkill(input: NewSkillInput): Promise<AgentRuntimeSnapshot> {
  const root = getAgentRuntimeRoots().skills[input.scope];
  const plan = planNewSkill(input, await folderNames(root));
  if (plan.errors.length > 0) throw new Error(plan.errors.join('; '));
  await writeFiles(safeJoin(root, plan.folder), plan.files);
  return getAgentRuntimeManager().refresh();
}

export async function previewImport(
  kind: 'agent' | 'profile' | 'skill',
  sourceDir: string,
  scope: CatalogScope
): Promise<ImportPreview> {
  const roots = getAgentRuntimeRoots();
  if (kind === 'agent') {
    const existing = await folderNames(roots.agents[scope]);
    let manifestJson: unknown;
    try {
      manifestJson = JSON.parse(await readFile(path.join(sourceDir, 'agent.json'), 'utf8'));
    } catch {
      return { kind, name: path.basename(sourceDir), duplicate: false, errors: ['No readable agent.json in the chosen folder.'] };
    }
    return validateAgentImport(manifestJson, existing).preview;
  }
  if (kind === 'profile') {
    const existing = await folderNames(roots.profiles[scope]);
    let markdown: string;
    try {
      markdown = await readFile(path.join(sourceDir, 'AGENT.md'), 'utf8');
    } catch {
      return { kind, name: path.basename(sourceDir), duplicate: false, errors: ['No readable AGENT.md in the chosen folder.'] };
    }
    return validateAgentProfileImport(markdown, existing).preview;
  }
  const existing = await folderNames(roots.skills[scope]);
  let markdown: string;
  try {
    markdown = await readFile(path.join(sourceDir, 'SKILL.md'), 'utf8');
  } catch {
    return { kind, name: path.basename(sourceDir), duplicate: false, errors: ['No readable SKILL.md in the chosen folder.'] };
  }
  return validateSkillImport(markdown, existing).preview;
}

export async function importItem(
  kind: 'agent' | 'profile' | 'skill',
  sourceDir: string,
  scope: CatalogScope,
  onDuplicate: 'block' | 'rename'
): Promise<AgentRuntimeSnapshot> {
  const preview = await previewImport(kind, sourceDir, scope);
  if (preview.errors.length > 0) throw new Error(preview.errors.join('; '));

  const roots = getAgentRuntimeRoots();
  const root = kind === 'agent' ? roots.runtimeHosts[scope] : kind === 'profile' ? roots.profiles[scope] : roots.skills[scope];
  const target = resolveImportFolder(preview.name, await folderNames(root), onDuplicate);
  if (target.error || !target.folder) throw new Error(target.error ?? 'Could not resolve a target folder.');

  await copyTree(sourceDir, safeJoin(root, target.folder));
  return getAgentRuntimeManager().refresh();
}
