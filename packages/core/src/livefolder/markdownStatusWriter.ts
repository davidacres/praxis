import { liveFolderFs } from './liveFolderFs';
import { readUtf8 } from './markdownPlanParser';
import { ensureFrontMatter, type IssueType } from './markdownTemplate';
import { composeIdeaContent } from '../issues/ideaTranscript';

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
  filePath: string,
  newPlanStatus: string
): Promise<boolean> {
  const content = await readUtf8(filePath);
  const mdStatus = planStatusToMarkdown(newPlanStatus);
  const statusLineRe = /^(\*\*Status:\*\*\s*).+$/m;
  const match = statusLineRe.exec(content);

  let updated: string;
  if (match) {
    updated = content.replace(statusLineRe, `$1${mdStatus}`);
  } else {
    // No Status line found — insert one after the title
    const normalized = content.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');
    let insertIdx = 1;
    while (insertIdx < lines.length && lines[insertIdx].trim() === '') {
      insertIdx++;
    }
    lines.splice(insertIdx, 0, `**Status:** ${mdStatus}`);
    updated = lines.join('\n');
  }

  if (updated === content) {
    return false;
  }

  await liveFolderFs().writeFile(filePath, updated);
  return true;
}

/**
 * Updates a story's status row inside the parent `feature.md` story table.
 * Looks for a markdown table row matching the story number/name pattern.
 */
