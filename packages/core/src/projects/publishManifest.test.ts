import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPublishManifest,
  createPublishedArtifact,
  validatePublishedArtifact,
  PUBLISH_MANIFEST_SCHEMA_VERSION
} from './publishManifest';

async function makeDotnetPublishDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-publish-dotnet-'));
  await writeFile(path.join(dir, 'MyApp.dll'), Buffer.from('fake-dll-bytes'));
  await writeFile(path.join(dir, 'MyApp.deps.json'), '{"runtimeTarget":{}}');
  await writeFile(path.join(dir, 'MyApp.runtimeconfig.json'), '{"runtimeOptions":{}}');
  await mkdir(path.join(dir, 'runtimes', 'win-x64', 'native'), { recursive: true });
  await writeFile(path.join(dir, 'runtimes', 'win-x64', 'native', 'lib.dll'), Buffer.from('native'));
  return dir;
}

async function makeWebArtifactDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-publish-web-'));
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><html></html>');
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await writeFile(path.join(dir, 'assets', 'app.js'), 'console.log("hi");');
  await writeFile(path.join(dir, 'assets', 'app.css'), 'body{margin:0}');
  return dir;
}

test('a .NET publish directory validates', async () => {
  const dir = await makeDotnetPublishDir();
  try {
    const manifest = await buildPublishManifest(dir);
    assert.equal(manifest.schemaVersion, PUBLISH_MANIFEST_SCHEMA_VERSION);
    assert.equal(manifest.files.length, 4);
    const result = await validatePublishedArtifact(dir, manifest);
    assert.equal(result.valid, true);
    assert.deepEqual(result.issues, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a web artifact directory validates', async () => {
  const dir = await makeWebArtifactDir();
  try {
    const manifest = await buildPublishManifest(dir);
    assert.equal(manifest.files.length, 3);
    const result = await validatePublishedArtifact(dir, manifest);
    assert.equal(result.valid, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an absent artifact directory fails validation with every file reported missing', async () => {
  const dir = await makeWebArtifactDir();
  const manifest = await buildPublishManifest(dir);
  await rm(dir, { recursive: true, force: true });
  const result = await validatePublishedArtifact(dir, manifest);
  assert.equal(result.valid, false);
  assert.equal(result.issues.length, 3);
  assert.ok(result.issues.every(issue => issue.kind === 'missing'));
});

test('a modified file fails validation as "modified", not "missing"', async () => {
  const dir = await makeWebArtifactDir();
  try {
    const manifest = await buildPublishManifest(dir);
    await writeFile(path.join(dir, 'index.html'), '<!doctype html><html>tampered</html>');
    const result = await validatePublishedArtifact(dir, manifest);
    assert.equal(result.valid, false);
    assert.deepEqual(result.issues, [{ path: 'index.html', kind: 'modified' }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a file removed from the artifact after publishing fails validation as "missing"', async () => {
  const dir = await makeWebArtifactDir();
  try {
    const manifest = await buildPublishManifest(dir);
    await rm(path.join(dir, 'assets', 'app.js'));
    const result = await validatePublishedArtifact(dir, manifest);
    assert.equal(result.valid, false);
    assert.deepEqual(result.issues, [{ path: 'assets/app.js', kind: 'missing' }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a file added to the artifact after publishing fails validation as "unexpected"', async () => {
  const dir = await makeWebArtifactDir();
  try {
    const manifest = await buildPublishManifest(dir);
    await writeFile(path.join(dir, 'assets', 'sneaky.js'), 'eval("...")');
    const result = await validatePublishedArtifact(dir, manifest);
    assert.equal(result.valid, false);
    assert.deepEqual(result.issues, [{ path: 'assets/sneaky.js', kind: 'unexpected' }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a rebuilt-but-byte-identical artifact still validates — the digest is content-based, not timestamp-based', async () => {
  const first = await makeWebArtifactDir();
  const second = await makeWebArtifactDir();
  try {
    const manifestFromFirst = await buildPublishManifest(first);
    const result = await validatePublishedArtifact(second, manifestFromFirst);
    assert.equal(result.valid, true, 'two independently-created directories with identical content should validate against either manifest');
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});

test('the overall digest changes if any file changes, and is stable across re-builds of identical content', async () => {
  const dir = await makeWebArtifactDir();
  try {
    const before = await buildPublishManifest(dir);
    const rebuiltSameContent = await buildPublishManifest(dir);
    assert.equal(before.digest, rebuiltSameContent.digest);

    await writeFile(path.join(dir, 'index.html'), '<!doctype html><html>changed</html>');
    const after = await buildPublishManifest(dir);
    assert.notEqual(before.digest, after.digest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildPublishManifest rejects a path that is not a directory', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-publish-'));
  const filePath = path.join(dir, 'not-a-dir.txt');
  await writeFile(filePath, 'hello');
  try {
    await assert.rejects(() => buildPublishManifest(filePath), /Not a directory/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('createPublishedArtifact folds a manifest into a PublishedArtifact whose digest matches the manifest\'s own', async () => {
  const dir = await makeDotnetPublishDir();
  try {
    const { artifact, manifest } = await createPublishedArtifact({
      id: 'artifact-1',
      deploymentProfileId: 'production',
      sourceCommit: { kind: 'commit', sha: 'abc123' },
      rootDir: dir
    });
    assert.equal(artifact.digest, manifest.digest);
    assert.equal(artifact.deploymentProfileId, 'production');
    assert.deepEqual(artifact.location, { kind: 'local-path', path: dir });
    assert.deepEqual(artifact.sourceCommit, { kind: 'commit', sha: 'abc123' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('two structurally different artifacts (different file sets) never produce the same digest', async () => {
  const dotnetDir = await makeDotnetPublishDir();
  const webDir = await makeWebArtifactDir();
  try {
    const dotnetManifest = await buildPublishManifest(dotnetDir);
    const webManifest = await buildPublishManifest(webDir);
    assert.notEqual(dotnetManifest.digest, webManifest.digest);
  } finally {
    await rm(dotnetDir, { recursive: true, force: true });
    await rm(webDir, { recursive: true, force: true });
  }
});
