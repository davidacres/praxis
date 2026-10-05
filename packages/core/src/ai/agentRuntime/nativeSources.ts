/**
 * Agents, skills and instruction files that other AI tools keep in a project
 * or the user's home folder — Claude Code, Codex, GitHub Copilot, Gemini /
 * Antigravity, Cursor — discovered in place (never copied) so Praxis can show
 * them and use them on any runtime.
 *
 * Each source records which Praxis runtimes already read it natively
 * (`readBy`). A session on one of those runtimes gets nothing extra from
 * Praxis — the tool loads the file itself — while any other runtime gets the
 * equivalent through Praxis (instructions in the system prompt, skills via
 * normal skill activation, agents as profiles). That is what keeps the same
 * file from being loaded twice.
 *
 * Project files can arrive with a cloned repository, so they are untrusted
 * until the user approves the project; files in the user's home are theirs
 * and trusted.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentProfile } from '../agentContracts';
import type { AiProvider } from '../../types';
import type { DiscoveredAgentProfile } from './profileRegistry';
import { discoverSkills, yamlScalar, type DiscoveredSkill } from './skillRegistry';

export type NativeEcosystem = 'claude' | 'codex' | 'agents' | 'copilot' | 'gemini' | 'cursor';
export type NativeScope = 'project' | 'user';

export const NATIVE_ECOSYSTEM_LABELS: Record<NativeEcosystem, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  agents: 'Shared (.agents)',
  copilot: 'GitHub Copilot',
  gemini: 'Gemini / Antigravity',
  cursor: 'Cursor'
};

export const NATIVE_ECOSYSTEMS: readonly NativeEcosystem[] = ['claude', 'codex', 'agents', 'copilot', 'gemini', 'cursor'];

/** Where an item came from, and which Praxis runtimes load it on their own. */
export interface NativeSourceRef {
  ecosystem: NativeEcosystem;
  scope: NativeScope;
  /** Absolute path of the file (agent, instruction) or skill folder. */
  path: string;
  readBy: readonly AiProvider[];
}

export interface NativeInstructionFile extends NativeSourceRef {
  /** Path relative to the project root, or `~/…` for user files. */
  displayPath: string;
  bytes: number;
  fingerprint: string;
  content: string;
  /**
   * False for files that only apply to some paths (Copilot `applyTo` globs,
   * Cursor rules that are not `alwaysApply`) — shown, never added to a prompt.
   */
  alwaysApplies: boolean;
  appliesTo?: string;
  /** Larger than Praxis adds to a session on its own (`MAX_INSTRUCTION_CHARS`); set in snapshots. */
  tooLargeForSessions?: boolean;
}

export interface NativeSourceOptions {
  /** The project's root folder (see `findProjectRoot`), if any. */
  projectRoot?: string;
  homeDir: string;
  /** Ecosystems to read; default all. */
  enabled?: Partial<Record<NativeEcosystem, boolean>>;
  /** Project files are trusted only once the user approves the project. */
  projectApproved: boolean;
  /** Extra folders to read: skill folders (each `<name>/SKILL.md`) or agent `.md` files. */
  extraSkillPaths?: readonly string[];
  extraAgentPaths?: readonly string[];
}

export interface NativeSourceDiscovery {
  projectRoot?: string;
  instructions: NativeInstructionFile[];
  agents: DiscoveredAgentProfile[];
  skills: DiscoveredSkill[];
}

// -- What each tool keeps where ------------------------------------------------

interface InstructionPattern {
  /** A file, or a folder plus a file suffix. */
  file?: string;
  dir?: string;
  suffix?: string;
  readBy: readonly AiProvider[];
}

interface EcosystemLayout {
  instructions: { project: readonly InstructionPattern[]; user: readonly InstructionPattern[] };
  agents: { project?: string; user?: string; suffix: string; readBy: readonly AiProvider[] };
  skills: { project: readonly string[]; user: readonly string[]; readBy: readonly AiProvider[] };
}

const NONE: readonly AiProvider[] = [];

/**
 * Native readers are the Praxis ACP runtimes as launched: `claude-agent-acp`
 * passes `settingSources: user/project/local`, so Claude Code loads its own
 * files; `codex-acp` and `copilot --acp` run the real CLIs; Antigravity is the
 * successor to Gemini CLI and keeps its context files and subagents.
 */
