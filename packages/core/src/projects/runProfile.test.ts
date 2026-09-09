import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRunProfile,
  RUN_PROFILE_SCHEMA_VERSION,
  serializeRunProfile,
  validateRunProfile,
  type RunProfile,
  type RunServiceDefinition
} from './runProfile';

function service(overrides: Partial<RunServiceDefinition> = {}): RunServiceDefinition {
  return { id: 'api', name: 'API', executable: 'node', args: ['server.js'], cwd: 'apps/api', ...overrides };
}

function profile(services: RunServiceDefinition[]): RunProfile {
  return {
    schemaVersion: RUN_PROFILE_SCHEMA_VERSION,
    id: 'default',
    name: 'Default run',
    services,
    createdAt: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:00.000Z'
  };
}

test('a well-formed profile with a frontend and an API service validates clean', () => {
  const p = profile([
    service({ id: 'api', cwd: 'apps/api', port: 5000, readinessProbe: { kind: 'http', path: '/healthz' } }),
    service({ id: 'web', name: 'Web', executable: 'npm', args: ['run', 'dev'], cwd: 'apps/web', dependsOn: ['api'], port: 3000 })
  ]);
  assert.deepEqual(validateRunProfile(p), { valid: true, errors: [] });
});

test('an ASP.NET-shaped service (dotnet executable, no port yet known) validates clean', () => {
  const p = profile([service({ id: 'api', executable: 'dotnet', args: ['run', '--project', 'Api.csproj'], cwd: 'src/Api' })]);
  assert.deepEqual(validateRunProfile(p), { valid: true, errors: [] });
});

// ── Round trip ────────────────────────────────────────────────────────────

test('a profile round-trips through serialize/parse unchanged', () => {
  const p = profile([service()]);
  const { profile: parsed, issues } = parseRunProfile(JSON.parse(serializeRunProfile(p)));
  assert.deepEqual(issues, []);
  assert.deepEqual(parsed, p);
});

test('parseRunProfile fails closed on a malformed payload', () => {
  const { profile: parsed, issues } = parseRunProfile({ not: 'a profile' });
  assert.equal(parsed, undefined);
  assert.ok(issues.length > 0);
});

test('parseRunProfile rejects a schema version it does not understand', () => {
  const { profile: parsed, issues } = parseRunProfile({ ...profile([service()]), schemaVersion: RUN_PROFILE_SCHEMA_VERSION + 1 });
  assert.equal(parsed, undefined);
  assert.ok(issues.some(issue => issue.path === 'schemaVersion'));
});

// ── Repo-relative paths ─────────────────────────────────────────────────

