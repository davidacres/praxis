import * as vscode from 'vscode';
import { readUtf8 } from './markdownPlanParser';

/** Reverse-map plan statuses back to the emoji-prefixed markdown format. */
export function planStatusToMarkdown(planStatus: string): string {
  switch (planStatus) {
    case 'Done':
      return '✅ Complete';
    case 'In Progress':
      return '🔄 In Progress';
    case 'Blocked':
      return '⛔ Blocked';
    case 'To Do':
      return '📋 To Do';
    case 'Backlog':
      return '📋 Proposed';
    default:
      return planStatus;
  }
}

/**
 * Updates the `**Status:**` line in a markdown file to the given plan status.
 * Returns true if the file was modified.
 */
export async function writeStatusToMarkdownFile(
  fileUri: vscode.Uri,
  newPlanStatus: string
): Promise<boolean> {
  const content = await readUtf8(fileUri);
  const mdStatus = planStatusToMarkdown(newPlanStatus);
  const statusLineRe = /^(\*\*Status:\*\*\s*).+$/m;
  const match = statusLineRe.exec(content);
  if (!match) {
    return false;
  }

  const updated = content.replace(statusLineRe, `$1${mdStatus}`);
  if (updated === content) {
    return false;
  }

  const encoder = new TextEncoder();
  await vscode.workspace.fs.writeFile(fileUri, encoder.encode(updated));
  return true;
}

/**
 * Updates a story's status row inside the parent `feature.md` story table.
 * Looks for a markdown table row matching the story number/name pattern.
 */
export async function updateFeatureStoryTable(
  featureMdUri: vscode.Uri,
  storySeq: number,
  storyName: string,
  newPlanStatus: string
): Promise<boolean> {
  let content: string;
  try {
    content = await readUtf8(featureMdUri);
  } catch {
    return false;
  }

  const mdStatus = planStatusToMarkdown(newPlanStatus);
  const lines = content.split(/\r?\n/);
  let modified = false;

  // Match table rows like: | 01.1 | Story Name | ✅ Complete | ...
  // The story seq appears as NN.M or just the seq number
  const storySeqStr = String(storySeq);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) {
      continue;
    }
    const cells = line.split('|').map(c => c.trim());
    // cells[0] is empty (before first |), cells[1] is story ref
    const refCell = cells[1] ?? '';
    if (!refCell.includes(storySeqStr)) {
      continue;
    }
    // Check if the story name appears in the row (fuzzy match)
    const nameCell = cells[2] ?? '';
    const nameWords = storyName.split(/\s+/).slice(0, 3).join('.*');
    if (nameWords.length > 0 && !new RegExp(nameWords, 'i').test(nameCell) && !new RegExp(nameWords, 'i').test(line)) {
      continue;
    }
    // Find the status cell — typically cells[3]
    const statusIdx = cells.findIndex((c, idx) => idx >= 3 && (c.includes('✅') || c.includes('🔄') || c.includes('📋') || c.includes('⛔') || c === 'Done' || c === 'In Progress' || c === 'Blocked' || c === 'Proposed' || c === 'Complete' || c === 'Backlog' || c === 'To Do'));
    if (statusIdx < 0) {
      continue;
    }
    cells[statusIdx] = mdStatus;
    lines[i] = '| ' + cells.filter((_, idx) => idx > 0 && idx < cells.length - 1).join(' | ') + ' |';
    modified = true;
    break;
  }

  if (!modified) {
    return false;
  }

  const updated = lines.join('\n');
  const encoder = new TextEncoder();
  await vscode.workspace.fs.writeFile(featureMdUri, encoder.encode(updated));
  return true;
}

export async function appendFeatureItemTableRow(
  featureMdUri: vscode.Uri,
  itemReference: string,
  itemType: string,
  itemName: string,
  planStatus: string
): Promise<boolean> {
  let content: string;
  try {
    content = await readUtf8(featureMdUri);
  } catch {
    return false;
  }

  const mdStatus = planStatusToMarkdown(planStatus);
  const escapedReference = itemReference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedType = itemType.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existingRow = new RegExp(`^\\|\\s*${escapedReference}\\s*\\|\\s*${escapedType}\\s*\\|`, 'mi');
  if (existingRow.test(content)) {
    return false;
  }

  const row = `| ${itemReference} | ${itemType} | ${itemName} | ${mdStatus} |`;
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const sectionIndex = lines.findIndex(line => /^##\s+(Items|Stories)\b/i.test(line.trim()));

  if (sectionIndex >= 0) {
    let insertIndex = sectionIndex + 1;
    let hasHeader = false;
    while (insertIndex < lines.length) {
      const trimmed = lines[insertIndex].trim();
      if (/^##\s+/.test(trimmed)) {
        break;
      }
      if (/^\|\s*Ref\s*\|\s*Type\s*\|\s*Name\s*\|\s*Status\s*\|$/i.test(trimmed)) {
        hasHeader = true;
      }
      insertIndex += 1;
    }

    const nextLines = [...lines];
    if (!hasHeader) {
      nextLines.splice(
        insertIndex,
        0,
        '',
        '| Ref | Type | Name | Status |',
        '| --- | --- | --- | --- |',
        row
      );
    } else {
      nextLines.splice(insertIndex, 0, row);
    }
    await vscode.workspace.fs.writeFile(featureMdUri, new TextEncoder().encode(nextLines.join('\n')));
    return true;
  }

  const updated = `${normalized.trimEnd()}\n\n## Items\n\n| Ref | Type | Name | Status |\n| --- | --- | --- | --- |\n${row}\n`;
  await vscode.workspace.fs.writeFile(featureMdUri, new TextEncoder().encode(updated));
  return true;
}

/**
 * Updates the feature-level `**Status:**` based on aggregate story statuses.
 * Rules:
 * - All stories Done → feature is Done
 * - Any story In Progress → feature is In Progress (if not already Done)
 * - Any story Blocked → feature is In Progress
 * - Otherwise keeps existing status
 */
export function computeFeatureRollupStatus(storyStatuses: string[]): string | undefined {
  if (storyStatuses.length === 0) {
    return undefined;
  }
  if (storyStatuses.every(s => s === 'Done')) {
    return 'Done';
  }
  if (storyStatuses.some(s => s === 'In Progress' || s === 'Blocked')) {
    return 'In Progress';
  }
  if (storyStatuses.some(s => s === 'To Do')) {
    return 'To Do';
  }
  return undefined;
}
