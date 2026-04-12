import * as assert from 'assert';
import {
  buildUnreadablePathError,
  looksLikeMalformedWindowsPath,
  normalizeConfiguredFolderPath,
  toStoredFolderPath
} from '../livefolder/pathUtils';

suite('livefolder path utils', () => {
  test('win32 paths round-trip safely through stored forward-slash form', () => {
    const nativeWinPath = 'C:\\dev-ai\\exampleAdmin-main\\plans';
    const storedPath = toStoredFolderPath(nativeWinPath, 'win32');

    assert.strictEqual(storedPath, 'C:/dev-ai/exampleAdmin-main/plans');

    const roundTripped = JSON.parse(JSON.stringify({ liveFolderPath: storedPath })) as {
      liveFolderPath: string;
    };

    assert.strictEqual(
      normalizeConfiguredFolderPath(roundTripped.liveFolderPath, 'win32'),
      nativeWinPath
    );
  });

  test('win32 normalization also accepts raw backslash input', () => {
    const configuredPath = 'C:\\dev-ai\\exampleAdmin-main\\plans';

    assert.strictEqual(
      normalizeConfiguredFolderPath(configuredPath, 'win32'),
      'C:\\dev-ai\\exampleAdmin-main\\plans'
    );
  });

  test('posix paths round-trip unchanged', () => {
    const nativePosixPath = '/workspace/example-admin/plans';
    const storedPath = toStoredFolderPath(nativePosixPath, 'linux');

    assert.strictEqual(storedPath, nativePosixPath);

    const roundTripped = JSON.parse(JSON.stringify({ liveFolderPath: storedPath })) as {
      liveFolderPath: string;
    };

    assert.strictEqual(
      normalizeConfiguredFolderPath(roundTripped.liveFolderPath, 'linux'),
      nativePosixPath
    );
  });

  test('malformed windows paths are detected explicitly', () => {
    const malformedPath = 'c:ev-airakaAdmin-mainlans';

    assert.strictEqual(looksLikeMalformedWindowsPath(malformedPath), true);
    assert.match(
      buildUnreadablePathError(malformedPath, 'win32'),
      /use forward slashes like C:\/path\/to\/plans/i
    );
  });

  test('non-malformed posix paths do not get windows-specific guidance', () => {
    const error = buildUnreadablePathError('/workspace/plans', 'linux');

    assert.strictEqual(error, 'Selected path is not readable: /workspace/plans');
  });
});
