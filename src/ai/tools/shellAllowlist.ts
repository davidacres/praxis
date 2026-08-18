import type { ToolPermissionRequest } from './localTools';

function normalizeShellSegment(segment: string): string {
  return segment.replaceAll(/\s+/g, ' ').trim();
}

function isDirectoryChangeSegment(segment: string): boolean {
  const normalized = normalizeShellSegment(segment).toLowerCase();
  return (
    normalized.startsWith('cd ') ||
    normalized.startsWith('set-location ') ||
    normalized.startsWith('push-location ')
  );
}

function isSafeShellProbeSegment(segment: string): boolean {
  const normalized = normalizeShellSegment(segment);
  const patterns = [
    /^dotnet\s+--version(?:\s+2>&1)?$/i,
    /^node\s+--version(?:\s+2>&1)?$/i,
    /^npm\s+--version(?:\s+2>&1)?$/i,
    /^git\s+--version(?:\s+2>&1)?$/i,
    /^python(?:3)?\s+--version(?:\s+2>&1)?$/i,
    /^where(?:\.exe)?\s+(?:dotnet|node|npm|git|python(?:3)?)(?:\s+2>&1)?$/i,
    /^(?:pwd|get-location)(?:\s+2>&1)?$/i
  ];
  return patterns.some(pattern => pattern.test(normalized));
}

function isSafeGitInspectionSegment(segment: string): boolean {
  const normalized = normalizeShellSegment(segment);
  const patterns = [
    /^git\s+(?:--no-pager\s+)?status(?:\s+.*)?$/i,
    /^git\s+(?:--no-pager\s+)?branch(?:\s+.*)?$/i,
    /^git\s+(?:--no-pager\s+)?log(?:\s+.*)?$/i,
    /^git\s+(?:--no-pager\s+)?diff(?:\s+.*)?$/i,
    /^git\s+(?:--no-pager\s+)?show(?:\s+.*)?$/i,
    /^git\s+rev-parse(?:\s+.*)?$/i,
    /^git\s+symbolic-ref(?:\s+.*)?$/i,
    /^git\s+describe(?:\s+.*)?$/i,
    /^git\s+ls-files(?:\s+.*)?$/i,
    /^git\s+remote\s+-v$/i,
    /^git\s+remote\s+show(?:\s+.*)?$/i,
    /^git\s+tag(?:\s+--list|\s+-l)?(?:\s+.*)?$/i,
    /^git\s+stash\s+list(?:\s+.*)?$/i,
    /^git\s+config\s+--get(?:-all)?(?:\s+.*)?$/i,
    /^git\s+merge-base(?:\s+.*)?$/i,
    /^git\s+submodule\s+status(?:\s+.*)?$/i
  ];
  return patterns.some(pattern => pattern.test(normalized));
}

function isSafeBuildShellSegment(segment: string): boolean {
  const normalized = normalizeShellSegment(segment);
  const powershellScriptMatch =
    /^(?:pwsh|powershell)(?:\.exe)?\s+.+?-file\s+(?<script>[^\s]+)(?:\s+.*)?$/i.exec(normalized);
  if (powershellScriptMatch?.groups?.script) {
    const scriptPath = powershellScriptMatch.groups.script.replaceAll(/^['"]|['"]$/g, '').toLowerCase();
    if (
      scriptPath.includes('build') ||
      scriptPath.includes('publish') ||
      scriptPath.includes('package') ||
      scriptPath.includes('test') ||
      scriptPath.includes('install')
    ) {
      return true;
    }
  }

  const patterns = [
    /^dotnet\s+(?:build|publish|test|pack|restore|msbuild|clean|workload\s+restore)(?:\s+.*)?$/i,
    /^msbuild(?:\.exe)?\s+.+$/i,
    /^npm\s+(?:build|compile|package|pack|test|ci)(?:\s+.*)?$/i,
    /^npm\s+run\s+(?:build|compile|package|pack|test|ci)(?:\s+.*)?$/i,
    /^npm\s+(?:install(?::[\w:-]+)|run\s+install(?::[\w:-]+))(?:\s+.*)?$/i,
    /^npx\s+.+$/i,
    /^(?:candle|light|heat|wix)(?:\.exe)?\s+.+$/i,
    /^nuget(?:\.exe)?\s+(?:restore|pack)(?:\s+.*)?$/i
  ];
  return patterns.some(pattern => pattern.test(normalized));
}

/** Auto-allow safe read/list and a curated set of inspection/build shell commands. */
export function shouldAutoAllowToolPermission(request: ToolPermissionRequest): boolean {
  if (request.kind === 'read' || request.kind === 'list') {
    return true;
  }
  if (request.kind !== 'shell') {
    return false;
  }

  const command = request.detail?.trim();
  if (!command) {
    return false;
  }

  const segments = command
    .split('&&')
    .map(segment => segment.trim())
    .filter(segment => segment.length > 0);
  if (segments.length === 0) {
    return false;
  }

  return segments.every(
    segment =>
      isDirectoryChangeSegment(segment) ||
      isSafeShellProbeSegment(segment) ||
      isSafeGitInspectionSegment(segment) ||
      isSafeBuildShellSegment(segment)
  );
}
