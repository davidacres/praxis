import * as assert from 'assert';
import {
  resolveCopilotCliOverride,
  resolveCopilotClientOptions
} from '../ai/copilotSdkRuntime';

suite('Copilot SDK runtime config', () => {
  test('returns no override when no cli path is configured', () => {
    assert.deepStrictEqual(resolveCopilotCliOverride(''), {});
    assert.deepStrictEqual(resolveCopilotCliOverride(undefined), {});
  });

  test('preserves a real custom copilot cli override', () => {
    const resolved = resolveCopilotCliOverride('C:/tools/copilot-runtime/copilot.exe');
    assert.strictEqual(resolved.cliPath, 'C:/tools/copilot-runtime/copilot.exe');
    assert.strictEqual(resolved.warning, undefined);
  });

  test('ignores vscode cli launcher paths', () => {
    const resolved = resolveCopilotCliOverride('C:\\Program Files\\Microsoft VS Code\\Code.exe');
    assert.strictEqual(resolved.cliPath, undefined);
    assert.ok(resolved.warning?.includes('editor launcher'));
  });

  test('ignores cursor cli launcher paths', () => {
    const resolved = resolveCopilotCliOverride('/Applications/Cursor.app/Contents/Resources/app/bin/cursor');
    assert.strictEqual(resolved.cliPath, undefined);
    assert.ok(resolved.warning?.includes('GitHub Copilot SDK runtime'));
  });

  test('uses ELECTRON_RUN_AS_NODE for default bundled runtime under Electron', () => {
    const resolved = resolveCopilotClientOptions(undefined, {
      isElectronHost: true,
      env: { PATH: 'test-path' }
    });

    assert.ok(resolved.clientOptions.cliPath);
    const cliPath = resolved.clientOptions.cliPath ?? '';
    const usesJsLoader = /[\\/]@github[\\/]copilot[\\/]npm-loader\.js$/i.test(cliPath);
    const usesNativeBinary = /[\\/]@github[\\/]copilot-[^\\/]+[\\/].*copilot(?:\.exe)?$/i.test(cliPath);

    assert.ok(usesJsLoader || usesNativeBinary);
    if (usesJsLoader) {
      assert.strictEqual(resolved.clientOptions.env?.ELECTRON_RUN_AS_NODE, '1');
      assert.strictEqual(resolved.clientOptions.env?.PATH, 'test-path');
    } else {
      assert.strictEqual(resolved.clientOptions.env, undefined);
    }
  });

  test('uses ELECTRON_RUN_AS_NODE for javascript cli overrides under Electron', () => {
    const resolved = resolveCopilotClientOptions('C:/copilot/index.js', {
      isElectronHost: true,
      env: {}
    });

    assert.strictEqual(resolved.clientOptions.cliPath, 'C:/copilot/index.js');
    assert.strictEqual(resolved.clientOptions.env?.ELECTRON_RUN_AS_NODE, '1');
  });

  test('does not force ELECTRON_RUN_AS_NODE for native cli executables', () => {
    const resolved = resolveCopilotClientOptions('C:/copilot/copilot.exe', {
      isElectronHost: true,
      env: {}
    });

    assert.strictEqual(resolved.clientOptions.cliPath, 'C:/copilot/copilot.exe');
    assert.strictEqual(resolved.clientOptions.env, undefined);
  });
});
