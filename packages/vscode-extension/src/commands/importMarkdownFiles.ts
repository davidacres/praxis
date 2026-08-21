/**
 * Converts external markdown files to the canonical ticket-manager template format.
 *
 * This is a one-time conversion command that:
 * 1. Strips blockquote prefixes from field lines (`> **Status:**` → `**Status:**`)
 * 2. Maps non-standard Type values to canonical types (Story/Task/Bug)
 * 3. Normalizes field names (e.g. `Branch commit` → `Branch`)
 * 4. Adds missing required fields from the template
 * 5. Adds missing required sections
 */

import * as vscode from 'vscode';
import { readUtf8 } from '../livefolder/markdownPlanParser';
import { ensureFrontMatter, type IssueType } from '../livefolder/markdownTemplate';

// ── Type mapping ─────────────────────────────────────────────────────

const TYPE_ALIASES: Record<string, IssueType> = {
  story: 'Story',
  ui: 'Story',
  frontend: 'Story',
  feature: 'Story',
  task: 'Task',
  backend: 'Task',
  infra: 'Task',
  infrastructure: 'Task',
  chore: 'Task',
  bug: 'Bug',
  defect: 'Bug',
  fix: 'Bug',
};

function resolveIssueType(raw: string | undefined): IssueType {
  if (!raw) {
    return 'Story';
  }
  return TYPE_ALIASES[raw.trim().toLowerCase()] ?? 'Story';
}

// ── Field normalization ──────────────────────────────────────────────

/** Field name aliases that should be renamed to the canonical form. */
const FIELD_NAME_ALIASES: Record<string, string> = {
  'branch commit': 'Branch',
  'depends on': 'Depends On',
  'start date': 'Created',
};

/**
 * Normalize a single markdown file's content to our template format.
 * Returns the updated content, or the original if no changes were needed.
 */
export function normalizeMarkdownContent(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  let modified = false;

  // Pass 1: Strip blockquote prefixes from bold-field lines
  for (let i = 0; i < lines.length; i++) {
    const bqMatch = lines[i].match(/^>\s*(\*\*.+?\*\*\s*.*)$/);
    if (bqMatch) {
      lines[i] = bqMatch[1];
      modified = true;
    }
  }

  // Pass 2: Normalize field names (e.g. `**Branch commit:**` → `**Branch:**`)
  for (let i = 0; i < lines.length; i++) {
    const fieldMatch = lines[i].match(/^\*\*(.+?):\*\*(.*)$/);
    if (fieldMatch) {
      const fieldName = fieldMatch[1];
      const canonical = FIELD_NAME_ALIASES[fieldName.toLowerCase()];
      if (canonical) {
        lines[i] = `**${canonical}:**${fieldMatch[2]}`;
        modified = true;
      }
    }
  }

  // Pass 3: Resolve the Type field to a canonical value
  for (let i = 0; i < lines.length; i++) {
    const typeMatch = lines[i].match(/^\*\*Type:\*\*\s*(.+)$/);
    if (typeMatch) {
      const rawType = typeMatch[1].trim();
      const resolved = resolveIssueType(rawType);
      if (rawType !== resolved) {
        lines[i] = `**Type:** ${resolved}`;
        modified = true;
      }
      break;
    }
  }

  if (!modified) {
    return content;
  }
  return lines.join('\n');
}

/**
 * Determine the issue type from file content (after normalization).
 */
function detectIssueType(content: string): IssueType {
  const m = content.match(/^\*\*Type:\*\*\s*(.+)$/m);
  if (m) {
    return resolveIssueType(m[1]);
  }
  return 'Story';
}

// ── Command implementation ───────────────────────────────────────────

export interface ImportResult {
  file: string;
  status: 'converted' | 'already-valid' | 'error';
  error?: string;
}

/**
 * Import and convert markdown files in a folder to the canonical template format.
 */
export async function importMarkdownFiles(
  folderUri: vscode.Uri,
  onProgress?: (message: string) => void
): Promise<ImportResult[]> {
  const results: ImportResult[] = [];
  const entries = await vscode.workspace.fs.readDirectory(folderUri);

  for (const [name, type] of entries) {
    if (type === vscode.FileType.Directory) {
      // Recurse into subdirectories
      const subResults = await importMarkdownFiles(
        vscode.Uri.joinPath(folderUri, name),
        onProgress
      );
      results.push(...subResults);
      continue;
    }

    if (!name.toLowerCase().endsWith('.md')) {
      continue;
    }

    const fileUri = vscode.Uri.joinPath(folderUri, name);
    onProgress?.(`Processing: ${name}`);

    try {
      const raw = await readUtf8(fileUri);

      // Skip files without a title heading (not issue files)
      if (!raw.match(/^#\s+.+$/m)) {
        continue;
      }

      // Step 1: Normalize format (strip blockquotes, rename fields, map types)
      const normalizedContent = normalizeMarkdownContent(raw);

      // Step 2: Detect issue type from (now-normalized) content
      const issueType = detectIssueType(normalizedContent);

      // Step 3: Add missing template fields and sections
      const upgraded = ensureFrontMatter(normalizedContent, issueType);

      if (upgraded === raw) {
        results.push({ file: name, status: 'already-valid' });
        continue;
      }

      await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(upgraded));
      results.push({ file: name, status: 'converted' });
    } catch (err) {
      results.push({
        file: name,
        status: 'error',
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  return results;
}

/**
 * Register the import command.
 */
export function registerImportCommand(context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.commands.registerCommand('ticketManager.importMarkdownFiles', async () => {
    const folders = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Select folder to import',
      title: 'Import Markdown Files to Ticket Manager Format'
    });

    if (!folders || folders.length === 0) {
      return;
    }

    const folderUri = folders[0];

    const results = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Importing markdown files…',
        cancellable: false
      },
      async (progress) => {
        return importMarkdownFiles(folderUri, (msg) => {
          progress.report({ message: msg });
        });
      }
    );

    const converted = results.filter(r => r.status === 'converted').length;
    const valid = results.filter(r => r.status === 'already-valid').length;
    const errors = results.filter(r => r.status === 'error').length;

    const parts: string[] = [];
    if (converted > 0) { parts.push(`${converted} converted`); }
    if (valid > 0) { parts.push(`${valid} already valid`); }
    if (errors > 0) { parts.push(`${errors} errors`); }

    const summary = parts.length > 0
      ? `Import complete: ${parts.join(', ')}.`
      : 'No markdown files found.';

    if (errors > 0) {
      vscode.window.showWarningMessage(summary);
    } else {
      vscode.window.showInformationMessage(summary);
    }
  });
}
