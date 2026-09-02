/**
 * Pure builders for creating and importing agents and skills (FX-BF-010).
 *
 * Everything here is fail-closed and path-safe: a plan with any error carries an
 * empty file list so the caller writes nothing, and every generated or imported
 * path is a single safe segment under the chosen scope root. Actual disk writes
 * (and recursive import copies) happen in the host, which re-checks each path
 * with `safeSegment` / `safeJoin`.
 */

import * as path from 'node:path';
import {
  validateAgentManifest,
  type AgentEntry,
  type AgentManifest,
  type AgentTransport,
  type CatalogScope
} from './manifest';

export interface NewAgentInput {
  scope: CatalogScope;
  name: string;
  id: string;
  transport: AgentTransport;
  /** Command for process transports (acp / copilot-sdk / custom). */
  command?: string;
  /** URL for network transports (http / gateway). */
  url?: string;
  args?: string[];
  config?: string;
  activation?: 'onDemand' | 'startup';
  skills?: string[];
  /** Also emit a labelled starter implementation for the transport. */
  scaffold?: boolean;
}

export interface NewSkillInput {
  scope: CatalogScope;
  name: string;
  description: string;
  version?: string;
  triggers?: string[];
  /** Body markdown after the front matter. */
  instructions?: string;
  includeScripts?: boolean;
  includeReferences?: boolean;
  includeExamples?: boolean;
}

export interface GeneratedFile {
  /** POSIX-style path relative to the new item's folder. */
  path: string;
  content: string;
}

export interface CreationPlan {
  /** Safe folder name under the scope's agents/ or skills/ root. */
  folder: string;
  files: GeneratedFile[];
  /** Non-empty means nothing should be written. */
  errors: string[];
}

const SEGMENT = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;

/** A lowercase, dash-safe single path segment, or the reason it is rejected. */
export function safeSegment(value: string): { name?: string; error?: string } {
  const trimmed = value.trim();
  if (!trimmed) return { error: 'A name is required.' };
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('..')) {
    return { error: 'Only letters, digits, and dashes are allowed.' };
  }
  if (!SEGMENT.test(trimmed)) {
    return { error: 'Use 2–64 lowercase letters, digits, or dashes (must start and end alphanumeric).' };
  }
  return { name: trimmed };
}

/** Joins `relative` under `root`, throwing if it would escape (host re-check for imports). */
export function safeJoin(root: string, relative: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relative);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Path escapes the approved root: ${relative}`);
  }
  return resolved;
}

const PROCESS_TRANSPORTS: AgentTransport[] = ['acp', 'copilot-sdk', 'custom'];
const NETWORK_TRANSPORTS: AgentTransport[] = ['http', 'gateway'];

/** Assembles and validates an `agent.json` body from wizard input. */
export function buildAgentManifest(input: NewAgentInput): { manifest: AgentManifest; errors: string[] } {
  const errors: string[] = [];
  const entry: AgentEntry = {};
  if (PROCESS_TRANSPORTS.includes(input.transport)) {
    if (!input.command?.trim()) errors.push('A command is required for this transport.');
    else entry.command = input.command.trim();
    if (input.args && input.args.length > 0) entry.args = input.args.map(arg => arg.trim()).filter(Boolean);
  } else if (NETWORK_TRANSPORTS.includes(input.transport)) {
    if (!input.url?.trim()) errors.push('A URL is required for this transport.');
    else entry.url = input.url.trim();
  }

  const manifest: AgentManifest = {
    schemaVersion: 1,
    id: input.id.trim(),
    name: input.name.trim(),
    type: input.transport,
    entry,
    ...(input.skills && input.skills.length > 0 ? { skills: input.skills } : {}),
    ...(input.config?.trim() ? { config: input.config.trim() } : {}),
    ...(input.activation ? { activation: input.activation } : {})
  };

  for (const issue of validateAgentManifest(manifest, `${input.id}/agent.json`)) {
    errors.push(`${issue.path}: ${issue.message}`);
  }
  return { manifest, errors };
}

const SCAFFOLD_BANNER = '// SCAFFOLD — this file is a starting point. Implement it before starting the host.\n';

function agentScaffoldFiles(input: NewAgentInput): GeneratedFile[] {
  if (PROCESS_TRANSPORTS.includes(input.transport)) {
    return [
      {
        path: 'index.js',
        content:
          SCAFFOLD_BANNER +
          `\n/*\n * ${input.name} — ${input.transport} agent.\n` +
          ` * Speak your transport's protocol on stdio (or your chosen channel).\n */\n\n` +
          `process.stderr.write('${input.id}: scaffold not implemented\\n');\nprocess.exit(1);\n`
      },
      {
        path: 'package.json',
        content: JSON.stringify({ name: input.id, private: true, type: 'module', scripts: { start: 'node index.js' } }, null, 2) + '\n'
      }
    ];
  }
  return [
    {
      path: 'README.md',
      content:
        `# ${input.name}\n\n` +
        `Scaffold for a **${input.transport}** agent. Point \`entry.url\` in \`agent.json\` at your\n` +
        `running endpoint and remove this file once it is configured.\n\n` +
        `- URL: \`${input.url ?? '(set me)'}\`\n`
    }
  ];
}

