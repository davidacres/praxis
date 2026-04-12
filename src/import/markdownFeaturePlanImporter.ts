import * as vscode from 'vscode';
import {
  identifyPlanFolder,
  parsePlanFolder,
  stableFeatureKey,
  stableStoryKey
} from '../livefolder/markdownPlanParser';

// ── Types ───────────────────────────────────────────────────────────

export interface ImportOptions {
  projectKey: string;
  projectName: string;
  currentUser: string;
  onProgress: (message: string) => void;
}

export interface ImportResult {
  jsonc: string;
  stats: {
    featuresImported: number;
    storiesImported: number;
  };
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Try to locate a `plans` or `features` folder in the workspace so we can
 * pre-fill the folder picker.
 */
export async function resolveSuggestedPlansFolderUri(): Promise<vscode.Uri | undefined> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders?.length) {
    return undefined;
  }

  for (const wf of folders) {
    for (const candidate of ['plans', 'features', 'docs/plans']) {
      const uri = vscode.Uri.joinPath(wf.uri, candidate);
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type === vscode.FileType.Directory) {
          // If we found a `features` dir directly, return its parent
          if (candidate === 'features') {
            return wf.uri;
          }
          return uri;
        }
      } catch {
        // candidate doesn't exist — try next
      }
    }
  }

  for (const wf of folders) {
    try {
      const identified = await identifyPlanFolder(wf.uri);
      return identified.plansRootUri;
    } catch {
      // No plans tree found under this workspace root.
    }
  }

  return undefined;
}

// ── Main generator ──────────────────────────────────────────────────

/**
 * Reads a markdown plans folder and produces a Ticket Manager JSONC plan
 * document that can be saved directly to disk and loaded in File mode.
 */
export async function generateTicketPlanFromMarkdownFeatures(
  rootUri: vscode.Uri,
  options: ImportOptions
): Promise<ImportResult> {
  const { projectKey, projectName, currentUser, onProgress } = options;

  onProgress('Parsing feature and story files…');
  const parsed = await parsePlanFolder(rootUri, onProgress);

  if (parsed.features.length === 0) {
    throw new Error(
      'No features found. Expected folders like features/feature-01-name/feature.md under the selected root.'
    );
  }

  onProgress('Building plan document…');

  const now = new Date().toISOString();

  // Build items — features first, then stories with parent references
  const items: Record<string, unknown>[] = [];
  const boardIssueKeys: string[] = [];

  for (const f of parsed.features) {
    const key = stableFeatureKey(projectKey, f.featureId);
    boardIssueKeys.push(key);
    items.push({
      key,
      summary: f.title,
      type: 'Feature',
      status: f.planStatus,
      projectKey,
      projectName,
      assignee: currentUser,
      priority: 'High',
      created: f.planningDates.created ?? now,
      updated: now,
      description: f.description
    });
  }

  for (const s of parsed.stories) {
    const key = stableStoryKey(projectKey, s.featureId, s.storySeq);
    const parentKey = stableFeatureKey(projectKey, s.featureId);
    boardIssueKeys.push(key);
    items.push({
      key,
      summary: s.title,
      type: 'Story',
      status: s.planStatus,
      projectKey,
      projectName,
      assignee: currentUser,
      priority: 'Medium',
      created: s.planningDates.created ?? now,
      updated: now,
      description: s.description,
      parent: parentKey
    });
  }

  const plan = {
    version: 1,
    currentUser,
    projects: [{ key: projectKey, name: projectName }],
    workflow: {
      statuses: [
        { name: 'Backlog', category: 'todo' },
        { name: 'To Do', category: 'todo' },
        { name: 'In Progress', category: 'indeterminate' },
        { name: 'Blocked', category: 'indeterminate' },
        { name: 'Done', category: 'done' }
      ]
    },
    boards: [
      {
        id: `board-${projectKey.toLowerCase()}`,
        name: `${projectName} Board`,
        type: 'plan',
        projectKey,
        projectName,
        locationName: 'Imported Plan',
        issueKeys: boardIssueKeys,
        columnStatusOrder: ['Backlog', 'To Do', 'In Progress', 'Blocked', 'Done']
      }
    ],
    items
  };

  const jsonc = JSON.stringify(plan, null, 2) + '\n';

  onProgress(
    `Done — ${parsed.features.length} feature(s), ${parsed.stories.length} story/stories.`
  );

  return {
    jsonc,
    stats: {
      featuresImported: parsed.features.length,
      storiesImported: parsed.stories.length
    }
  };
}
