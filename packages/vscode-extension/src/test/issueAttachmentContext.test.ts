import * as assert from 'node:assert';
import { readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import { stageIssueAttachments } from '../ai/issueAttachmentContext';
import type { IssueAttachment } from '../types';
import type { IssueTrackerService } from '../backends/issueTrackerService';

suite('issueAttachmentContext', () => {
  const createdDirectories = new Set<string>();

  teardown(async () => {
    await Promise.all([...createdDirectories].map(directory => rm(directory, { recursive: true, force: true })));
    createdDirectories.clear();
  });

  test('downloads attachments and writes a manifest file', async () => {
    const attachments: IssueAttachment[] = [
      {
        id: '1',
        fileName: 'mockup.png',
        mimeType: 'image/png',
        contentUrl: 'https://jira.example/attachment/1/mockup.png'
      },
      {
        id: '2',
        fileName: 'notes.txt',
        mimeType: 'text/plain',
        contentUrl: 'https://jira.example/attachment/2/notes.txt'
      }
    ];

    const backendService = {
      async downloadAttachment(_issueKey: string, attachment: IssueAttachment, targetFilePath: string): Promise<void> {
        createdDirectories.add(path.dirname(targetFilePath));
        await import('node:fs/promises').then(fs =>
          fs.writeFile(targetFilePath, `downloaded:${attachment.fileName}`, 'utf8')
        );
      }
    } as unknown as IssueTrackerService;

    const staged = await stageIssueAttachments({
      issue: {
        key: 'APP-42',
        attachments
      },
      backendService
    });

    assert.strictEqual(staged[0]?.fileName, 'ATTACHMENTS.md');
    assert.strictEqual(staged.length, 3);

    const manifestText = await readFile(staged[0]!.localPath, 'utf8');
    assert.match(manifestText, /mockup\.png/);
    assert.match(manifestText, /notes\.txt/);

    const downloadedText = await readFile(staged[1]!.localPath, 'utf8');
    assert.strictEqual(downloadedText, 'downloaded:mockup.png');
  });

  test('excludes .msi.zip build artifacts from downloads', async () => {
    const attachments: IssueAttachment[] = [
      {
        id: '1',
        fileName: 'mockup.png',
        mimeType: 'image/png',
        contentUrl: 'https://jira.example/attachment/1/mockup.png'
      },
      {
        id: '2',
        fileName: 'systemconfigurator-kamai-80-01.msi.zip',
        mimeType: 'application/zip',
        contentUrl: 'https://jira.example/attachment/2/systemconfigurator-kamai-80-01.msi.zip'
      },
      {
        id: '3',
        fileName: 'Another-Build.MSI.ZIP',
        mimeType: 'application/zip',
        contentUrl: 'https://jira.example/attachment/3/Another-Build.MSI.ZIP'
      }
    ];

    const downloaded: string[] = [];
    const backendService = {
      async downloadAttachment(_issueKey: string, attachment: IssueAttachment, targetFilePath: string): Promise<void> {
        downloaded.push(attachment.fileName);
        createdDirectories.add(path.dirname(targetFilePath));
        await import('node:fs/promises').then(fs =>
          fs.writeFile(targetFilePath, `downloaded:${attachment.fileName}`, 'utf8')
        );
      }
    } as unknown as IssueTrackerService;

    const logMessages: string[] = [];
    const staged = await stageIssueAttachments({
      issue: {
        key: 'KAMAI-80',
        attachments
      },
      backendService,
      logger: { appendLine: (msg: string) => logMessages.push(msg) }
    });

    // Only mockup.png should be downloaded (+ manifest)
    assert.strictEqual(staged.length, 2);
    assert.strictEqual(staged[0]?.fileName, 'ATTACHMENTS.md');
    assert.strictEqual(staged[1]?.fileName, 'mockup.png');
    assert.deepStrictEqual(downloaded, ['mockup.png']);

    // Both .msi.zip files should be logged as skipped
    assert.ok(logMessages.some(msg => msg.includes('Skipping build artifact') && msg.includes('systemconfigurator-kamai-80-01.msi.zip')));
    assert.ok(logMessages.some(msg => msg.includes('Skipping build artifact') && msg.includes('Another-Build.MSI.ZIP')));
  });
});