const LAYOUTS: Record<NativeEcosystem, EcosystemLayout> = {
  claude: {
    instructions: {
      project: [{ file: 'CLAUDE.md', readBy: ['claude-code-cli'] }, { file: '.claude/CLAUDE.md', readBy: ['claude-code-cli'] }],
      user: [{ file: '.claude/CLAUDE.md', readBy: ['claude-code-cli'] }]
    },
    agents: { project: '.claude/agents', user: '.claude/agents', suffix: '.md', readBy: ['claude-code-cli'] },
    skills: { project: ['.claude/skills'], user: ['.claude/skills'], readBy: ['claude-code-cli'] }
  },
  codex: {
    instructions: {
      // AGENTS.md is the cross-tool file: Codex and Copilot both read it.
      project: [{ file: 'AGENTS.md', readBy: ['codex-cli', 'copilot-cli'] }],
      user: [{ file: '.codex/AGENTS.md', readBy: ['codex-cli'] }]
    },
    agents: { suffix: '.md', readBy: NONE },
    skills: { project: ['.codex/skills'], user: ['.codex/skills'], readBy: ['codex-cli'] }
  },
  agents: {
    instructions: { project: [], user: [] },
    agents: { suffix: '.md', readBy: NONE },
    skills: { project: ['.agents/skills'], user: ['.agents/skills'], readBy: ['codex-cli', 'copilot-cli'] }
  },
  copilot: {
    instructions: {
      project: [
        { file: '.github/copilot-instructions.md', readBy: ['copilot-cli'] },
        { dir: '.github/instructions', suffix: '.instructions.md', readBy: ['copilot-cli'] }
      ],
      user: []
    },
    agents: { project: '.github/agents', user: '.copilot/agents', suffix: '.agent.md', readBy: ['copilot-cli'] },
    skills: { project: ['.github/skills'], user: ['.copilot/skills'], readBy: ['copilot-cli'] }
  },
  gemini: {
    instructions: {
      project: [{ file: 'GEMINI.md', readBy: ['antigravity-cli'] }],
      user: [{ file: '.gemini/GEMINI.md', readBy: ['antigravity-cli'] }]
    },
    agents: { project: '.gemini/agents', user: '.gemini/agents', suffix: '.md', readBy: ['antigravity-cli'] },
    skills: { project: [], user: [], readBy: ['antigravity-cli'] }
  },
  cursor: {
    instructions: {
      project: [{ file: '.cursorrules', readBy: ['cursor-cli'] }, { dir: '.cursor/rules', suffix: '.mdc', readBy: ['cursor-cli'] }],
      user: []
    },
    agents: { suffix: '.md', readBy: NONE },
    skills: { project: [], user: [], readBy: NONE }
  }
};

const MAX_FILE_BYTES = 256 * 1024;

// -- Helpers ------------------------------------------------------------------

function frontMatter(content: string): { values: Map<string, string>; body: string; hasFrontMatter: boolean } {
  const normalized = content.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---')) return { values: new Map(), body: normalized.trim(), hasFrontMatter: false };
  const end = normalized.indexOf('\n---', 3);
  if (end < 0) return { values: new Map(), body: normalized.trim(), hasFrontMatter: false };
  const values = new Map<string, string>();
  for (const line of normalized.slice(3, end).split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (match) values.set(match[1].toLowerCase(), yamlScalar(match[2]));
  }
  const afterClose = normalized.indexOf('\n', end + 4);
  return { values, body: afterClose < 0 ? '' : normalized.slice(afterClose + 1).trim(), hasFrontMatter: true };
}

