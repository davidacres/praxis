import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PreviewAccessRegistry, previewAccessBlockedReason } from './previewAccess';

test('a granted origin opens', () => {
  const registry = new PreviewAccessRegistry();
  registry.grant('proj-1', 'run-1', 'web', 'http://127.0.0.1:5173');
  assert.equal(previewAccessBlockedReason('http://127.0.0.1:5173/', registry), undefined);
  assert.equal(previewAccessBlockedReason('http://127.0.0.1:5173/about', registry), undefined);
});

test('a different port on the same host stays blocked even with another port granted', () => {
  const registry = new PreviewAccessRegistry();
  registry.grant('proj-1', 'run-1', 'web', 'http://127.0.0.1:5173');
  const reason = previewAccessBlockedReason('http://127.0.0.1:5174/', registry);
  assert.match(reason ?? '', /no active preview grant/);
});

test("another project's ungranted origin stays blocked", () => {
  const registry = new PreviewAccessRegistry();
  registry.grant('proj-1', 'run-1', 'web', 'http://127.0.0.1:5173');
  const reason = previewAccessBlockedReason('http://127.0.0.1:9000/', registry);
  assert.match(reason ?? '', /no active preview grant/);
});

test('localhost and 127.0.0.1 are distinct origins — granting one does not grant the other', () => {
  const registry = new PreviewAccessRegistry();
  registry.grant('proj-1', 'run-1', 'web', 'http://127.0.0.1:5173');
  const reason = previewAccessBlockedReason('http://localhost:5173/', registry);
  assert.match(reason ?? '', /no active preview grant/);
});

test('a public host is never blocked by this policy, granted or not', () => {
  const registry = new PreviewAccessRegistry();
  assert.equal(previewAccessBlockedReason('https://example.com/', registry), undefined);
  assert.equal(previewAccessBlockedReason('https://docs.example.com/guide', registry), undefined);
});

test('a private-network (non-loopback) host is blocked without a grant, and opens once granted', () => {
  const registry = new PreviewAccessRegistry();
  assert.match(previewAccessBlockedReason('http://192.168.1.42:8080/', registry) ?? '', /no active preview grant/);
  registry.grant('proj-1', 'run-1', 'api', 'http://192.168.1.42:8080');
  assert.equal(previewAccessBlockedReason('http://192.168.1.42:8080/', registry), undefined);
});

test('a redirect to an unapproved private host is blocked — same policy as navigation', () => {
  const registry = new PreviewAccessRegistry();
  registry.grant('proj-1', 'run-1', 'web', 'http://127.0.0.1:5173');
  // The previewed page's own top-level navigation redirects to a different, ungranted private host.
  const reason = previewAccessBlockedReason('http://10.0.0.5:80/admin', registry);
  assert.match(reason ?? '', /no active preview grant/);
});

test('an unapproved private subresource is blocked — same policy applied to a subresource URL', () => {
  const registry = new PreviewAccessRegistry();
  registry.grant('proj-1', 'run-1', 'web', 'http://127.0.0.1:5173');
  // e.g. the previewed page's own JS trying to fetch a cloud metadata-style private endpoint.
  const reason = previewAccessBlockedReason('http://169.254.169.254/latest/meta-data/', registry);
  assert.match(reason ?? '', /no active preview grant/);
});

test('an unsupported scheme is refused regardless of grants', () => {
  const registry = new PreviewAccessRegistry();
  registry.grant('proj-1', 'run-1', 'web', 'http://127.0.0.1:5173');
  assert.match(previewAccessBlockedReason('file:///etc/passwd', registry) ?? '', /Unsupported scheme/);
});

test('a malformed URL is refused', () => {
  const registry = new PreviewAccessRegistry();
  assert.match(previewAccessBlockedReason('not a url', registry) ?? '', /Not a valid absolute URL/);
});

test('grant refuses a non-private origin outright', () => {
  const registry = new PreviewAccessRegistry();
  assert.throws(() => registry.grant('proj-1', 'run-1', 'web', 'https://example.com'), /non-private origin/);
});

test('grant refuses a malformed origin', () => {
  const registry = new PreviewAccessRegistry();
  assert.throws(() => registry.grant('proj-1', 'run-1', 'web', 'not a url'), /Not a valid http\(s\) origin/);
});

test('revoke on run closure removes exactly that run\'s grants and nothing else', () => {
  const registry = new PreviewAccessRegistry();
  registry.grant('proj-1', 'run-1', 'web', 'http://127.0.0.1:5173');
  registry.grant('proj-1', 'run-1', 'api', 'http://127.0.0.1:5000');
  registry.grant('proj-2', 'run-2', 'web', 'http://127.0.0.1:5174');

  registry.revokeRun('proj-1', 'run-1');

  assert.match(previewAccessBlockedReason('http://127.0.0.1:5173/', registry) ?? '', /no active preview grant/);
  assert.match(previewAccessBlockedReason('http://127.0.0.1:5000/', registry) ?? '', /no active preview grant/);
  assert.equal(previewAccessBlockedReason('http://127.0.0.1:5174/', registry), undefined, "another project's grant must survive");
});

test('re-granting the same origin to a new run supersedes the previous grant', () => {
  const registry = new PreviewAccessRegistry();
  registry.grant('proj-1', 'run-1', 'web', 'http://127.0.0.1:5173');
  registry.grant('proj-1', 'run-2', 'web', 'http://127.0.0.1:5173');
  assert.equal(registry.grants().length, 1);
  assert.equal(registry.grants()[0].runId, 'run-2');
});

test('revokeAll clears every grant across every project', () => {
  const registry = new PreviewAccessRegistry();
  registry.grant('proj-1', 'run-1', 'web', 'http://127.0.0.1:5173');
  registry.grant('proj-2', 'run-2', 'web', 'http://127.0.0.1:5174');
  registry.revokeAll();
  assert.deepEqual(registry.grants(), []);
});

test('grants() reports the granting identity for each origin', () => {
  const registry = new PreviewAccessRegistry();
  registry.grant('proj-1', 'run-1', 'web', 'http://127.0.0.1:5173');
  const [grant] = registry.grants();
  assert.equal(grant.projectId, 'proj-1');
  assert.equal(grant.runId, 'run-1');
  assert.equal(grant.serviceId, 'web');
  assert.equal(grant.origin, 'http://127.0.0.1:5173');
  assert.ok(grant.grantedAt);
});
