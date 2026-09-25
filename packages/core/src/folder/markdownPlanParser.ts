import * as path from 'node:path';
import type { ProjectWorkflowStage } from '../projects/projectTypes';
import { DEFAULT_WORKFLOW, resolveStatus } from '../projects/projectWorkflow';
import { folderFs } from './folderFs';
import {
  buildUnreadablePathError,
  normalizeConfiguredFolderPath
} from './pathUtils';

// ── Shared types ────────────────────────────────────────────────────

export interface ParsedPlanningDates {
  created?: string;
  completed?: string;
}

export interface ParsedFeatureFolder {
  /** Explicit document id, used to resolve local planning references. */
  planningId?: string;
  dirName: string;
  featureId: number;
  title: string;
  planStatus: string;
  description: string;
  featureMdPath: string;
  depTokens: string[];
  planningDates: ParsedPlanningDates;
  priority?: string;
  model?: string;
  complexity?: string;
}

export interface ParsedStoryFile {
  featureId: number;
  storySeq: number;
  filename: string;
  title: string;
  planStatus: string;
  description: string;
  ideaTranscript?: string;
  relativePath: string;
  storyMdPath: string;
  depTokens: string[];
  planningDates: ParsedPlanningDates;
  branch?: string;
}

export interface ParsedChildFile {
  /** Explicit document id; absent legacy files retain filename resolution. */
  planningId?: string;
  featureId: number | undefined;
  sequence: number;
  filename: string;
  issueType: 'Story' | 'Task' | 'Bug' | 'Idea';
  title: string;
  planStatus: string;
  description: string;
  ideaTranscript?: string;
  relativePath: string;
  filePath: string;
  depTokens: string[];
  planningDates: ParsedPlanningDates;
  branch?: string;
  priority?: string;
  severity?: string;
  reportedBy?: string;
  model?: string;
  complexity?: string;
}

export interface ParsedPlanFolder {
  features: ParsedFeatureFolder[];
  stories: ParsedStoryFile[];
  childItems: ParsedChildFile[];
  /** The resolved root folder for the plans tree. */
  plansRootPath: string;
  /** The resolved directory that contains the `feature-NN-*` subdirectories. */
  featuresRootPath: string;
}

// ── Helpers ─────────────────────────────────────────────────────────

export async function readUtf8(filePath: string): Promise<string> {
  return folderFs().readFile(filePath);
}

export function extractMainHeading(content: string): string {
  const m = content.match(/^#\s+(.+)$/m);
  return m?.[1]?.trim() ?? 'Untitled';
}

export function extractStatusRaw(content: string): string {
  return extractFrontMatterValue(content, 'status')
    || content.match(/^\*\*Status:\*\*\s*(.+)$/m)?.[1]?.trim()
    || '';
}

export function extractBranchRaw(content: string): string | undefined {
  const m = content.match(/^\*\*Branch:\*\*\s*(.+)$/m);
  return m?.[1]?.trim() || undefined;
}

export function extractPriorityRaw(content: string): string | undefined {
  const m = content.match(/^\*\*Priority:\*\*\s*(.+)$/m);
  return m?.[1]?.trim() || undefined;
}

export function extractSeverityRaw(content: string): string | undefined {
  const m = content.match(/^\*\*Severity:\*\*\s*(.+)$/m);
  return m?.[1]?.trim() || undefined;
}

export function extractReportedByRaw(content: string): string | undefined {
  const m = content.match(/^\*\*Reported By:\*\*\s*(.+)$/m);
  return m?.[1]?.trim() || undefined;
}

export function extractModelRaw(content: string): string | undefined {
  const m = content.match(/^\*\*Model:\*\*\s*(.+)$/m);
  return m?.[1]?.trim() || undefined;
}

export function extractTypeRaw(content: string): string | undefined {
  return extractFrontMatterValue(content, 'type')
    || content.match(/^\*\*Type:\*\*\s*(.+)$/m)?.[1]?.trim()
    || undefined;
}

function getFrontmatterBlock(content: string): string | undefined {
  return /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(content)?.[1];
}

function extractFrontMatterValue(content: string, key: string): string | undefined {
  const frontmatter = getFrontmatterBlock(content);
  return frontmatter?.match(new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, 'm'))?.[1]?.trim();
}

/**
 * Reads the flow-style `dependencies: [A, B]` frontmatter array. Most plan
 * documents carry this alongside a matching `## Dependencies` prose section,
 * but a large legacy subset (fx-bf-003/004/005 and siblings) declare it only
 * here — without this, those dependency edges never reach depTokens at all.
 */
function extractFrontMatterDependencyTokens(content: string): string[] {
  const frontmatter = getFrontmatterBlock(content);
  const list = frontmatter?.match(/^dependencies:\s*\[([^\]]*)\]\s*$/m)?.[1];
  if (!list) return [];
  return list.split(',').map(token => token.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

export function extractComplexityRaw(content: string): string | undefined {
  const m = content.match(/^\*\*Complexity:\*\*\s*(.+)$/m);
  return m?.[1]?.trim() || undefined;
}

export function extractSectionBody(content: string, heading: string): string | undefined {
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === `## ${heading}`) {
      i++;
      const buf: string[] = [];
      while (i < lines.length && !/^## /.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      const body = buf.join('\n').trim();
      return body.length > 0 ? body.slice(0, 6000) : undefined;
    }
    i++;
  }
  return undefined;
}

export interface ParsedComment {
  author: string;
  created: string;
  body: string;
}

/**
 * Extract comments from a `## Comments` section.
 * Each comment is a block starting with `**author** — timestamp` followed by body lines.
 */