export async function updateFeatureStoryTable(
  featureMdPath: string,
  storySeq: number,
  storyName: string,
  newPlanStatus: string
): Promise<boolean> {
  let content: string;
  try {
    content = await readUtf8(featureMdPath);
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
  await liveFolderFs().writeFile(featureMdPath, updated);
  return true;
}

export async function appendFeatureItemTableRow(
  featureMdPath: string,
  itemReference: string,
  itemType: string,
  itemName: string,
  planStatus: string
): Promise<boolean> {
  let content: string;
  try {
    content = await readUtf8(featureMdPath);
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
    await liveFolderFs().writeFile(featureMdPath, nextLines.join('\n'));
    return true;
  }

  const updated = `${normalized.trimEnd()}\n\n## Items\n\n| Ref | Type | Name | Status |\n| --- | --- | --- | --- |\n${row}\n`;
  await liveFolderFs().writeFile(featureMdPath, updated);
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

/**
 * Appends a comment to the `## Comments` section of a markdown file.
 * Creates the section if it doesn't exist.
 */
export async function appendCommentToMarkdownFile(
  filePath: string,
  author: string,
  body: string
): Promise<void> {
  const content = await readUtf8(filePath);
  const normalized = content.replace(/\r\n/g, '\n');
  const now = new Date().toISOString();
  const commentBlock = `**${author}** — ${now}\n${body}`;

  const lines = normalized.split('\n');
  const sectionIndex = lines.findIndex(line => /^##\s+Comments\b/i.test(line.trim()));

  let updated: string;
  if (sectionIndex >= 0) {
    // Find the end of the Comments section (next ## heading or EOF)
    let endIndex = sectionIndex + 1;
    while (endIndex < lines.length && !/^## /.test(lines[endIndex])) {
      endIndex++;
    }
    const nextLines = [...lines];
    nextLines.splice(endIndex, 0, '', commentBlock);
    updated = nextLines.join('\n');
  } else {
    updated = `${normalized.trimEnd()}\n\n## Comments\n\n${commentBlock}\n`;
  }

  await liveFolderFs().writeFile(filePath, updated);
}

/**
 * Replaces the body of the `## Description` (or `## Summary`) section in a markdown file.
 * Returns true if the file was modified.
 */
export async function writeDescriptionToMarkdownFile(
  filePath: string,
  newDescription: string
): Promise<boolean> {
  const content = await readUtf8(filePath);
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  // Find ## Description or ## Summary heading
  const headingIndex = lines.findIndex(line =>
    /^##\s+(Description|Summary)\b/i.test(line.trim())
  );
  if (headingIndex < 0) {
    return false;
  }

  // Find the end of the section (next ## heading or EOF)
  let endIndex = headingIndex + 1;
  while (endIndex < lines.length && !/^## /.test(lines[endIndex])) {
    endIndex++;
  }

  const before = lines.slice(0, headingIndex + 1);
  const after = lines.slice(endIndex);
  const updated = [...before, '', newDescription.trim(), '', ...after].join('\n');

  if (updated === normalized) {
    return false;
  }

  await liveFolderFs().writeFile(filePath, updated);
  return true;
}

/**
 * Updates the issue title — the first `# ` heading line — in a markdown file.
 * Returns true if the file was modified. An empty summary is never written.
 * Note: a task's title also appears in its feature's items table; that table
 * row is cosmetic and is not rewritten here.
 */
export async function writeSummaryToMarkdownFile(
  filePath: string,
  newSummary: string
): Promise<boolean> {
  const trimmed = newSummary.trim();
  if (!trimmed) {
    return false;
  }
  const content = await readUtf8(filePath);
  // `[^\r\n]*` keeps the existing line ending untouched.
  const updated = content.replace(/^#[ \t]+[^\r\n]*/m, `# ${trimmed}`);
  if (updated === content) {
    return false;
  }
  await liveFolderFs().writeFile(filePath, updated);
  return true;
}

export async function writeIdeaTranscriptToMarkdownFile(
  filePath: string,
  newDescription: string,
  newIdeaTranscript: string
): Promise<boolean> {
  const content = await readUtf8(filePath);
  const composed = composeIdeaContent(newDescription, newIdeaTranscript);
  if (composed === undefined) {
    return false;
  }

  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const descriptionIndex = lines.findIndex(line => /^##\s+(Description|Idea Details)\b/i.test(line.trim()));
  const transcriptIndex = lines.findIndex(line => /^##\s+(Research Transcript|AI Research Transcript)\b/i.test(line.trim()));

  if (descriptionIndex < 0 && transcriptIndex < 0) {
    return false;
  }

  let updated = normalized;
  if (descriptionIndex >= 0 && transcriptIndex >= 0 && transcriptIndex > descriptionIndex) {
    const nextLines = [...lines];
    const descriptionEnd = transcriptIndex;
    nextLines.splice(descriptionIndex, descriptionEnd - descriptionIndex, ...composed.split('\n'));
    updated = nextLines.join('\n');
  } else if (descriptionIndex >= 0) {
    updated = normalized.replace(/^(##\s+(?:Description|Idea Details)\b[\s\S]*?)(?=\n##\s|$)/i, composed);
  } else if (transcriptIndex >= 0) {
    updated = normalized.replace(/^(##\s+(?:Research Transcript|AI Research Transcript)\b[\s\S]*?)(?=\n##\s|$)/i, composed);
  }

  if (updated === content) {
    return false;
  }

  await liveFolderFs().writeFile(filePath, updated);
  return true;
}

/**
 * Updates the `**Priority:**` line in a markdown file.
 * Returns true if the file was modified.
 */
export async function writePriorityToMarkdownFile(
  filePath: string,
  newPriority: string
): Promise<boolean> {
  const content = await readUtf8(filePath);
  const re = /^(\*\*Priority:\*\*\s*).+$/m;
  if (!re.test(content)) {
    return false;
  }

  const updated = content.replace(re, `$1${newPriority}`);
  if (updated === content) {
    return false;
  }

  await liveFolderFs().writeFile(filePath, updated);
  return true;
}

/**
 * Updates the `**Model:**` line in a markdown file.
 * If no Model line exists, inserts one after the Status line (or after the title).
 * Returns true if the file was modified.
 */
export async function writeModelToMarkdownFile(
  filePath: string,
  model: string
): Promise<boolean> {
  const content = await readUtf8(filePath);
  const modelLineRe = /^(\*\*Model:\*\*\s*).+$/m;
  const match = modelLineRe.exec(content);

  let updated: string;
  if (match) {
    updated = content.replace(modelLineRe, `$1${model}`);
  } else {
    const normalized = content.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');
    // Insert after title + blank lines
    let insertIdx = 1;
    while (insertIdx < lines.length && lines[insertIdx].trim() === '') {
      insertIdx++;
    }
    // Insert after Status line if present, else after title
    const statusIdx = lines.findIndex(l => l.startsWith('**Status:**'));
    if (statusIdx >= 0) {
      insertIdx = statusIdx + 1;
    }
    lines.splice(insertIdx, 0, `**Model:** ${model}`);
    updated = lines.join('\n');
  }

  if (updated === content) {
    return false;
  }

  await liveFolderFs().writeFile(filePath, updated);
  return true;
}

export async function writeSeverityToMarkdownFile(
  filePath: string,
  newSeverity: string
): Promise<boolean> {
  const content = await readUtf8(filePath);
  const re = /^(\*\*Severity:\*\*\s*).+$/m;
  if (!re.test(content)) {
    return false;
  }
  const updated = content.replace(re, `$1${newSeverity}`);
  if (updated === content) {
    return false;
  }
  await liveFolderFs().writeFile(filePath, updated);
  return true;
}

export async function writeReportedByToMarkdownFile(
  filePath: string,
  newReportedBy: string
): Promise<boolean> {
  const content = await readUtf8(filePath);
  const re = /^(\*\*Reported By:\*\*\s*).*$/m;
  if (!re.test(content)) {
    return false;
  }
  const updated = content.replace(re, `$1${newReportedBy}`);
  if (updated === content) {
    return false;
  }
  await liveFolderFs().writeFile(filePath, updated);
  return true;
}

/**
 * Upgrades a markdown issue file to the current template format.
 * Adds missing header fields and sections without removing existing content.
 * Returns true if the file was modified.
 */
export async function upgradeMarkdownFile(
  filePath: string,
  issueType: string
): Promise<boolean> {
  const raw = await readUtf8(filePath);
  const updated = ensureFrontMatter(raw, issueType as IssueType);

  if (updated === raw) {
    return false;
  }

  await liveFolderFs().writeFile(filePath, updated);
  return true;
}
