import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { prepareArtifactForJiraUpload } from '@praxis/core';

suite('jiraArtifactArchive', () => {
  const tempDirectories: string[] = [];

  teardown(async () => {
    await Promise.all(tempDirectories.map(dir => fs.rm(dir, { recursive: true, force: true })));
    tempDirectories.length = 0;
  });

  test('zips MSI artifacts before upload with ticket and build suffixes', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ticket-manager-archive-'));
    tempDirectories.push(tempDir);

    const artifactPath = path.join(tempDir, 'SystemConfigurator.msi');
    await fs.writeFile(artifactPath, Buffer.from('msi-content'));

    const prepared = await prepareArtifactForJiraUpload(artifactPath, {
      issueKey: 'KAMAI-43',
      buildIdentifier: '01'
    });

    assert.strictEqual(prepared.attachmentName, 'systemconfigurator-kamai-43-01.msi.zip');
    assert.strictEqual(
      prepared.uploadPath,
      path.join(tempDir, 'systemconfigurator-kamai-43-01.msi.zip')
    );

    const stats = await fs.stat(prepared.uploadPath);
    assert.ok(stats.size > 0);

    await prepared.cleanup?.();
    await assert.rejects(fs.stat(prepared.uploadPath));
  });

  test('defaults the MSI build suffix to a zero-padded artifact index', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ticket-manager-archive-'));
    tempDirectories.push(tempDir);

    const artifactPath = path.join(tempDir, 'SystemConfigurator.msi');
    await fs.writeFile(artifactPath, Buffer.from('msi-content'));

    const prepared = await prepareArtifactForJiraUpload(artifactPath, {
      issueKey: 'KAMAI-43',
      artifactIndex: 0
    });

    assert.strictEqual(prepared.attachmentName, 'systemconfigurator-kamai-43-01.msi.zip');
  });

  test('keeps non-MSI artifacts unchanged', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ticket-manager-archive-'));
    tempDirectories.push(tempDir);

    const artifactPath = path.join(tempDir, 'TicketManager.txt');
    await fs.writeFile(artifactPath, 'plain-text');

    const prepared = await prepareArtifactForJiraUpload(artifactPath);

    assert.strictEqual(prepared.attachmentName, 'TicketManager.txt');
    assert.strictEqual(prepared.uploadPath, artifactPath);
    assert.strictEqual(prepared.cleanup, undefined);
  });
});