export function extractComments(content: string): ParsedComment[] {
  const sectionBody = extractSectionBody(content, 'Comments');
  if (!sectionBody) {
    return [];
  }
  const comments: ParsedComment[] = [];
  const headerRe = /^\*\*(.+?)\*\*\s*(?:—|--|-)\s*(.+)$/;
  const lines = sectionBody.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const m = headerRe.exec(lines[i]);
    if (m) {
      const author = m[1].trim();
      const created = m[2].trim();
      i++;
      const bodyLines: string[] = [];
      while (i < lines.length && !headerRe.test(lines[i])) {
        bodyLines.push(lines[i]);
        i++;
      }
      const body = bodyLines.join('\n').trim();
      if (body.length > 0) {
        comments.push({ author, created, body });
      }
    } else {
      i++;
    }
  }
  return comments;
}

export function buildDescription(content: string): string {
  return (
    extractSectionBody(content, 'Description') ??
    extractSectionBody(content, 'Summary') ??
    extractSectionBody(content, 'Deliverables (from master plan)') ??
    extractSectionBody(content, 'Deliverables') ??
    content.slice(0, 2000).trim()
  );
}

/** Map free-text markdown status lines to workflow status names. */
/**
 * @deprecated Use `resolveStatus(raw, workflow)` — a plan folder's statuses now
 * come from the board's declared workflow (FX-BE-044). This remains as the
 * default-workflow shorthand so existing callers keep their exact behaviour.
 */
export function mapMarkdownStatusToPlanStatus(raw: string): string {
  return resolveStatus(raw, DEFAULT_WORKFLOW);
}

type FileKind = 'file' | 'directory';

export interface IdentifiedPlanFolder {
  plansRootPath: string;
  featuresRootPath: string;
  featureEntries: [string, FileKind][];
}

const FEATURE_DIR = /^feature-(\d+)-/i;
const CHILD_FILE_PREFIX_TO_ISSUE_TYPE = {
  story: 'Story',
  task: 'Task',
  bug: 'Bug',
  idea: 'Idea'
} as const;

/** Normalize a `**Type:**` front matter value to a canonical child issue type, or undefined. */
function normalizeChildIssueType(raw: string | undefined): 'Story' | 'Task' | 'Bug' | 'Idea' | undefined {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === 'story') { return 'Story'; }
  if (trimmed === 'task') { return 'Task'; }
  if (trimmed === 'bug') { return 'Bug'; }
  if (trimmed === 'idea') { return 'Idea'; }
  return undefined;
}
const SEARCH_SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.idea',
  '.next',
  '.svn',
  '.turbo',
  '.vscode',
  'bin',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'target'
]);

interface ParsedChildFileName {
  featureId: number | undefined;
  sequence: number;
  issueType: 'Story' | 'Task' | 'Bug' | 'Idea';
}

/**
 * Parse child item filenames in two formats:
 * - Strict: `{type}-{featureId}-{sequence}-{slug}.md` (e.g., bug-01-1-fix.md)
 * - Loose:  `{type}-{sequence}-{ref}-{slug}.md` (e.g., bug-001-s107-name.md)
 *
 * The loose format is used when bugs/tasks are filed independently and the
 * second segment is not a pure number (contains letters like "s107").
 */
function parseChildFileName(name: string): ParsedChildFileName | undefined {
  // Strict format: type-featureId-sequence-slug.md
  const strict = name.match(/^(story|task|bug|idea)-(\d+)-(\d+)-.+\.md$/i);
  if (strict) {
    const prefix = strict[1].toLowerCase() as keyof typeof CHILD_FILE_PREFIX_TO_ISSUE_TYPE;
    return {
      issueType: CHILD_FILE_PREFIX_TO_ISSUE_TYPE[prefix],
      featureId: Number.parseInt(strict[2], 10),
      sequence: Number.parseInt(strict[3], 10)
    };
  }

  // Loose format: type-sequence-ref-slug.md (ref contains letters)
  const loose = name.match(/^(story|task|bug|idea)-(\d+)-[a-z]\w*-.+\.md$/i);
  if (loose) {
    const prefix = loose[1].toLowerCase() as keyof typeof CHILD_FILE_PREFIX_TO_ISSUE_TYPE;
    return {
      issueType: CHILD_FILE_PREFIX_TO_ISSUE_TYPE[prefix],
      featureId: undefined,
      sequence: Number.parseInt(loose[2], 10)
    };
  }

  return undefined;
}

function extractDependenciesSectionBody(content: string): string {
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    if (/^##\s+Dependencies\b/i.test(lines[i])) {
      i++;
      const buf: string[] = [];
      while (i < lines.length && !/^##\s/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      return buf.join('\n');
    }
    i++;
  }
  return '';
}

function extractDependsOnLine(content: string): string {
  const m = content.match(/^\*\*Depends(?:\s+on)?:\*\*\s*(.+)$/im);
  return m?.[1]?.trim() ?? '';
}

/**
 * An issue key, local or external: one or more hyphenated uppercase segments
 * ending in a numeric id (FX-BE-051, TASK-031, KAMAI-4). Segments, not a fixed
 * prefix list, so a new local id shape (e.g. FX-XY-001) is never truncated.
 */
const ISSUE_KEY_SOURCE = '[A-Z][A-Z0-9_]*(?:-[A-Z][A-Z0-9_]*)*-\\d+';

function scanDependencyTokens(text: string): string[] {
  const out = new Set<string>();
  const issueKey = new RegExp(`\\b(${ISSUE_KEY_SOURCE})\\b`, 'g');
  let m: RegExpExecArray | null;
  while ((m = issueKey.exec(text))) {
    out.add(m[1]);
  }
  const featureDir = /\b(feature-\d+-[a-z0-9]+(?:-[a-z0-9]+)*)\b/gi;
  while ((m = featureDir.exec(text))) {
    out.add(m[1]);
  }
  const childRef = /\b((?:story|task|bug|idea)-\d+-\d+(?:-[a-z0-9]+)*)\b/gi;
  while ((m = childRef.exec(text))) {
    out.add(m[1]);
  }
  return [...out];
}

