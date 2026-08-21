import { createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';

export interface PreparedJiraArtifactUpload {
  uploadPath: string;
  attachmentName: string;
  cleanup?: () => Promise<void>;
}

interface PrepareJiraArtifactUploadOptions {
  issueKey?: string;
  buildIdentifier?: string;
  artifactIndex?: number;
}

function normalizeAttachmentSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getFallbackBuildIdentifier(artifactIndex?: number): string {
  return String((artifactIndex ?? 0) + 1).padStart(2, '0');
}

function buildMsiUploadName(
  sourceFilePath: string,
  options: PrepareJiraArtifactUploadOptions
): string {
  const originalName = path.basename(sourceFilePath);
  const extension = path.extname(originalName).toLowerCase();
  const originalStem = path.basename(originalName, path.extname(originalName));
  const normalizedIssueKey = normalizeAttachmentSegment(options.issueKey ?? '');

  if (!normalizedIssueKey) {
    return originalName;
  }

  const normalizedBuildIdentifier = normalizeAttachmentSegment(
    options.buildIdentifier ?? getFallbackBuildIdentifier(options.artifactIndex)
  );
  const baseStem = normalizeAttachmentSegment(originalStem);
  const suffixPattern = new RegExp(
    `-${escapeRegExp(normalizedIssueKey)}(?:-[a-z0-9-]+)?$`,
    'i'
  );
  const stemWithoutTicketSuffix = baseStem.replace(suffixPattern, '');

  return `${stemWithoutTicketSuffix || baseStem}-${normalizedIssueKey}-${normalizedBuildIdentifier}${extension}`;
}

async function zipSingleFile(
  sourceFilePath: string,
  zipFilePath: string,
  entryName: string
): Promise<void> {
  const zipFile = new ZipFile();
  zipFile.addFile(sourceFilePath, entryName);
  zipFile.end();

  await pipeline(zipFile.outputStream, createWriteStream(zipFilePath));
}

export async function prepareArtifactForJiraUpload(
  sourceFilePath: string,
  options: PrepareJiraArtifactUploadOptions = {}
): Promise<PreparedJiraArtifactUpload> {
  const attachmentName = path.basename(sourceFilePath);
  if (path.extname(attachmentName).toLowerCase() !== '.msi') {
    return {
      uploadPath: sourceFilePath,
      attachmentName
    };
  }

  const msiUploadName = buildMsiUploadName(sourceFilePath, options);
  const zipFilePath = path.join(path.dirname(sourceFilePath), `${msiUploadName}.zip`);
  await fs.rm(zipFilePath, { force: true });
  await zipSingleFile(sourceFilePath, zipFilePath, msiUploadName);

  return {
    uploadPath: zipFilePath,
    attachmentName: path.basename(zipFilePath),
    cleanup: async () => {
      await fs.rm(zipFilePath, { force: true });
    }
  };
}