import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { IssueTrackerService } from '../backends/issueTrackerService';
import type { AgentTaskAttachment } from './agentTypes';
import type { IssueAttachment, IssueDetails } from '../types';

interface AttachmentLogger {
  appendLine(message: string): void;
}

function sanitizePathSegment(value: string): string {
  return value.replaceAll(/[<>:"/\\|?*\x00-\x1F]+/g, '-').replaceAll(/\s+/g, ' ').trim() || 'attachment';
}

function buildUniqueFileName(fileName: string, seen: Set<string>): string {
  const sanitized = sanitizePathSegment(fileName);
  const extension = path.extname(sanitized);
  const baseName = extension ? sanitized.slice(0, -extension.length) : sanitized;

  let candidate = sanitized;
  let counter = 2;
  while (seen.has(candidate.toLowerCase())) {
    candidate = `${baseName}-${counter}${extension}`;
    counter += 1;
  }

  seen.add(candidate.toLowerCase());
  return candidate;
}

async function writeAttachmentManifest(
  issueKey: string,
  directoryPath: string,
  attachments: AgentTaskAttachment[]
): Promise<AgentTaskAttachment> {
  const manifestPath = path.join(directoryPath, 'ATTACHMENTS.md');
  const lines = [
    `# Attachment Context for ${issueKey}`,
    '',
    'The files below were downloaded from the issue before the Copilot task started.',
    ''
  ];

  for (const attachment of attachments) {
    lines.push(`- ${attachment.fileName}`);
    lines.push(`  - Local path: ${attachment.localPath}`);
    if (attachment.mediaType) {
      lines.push(`  - Media type: ${attachment.mediaType}`);
    }
    if (typeof attachment.sizeBytes === 'number') {
      lines.push(`  - Size bytes: ${attachment.sizeBytes}`);
    }
    if (attachment.sourceUrl) {
      lines.push(`  - Source URL: ${attachment.sourceUrl}`);
    }
  }

  lines.push('');
  lines.push('Review these files before implementing the issue when they affect UI, behavior, or acceptance criteria.');

  await fs.writeFile(manifestPath, lines.join('\n'), 'utf8');
  return {
    fileName: 'ATTACHMENTS.md',
    localPath: manifestPath,
    mediaType: 'text/markdown'
  };
}

function isBuildArtifact(fileName: string): boolean {
  return fileName.toLowerCase().endsWith('.msi.zip');
}

export async function stageIssueAttachments(options: {
  issue: Pick<IssueDetails, 'key' | 'attachments'>;
  backendService: IssueTrackerService;
  logger?: AttachmentLogger;
}): Promise<AgentTaskAttachment[]> {
  const allAttachments = options.issue.attachments?.filter(attachment => attachment.fileName.trim().length > 0) ?? [];
  const issueAttachments: IssueAttachment[] = [];
  for (const attachment of allAttachments) {
    if (isBuildArtifact(attachment.fileName)) {
      options.logger?.appendLine(
        `[Attachment] Skipping build artifact ${attachment.fileName} for ${options.issue.key}`
      );
      continue;
    }
    issueAttachments.push(attachment);
  }
  if (issueAttachments.length === 0) {
    return [];
  }

  const directoryPath = path.join(
    os.tmpdir(),
    'ticket-manager',
    'issue-attachments',
    sanitizePathSegment(options.issue.key)
  );
  await fs.rm(directoryPath, { recursive: true, force: true });
  await fs.mkdir(directoryPath, { recursive: true });

  const seenNames = new Set<string>();
  const downloadedAttachments: AgentTaskAttachment[] = [];

  for (const attachment of issueAttachments) {
    const fileName = buildUniqueFileName(attachment.fileName, seenNames);
    const targetFilePath = path.join(directoryPath, fileName);
    options.logger?.appendLine(
      `[Attachment] Downloading ${attachment.fileName} for ${options.issue.key} to ${targetFilePath}`
    );
    try {
      await options.backendService.downloadAttachment(options.issue.key, attachment, targetFilePath);
    } catch (error) {
      throw new Error(
        `Failed to download attachment ${attachment.fileName} for ${options.issue.key}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    downloadedAttachments.push({
      fileName: attachment.fileName,
      localPath: targetFilePath,
      mediaType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      sourceUrl: attachment.contentUrl
    });
  }

  const manifest = await writeAttachmentManifest(options.issue.key, directoryPath, downloadedAttachments);
  return [manifest, ...downloadedAttachments];
}