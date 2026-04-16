import * as path from 'node:path';
import * as vscode from 'vscode';
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
  dirName: string;
  featureId: number;
  title: string;
  planStatus: string;
  description: string;
  featureMdUri: vscode.Uri;
  depTokens: string[];
  planningDates: ParsedPlanningDates;
}

export interface ParsedStoryFile {
  featureId: number;
  storySeq: number;
  filename: string;
  title: string;
  planStatus: string;
  description: string;
  relativePath: string;
  storyMdUri: vscode.Uri;
  depTokens: string[];
  planningDates: ParsedPlanningDates;
  branch?: string;
}

export interface ParsedChildFile {
  featureId: number;
  sequence: number;
  filename: string;
  issueType: 'Story' | 'Task' | 'Bug';
  title: string;
  planStatus: string;
  description: string;
  relativePath: string;
  fileUri: vscode.Uri;
  depTokens: string[];
  planningDates: ParsedPlanningDates;
  branch?: string;
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
  bug: 'Bug'
} as const;
const MAX_PLAN_SEARCH_DEPTH = 6;
const MAX_PLAN_SEARCH_DIRECTORIES = 500;
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

function parseChildFileName(
  name: string
): { featureId: number; sequence: number; issueType: 'Story' | 'Task' | 'Bug' } | undefined {
  const m = name.match(/^(story|task|bug)-(\d+)-(\d+)-.+\.md$/i);
  if (!m) {
    return undefined;
  }
  const prefix = m[1].toLowerCase() as keyof typeof CHILD_FILE_PREFIX_TO_ISSUE_TYPE;
  return {
    issueType: CHILD_FILE_PREFIX_TO_ISSUE_TYPE[prefix],
    featureId: Number.parseInt(m[2], 10),
    sequence: Number.parseInt(m[3], 10)
  };
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
  const childRef = /\b((?:story|task|bug)-\d+-\d+(?:-[a-z0-9]+)*)\b/gi;
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
    if (type !== vscode.FileType.Directory || !FEATURE_DIR.test(name)) {
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

async function identifyPlanFolderAtRoot(
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

  const entries = rootEntries ?? (await readDirectorySafe(candidateRoot));
  if (entries && (await containsFeaturePlanFolders(candidateRoot, entries))) {
    return {
      plansRootUri: canonicalPlansRootUri(candidateRoot, candidateRoot),
      featuresRootUri: candidateRoot,
      featureEntries: entries
    };
  }

  return undefined;
}

/**
 * Resolve a selected folder to the actual plans root and features folder.
 *
 * Search order:
 *  1. `<selected>/features/`
 *  2. `<selected>/`
 *  3. Nested subdirectories below `<selected>` (breadth-first, bounded search)
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

  const rootEntries = await readDirectorySafe(selectedRootUri);
  if (!rootEntries) {
    throw new Error(
      buildUnreadablePathError(typeof selectedRoot === 'string' ? selectedRoot : selectedRootUri.fsPath)
    );
  }

  const seen = new Set<string>([selectedRootUri.toString()]);
  const queue = listSearchableSubdirectories(rootEntries).map(name => {
    const uri = vscode.Uri.joinPath(selectedRootUri, name);
    seen.add(uri.toString());
    return { uri, depth: 1 };
  });

  let searchedDirectories = 1;
  while (queue.length > 0 && searchedDirectories < MAX_PLAN_SEARCH_DIRECTORIES) {
    const current = queue.shift()!;
    if (current.depth > MAX_PLAN_SEARCH_DEPTH) {
      continue;
    }

    const currentEntries = await readDirectorySafe(current.uri);
    if (!currentEntries) {
      continue;
    }
    searchedDirectories++;
    onProgress?.(`Searching for plans in ${current.uri.fsPath}`);

    const identified = await identifyPlanFolderAtRoot(current.uri, currentEntries);
    if (identified) {
      return identified;
    }

    if (current.depth >= MAX_PLAN_SEARCH_DEPTH) {
      continue;
    }

    for (const name of listSearchableSubdirectories(currentEntries)) {
      if (seen.size >= MAX_PLAN_SEARCH_DIRECTORIES) {
        break;
      }
      const childUri = vscode.Uri.joinPath(current.uri, name);
      const key = childUri.toString();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      queue.push({ uri: childUri, depth: current.depth + 1 });
    }
  }

  throw new Error(
    `No feature-NN-* folders with feature.md were found under the selected path or its nested subdirectories. ` +
      `Expected layout: plans/features/feature-01-…/feature.md`
  );
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

  const features: ParsedFeatureFolder[] = [];
  for (const [name, type] of featureEntries) {
    if (type !== vscode.FileType.Directory) {
      continue;
    }
    const dirMatch = name.match(FEATURE_DIR);
    if (!dirMatch) {
      continue;
    }
    const featureId = Number.parseInt(dirMatch[1], 10);
    const featureMdUri = vscode.Uri.joinPath(featuresRootUri, name, 'feature.md');
    let content: string;
    try {
      content = await readUtf8(featureMdUri);
    } catch {
      continue;
    }
    progress(`Reading feature: ${name}/feature.md`);
    features.push({
      dirName: name,
      featureId,
      title: extractMainHeading(content),
      planStatus: mapMarkdownStatusToPlanStatus(extractStatusRaw(content)),
      description: buildDescription(content),
      featureMdUri,
      depTokens: collectDependencyTokens(content),
      planningDates: extractPlanningDates(content)
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
      const parsed = parseChildFileName(fname);
      if (!parsed || parsed.featureId !== folder.featureId) {
        continue;
      }
      const fileUri = vscode.Uri.joinPath(folderUri, fname);
      const scontent = await readUtf8(fileUri);
      progress(`Reading ${parsed.issueType.toLowerCase()}: ${folder.dirName}/${fname}`);
      seenChildFiles.add(fname.toLowerCase());
      childItems.push({
        featureId: folder.featureId,
        sequence: parsed.sequence,
        filename: fname,
        issueType: parsed.issueType,
        title: extractMainHeading(scontent),
        planStatus: mapMarkdownStatusToPlanStatus(extractStatusRaw(scontent)),
        description: buildDescription(scontent),
        relativePath: `${folder.dirName}/${fname}`,
        fileUri,
        depTokens: collectDependencyTokens(scontent),
        planningDates: extractPlanningDates(scontent),
        branch: extractBranchRaw(scontent)
      });
      if (parsed.issueType === 'Story') {
        stories.push({
          featureId: folder.featureId,
          storySeq: parsed.sequence,
          filename: fname,
          title: extractMainHeading(scontent),
          planStatus: mapMarkdownStatusToPlanStatus(extractStatusRaw(scontent)),
          description: buildDescription(scontent),
          relativePath: `${folder.dirName}/${fname}`,
          storyMdUri: fileUri,
          depTokens: collectDependencyTokens(scontent),
          planningDates: extractPlanningDates(scontent),
          branch: extractBranchRaw(scontent)
        });
      }
    }
  }

  // Also scan the features root for child items not nested inside feature dirs
  const featureIdSet = new Set(features.map(f => f.featureId));
  for (const [fname, ftype] of featureEntries) {
    if (ftype !== vscode.FileType.File || !fname.toLowerCase().endsWith('.md')) {
      continue;
    }
    if (seenChildFiles.has(fname.toLowerCase())) {
      continue;
    }
    const parsed = parseChildFileName(fname);
    if (!parsed || !featureIdSet.has(parsed.featureId)) {
      continue;
    }
    const fileUri = vscode.Uri.joinPath(featuresRootUri, fname);
    const scontent = await readUtf8(fileUri);
    progress(`Reading ${parsed.issueType.toLowerCase()}: ${fname}`);
    childItems.push({
      featureId: parsed.featureId,
      sequence: parsed.sequence,
      filename: fname,
      issueType: parsed.issueType,
      title: extractMainHeading(scontent),
      planStatus: mapMarkdownStatusToPlanStatus(extractStatusRaw(scontent)),
      description: buildDescription(scontent),
      relativePath: fname,
      fileUri,
      depTokens: collectDependencyTokens(scontent),
      planningDates: extractPlanningDates(scontent),
      branch: extractBranchRaw(scontent)
    });
    if (parsed.issueType === 'Story') {
      stories.push({
        featureId: parsed.featureId,
        storySeq: parsed.sequence,
        filename: fname,
        title: extractMainHeading(scontent),
        planStatus: mapMarkdownStatusToPlanStatus(extractStatusRaw(scontent)),
        description: buildDescription(scontent),
        relativePath: fname,
        storyMdUri: fileUri,
        depTokens: collectDependencyTokens(scontent),
        planningDates: extractPlanningDates(scontent),
        branch: extractBranchRaw(scontent)
      });
    }
  }

  childItems.sort((a, b) => {
    if (a.featureId !== b.featureId) {
      return a.featureId - b.featureId;
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
