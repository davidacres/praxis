import * as vscode from 'vscode';

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

export interface ParsedPlanFolder {
  features: ParsedFeatureFolder[];
  stories: ParsedStoryFile[];
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

const FEATURE_DIR = /^feature-(\d+)-/i;

function parseStoryFileName(name: string): { featureId: number; storySeq: number } | undefined {
  const m = name.match(/^story-(\d+)-(\d+)-.+\.md$/i);
  if (!m) {
    return undefined;
  }
  return { featureId: Number.parseInt(m[1], 10), storySeq: Number.parseInt(m[2], 10) };
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
  const storyRef = /\b(story-\d+-\d+(?:-[a-z0-9]+)*)\b/gi;
  while ((m = storyRef.exec(text))) {
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

// ── Main parser ─────────────────────────────────────────────────────

/**
 * Locate the directory that contains `feature-NN-*` sub-folders.
 *
 * Search order:
 *  1. `<root>/features/`
 *  2. `<root>/` itself
 *  3. Any immediate subdirectory of `<root>` that contains `feature-NN-*` dirs
 *
 * Returns the resolved URI and its directory listing, or throws.
 */
async function resolveFeaturesRoot(
  plansRoot: vscode.Uri
): Promise<{ featuresUri: vscode.Uri; entries: [string, vscode.FileType][] }> {
  const hasFeatureDirs = (entries: [string, vscode.FileType][]): boolean =>
    entries.some(([name, type]) => type === vscode.FileType.Directory && FEATURE_DIR.test(name));

  // 1. Try <root>/features
  try {
    const featuresUri = vscode.Uri.joinPath(plansRoot, 'features');
    const entries = await vscode.workspace.fs.readDirectory(featuresUri);
    if (hasFeatureDirs(entries)) {
      return { featuresUri, entries };
    }
  } catch {
    // Not found — continue searching
  }

  // 2. Try <root> itself
  try {
    const entries = await vscode.workspace.fs.readDirectory(plansRoot);
    if (hasFeatureDirs(entries)) {
      return { featuresUri: plansRoot, entries };
    }

    // 3. Try each immediate subdirectory of <root>
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.Directory) {
        continue;
      }
      try {
        const subUri = vscode.Uri.joinPath(plansRoot, name);
        const subEntries = await vscode.workspace.fs.readDirectory(subUri);
        if (hasFeatureDirs(subEntries)) {
          return { featuresUri: subUri, entries: subEntries };
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Root itself is unreadable
  }

  throw new Error(
    `No feature-NN-* folders found under the selected path or its subdirectories. ` +
    `Expected layout: features/feature-01-…/feature.md`
  );
}

/**
 * Scans a `plans`-style root folder and returns parsed features and stories.
 * Does not modify the source tree — pure read operation.
 *
 * Automatically discovers the features directory by searching:
 *  1. `<plansRoot>/features/`
 *  2. `<plansRoot>/` itself
 *  3. Any immediate subdirectory of `<plansRoot>`
 */
export async function parsePlanFolder(
  plansRoot: vscode.Uri,
  onProgress?: (message: string) => void
): Promise<ParsedPlanFolder> {
  const progress = onProgress ?? (() => undefined);

  const { featuresUri, entries: featureEntries } = await resolveFeaturesRoot(plansRoot);

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
    const featureMdUri = vscode.Uri.joinPath(featuresUri, name, 'feature.md');
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
  for (const folder of features) {
    const folderUri = vscode.Uri.joinPath(featuresUri, folder.dirName);
    const files = await vscode.workspace.fs.readDirectory(folderUri);
    for (const [fname, ftype] of files) {
      if (ftype !== vscode.FileType.File || !fname.toLowerCase().endsWith('.md')) {
        continue;
      }
      if (fname.toLowerCase() === 'feature.md') {
        continue;
      }
      const parsed = parseStoryFileName(fname);
      if (!parsed || parsed.featureId !== folder.featureId) {
        continue;
      }
      const storyMdUri = vscode.Uri.joinPath(folderUri, fname);
      const scontent = await readUtf8(storyMdUri);
      progress(`Reading story: ${folder.dirName}/${fname}`);
      stories.push({
        featureId: folder.featureId,
        storySeq: parsed.storySeq,
        filename: fname,
        title: extractMainHeading(scontent),
        planStatus: mapMarkdownStatusToPlanStatus(extractStatusRaw(scontent)),
        description: buildDescription(scontent),
        relativePath: `${folder.dirName}/${fname}`,
        storyMdUri,
        depTokens: collectDependencyTokens(scontent),
        planningDates: extractPlanningDates(scontent),
        branch: extractBranchRaw(scontent)
      });
    }
  }

  stories.sort((a, b) => {
    if (a.featureId !== b.featureId) {
      return a.featureId - b.featureId;
    }
    if (a.storySeq !== b.storySeq) {
      return a.storySeq - b.storySeq;
    }
    return a.filename.localeCompare(b.filename);
  });

  return { features, stories, featuresRootUri: featuresUri };
}
