import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRunProfile, writeRunProfile } from './runProfileStore';
import { RUN_PROFILE_SCHEMA_VERSION, type RunProfile } from './runProfile';
import { writeFile, mkdir } from 'node:fs/promises';

function profile(): RunProfile {
  return {
    schemaVersion: RUN_PROFILE_SCHEMA_VERSION,
    id: 'default',
    name: 'Default run',
    services: [{ id: 'api', name: 'API', executable: 'node', args: ['server.js'], cwd: 'apps/api', port: 5000 }],
    createdAt: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:00.000Z'
  };
}

test('reading a project with no run profile comes back with no profile and no issues', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-runprofile-'));
  try {
    const result = await readRunProfile(dir);
    assert.deepEqual(result, { issues: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a profile written then read back round-trips unchanged', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-runprofile-'));
  try {
    await writeRunProfile(dir, profile());
    const result = await readRunProfile(dir);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.profile, profile());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeRunProfile refuses an invalid profile before touching disk', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-runprofile-'));
  try {
    const invalid: RunProfile = { ...profile(), services: [] };
    await assert.rejects(() => writeRunProfile(dir, invalid), /is invalid/);
    const result = await readRunProfile(dir);
    assert.deepEqual(result, { issues: [] }); // nothing was written
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a hand-edited malformed run.praxis.json comes back with a visible reason, not a silent empty profile', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-runprofile-'));
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'run.praxis.json'), 'not valid json', 'utf8');
    const result = await readRunProfile(dir);
    assert.equal(result.profile, undefined);
    assert.ok(result.issues.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rewriting a profile overwrites the file rather than appending to it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-runprofile-'));
  try {
    await writeRunProfile(dir, profile());
    const updated: RunProfile = { ...profile(), name: 'Renamed run' };
    await writeRunProfile(dir, updated);
    const result = await readRunProfile(dir);
    assert.equal(result.profile?.name, 'Renamed run');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
