import assert from 'node:assert/strict';
import test from 'node:test';
import { getMobileHostIdentity, resetMobileHostIdentity, rotateMobileHostIdentity } from './mobileHostIdentity';

test('identity reads share one load and wait behind host-key rotation', async () => {
  const storeModule = require('./connectionStoreInstance') as typeof import('./connectionStoreInstance');
  const originalStore = storeModule.getSecretsStore;
  const originalOverride = process.env.PRAXIS_MOBILE_HOST_KEY;
  delete process.env.PRAXIS_MOBILE_HOST_KEY;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let deleting!: () => void;
  const entered = new Promise<void>(resolve => { deleting = resolve; });
  const values = new Map([['mobile:hostStaticKey', '01'.repeat(32)]]);
  const store = {
    get: async (key: string) => values.get(key),
    store: async (key: string, value: string) => { values.set(key, value); },
    delete: async (key: string) => {
      if (key === 'mobile:hostStaticKey') { deleting(); await gate; }
      values.delete(key);
    },
  };
  storeModule.getSecretsStore = () => store as ReturnType<typeof originalStore>;
  resetMobileHostIdentity();
  try {
    const [first, same] = await Promise.all([getMobileHostIdentity(), getMobileHostIdentity()]);
    assert.equal(first, same);
    const rotation = rotateMobileHostIdentity();
    await entered;
    let readFinished = false;
    const read = getMobileHostIdentity().then(value => { readFinished = true; return value; });
    await Promise.resolve();
    assert.equal(readFinished, false, 'status readers must wait while the old secret is being deleted');
    release();
    const [rotated, during] = await Promise.all([rotation, read]);
    assert.notDeepEqual(rotated.publicKey, first.publicKey);
    assert.equal(rotated, during);
    assert.equal(await getMobileHostIdentity(), rotated);
  } finally {
    release();
    storeModule.getSecretsStore = originalStore;
    if (originalOverride === undefined) delete process.env.PRAXIS_MOBILE_HOST_KEY;
    else process.env.PRAXIS_MOBILE_HOST_KEY = originalOverride;
    resetMobileHostIdentity();
  }
});
