/*
 * DUPLICATE OF packages/core/src/livefolder/markdownPlanParser.ts — not yet collapsed.
 *
 * Every other module the extension duplicated has been deleted in favour of
 * core's copy. These three livefolder modules are the exception: they are not
 * stale copies but parallel implementations typed against `vscode.Uri` and
 * `vscode.workspace.fs`, where core's equivalents take plain string paths and
 * inject file IO. Collapsing them means rewriting the path handling across
 * ~2,600 lines and adapting Uri <-> string at the extension boundary, in the
 * same way adapters/vsCodeHostStorage.ts adapts storage.
 *
 * That refactor is deliberately not attempted here because it cannot be
 * verified in this environment: `npm test` for this package launches a real
 * VS Code via @vscode/test-cli, and the download for 1.135.0 on darwin-arm64
 * ships its binary as `Code` while vscode-test spawns `Electron`. Symlinking
 * around the name gets past the spawn but the process is then SIGKILLed,
 * because the substitution breaks the bundle's code signature.
 *
 * Until these are collapsed, a behavioural change to plan parsing or live
 * folder sync must be made in BOTH this file and its core counterpart.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
  buildUnreadablePathError,
  normalizeConfiguredFolderPath
} from '@praxis/core';

// ── Shared types ────────────────────────────────────────────────────

export interface ParsedPlanningDates {
  created?: string;
  completed?: string;
}

export interface ParsedFeatureFolder {
  dirName: string;
  featureId: number;
  title: string;
  planStatus: string;
  description: string;
  featureMdUri: vscode.Uri;
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
  storyMdUri: vscode.Uri;
  depTokens: string[];
  planningDates: ParsedPlanningDates;
  branch?: string;
}

export interface ParsedChildFile {
  featureId: number | undefined;
  sequence: number;
  filename: string;
  issueType: 'Story' | 'Task' | 'Bug' | 'Idea';
  title: string;
  planStatus: string;
  description: string;
  ideaTranscript?: string;
  relativePath: string;
  fileUri: vscode.Uri;
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
  plansRootUri: vscode.Uri;
  /** The resolved directory that contains the `feature-NN-*` subdirectories. */
  featuresRootUri: vscode.Uri;
}

// ── Helpers ─────────────────────────────────────────────────────────

export async function readUtf8(uri: vscode.Uri): Promise<string> {
  const bytes = await vscode.workspace.fs.readFile(uri);
  return new TextDecoder('utf-8').decode(bytes);
}