test('an absolute cwd is rejected', () => {
  const result = validateRunProfile(profile([service({ cwd: '/etc/passwd' })]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(issue => issue.path === 'services[0].cwd'));
});

test('a Windows-style absolute cwd is rejected even off a POSIX host', () => {
  const result = validateRunProfile(profile([service({ cwd: 'C:\\repo\\api' })]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(issue => issue.path === 'services[0].cwd'));
});

test('a relative cwd is accepted', () => {
  const result = validateRunProfile(profile([service({ cwd: 'apps/api' })]));
  assert.equal(result.valid, true);
});

// ── Duplicate ids ────────────────────────────────────────────────────────

test('duplicate service ids are rejected', () => {
  const result = validateRunProfile(profile([service({ id: 'api' }), service({ id: 'api', name: 'API 2' })]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(issue => issue.message.includes('Duplicate service id "api"')));
});

// ── Dependency cycles ────────────────────────────────────────────────────

test('a two-service dependency cycle is rejected with the cycle named', () => {
  const result = validateRunProfile(
    profile([service({ id: 'a', dependsOn: ['b'] }), service({ id: 'b', name: 'B', dependsOn: ['a'] })])
  );
  assert.equal(result.valid, false);
  const cycleIssue = result.errors.find(issue => issue.path === 'services');
  assert.ok(cycleIssue);
  assert.match(cycleIssue!.message, /cycle/i);
});

test('a longer cycle (a -> b -> c -> a) is also detected', () => {
  const result = validateRunProfile(
    profile([
      service({ id: 'a', dependsOn: ['b'] }),
      service({ id: 'b', name: 'B', dependsOn: ['c'] }),
      service({ id: 'c', name: 'C', dependsOn: ['a'] })
    ])
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(issue => issue.path === 'services'));
});

test('a dependsOn referencing an unknown service id is rejected', () => {
  const result = validateRunProfile(profile([service({ id: 'web', dependsOn: ['api'] })]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(issue => issue.message.includes('Unknown service id "api"')));
});

test('a valid DAG (diamond dependency) is accepted', () => {
  const result = validateRunProfile(
    profile([
      service({ id: 'db', name: 'DB', executable: 'postgres' }),
      service({ id: 'cache', name: 'Cache', executable: 'redis-server' }),
      service({ id: 'api', dependsOn: ['db', 'cache'] })
    ])
  );
  assert.equal(result.valid, true);
});

// ── Invalid probes ───────────────────────────────────────────────────────

test('an http probe with no path is rejected', () => {
  const result = validateRunProfile(profile([service({ readinessProbe: { kind: 'http', path: '' } })]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(issue => issue.path.endsWith('.path')));
});

test('a tcp probe with an out-of-range port is rejected', () => {
  const result = validateRunProfile(profile([service({ readinessProbe: { kind: 'tcp', port: 70000 } })]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(issue => issue.path.endsWith('.port')));
});

test('a log-line probe with an empty match is rejected', () => {
  const result = validateRunProfile(profile([service({ readinessProbe: { kind: 'log-line', match: '' } })]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(issue => issue.path.endsWith('.match')));
});

test('an unknown probe kind is rejected', () => {
  const result = validateRunProfile(
    profile([service({ readinessProbe: { kind: 'websocket' as never, path: '/x' } as never })])
  );
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(issue => issue.path.endsWith('.kind')));
});

test('a valid probe of each kind is accepted', () => {
  for (const probe of [
    { kind: 'http' as const, path: '/healthz' },
    { kind: 'tcp' as const, port: 5432 },
    { kind: 'log-line' as const, match: 'Server started' }
  ]) {
    const result = validateRunProfile(profile([service({ readinessProbe: probe })]));
    assert.equal(result.valid, true, JSON.stringify(probe));
  }
});

// ── Embedded secrets ─────────────────────────────────────────────────────

test('a literal value under a secret-shaped env key is rejected', () => {
  const result = validateRunProfile(profile([service({ env: { API_KEY: 'sk_live_abcdef1234567890' } })]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(issue => issue.path.endsWith('.env.API_KEY')));
});

test('a ${secret:NAME} reference under a secret-shaped env key is accepted', () => {
  const result = validateRunProfile(profile([service({ env: { API_KEY: '${secret:my-api-key}' } })]));
  assert.equal(result.valid, true);
});

test('a plain, non-secret-shaped env variable may hold a literal value', () => {
  const result = validateRunProfile(profile([service({ env: { NODE_ENV: 'development', PORT: '5000' } })]));
  assert.equal(result.valid, true);
});

test('every secret-shaped key vocabulary word is caught', () => {
  for (const key of ['DB_PASSWORD', 'AUTH_TOKEN', 'CLIENT_SECRET', 'STRIPE_APIKEY', 'GITHUB_API_KEY', 'MY_PAT']) {
    const result = validateRunProfile(profile([service({ env: { [key]: 'literal-value-not-a-reference' } })]));
    assert.equal(result.valid, false, key);
  }
});

// ── Structural ───────────────────────────────────────────────────────────

test('a profile with no services is rejected', () => {
  const result = validateRunProfile(profile([]));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(issue => issue.path === 'services'));
});

test('a profile missing id or name is rejected', () => {
  const result = validateRunProfile({ ...profile([service()]), id: '', name: '' });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(issue => issue.path === 'id'));
  assert.ok(result.errors.some(issue => issue.path === 'name'));
});
