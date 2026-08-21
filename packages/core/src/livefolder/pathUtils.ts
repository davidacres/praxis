import * as path from 'node:path';

export type SupportedPathPlatform = 'win32' | 'linux' | 'darwin';

function isWindowsPlatform(platform: SupportedPathPlatform = process.platform as SupportedPathPlatform): boolean {
  return platform === 'win32';
}

export function normalizeConfiguredFolderPath(
  filePath: string,
  platform: SupportedPathPlatform = process.platform as SupportedPathPlatform
): string {
  const trimmed = filePath.trim();
  if (isWindowsPlatform(platform)) {
    return path.win32.normalize(trimmed.replace(/\//g, '\\'));
  }
  return path.posix.normalize(trimmed.replace(/\\/g, '/'));
}

export function toStoredFolderPath(
  fsPath: string,
  platform: SupportedPathPlatform = process.platform as SupportedPathPlatform
): string {
  const trimmed = fsPath.trim();
  if (isWindowsPlatform(platform)) {
    return path.win32.normalize(trimmed).replace(/\\/g, '/');
  }
  return path.posix.normalize(trimmed);
}

export function looksLikeMalformedWindowsPath(filePath: string): boolean {
  const trimmed = filePath.trim();
  return (
    /^[A-Za-z]:[^\\/]/.test(trimmed) &&
    !trimmed.includes('\\') &&
    !trimmed.includes('/')
  );
}

export function buildUnreadablePathError(
  filePath: string,
  platform: SupportedPathPlatform = process.platform as SupportedPathPlatform
): string {
  const guidance =
    isWindowsPlatform(platform) && looksLikeMalformedWindowsPath(filePath)
      ? ' This looks like a malformed Windows path. If it was entered in JSON settings, use forward slashes like C:/path/to/plans, double backslashes like C:\\\\path\\\\to\\\\plans, or reselect the folder with Browse.'
      : '';
  return `Selected path is not readable: ${filePath}${guidance}`;
}
