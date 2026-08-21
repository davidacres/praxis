import * as nodePath from 'node:path';

export class PathSandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathSandboxError';
  }
}

/** Resolve a user-supplied path under workingDirectory; reject escapes. */
export function resolveSandboxedPath(workingDirectory: string, inputPath: string): string {
  const root = nodePath.resolve(workingDirectory);
  const candidate = nodePath.isAbsolute(inputPath)
    ? nodePath.resolve(inputPath)
    : nodePath.resolve(root, inputPath);

  const relative = nodePath.relative(root, candidate);
  if (relative.startsWith('..') || nodePath.isAbsolute(relative)) {
    throw new PathSandboxError(`Path escapes working directory: ${inputPath}`);
  }
  return candidate;
}