/** Full plan for a new agent folder. Any error → `files: []`. */
export function planNewAgent(input: NewAgentInput, existingIds: string[]): CreationPlan {
  const errors: string[] = [];
  const folder = safeSegment(input.id);
  if (folder.error) errors.push(`id: ${folder.error}`);
  if (!input.name.trim()) errors.push('name: A display name is required.');
  if (folder.name && existingIds.includes(folder.name)) {
    errors.push(`id: "${folder.name}" already exists in this scope.`);
  }

  const built = buildAgentManifest(input);
  errors.push(...built.errors);

  if (errors.length > 0) return { folder: folder.name ?? '', files: [], errors };

  const files: GeneratedFile[] = [
    { path: 'agent.json', content: JSON.stringify(built.manifest, null, 2) + '\n' }
  ];
  if (input.scaffold) files.push(...agentScaffoldFiles(input));
  return { folder: folder.name!, files, errors: [] };
}

/** The `SKILL.md` front matter + body for a new skill. */
export function buildSkillDoc(input: NewSkillInput): string {
  const lines = ['---', `name: ${input.name.trim()}`, `description: ${input.description.trim()}`];
  if (input.version?.trim()) lines.push(`version: ${input.version.trim()}`);
  const triggers = (input.triggers ?? []).map(trigger => trigger.trim()).filter(Boolean);
  if (triggers.length > 0) lines.push(`triggers: ${triggers.join(', ')}`);
  lines.push('---', '');
  lines.push(input.instructions?.trim() || `# ${input.name.trim()}\n\nDescribe when and how to use this skill.`);
  return lines.join('\n') + '\n';
}

/** Full plan for a new skill package. Any error → `files: []`. */
export function planNewSkill(input: NewSkillInput, existingNames: string[]): CreationPlan {
  const errors: string[] = [];
  const folder = safeSegment(input.name);
  if (folder.error) errors.push(`name: ${folder.error}`);
  if (!input.description.trim()) errors.push('description: A description is required.');
  if (folder.name && existingNames.includes(folder.name)) {
    errors.push(`name: A skill named "${folder.name}" already exists in this scope.`);
  }
  if (errors.length > 0) return { folder: folder.name ?? '', files: [], errors };

  const files: GeneratedFile[] = [{ path: 'SKILL.md', content: buildSkillDoc(input) }];
  if (input.includeScripts) files.push({ path: 'scripts/README.md', content: '# scripts\n\nExecutable helpers for this skill. Nothing here runs during discovery.\n' });
  if (input.includeReferences) files.push({ path: 'references/README.md', content: '# references\n\nReference material the skill can cite.\n' });
  if (input.includeExamples) files.push({ path: 'examples/README.md', content: '# examples\n\nWorked examples of the skill in use.\n' });
  return { folder: folder.name!, files, errors: [] };
}

// ── Import validation ────────────────────────────────────────────────────

export interface ImportPreview {
  kind: 'agent' | 'skill';
  /** Proposed folder name in the target scope. */
  name: string;
  /** True when `name` already exists — the caller must resolve before writing. */
  duplicate: boolean;
  errors: string[];
}

/** Validates a would-be imported `agent.json`; `name` is the id to file it under. */
export function validateAgentImport(
  manifestJson: unknown,
  existingIds: string[]
): { preview: ImportPreview } {
  const errors: string[] = [];
  const issues = validateAgentManifest(manifestJson, 'agent.json');
  for (const issue of issues) errors.push(`${issue.path}: ${issue.message}`);
  const id = typeof (manifestJson as { id?: unknown })?.id === 'string' ? String((manifestJson as { id: string }).id).trim() : '';
  const safe = id ? safeSegment(id) : { error: 'id: missing' };
  if (safe.error && !errors.some(e => e.startsWith('id:'))) errors.push(`id: ${safe.error}`);
  return {
    preview: {
      kind: 'agent',
      name: safe.name ?? id,
      duplicate: !!safe.name && existingIds.includes(safe.name),
      errors
    }
  };
}

/** Validates a would-be imported `SKILL.md`. */
export function validateSkillImport(
  skillMarkdown: string,
  existingNames: string[]
): { preview: ImportPreview } {
  const errors: string[] = [];
  const parsed = parseSkillFrontMatter(skillMarkdown);
  if (parsed.error) errors.push(parsed.error);
  const safe = parsed.name ? safeSegment(parsed.name) : { error: 'name: missing' };
  if (safe.error) errors.push(safe.error.startsWith('name') ? safe.error : `name: ${safe.error}`);
  return {
    preview: {
      kind: 'skill',
      name: safe.name ?? parsed.name ?? '',
      duplicate: !!safe.name && existingNames.includes(safe.name),
      errors
    }
  };
}

/** Minimal front-matter read for import validation (name + closed block). */
export function parseSkillFrontMatter(content: string): { name?: string; description?: string; error?: string } {
  if (!content.startsWith('---')) return { error: 'SKILL.md must start with YAML front matter.' };
  const end = content.indexOf('\n---', 3);
  if (end < 0) return { error: 'SKILL.md front matter is not closed.' };
  const values = new Map<string, string>();
  for (const line of content.slice(3, end).split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (match) values.set(match[1], match[2].replace(/^['"]|['"]$/g, '').trim());
  }
  const name = values.get('name');
  const description = values.get('description');
  if (!name || !description) return { name, description, error: 'name and description are required.' };
  return { name, description };
}

/** A non-clashing folder name, deriving `-2`, `-3`… when `rename` is requested. */
export function resolveImportFolder(
  base: string,
  existing: string[],
  onDuplicate: 'block' | 'rename'
): { folder?: string; error?: string } {
  const safe = safeSegment(base);
  if (safe.error) return { error: safe.error };
  if (!existing.includes(safe.name!)) return { folder: safe.name };
  if (onDuplicate === 'block') return { error: `"${safe.name}" already exists — choose rename or a different source.` };
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${safe.name}-${n}`;
    if (!existing.includes(candidate)) return { folder: candidate };
  }
  return { error: 'Could not find a free name.' };
}
