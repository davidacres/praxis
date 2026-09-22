import assert from 'node:assert/strict';
import test from 'node:test';
import type { MobileAccessSettings } from '@praxis/core';
import { resolveMobileListenerChange } from './mobileAccessLifecycle';

const settings = (over: Partial<MobileAccessSettings> = {}): MobileAccessSettings => ({
  mode: 'off',
  hostName: 'Dave Mac',
  allowedInterfaces: [],
  allowedSubnets: [],
  remoteSignInRequired: false,
  listenPort: 43100,
  ...over,
});

test('off means no listener and nothing to drop', () => {
  const change = resolveMobileListenerChange(undefined, settings({ mode: 'off' }));
  assert.equal(change.listener.bound, false);
  assert.equal(change.bind, false);
  assert.equal(change.dropConnections, false);
});

test('first enable binds without dropping (there are no peers yet)', () => {
  const change = resolveMobileListenerChange(undefined, settings({ mode: 'local-only' }));
  assert.equal(change.listener.bound, true);
  assert.equal(change.listener.mode, 'local-only');
  assert.equal(change.bind, true);
  assert.equal(change.dropConnections, false);
});

test('turning access off unbinds and severs every peer', () => {
  const previous = resolveMobileListenerChange(undefined, settings({ mode: 'internet' })).listener;
  const change = resolveMobileListenerChange(previous, settings({ mode: 'off' }));
  assert.equal(change.unbind, true);
  assert.equal(change.listener.bound, false);
  assert.equal(change.dropConnections, true);
});

test('narrowing internet -> local-only drops peers; widening local-only -> internet keeps them', () => {
  const internet = resolveMobileListenerChange(undefined, settings({ mode: 'internet' })).listener;
  const narrow = resolveMobileListenerChange(internet, settings({ mode: 'local-only' }));
  assert.equal(narrow.dropConnections, true);
  assert.equal(narrow.bind, true);

  const local = resolveMobileListenerChange(undefined, settings({ mode: 'local-only' })).listener;
  const widen = resolveMobileListenerChange(local, settings({ mode: 'internet' }));
  assert.equal(widen.dropConnections, false);
});

test('a lateral allowlist change at the same mode drops established peers', () => {
  const before = resolveMobileListenerChange(undefined, settings({ mode: 'local-only' })).listener;
  const change = resolveMobileListenerChange(before, settings({ mode: 'local-only', allowedInterfaces: ['en0'] }));
  assert.equal(change.dropConnections, true);
  assert.equal(change.bind, false);
});

test('no change is a no-op', () => {
  const before = resolveMobileListenerChange(undefined, settings({ mode: 'local-only' })).listener;
  const change = resolveMobileListenerChange(before, settings({ mode: 'local-only' }));
  assert.equal(change.bind, false);
  assert.equal(change.unbind, false);
  assert.equal(change.dropConnections, false);
});

test('changing the listen port rebinds and drops peers', () => {
  const before = resolveMobileListenerChange(undefined, settings({ mode: 'local-only', listenPort: 43100 })).listener;
  const change = resolveMobileListenerChange(before, settings({ mode: 'local-only', listenPort: 43101 }));
  assert.equal(change.bind, true);
  assert.equal(change.dropConnections, true);
  assert.equal(change.listener.port, 43101);
});
