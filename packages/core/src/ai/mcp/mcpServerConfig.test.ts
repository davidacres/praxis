import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_APP_SETTINGS, mergeAppSettings, sanitizeAppSettings } from '../../config/appSettings';
import { describeMcpServerProblem, enabledMcpServers, mcpServerSlug, sanitizeMcpServers } from './mcpServerConfig';

test('keeps well-formed http and stdio servers and drops malformed ones', () => {
  const servers = sanitizeMcpServers([
    { id: 'a', name: 'Docs', enabled: true, transport: 'http', url: 'https://example.com/mcp', headers: { Authorization: 'Bearer x', 'bad header': 'no' } },
    { id: 'b', name: 'Local', transport: 'stdio', command: 'npx', args: ['-y', 'thing', 7], env: { TOKEN: 'v', '1BAD': 'no' } },
    { id: 'c', name: 'No url', transport: 'http' },
    { id: 'd', name: 'File', transport: 'http', url: 'file:///etc/passwd' },
    { id: 'e', name: 'No command', transport: 'stdio' },
    { id: 'f', name: '', transport: 'stdio', command: 'x' },
    { id: 'g', name: 'Odd', transport: 'carrier-pigeon', url: 'https://example.com' },
    'nonsense'
  ]);
  assert.deepEqual(servers.map(server => server.id), ['a', 'b']);
  assert.deepEqual(servers[0].headers, { Authorization: 'Bearer x' });
  assert.deepEqual(servers[1].args, ['-y', 'thing']);
  assert.deepEqual(servers[1].env, { TOKEN: 'v' });
  // Approval is on unless the user turned it off.
  assert.equal(servers[0].requireApproval, true);
});

test('duplicate ids and names that would collide in tool names are dropped', () => {
  const servers = sanitizeMcpServers([
    { id: 'a', name: 'GitHub', transport: 'stdio', command: 'x' },
    { id: 'a', name: 'Other', transport: 'stdio', command: 'x' },
    { id: 'b', name: 'git-hub', transport: 'stdio', command: 'x' },
    { id: 'c', name: 'github', transport: 'stdio', command: 'x' }
  ]);
  assert.deepEqual(servers.map(server => server.id), ['a', 'b']);
});

test('slug and enabled filter', () => {
  assert.equal(mcpServerSlug('  GitHub Tools! '), 'github_tools');
  const servers = sanitizeMcpServers([
    { id: 'a', name: 'On', transport: 'stdio', command: 'x' },
    { id: 'b', name: 'Off', enabled: false, transport: 'stdio', command: 'x' }
  ]);
  assert.deepEqual(enabledMcpServers(servers).map(server => server.id), ['a']);
});

test('the form explains what is missing', () => {
  assert.match(describeMcpServerProblem({ name: '', transport: 'http' }) ?? '', /Name/);
  assert.match(describeMcpServerProblem({ name: 'x', transport: 'http', url: 'nope' }) ?? '', /URL/);
  assert.match(describeMcpServerProblem({ name: 'x', transport: 'stdio' }) ?? '', /command/);
  assert.equal(describeMcpServerProblem({ name: 'x', transport: 'stdio', command: 'npx' }), undefined);
});

test('settings round-trip the list and a patch replaces it wholesale', () => {
  const server = { id: 'a', name: 'Docs', enabled: true, transport: 'http' as const, url: 'https://example.com/mcp', requireApproval: true };
  const withServer = mergeAppSettings(DEFAULT_APP_SETTINGS, { ai: { mcpServers: [server] } });
  assert.deepEqual(withServer.ai.mcpServers?.map(entry => entry.id), ['a']);
  assert.deepEqual(sanitizeAppSettings(JSON.parse(JSON.stringify(withServer))).ai.mcpServers?.map(entry => entry.id), ['a']);

  const replaced = mergeAppSettings(withServer, { ai: { mcpServers: [{ ...server, id: 'b', name: 'Other' }] } });
  assert.deepEqual(replaced.ai.mcpServers?.map(entry => entry.id), ['b']);
  assert.equal(mergeAppSettings(replaced, { ai: { mcpServers: [] } }).ai.mcpServers, undefined);
  // An unrelated patch leaves the list alone.
  assert.deepEqual(mergeAppSettings(replaced, { ai: { spendLimit: 5 } }).ai.mcpServers?.map(entry => entry.id), ['b']);
});