export function collectDependencyTokens(content: string): string[] {
  const parts: string[] = [];
  const section = extractDependenciesSectionBody(content);
  if (section.trim().length > 0) {
    parts.push(section);
  }
  const line = extractDependsOnLine(content);
  if (line.length > 0) {
    parts.push(line);
  }
  const tokens = new Set(scanDependencyTokens(parts.join('\n')));
  for (const token of extractFrontMatterDependencyTokens(content)) {
    tokens.add(token);
  }
  return [...tokens];
}

function parseFlexibleDate(value: string): string | undefined {
  const t = value.trim();
  if (!t) {
    return undefined;
  }
  const d = new Date(t);
  if (!Number.isNaN(d.getTime())) {
    return d.toISOString();
  }
  return undefined;
}

export function extractPlanningDates(content: string): ParsedPlanningDates {
  const pick = (patterns: RegExp[]): string | undefined => {
    for (const re of patterns) {
      const m = content.match(re);
      if (m?.[1]) {
        const iso = parseFlexibleDate(m[1]);
        if (iso) {
          return iso;
        }
      }
    }
    return undefined;
  };
  const created = pick([/^\*\*Created:\*\*\s*(.+)$/im, /^\*\*Start date:\*\*\s*(.+)$/im]);
  const completed = pick([
    /^\*\*Completed:\*\*\s*(.+)$/im,
    /^\*\*Finished:\*\*\s*(.+)$/im,
    /^\*\*Done:\*\*\s*(.+)$/im
  ]);
  return { created, completed };
}

// ── Stable key generation ───────────────────────────────────────────

/** Generate a stable issue key from folder/file names so keys don't shift when folders are added. */
export function stableFeatureKey(projectKey: string, featureId: number): string {
  return `${projectKey}-F${String(featureId).padStart(2, '0')}`;
}

export function stableStoryKey(projectKey: string, featureId: number, storySeq: number): string {
  return `${projectKey}-S${String(featureId).padStart(2, '0')}-${storySeq}`;
}

function childIssueTypeKeyPrefix(issueType: string): string {
  switch (issueType.trim().toLowerCase()) {
    case 'story':
      return 'S';
    case 'task':
      return 'T';
    case 'bug':
      return 'B';
    default:
      return 'I';
  }
}

export function stableChildKey(
  projectKey: string,
  issueType: string,
  featureId: number,
  sequence: number
): string {
  const prefix = childIssueTypeKeyPrefix(issueType);
  return `${projectKey}-${prefix}${String(featureId).padStart(2, '0')}-${sequence}`;
}

// ── Main parser ─────────────────────────────────────────────────────

/**
 * Safely read a directory, returning `undefined` if it does not exist or is unreadable.
 */
async function readDirectorySafe(dirPath: string): Promise<[string, FileKind][] | undefined> {
  try {
    return await folderFs().readDirectory(dirPath);
  } catch {
    return undefined;
  }
}

async function hasFeatureMarkdown(featureDirPath: string): Promise<boolean> {
  const entries = await readDirectorySafe(featureDirPath);
  return (
    entries?.some(([name, type]) => type === 'file' && name.toLowerCase() === 'feature.md') ?? false
  );
}

async function containsFeaturePlanFolders(
  rootPath: string,
  entries: [string, FileKind][]
): Promise<boolean> {
  for (const [name, type] of entries) {
    if (type !== 'directory') {
      continue;
    }
    if (await hasFeatureMarkdown(path.join(rootPath, name))) {
      return true;
    }
  }
  return false;
}

function scoreSearchDirectory(name: string): number {
  const lower = name.toLowerCase();
  if (lower === 'plans' || lower === 'plan') {
    return 100;
  }
  if (lower === 'features' || lower === 'feature') {
    return 90;
  }
  if (lower.includes('plan')) {
    return 80;
  }
  if (lower.includes('feature')) {
    return 70;
  }
  if (lower === 'docs' || lower === 'doc') {
    return 60;
  }
  if (lower.includes('ticket') || lower.includes('roadmap')) {
    return 50;
  }
  return 0;
}

function listSearchableSubdirectories(entries: [string, FileKind][]): string[] {
  return entries
    .filter(([name, type]) => type === 'directory' && !SEARCH_SKIP_DIRS.has(name.toLowerCase()))
    .map(([name]) => name)
    .sort((a, b) => {
      const scoreDiff = scoreSearchDirectory(b) - scoreSearchDirectory(a);
      return scoreDiff !== 0 ? scoreDiff : a.localeCompare(b);
    });
}

/**
 * Whether a directory listing sits on a git checkout boundary, and of which kind.
 *
 * A `.git` **directory** is a clone — a different repository, whose plans are a
 * different project's. A `.git` **file** (`gitdir: …`) is a worktree — the *same*
 * repository with another branch checked out, so its plans are the same plans at
 * a different commit. Unioning those into one board produced the same ticket key
 * several times over, with edits landing in whichever copy the scan reached first.
 */
function checkoutKind(entries: [string, FileKind][]): 'clone' | 'worktree' | undefined {
  const git = entries.find(([name]) => name.toLowerCase() === '.git');
  if (!git) {
    return undefined;
  }
  return git[1] === 'directory' ? 'clone' : 'worktree';
}

function canonicalPlansRootPath(candidateRoot: string, featuresRootPath: string): string {
  if (
    candidateRoot === featuresRootPath &&
    path.basename(featuresRootPath).toLowerCase() === 'features'
  ) {
    return path.dirname(featuresRootPath);
  }
  return candidateRoot;
}

function toDirectoryPath(selectedRoot: string): string {
  return normalizeConfiguredFolderPath(selectedRoot);
}

