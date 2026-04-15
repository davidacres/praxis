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
});