/** `csharp-dotnet-code-reviewer` → `Csharp Dotnet Code Reviewer`. */
export function humanizeIdentifier(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(word => word[0]!.toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Claude agent descriptions often embed escaped newlines and `<example>`
 * blocks meant for the model's delegation logic; keep the human sentence.
 */
export function summarizeDescription(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const text = raw.replace(/\\n/g, '\n').split(/<example>/i)[0]!.split(/\n\s*\n/)[0]!.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  if (text.length <= 240) return text;
  const cut = text.slice(0, 240);
  const sentence = cut.lastIndexOf('. ');
  return `${sentence > 80 ? cut.slice(0, sentence + 1) : `${cut.trimEnd()}…`}`;
}

const WRITE_TOOLS = /\b(write|edit|multiedit|bash|shell|notebookedit|run_shell_command|execute|terminal|create|replace)\b/i;

/** A tool list that grants nothing able to change files or run commands means read-only. */
export function toolModeFromList(tools: string | undefined): AgentProfile['toolMode'] | undefined {
  if (!tools?.trim()) return undefined;
  const list = tools.replace(/^\[|\]$/g, '').split(/[,\s]+/).map(item => item.replace(/['"]/g, '').trim()).filter(Boolean);
  if (list.length === 0 || list.includes('*')) return undefined;
  return list.some(tool => WRITE_TOOLS.test(tool)) ? undefined : 'read-only';
}

/** Parses a Claude Code, Copilot (`.agent.md`) or Gemini agent file into a Praxis profile. */
export function parseNativeAgent(content: string, fileName: string, suffix: string): { profile: AgentProfile; error?: string } {
  const parsed = frontMatter(content);
  const fallbackId = fileName.endsWith(suffix) ? fileName.slice(0, -suffix.length) : path.parse(fileName).name;
  const id = (parsed.values.get('name') && /^[a-z0-9][a-z0-9._-]*$/i.test(parsed.values.get('name')!) ? parsed.values.get('name')! : fallbackId)
    .toLowerCase();
  const displayName = parsed.values.get('name') && !/^[a-z0-9._-]+$/.test(parsed.values.get('name')!)
    ? parsed.values.get('name')!
    : humanizeIdentifier(id);
  const description = summarizeDescription(parsed.values.get('description'));
  const toolMode = toolModeFromList(parsed.values.get('tools'));
  const profile: AgentProfile = {
    id,
    name: displayName,
    instructions: parsed.body,
    ...(description ? { description } : {}),
    ...(toolMode ? { toolMode } : {})
  };
  if (!parsed.body) return { profile, error: 'The agent file has no instructions after its front matter.' };
  return { profile };
}

async function readSmall(file: string): Promise<string | undefined> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return undefined;
    return await readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

async function filesWithSuffix(dir: string, suffix: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith(suffix))
      .map(entry => path.join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

const fingerprintOf = (content: string): string => createHash('sha256').update(content).digest('hex');

function displayPathFor(file: string, scope: NativeScope, projectRoot: string | undefined, homeDir: string): string {
  const base = scope === 'project' ? projectRoot : homeDir;
  const relative = base ? path.relative(base, file) : file;
  return scope === 'user' ? `~/${relative}` : relative;
}

/** The nearest ancestor holding `.git` (the project root other tools also use), else `dir`. */
export async function findProjectRoot(dir: string): Promise<string> {
  let current = path.resolve(dir);
  for (;;) {
    try {
      await stat(path.join(current, '.git'));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(dir);
      current = parent;
    }
  }
}

// -- Discovery ------------------------------------------------------------------

export async function discoverNativeSources(options: NativeSourceOptions): Promise<NativeSourceDiscovery> {
  const enabled = (ecosystem: NativeEcosystem): boolean => options.enabled?.[ecosystem] !== false;
  const instructions: NativeInstructionFile[] = [];
  const agents: DiscoveredAgentProfile[] = [];
  const skills: DiscoveredSkill[] = [];
  const bases: Array<{ scope: NativeScope; root: string }> = [
    ...(options.projectRoot ? [{ scope: 'project' as const, root: options.projectRoot }] : []),
    { scope: 'user', root: options.homeDir }
  ];
  const trustedFor = (scope: NativeScope): boolean => scope === 'user' || options.projectApproved;
  const seenPaths = new Set<string>();

  for (const ecosystem of NATIVE_ECOSYSTEMS.filter(enabled)) {
    const layout = LAYOUTS[ecosystem];
    for (const { scope, root } of bases) {
      // A project folder inside the home folder must not be read twice as "user".
      for (const pattern of layout.instructions[scope]) {
        const files = pattern.file ? [path.join(root, pattern.file)] : await filesWithSuffix(path.join(root, pattern.dir!), pattern.suffix!);
        for (const file of files) {
          if (seenPaths.has(file)) continue;
          const content = await readSmall(file);
          if (content === undefined || !content.trim()) continue;
          seenPaths.add(file);
          const parsed = frontMatter(content);
          const appliesTo = parsed.values.get('applyto') ?? parsed.values.get('globs');
          const alwaysApplies = file.endsWith('.mdc')
            ? parsed.values.get('alwaysapply') === 'true'
            : !appliesTo || appliesTo === '**' || appliesTo === '**/*';
          instructions.push({
            ecosystem,
            scope,
            path: file,
            readBy: pattern.readBy,
            displayPath: displayPathFor(file, scope, options.projectRoot, options.homeDir),
            bytes: Buffer.byteLength(content),
            fingerprint: fingerprintOf(content),
            content: parsed.hasFrontMatter ? parsed.body : content.trim(),
            alwaysApplies,
            ...(appliesTo ? { appliesTo } : {})
          });
        }
      }

      const agentDir = layout.agents[scope];
      if (agentDir) {
        for (const file of await filesWithSuffix(path.join(root, agentDir), layout.agents.suffix)) {
          const content = await readSmall(file);
          if (content === undefined) continue;
          const parsed = parseNativeAgent(content, path.basename(file), layout.agents.suffix);
          agents.push({
            profile: parsed.profile,
            profilePath: file,
            rootPath: path.dirname(file),
            fingerprint: fingerprintOf(content),
            scope: scope === 'project' ? 'project' : 'global',
            trusted: trustedFor(scope),
            legacy: false,
            ...(parsed.error ? { error: parsed.error } : {}),
            source: { ecosystem, scope, path: file, readBy: layout.agents.readBy }
          });
        }
      }

      for (const skillDir of layout.skills[scope]) {
        const found = await discoverSkills([path.join(root, skillDir)], trustedFor(scope) ? [path.join(root, skillDir)] : []);
        for (const skill of found) {
          skills.push({
            ...skill,
            scope: scope === 'project' ? 'project' : 'global',
            trusted: trustedFor(scope),
            source: { ecosystem, scope, path: skill.skillPath, readBy: layout.skills.readBy }
          });
        }
      }
    }
  }

  for (const extra of options.extraSkillPaths ?? []) {
    for (const skill of await discoverSkills([extra], [extra])) {
      skills.push({ ...skill, scope: 'global', trusted: true, source: { ecosystem: 'agents', scope: 'user', path: skill.skillPath, readBy: NONE } });
    }
  }
  for (const extra of options.extraAgentPaths ?? []) {
    for (const file of await filesWithSuffix(extra, '.md')) {
      const content = await readSmall(file);
      if (content === undefined) continue;
      const suffix = file.endsWith('.agent.md') ? '.agent.md' : '.md';
      const parsed = parseNativeAgent(content, path.basename(file), suffix);
      agents.push({
        profile: parsed.profile,
        profilePath: file,
        rootPath: extra,
        fingerprint: fingerprintOf(content),
        scope: 'global',
        trusted: true,
        legacy: false,
        ...(parsed.error ? { error: parsed.error } : {}),
        source: { ecosystem: 'agents', scope: 'user', path: file, readBy: NONE }
      });
    }
  }

  return { ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}), instructions, agents, skills };
}

// -- One entry per id -------------------------------------------------------------

/**
 * Lower wins. Praxis's own items (project, then global — including copies
 * made from another tool) beat other tools' files; among those a project's
 * beat the user's; the built-in item is the fallback.
 */
export function catalogRank(item: { scope: string; builtIn?: boolean; source?: NativeSourceRef }): number {
  if (!item.source) {
    if (item.builtIn) return 4;
    return item.scope === 'project' ? 0 : 1;
  }
  return item.source.scope === 'project' ? 2 : 3;
}

export function sourceLabel(source: NativeSourceRef): string {
  return `${NATIVE_ECOSYSTEM_LABELS[source.ecosystem]} · ${source.scope === 'project' ? 'project' : 'your user folder'}`;
}

/**
 * Keeps one item per id by `catalogRank`, recording where else it was found
 * (`alsoIn`) so the UI can say "also in Claude Code · user".
 */
export function mergeById<T extends { scope: string; builtIn?: boolean; source?: NativeSourceRef; alsoIn?: string[] }>(
  items: readonly T[],
  idOf: (item: T) => string
): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(idOf(item), [...(groups.get(idOf(item)) ?? []), item]);
  const merged: T[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => catalogRank(left) - catalogRank(right));
    const [winner, ...rest] = ordered;
    const alsoIn = rest.map(item => (item.source ? sourceLabel(item.source) : item.builtIn ? 'Praxis built-in' : 'Praxis'));
    merged.push(alsoIn.length ? { ...winner!, alsoIn: [...new Set(alsoIn)] } : winner!);
  }
  return merged;
}

// -- Instructions for a session -------------------------------------------------------------

const INSTRUCTION_ORDER: readonly string[] = ['AGENTS.md', 'CLAUDE.md', '.claude/CLAUDE.md', 'GEMINI.md', '.github/copilot-instructions.md'];
/** Instruction text Praxis adds to one session, in characters; a larger file is left out. */
export const MAX_INSTRUCTION_CHARS = 24_000;

export interface SessionInstructions {
  text: string;
  included: Array<{ displayPath: string; ecosystem: NativeEcosystem }>;
  /** Files the runtime already reads natively (or that do not always apply). */
  skipped: Array<{ displayPath: string; reason: 'native' | 'path-specific' | 'duplicate' | 'user-scope' | 'untrusted' | 'size-limit' | 'other-source' }>;
}

/**
 * The project instruction files a session on `runtime` should receive from
 * Praxis: every always-applying project file that runtime does not already
 * load itself, identical content once, `AGENTS.md` first, bounded in size.
 * `runtime` is the session's provider (an API provider reads nothing natively).
 */
export function buildSessionInstructions(
  files: readonly NativeInstructionFile[],
  runtime: AiProvider | 'custom' | string,
  options: {
    projectApproved: boolean;
    /** Only this tool's files — its conventions become the project's instructions for every AI. */
    source?: 'all' | NativeEcosystem;
  }
): SessionInstructions {
  const rank = (file: NativeInstructionFile): number => {
    const index = INSTRUCTION_ORDER.indexOf(file.displayPath);
    return index < 0 ? INSTRUCTION_ORDER.length : index;
  };
  const included: SessionInstructions['included'] = [];
  const skipped: SessionInstructions['skipped'] = [];
  const seenContent = new Set<string>();
  const sections: string[] = [];
  let used = 0;
  for (const file of [...files].sort((left, right) => rank(left) - rank(right) || left.displayPath.localeCompare(right.displayPath))) {
    if (file.scope !== 'project') { skipped.push({ displayPath: file.displayPath, reason: 'user-scope' }); continue; }
    if (!options.projectApproved) { skipped.push({ displayPath: file.displayPath, reason: 'untrusted' }); continue; }
    if (options.source && options.source !== 'all' && file.ecosystem !== options.source) { skipped.push({ displayPath: file.displayPath, reason: 'other-source' }); continue; }
    if (file.readBy.includes(runtime as AiProvider)) { skipped.push({ displayPath: file.displayPath, reason: 'native' }); continue; }
    if (!file.alwaysApplies) { skipped.push({ displayPath: file.displayPath, reason: 'path-specific' }); continue; }
    const normalized = file.content.replace(/\s+/g, ' ').trim();
    if (!normalized || seenContent.has(normalized)) { skipped.push({ displayPath: file.displayPath, reason: 'duplicate' }); continue; }
    if (used + file.content.length > MAX_INSTRUCTION_CHARS) { skipped.push({ displayPath: file.displayPath, reason: 'size-limit' }); continue; }
    seenContent.add(normalized);
    used += file.content.length;
    included.push({ displayPath: file.displayPath, ecosystem: file.ecosystem });
    sections.push(`### ${file.displayPath}\n\n${file.content.trim()}`);
  }
  const text = sections.length
    ? [
        '## Project instructions',
        'This project keeps instructions for AI tools in the files below. Follow them as project conventions unless they conflict with the task or with Praxis instructions.',
        ...sections
      ].join('\n\n')
    : '';
  return { text, included, skipped };
}

/** Whether a runtime already loads a skill or agent from this source by itself. */
export function readNatively(source: NativeSourceRef | undefined, runtime: AiProvider): boolean {
  return Boolean(source?.readBy.includes(runtime));
}