const CHILD_ITEM_SUBDIRS = ['bugs', 'tasks', 'stories'];

async function containsChildItemDirs(rootPath: string): Promise<boolean> {
  for (const subdir of CHILD_ITEM_SUBDIRS) {
    const subdirPath = path.join(rootPath, subdir);
    const entries = await readDirectorySafe(subdirPath);
    if (entries?.some(([name, type]) => type === 'file' && name.toLowerCase().endsWith('.md'))) {
      return true;
    }
  }
  return false;
}

/** Check if a directory (or its immediate subdirectories) contains .md files with recognized front matter types. */
async function containsTypedMarkdownFiles(rootPath: string): Promise<boolean> {
  const entries = await readDirectorySafe(rootPath);
  if (!entries) {
    return false;
  }

  // Check .md files directly in this directory
  for (const [name, type] of entries) {
    if (type === 'file' && name.toLowerCase().endsWith('.md')) {
      try {
        const content = await readUtf8(path.join(rootPath, name));
        if (normalizeChildIssueType(extractTypeRaw(content))) {
          return true;
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  // Check .md files in immediate subdirectories (any name, not just bugs/tasks/stories)
  for (const [name, type] of entries) {
    if (type !== 'directory' || SEARCH_SKIP_DIRS.has(name.toLowerCase())) {
      continue;
    }
    const subEntries = await readDirectorySafe(path.join(rootPath, name));
    if (!subEntries) {
      continue;
    }
    for (const [fname, ftype] of subEntries) {
      if (ftype === 'file' && fname.toLowerCase().endsWith('.md')) {
        try {
          const content = await readUtf8(path.join(rootPath, name, fname));
          if (normalizeChildIssueType(extractTypeRaw(content))) {
            return true;
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  return false;
}

export async function identifyPlanFolderAtRoot(
  candidateRoot: string,
  rootEntries?: [string, FileKind][],
  /**
   * Whether a bare `bugs/`/`tasks/`/`stories/` directory (with no `feature.md`
   * anywhere above it) may be accepted as its own plan root on its own.
   *
   * True only for the folder a connection is actually pointed at — that is
   * the "standalone bug/task tracking" case the fallback below exists for.
   * `discoverPlanFolders`' BFS passes false for every candidate it reaches by
   * walking down from there: a `stories/` folder found a level or two below an
   * unmatched parent is someone's feature folder that failed to match (e.g. a
   * `feature-issues.md` mirror instead of `feature.md`), not an independent
   * board, and must not be promoted into one just because one of its child
   * items happens to carry a recognized `type:`.
   */
  allowStandaloneChildItems = true
): Promise<IdentifiedPlanFolder | undefined> {
  const featuresPath = path.join(candidateRoot, 'features');
  const featureEntries = await readDirectorySafe(featuresPath);
  if (featureEntries && (await containsFeaturePlanFolders(featuresPath, featureEntries))) {
    return {
      plansRootPath: candidateRoot,
      featuresRootPath: featuresPath,
      featureEntries
    };
  }
  // An empty features/ directory marks a brand-new plans root (Create Board
  // initializes this when the user picks a folder with no existing plans).
  if (featureEntries && featureEntries.length === 0) {
    return {
      plansRootPath: candidateRoot,
      featuresRootPath: featuresPath,
      featureEntries
    };
  }

  const entries = rootEntries ?? (await readDirectorySafe(candidateRoot));
  if (entries && (await containsFeaturePlanFolders(candidateRoot, entries))) {
    return {
      plansRootPath: canonicalPlansRootPath(candidateRoot, candidateRoot),
      featuresRootPath: candidateRoot,
      featureEntries: entries
    };
  }

  if (!allowStandaloneChildItems) {
    return undefined;
  }

  // Accept as a plan folder if it has child-item subdirectories (bugs/, tasks/, stories/)
  // even without feature folders — supports standalone bug/task tracking
  if (await containsChildItemDirs(candidateRoot)) {
    return {
      plansRootPath: candidateRoot,
      featuresRootPath: featureEntries ? featuresPath : candidateRoot,
      featureEntries: featureEntries ?? entries ?? []
    };
  }

  // Accept if any .md files (here or in immediate subdirs) have recognized **Type:** front matter
  if (await containsTypedMarkdownFiles(candidateRoot)) {
    return {
      plansRootPath: candidateRoot,
      featuresRootPath: featureEntries ? featuresPath : candidateRoot,
      featureEntries: featureEntries ?? entries ?? []
    };
  }

  return undefined;
}

/**
 * Discover every plans root under a selected folder (breadth-first).
 *
 * - If the selected folder itself is a plans root, returns only that one.
 * - Otherwise returns each distinct nested plans root (e.g. one per sub-repo).
 *   Once a plans root is found, its children are not searched further so nested
 *   `features/` trees are not reported as separate boards.
 */
export async function discoverPlanFolders(
  selectedRoot: string,
  onProgress?: (message: string) => void
): Promise<IdentifiedPlanFolder[]> {
  const selectedRootPath = toDirectoryPath(selectedRoot);

  const directMatch = await identifyPlanFolderAtRoot(selectedRootPath);

  const rootEntries = await readDirectorySafe(selectedRootPath);
  if (!rootEntries) {
    throw new Error(buildUnreadablePathError(selectedRoot));
  }

  const matches: IdentifiedPlanFolder[] = [];
  const seen = new Set<string>([selectedRootPath]);
  const queue = listSearchableSubdirectories(rootEntries).map(name => {
    const p = path.join(selectedRootPath, name);
    seen.add(p);
    return p;
  });

  while (queue.length > 0) {
    const current = queue.shift()!;

    const currentEntries = await readDirectorySafe(current);
    if (!currentEntries) {
      continue;
    }
    onProgress?.(`Searching for plans in ${current}`);

    // A nested checkout owns its own plans: a worktree holds the same plans on
    // another branch (the same ticket keys), and a nested clone is a different
    // project entirely. Neither belongs to the folder enclosing it. Scanning a
    // checkout directly still works — `selectedRootPath` is never enqueued here.
    if (checkoutKind(currentEntries)) {
      continue;
    }

    // A candidate reached by walking down from the selected root is never
    // allowed to claim board status purely via the standalone bugs/tasks/stories
    // fallback — only the folder a connection is actually pointed at may (see
    // `identifyPlanFolderAtRoot`'s `allowStandaloneChildItems`).
    const identified = await identifyPlanFolderAtRoot(current, currentEntries, false);
    if (identified) {
      matches.push(identified);
      // Do not descend into a plans root — avoid duplicate nested boards.
      continue;
    }

    for (const name of listSearchableSubdirectories(currentEntries)) {
      const childPath = path.join(current, name);
      if (seen.has(childPath)) {
        continue;
      }
      seen.add(childPath);
      queue.push(childPath);
    }
  }

  // A parent can look like a plans root because it contains loose markdown files
  // while also containing repository plans roots. Prefer the nested repositories
  // when any were found; otherwise retain the selected folder as a single board.
  return matches.length > 0 ? matches : directMatch ? [directMatch] : [];
}

/**
 * Discover Git repository roots below a selected folder, including the
 * selected folder when it is itself a repository. This bootstraps empty
 * repositories before they have a `features/` plans tree.
 */
export async function discoverRepositoryFolders(
  selectedRoot: string,
  onProgress?: (message: string) => void
): Promise<string[]> {
  const selectedRootPath = toDirectoryPath(selectedRoot);
  const rootEntries = await readDirectorySafe(selectedRootPath);
  if (!rootEntries) {
    throw new Error(buildUnreadablePathError(selectedRoot));
  }

  const repositories: string[] = [];
  const seen = new Set<string>([selectedRootPath]);
  const queue = [selectedRootPath];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = current === selectedRootPath ? rootEntries : await readDirectorySafe(current);
    if (!entries) {
      continue;
    }
    onProgress?.(`Searching for repositories in ${current}`);

    // Worktrees are deliberately not offered: a worktree is the repository it
    // was created from, on another branch, so importing one alongside its main
    // checkout would produce two projects over the same plans. Point a project
    // straight at a worktree when you want a board for that branch's state.
    const kind = checkoutKind(entries);
    if (kind === 'clone') {
      repositories.push(current);
    }

    for (const name of listSearchableSubdirectories(entries)) {
      const childPath = path.join(current, name);
      if (!seen.has(childPath)) {
        seen.add(childPath);
        queue.push(childPath);
      }
    }
  }

  return repositories;
}

/**
 * Resolve a selected folder to the actual plans root and features folder.
 *
 * Search order:
 *  1. `<selected>/features/`
 *  2. `<selected>/`
 *  3. All searchable nested subdirectories below `<selected>` (breadth-first)
 */
export async function identifyPlanFolder(
  selectedRoot: string,
  onProgress?: (message: string) => void
): Promise<IdentifiedPlanFolder> {
  const selectedRootPath = toDirectoryPath(selectedRoot);
  const directMatch = await identifyPlanFolderAtRoot(selectedRootPath);
  if (directMatch) {
    return directMatch;
  }
  const matches = await discoverPlanFolders(selectedRoot, onProgress);
  if (matches.length > 0) {
    return matches[0];
  }

  // A plans folder does not need any particular subfolder to be valid. Tickets
  // are plain markdown files discovered anywhere in the tree, so an explicitly
  // selected folder is a usable plans root as long as it can be read.
  // Recursive discovery stays strict — only this explicit selection is accepted.
  const selectedEntries = await readDirectorySafe(selectedRootPath);
  if (selectedEntries) {
    return {
      plansRootPath: selectedRootPath,
      featuresRootPath: path.join(selectedRootPath, 'features'),
      featureEntries: []
    };
  }

  throw new Error(buildUnreadablePathError(selectedRootPath));
}

/**
 * Scans a `plans`-style root folder and returns parsed features and child markdown items.
 * Does not modify the source tree — pure read operation.
 *
 * Automatically discovers the plans/features directory by searching beneath
 * the selected root when needed.
 */
export async function parsePlanFolder(
  plansRoot: string,
  onProgress?: (message: string) => void,
  /** The board's declared workflow; defaults to the five statuses folders have always used. */
  workflow?: readonly ProjectWorkflowStage[]
): Promise<ParsedPlanFolder> {
  const progress = onProgress ?? (() => undefined);

  const identified = await identifyPlanFolder(plansRoot, progress);
  return parsePlanFolderRecursively(identified, progress, workflow);

  // Legacy depth-limited implementation retained below until the recursive
  // parser has fully replaced it and its compatibility coverage is complete.
  const { plansRootPath, featuresRootPath, featureEntries } = identified;

  progress('Scanning feature folders…');

  let autoFeatureId = 9000;
  const features: ParsedFeatureFolder[] = [];
  for (const [name, type] of featureEntries) {
    if (type !== 'directory') {
      continue;
    }
    const featureMdPath = path.join(featuresRootPath, name, 'feature.md');
    let content: string;
    try {
      content = await readUtf8(featureMdPath);
    } catch {
      continue;
    }
    const dirMatch = name.match(FEATURE_DIR);
    const featureId = dirMatch ? Number.parseInt(dirMatch?.[1] ?? '', 10) : autoFeatureId++;
    progress(`Reading feature: ${name}/feature.md`);
    features.push({
      dirName: name,
      featureId,
      title: extractMainHeading(content),
      planStatus: mapMarkdownStatusToPlanStatus(extractStatusRaw(content)),
      description: buildDescription(content),
      featureMdPath,
      depTokens: collectDependencyTokens(content),
      planningDates: extractPlanningDates(content),
      priority: extractPriorityRaw(content),
      model: extractModelRaw(content),
      complexity: extractComplexityRaw(content)
    });
  }

  features.sort((a, b) => {
    if (a.featureId !== b.featureId) {
      return a.featureId - b.featureId;
    }
    return a.dirName.localeCompare(b.dirName);
  });

  const stories: ParsedStoryFile[] = [];
  const childItems: ParsedChildFile[] = [];
  const seenChildFiles = new Set<string>();
  let autoSequence = 9000; // high base to avoid collisions with filename-derived sequences

  // Scan inside each feature directory
  for (const folder of features) {
    const folderPath = path.join(featuresRootPath, folder.dirName);
    const files = await folderFs().readDirectory(folderPath);
    for (const [fname, kind] of files) {
      if (kind !== 'file' || !fname.toLowerCase().endsWith('.md')) {
        continue;
      }
      if (fname.toLowerCase() === 'feature.md') {
        continue;
      }
      const filePath = path.join(folderPath, fname);
      const scontent = await readUtf8(filePath);

      // Try filename-based parsing first, then fall back to front matter **Type:**
      const parsed = parseChildFileName(fname);
      let issueType: 'Story' | 'Task' | 'Bug' | 'Idea';
      let resolvedFeatureId: number;
      let sequence: number;

      if (parsed) {
        // Strict-format files must match the folder's featureId;
        // loose-format files (featureId undefined) inherit it from the folder.
        if (parsed!.featureId !== undefined && parsed!.featureId !== folder.featureId) {
          continue;
        }
        issueType = parsed!.issueType;
        resolvedFeatureId = parsed!.featureId ?? folder.featureId;
        sequence = parsed!.sequence;
      } else {
        // Fall back to front matter type detection
        const contentType = normalizeChildIssueType(extractTypeRaw(scontent));
        if (!contentType) {
          continue;
        }
        issueType = contentType!;
        resolvedFeatureId = folder.featureId;
        sequence = autoSequence++;
      }

      progress(`Reading ${issueType.toLowerCase()}: ${folder.dirName}/${fname}`);
      seenChildFiles.add(fname.toLowerCase());
      childItems.push({
        featureId: resolvedFeatureId,
        sequence,
        filename: fname,
        issueType,
        title: extractMainHeading(scontent),
        planStatus: mapMarkdownStatusToPlanStatus(extractStatusRaw(scontent)),
        description: buildDescription(scontent),
        ideaTranscript: extractSectionBody(scontent, 'Research Transcript'),
        relativePath: `${folder.dirName}/${fname}`,
        filePath,
        depTokens: collectDependencyTokens(scontent),
        planningDates: extractPlanningDates(scontent),
        branch: extractBranchRaw(scontent),
        priority: extractPriorityRaw(scontent),
        model: extractModelRaw(scontent),
        complexity: extractComplexityRaw(scontent),
        severity: extractSeverityRaw(scontent),
        reportedBy: extractReportedByRaw(scontent)
      });
      if (issueType === 'Story') {
        stories.push({
          featureId: resolvedFeatureId,
          storySeq: sequence,
          filename: fname,
          title: extractMainHeading(scontent),
          planStatus: mapMarkdownStatusToPlanStatus(extractStatusRaw(scontent)),
          description: buildDescription(scontent),
          ideaTranscript: extractSectionBody(scontent, 'Research Transcript'),
          relativePath: `${folder.dirName}/${fname}`,
          storyMdPath: filePath,
          depTokens: collectDependencyTokens(scontent),
          planningDates: extractPlanningDates(scontent),
          branch: extractBranchRaw(scontent)
        });
      }
    }
  }

  // Also scan the features root and additional directories for child items
  // not nested inside feature dirs (e.g., plans/, plans/bugs/, or any subdirectory)
  const featureIdSet = new Set(features.map(f => f.featureId));
  const featureDirNames = new Set(features.map(f => f.dirName.toLowerCase()));
  const additionalDirs: string[] = [featuresRootPath];
  const scannedDirPaths = new Set<string>([featuresRootPath]);

  // Scan plansRootPath if it differs from featuresRootPath
  if (plansRootPath !== featuresRootPath) {
    additionalDirs.push(plansRootPath);
    scannedDirPaths.add(plansRootPath);
  }

  // Scan ALL subdirectories under plansRootPath (not just bugs/tasks/stories)
  const rootEntriesToScan = await readDirectorySafe(plansRootPath);
  if (rootEntriesToScan) {
    for (const [subName, subType] of rootEntriesToScan ?? []) {
      if (subType !== 'directory' || SEARCH_SKIP_DIRS.has(subName.toLowerCase())) {
        continue;
      }
      // Skip feature directories — already scanned above
      if (featureDirNames.has(subName.toLowerCase())) {
        continue;
      }
      const subdirPath = path.join(plansRootPath, subName);
      if (!scannedDirPaths.has(subdirPath)) {
        additionalDirs.push(subdirPath);
        scannedDirPaths.add(subdirPath);
      }
    }
  }

  for (const dirPath of additionalDirs) {
    let dirEntries: [string, FileKind][];
    if (dirPath === featuresRootPath) {
      dirEntries = featureEntries;
    } else {
      const entries = await readDirectorySafe(dirPath);
      if (!entries) {
        continue;
      }
      dirEntries = entries!;
    }
    for (const [fname, ftype] of dirEntries) {
      if (ftype !== 'file' || !fname.toLowerCase().endsWith('.md')) {
        continue;
      }
      if (seenChildFiles.has(fname.toLowerCase())) {
        continue;
      }
      const filePath = path.join(dirPath, fname);
      const scontent = await readUtf8(filePath);

      // Try filename-based parsing first, then fall back to front matter **Type:**
      const parsed = parseChildFileName(fname);
      let issueType: 'Story' | 'Task' | 'Bug' | 'Idea';
      let resolvedFeatureId: number | undefined;
      let sequence: number;

      if (parsed) {
        // Strict-format must reference a known feature; loose-format (no featureId) is always accepted
        if (parsed!.featureId !== undefined && !featureIdSet.has(parsed!.featureId!)) {
          continue;
        }
        issueType = parsed!.issueType;
        resolvedFeatureId = parsed!.featureId;
        sequence = parsed!.sequence;
      } else {
        // Fall back to front matter type detection
        const contentType = normalizeChildIssueType(extractTypeRaw(scontent));
        if (!contentType) {
          continue;
        }
        issueType = contentType!;
        resolvedFeatureId = undefined;
        sequence = autoSequence++;
      }

      progress(`Reading ${issueType.toLowerCase()}: ${fname}`);
      seenChildFiles.add(fname.toLowerCase());
      childItems.push({
        featureId: resolvedFeatureId,
        sequence,
        filename: fname,
        issueType,
        title: extractMainHeading(scontent),
        planStatus: mapMarkdownStatusToPlanStatus(extractStatusRaw(scontent)),
        description: buildDescription(scontent),
        ideaTranscript: extractSectionBody(scontent, 'Research Transcript'),
        relativePath: fname,
        filePath,
        depTokens: collectDependencyTokens(scontent),
        planningDates: extractPlanningDates(scontent),
        branch: extractBranchRaw(scontent),
        priority: extractPriorityRaw(scontent),
        model: extractModelRaw(scontent),
        complexity: extractComplexityRaw(scontent),
        severity: extractSeverityRaw(scontent),
        reportedBy: extractReportedByRaw(scontent)
      });
      if (issueType === 'Story' && resolvedFeatureId !== undefined) {
        stories.push({
          featureId: resolvedFeatureId!,
          storySeq: sequence,
          filename: fname,
          title: extractMainHeading(scontent),
          planStatus: mapMarkdownStatusToPlanStatus(extractStatusRaw(scontent)),
          description: buildDescription(scontent),
          ideaTranscript: extractSectionBody(scontent, 'Research Transcript'),
          relativePath: fname,
          storyMdPath: filePath,
          depTokens: collectDependencyTokens(scontent),
          planningDates: extractPlanningDates(scontent),
          branch: extractBranchRaw(scontent)
        });
      }
    }
  }

  childItems.sort((a, b) => {
    const aFid = a.featureId ?? 0;
    const bFid = b.featureId ?? 0;
    if (aFid !== bFid) {
      return aFid - bFid;
    }
    if (a.issueType !== b.issueType) {
      return a.issueType.localeCompare(b.issueType);
    }
    if (a.sequence !== b.sequence) {
      return a.sequence - b.sequence;
    }
    return a.filename.localeCompare(b.filename);
  });

  stories.sort((a, b) => {
    if (a.featureId !== b.featureId) {
      return a.featureId - b.featureId;
    }
    if (a.storySeq !== b.storySeq) {
      return a.storySeq - b.storySeq;
    }
    return a.filename.localeCompare(b.filename);
  });

  return { features, stories, childItems, plansRootPath, featuresRootPath };
}

interface MarkdownPlanFile {
  filePath: string;
  relativePath: string;
  name: string;
  content: string;
}

/** Recursively reads Markdown planning files. Folder names are deliberately not
 * used as an eligibility rule; metadata and legacy filename conventions decide
 * what each document represents. */
async function readMarkdownPlanFiles(rootPath: string, currentPath = rootPath, result: MarkdownPlanFile[] = []): Promise<MarkdownPlanFile[]> {
  const entries = await readDirectorySafe(currentPath);
  if (!entries) return result;
  for (const [name, type] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (SEARCH_SKIP_DIRS.has(name.toLowerCase())) continue;
    const filePath = path.join(currentPath, name);
    if (type === 'directory') {
      await readMarkdownPlanFiles(rootPath, filePath, result);
    } else if (name.toLowerCase().endsWith('.md')) {
      try {
        result.push({ filePath, relativePath: path.relative(rootPath, filePath).replaceAll(path.sep, '/'), name, content: await readUtf8(filePath) });
      } catch {
        // Ignore files that disappear or cannot be read during a refresh.
      }
    }
  }
  return result;
}

function planningNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /(?:FX-(?:BF|BE)|TASK)-0*(\d+)/i.exec(value) || /(?:^|[\\/-])feature-0*(\d+)(?:-|$)/i.exec(value);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function planningFeatureId(file: MarkdownPlanFile, featureDirectories: Map<string, number>): number | undefined {
  const explicit = extractFrontMatterValue(file.content, 'feature') || file.content.match(/^\*\*Feature:\*\*\s*(.+)$/im)?.[1];
  if (explicit) return planningNumber(explicit);
  let directory = path.dirname(file.filePath);
  while (directory.length >= path.dirname(directory).length) {
    const found = featureDirectories.get(directory);
    if (found !== undefined) return found;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return planningNumber(file.name);
}

async function parsePlanFolderRecursively(
  identified: IdentifiedPlanFolder,
  progress: (message: string) => void,
  workflow: readonly ProjectWorkflowStage[] = DEFAULT_WORKFLOW
): Promise<ParsedPlanFolder> {
  const { plansRootPath, featuresRootPath } = identified;
  const files = await readMarkdownPlanFiles(plansRootPath);
  const featureFiles = files.filter(file => file.name.toLowerCase() === 'feature.md' || extractTypeRaw(file.content)?.trim().toLowerCase() === 'feature');
  const featureDirectories = new Map<string, number>();
  const usedFeatureIds = new Set<number>();
  let autoFeatureId = 9000;
  const features: ParsedFeatureFolder[] = [];
  for (const file of featureFiles) {
    let featureId = planningNumber(extractFrontMatterValue(file.content, 'id'))
      || planningNumber(path.dirname(file.filePath))
      || autoFeatureId++;
    while (usedFeatureIds.has(featureId)) featureId = autoFeatureId++;
    usedFeatureIds.add(featureId);
    const directory = path.dirname(file.filePath);
    featureDirectories.set(directory, featureId);
    progress(`Reading feature: ${file.relativePath}`);
    features.push({
      planningId: extractFrontMatterValue(file.content, 'id'),
      dirName: path.relative(featuresRootPath, directory).replaceAll(path.sep, '/') || path.basename(directory),
      featureId,
      title: extractMainHeading(file.content),
      planStatus: resolveStatus(extractStatusRaw(file.content), workflow),
      description: buildDescription(file.content),
      featureMdPath: file.filePath,
      depTokens: collectDependencyTokens(file.content),
      planningDates: extractPlanningDates(file.content),
      priority: extractPriorityRaw(file.content),
      model: extractModelRaw(file.content),
      complexity: extractComplexityRaw(file.content)
    });
  }
  features.sort((left, right) => left.featureId - right.featureId || left.dirName.localeCompare(right.dirName));

  const featureIdByDirectory = new Map(featureDirectories);
  const childFiles = files.filter(file => !featureFiles.includes(file));
  let autoSequence = 9000;
  const childItems: ParsedChildFile[] = [];
  for (const file of childFiles) {
    const parsedName = parseChildFileName(file.name);
    const issueType = normalizeChildIssueType(extractTypeRaw(file.content)) || parsedName?.issueType;
    if (!issueType) continue;
    const featureId = planningFeatureId(file, featureIdByDirectory);
    const sequence = planningNumber(extractFrontMatterValue(file.content, 'id')) ?? parsedName?.sequence ?? autoSequence++;
    progress(`Reading ${issueType.toLowerCase()}: ${file.relativePath}`);
    childItems.push({
      planningId: extractFrontMatterValue(file.content, 'id'),
      featureId,
      sequence,
      filename: file.name,
      issueType,
      title: extractMainHeading(file.content),
      planStatus: resolveStatus(extractStatusRaw(file.content), workflow),
      description: buildDescription(file.content),
      ideaTranscript: extractSectionBody(file.content, 'Research Transcript'),
      relativePath: file.relativePath,
      filePath: file.filePath,
      depTokens: collectDependencyTokens(file.content),
      planningDates: extractPlanningDates(file.content),
      branch: extractBranchRaw(file.content),
      priority: extractPriorityRaw(file.content),
      severity: extractSeverityRaw(file.content),
      reportedBy: extractReportedByRaw(file.content),
      model: extractModelRaw(file.content),
      complexity: extractComplexityRaw(file.content)
    });
  }
  childItems.sort((left, right) => (left.featureId ?? 0) - (right.featureId ?? 0) || left.issueType.localeCompare(right.issueType) || left.sequence - right.sequence || left.relativePath.localeCompare(right.relativePath));
  const stories: ParsedStoryFile[] = childItems.filter(child => child.issueType === 'Story' && child.featureId !== undefined).map(child => ({
    featureId: child.featureId!, storySeq: child.sequence, filename: child.filename, title: child.title,
    planStatus: child.planStatus, description: child.description, ideaTranscript: child.ideaTranscript,
    relativePath: child.relativePath, storyMdPath: child.filePath, depTokens: child.depTokens,
    planningDates: child.planningDates, branch: child.branch
  }));
  return { features, stories, childItems, plansRootPath, featuresRootPath };
}

/** Resolve explicit local planning ids before interpreting tokens as tracker keys. */
export function resolvePlanDependencyKeys(parsed: ParsedPlanFolder, projectKey: string): Map<string, string[]> {
  const records = [
    ...parsed.features.map(feature => ({
      key: stableFeatureKey(projectKey, feature.featureId),
      id: feature.planningId,
      name: feature.dirName,
      tokens: feature.depTokens
    })),
    ...parsed.childItems.map(child => ({
      key: child.issueType === 'Story'
        ? stableStoryKey(projectKey, child.featureId ?? 0, child.sequence)
        : stableChildKey(projectKey, child.issueType, child.featureId ?? 0, child.sequence),
      id: child.planningId,
      name: child.filename.replace(/\.md$/i, '').toLowerCase(),
      tokens: child.depTokens
    }))
  ];
  const localIds = new Map<string, string>();
  const ambiguousIds = new Set<string>();
  for (const record of records) {
    if (!record.id) continue;
    if (localIds.has(record.id)) ambiguousIds.add(record.id);
    else localIds.set(record.id, record.key);
  }
  for (const id of ambiguousIds) localIds.delete(id);

  // Legacy fallback: a story.md/feature.md basename repeats across every
  // feature/story folder, so a name shared by more than one record must
  // resolve to nothing rather than silently pick whichever record was last.
  const names = new Map<string, string>();
  const ambiguousNames = new Set<string>();
  for (const record of records) {
    if (names.has(record.name)) ambiguousNames.add(record.name);
    else names.set(record.name, record.key);
  }
  for (const name of ambiguousNames) names.delete(name);

  const issueKeyPattern = new RegExp(`^${ISSUE_KEY_SOURCE}$`);
  const result = new Map<string, string[]>();
  for (const record of records) {
    if (!record.tokens.length) continue;
    const keys: string[] = [];
    for (const token of record.tokens) {
      if (ambiguousIds.has(token)) continue;
      const key = localIds.get(token)
        ?? (issueKeyPattern.test(token)
          ? token
          : names.get(token) ?? names.get(token.toLowerCase()));
      if (key && key !== record.key && !keys.includes(key)) keys.push(key);
    }
    if (keys.length) result.set(record.key, keys);
  }
  return result;
}