export function extractMainHeading(content: string): string {
  const m = content.match(/^#\s+(.+)$/m);
  return m?.[1]?.trim() ?? 'Untitled';
}

export function extractStatusRaw(content: string): string {
  const m = content.match(/^\*\*Status:\*\*\s*(.+)$/m);
  return m?.[1]?.trim() ?? '';
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
  const m = content.match(/^\*\*Type:\*\*\s*(.+)$/m);
  return m?.[1]?.trim() || undefined;
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
export function mapMarkdownStatusToPlanStatus(raw: string): string {
  const s = raw.toLowerCase();
  if (s.includes('complete') || s.includes('✅') || s.includes('done')) {
    return 'Done';
  }
  if (s.includes('block')) {
    return 'Blocked';
  }
  if (s.includes('progress') || s.includes('doing') || s.includes('wip') || s.includes('🔄')) {
    return 'In Progress';
  }
  if (s.includes('to do') || s.includes('todo') || s.includes('pending') || s.includes('planned')) {
    return 'To Do';
  }
  if (s.includes('backlog')) {
    return 'Backlog';
  }
  return 'Backlog';
}

export interface IdentifiedPlanFolder {
  plansRootUri: vscode.Uri;
  featuresRootUri: vscode.Uri;
  featureEntries: [string, vscode.FileType][];
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

function scanDependencyTokens(text: string): string[] {
  const out = new Set<string>();
  const issueKey = /\b([A-Z][A-Z0-9_]{1,14}-\d+)\b/g;
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
  return scanDependencyTokens(parts.join('\n'));
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
async function readDirectorySafe(
  uri: vscode.Uri
): Promise<[string, vscode.FileType][] | undefined> {
  try {
    return await vscode.workspace.fs.readDirectory(uri);
  } catch {
    return undefined;
  }
}

async function hasFeatureMarkdown(featureDirUri: vscode.Uri): Promise<boolean> {
  const entries = await readDirectorySafe(featureDirUri);
  return (
    entries?.some(
      ([name, type]) => type === vscode.FileType.File && name.toLowerCase() === 'feature.md'
    ) ?? false
  );
}

async function containsFeaturePlanFolders(
  rootUri: vscode.Uri,
  entries: [string, vscode.FileType][]
): Promise<boolean> {
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.Directory) {
      continue;
    }
    if (await hasFeatureMarkdown(vscode.Uri.joinPath(rootUri, name))) {
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

function listSearchableSubdirectories(entries: [string, vscode.FileType][]): string[] {
  return entries
    .filter(
      ([name, type]) => type === vscode.FileType.Directory && !SEARCH_SKIP_DIRS.has(name.toLowerCase())
    )
    .map(([name]) => name)
    .sort((a, b) => {
      const scoreDiff = scoreSearchDirectory(b) - scoreSearchDirectory(a);
      return scoreDiff !== 0 ? scoreDiff : a.localeCompare(b);
    });
}

function canonicalPlansRootUri(candidateRoot: vscode.Uri, featuresRootUri: vscode.Uri): vscode.Uri {
  if (
    candidateRoot.fsPath === featuresRootUri.fsPath &&
    path.basename(featuresRootUri.fsPath).toLowerCase() === 'features'
  ) {
    return vscode.Uri.file(path.dirname(featuresRootUri.fsPath));
  }
  return candidateRoot;
}

function toDirectoryUri(selectedRoot: vscode.Uri | string): vscode.Uri {
  if (typeof selectedRoot !== 'string') {
    return selectedRoot;
  }
  return vscode.Uri.file(normalizeConfiguredFolderPath(selectedRoot));
}

const CHILD_ITEM_SUBDIRS = ['bugs', 'tasks', 'stories'];

async function containsChildItemDirs(rootUri: vscode.Uri): Promise<boolean> {
  for (const subdir of CHILD_ITEM_SUBDIRS) {
    const subdirUri = vscode.Uri.joinPath(rootUri, subdir);
    const entries = await readDirectorySafe(subdirUri);
    if (entries?.some(([name, type]) => type === vscode.FileType.File && name.toLowerCase().endsWith('.md'))) {
      return true;
    }
  }
  return false;
}

/** Check if a directory (or its immediate subdirectories) contains .md files with recognized front matter types. */
async function containsTypedMarkdownFiles(rootUri: vscode.Uri): Promise<boolean> {
  const entries = await readDirectorySafe(rootUri);
  if (!entries) {
    return false;
  }

  // Check .md files directly in this directory
  for (const [name, type] of entries) {
    if (type === vscode.FileType.File && name.toLowerCase().endsWith('.md')) {
      try {
        const content = await readUtf8(vscode.Uri.joinPath(rootUri, name));
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
    if (type !== vscode.FileType.Directory || SEARCH_SKIP_DIRS.has(name.toLowerCase())) {
      continue;
    }
    const subEntries = await readDirectorySafe(vscode.Uri.joinPath(rootUri, name));
    if (!subEntries) {
      continue;
    }
    for (const [fname, ftype] of subEntries) {
      if (ftype === vscode.FileType.File && fname.toLowerCase().endsWith('.md')) {
        try {
          const content = await readUtf8(vscode.Uri.joinPath(rootUri, name, fname));
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
  candidateRoot: vscode.Uri,
  rootEntries?: [string, vscode.FileType][]
): Promise<IdentifiedPlanFolder | undefined> {
  const featuresUri = vscode.Uri.joinPath(candidateRoot, 'features');
  const featureEntries = await readDirectorySafe(featuresUri);
  if (featureEntries && (await containsFeaturePlanFolders(featuresUri, featureEntries))) {
    return {
      plansRootUri: candidateRoot,
      featuresRootUri: featuresUri,
      featureEntries
    };
  }
  // An empty features/ directory marks a brand-new plans root (Create Board
  // initializes this when the user picks a folder with no existing plans).
  if (featureEntries && featureEntries.length === 0) {
    return {
      plansRootUri: candidateRoot,
      featuresRootUri: featuresUri,
      featureEntries
    };
  }

  const entries = rootEntries ?? (await readDirectorySafe(candidateRoot));
  if (entries && (await containsFeaturePlanFolders(candidateRoot, entries))) {
    return {
      plansRootUri: canonicalPlansRootUri(candidateRoot, candidateRoot),
      featuresRootUri: candidateRoot,
      featureEntries: entries
    };
  }

  // Accept as a plan folder if it has child-item subdirectories (bugs/, tasks/, stories/)
  // even without feature folders — supports standalone bug/task tracking
  if (await containsChildItemDirs(candidateRoot)) {
    return {
      plansRootUri: candidateRoot,
      featuresRootUri: featureEntries ? featuresUri : candidateRoot,
      featureEntries: featureEntries ?? entries ?? []
    };
  }

  // Accept if any .md files (here or in immediate subdirs) have recognized **Type:** front matter
  if (await containsTypedMarkdownFiles(candidateRoot)) {
    return {
      plansRootUri: candidateRoot,
      featuresRootUri: featureEntries ? featuresUri : candidateRoot,
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
  selectedRoot: vscode.Uri | string,
  onProgress?: (message: string) => void
): Promise<IdentifiedPlanFolder[]> {
  const selectedRootUri = toDirectoryUri(selectedRoot);

  const directMatch = await identifyPlanFolderAtRoot(selectedRootUri);

  const rootEntries = await readDirectorySafe(selectedRootUri);
  if (!rootEntries) {
    throw new Error(
      buildUnreadablePathError(typeof selectedRoot === 'string' ? selectedRoot : selectedRootUri.fsPath)
    );
  }

  const matches: IdentifiedPlanFolder[] = [];
  const seen = new Set<string>([selectedRootUri.toString()]);
  const queue = listSearchableSubdirectories(rootEntries).map(name => {
    const uri = vscode.Uri.joinPath(selectedRootUri, name);
    seen.add(uri.toString());
    return uri;
  });

  while (queue.length > 0) {
    const current = queue.shift()!;

    const currentEntries = await readDirectorySafe(current);
    if (!currentEntries) {
      continue;
    }
    onProgress?.(`Searching for plans in ${current.fsPath}`);

    const identified = await identifyPlanFolderAtRoot(current, currentEntries);
    if (identified) {
      matches.push(identified);
      // Do not descend into a plans root — avoid duplicate nested boards.
      continue;
    }

    for (const name of listSearchableSubdirectories(currentEntries)) {
      const childUri = vscode.Uri.joinPath(current, name);
      const key = childUri.toString();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      queue.push(childUri);
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
  selectedRoot: vscode.Uri | string,
  onProgress?: (message: string) => void
): Promise<vscode.Uri[]> {
  const selectedRootUri = toDirectoryUri(selectedRoot);
  const rootEntries = await readDirectorySafe(selectedRootUri);
  if (!rootEntries) {
    throw new Error(
      buildUnreadablePathError(typeof selectedRoot === 'string' ? selectedRoot : selectedRootUri.fsPath)
    );
  }

  const repositories: vscode.Uri[] = [];
  const seen = new Set<string>([selectedRootUri.toString()]);
  const queue = [selectedRootUri];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const entries = current === selectedRootUri ? rootEntries : await readDirectorySafe(current);
    if (!entries) {
      continue;
    }
    onProgress?.(`Searching for repositories in ${current.fsPath}`);

    if (entries.some(([name]) => name.toLowerCase() === '.git')) {
      repositories.push(current);
    }

    for (const name of listSearchableSubdirectories(entries)) {
      const child = vscode.Uri.joinPath(current, name);
      const key = child.toString();
      if (!seen.has(key)) {
        seen.add(key);
        queue.push(child);
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
  selectedRoot: vscode.Uri | string,
  onProgress?: (message: string) => void
): Promise<IdentifiedPlanFolder> {
  const selectedRootUri = toDirectoryUri(selectedRoot);
  const directMatch = await identifyPlanFolderAtRoot(selectedRootUri);
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
  const selectedEntries = await readDirectorySafe(selectedRootUri);
  if (selectedEntries) {
    return {
      plansRootUri: selectedRootUri,
      featuresRootUri: vscode.Uri.joinPath(selectedRootUri, 'features'),
      featureEntries: []
    };
  }

  throw new Error(buildUnreadablePathError(selectedRootUri.fsPath));
}

/**
 * Scans a `plans`-style root folder and returns parsed features and child markdown items.
 * Does not modify the source tree — pure read operation.
 *
 * Automatically discovers the plans/features directory by searching beneath
 * the selected root when needed.
 */
export async function parsePlanFolder(
  plansRoot: vscode.Uri | string,
  onProgress?: (message: string) => void
): Promise<ParsedPlanFolder> {
  const progress = onProgress ?? (() => undefined);

  const identified = await identifyPlanFolder(plansRoot, progress);
  const { plansRootUri, featuresRootUri, featureEntries } = identified;

  progress('Scanning feature folders…');

  let autoFeatureId = 9000;
  const features: ParsedFeatureFolder[] = [];
  for (const [name, type] of featureEntries) {
    if (type !== vscode.FileType.Directory) {
      continue;
    }
    const featureMdUri = vscode.Uri.joinPath(featuresRootUri, name, 'feature.md');
    let content: string;
    try {
      content = await readUtf8(featureMdUri);
    } catch {
      continue;
    }
    const dirMatch = name.match(FEATURE_DIR);
    const featureId = dirMatch ? Number.parseInt(dirMatch[1], 10) : autoFeatureId++;
    progress(`Reading feature: ${name}/feature.md`);
    features.push({
      dirName: name,
      featureId,
      title: extractMainHeading(content),
      planStatus: mapMarkdownStatusToPlanStatus(extractStatusRaw(content)),
      description: buildDescription(content),
      featureMdUri,
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
    const folderUri = vscode.Uri.joinPath(featuresRootUri, folder.dirName);
    const files = await vscode.workspace.fs.readDirectory(folderUri);
    for (const [fname, ftype] of files) {
      if (ftype !== vscode.FileType.File || !fname.toLowerCase().endsWith('.md')) {
        continue;
      }
      if (fname.toLowerCase() === 'feature.md') {
        continue;
      }
      const fileUri = vscode.Uri.joinPath(folderUri, fname);
      const scontent = await readUtf8(fileUri);

      // Try filename-based parsing first, then fall back to front matter **Type:**
      const parsed = parseChildFileName(fname);
      let issueType: 'Story' | 'Task' | 'Bug' | 'Idea';
      let resolvedFeatureId: number;
      let sequence: number;

      if (parsed) {
        // Strict-format files must match the folder's featureId;
        // loose-format files (featureId undefined) inherit it from the folder.
        if (parsed.featureId !== undefined && parsed.featureId !== folder.featureId) {
          continue;
        }
        issueType = parsed.issueType;
        resolvedFeatureId = parsed.featureId ?? folder.featureId;
        sequence = parsed.sequence;
      } else {
        // Fall back to front matter type detection
        const contentType = normalizeChildIssueType(extractTypeRaw(scontent));
        if (!contentType) {
          continue;
        }
        issueType = contentType;
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
        fileUri,
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
          storyMdUri: fileUri,
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
  const additionalDirs: vscode.Uri[] = [featuresRootUri];
  const scannedDirPaths = new Set<string>([featuresRootUri.fsPath]);

  // Scan plansRootUri if it differs from featuresRootUri
  if (plansRootUri.fsPath !== featuresRootUri.fsPath) {
    additionalDirs.push(plansRootUri);
    scannedDirPaths.add(plansRootUri.fsPath);
  }

  // Scan ALL subdirectories under plansRootUri (not just bugs/tasks/stories)
  const rootEntriesToScan = await readDirectorySafe(plansRootUri);
  if (rootEntriesToScan) {
    for (const [subName, subType] of rootEntriesToScan) {
      if (subType !== vscode.FileType.Directory || SEARCH_SKIP_DIRS.has(subName.toLowerCase())) {
        continue;
      }
      // Skip feature directories — already scanned above
      if (featureDirNames.has(subName.toLowerCase())) {
        continue;
      }
      const subdirUri = vscode.Uri.joinPath(plansRootUri, subName);
      if (!scannedDirPaths.has(subdirUri.fsPath)) {
        additionalDirs.push(subdirUri);
        scannedDirPaths.add(subdirUri.fsPath);
      }
    }
  }

  for (const dirUri of additionalDirs) {
    let dirEntries: [string, vscode.FileType][];
    if (dirUri.fsPath === featuresRootUri.fsPath) {
      dirEntries = featureEntries;
    } else {
      const entries = await readDirectorySafe(dirUri);
      if (!entries) {
        continue;
      }
      dirEntries = entries;
    }
    for (const [fname, ftype] of dirEntries) {
      if (ftype !== vscode.FileType.File || !fname.toLowerCase().endsWith('.md')) {
        continue;
      }
      if (seenChildFiles.has(fname.toLowerCase())) {
        continue;
      }
      const fileUri = vscode.Uri.joinPath(dirUri, fname);
      const scontent = await readUtf8(fileUri);

      // Try filename-based parsing first, then fall back to front matter **Type:**
      const parsed = parseChildFileName(fname);
      let issueType: 'Story' | 'Task' | 'Bug' | 'Idea';
      let resolvedFeatureId: number | undefined;
      let sequence: number;

      if (parsed) {
        // Strict-format must reference a known feature; loose-format (no featureId) is always accepted
        if (parsed.featureId !== undefined && !featureIdSet.has(parsed.featureId)) {
          continue;
        }
        issueType = parsed.issueType;
        resolvedFeatureId = parsed.featureId;
        sequence = parsed.sequence;
      } else {
        // Fall back to front matter type detection
        const contentType = normalizeChildIssueType(extractTypeRaw(scontent));
        if (!contentType) {
          continue;
        }
        issueType = contentType;
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
        fileUri,
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
          featureId: resolvedFeatureId,
          storySeq: sequence,
          filename: fname,
          title: extractMainHeading(scontent),
          planStatus: mapMarkdownStatusToPlanStatus(extractStatusRaw(scontent)),
          description: buildDescription(scontent),
          ideaTranscript: extractSectionBody(scontent, 'Research Transcript'),
          relativePath: fname,
          storyMdUri: fileUri,
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

  return { features, stories, childItems, plansRootUri, featuresRootUri };
}
