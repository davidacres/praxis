/**
 * Launch configuration discovery (FX-BE-054 / TASK-142).
 *
 * Reads only — a manifest is inspected for what command a service already
 * declares, never executed to find out what it does. Every function here
 * takes already-read file content and returns a *proposal*; nothing is
 * persisted, and nothing here writes a `run.praxis.json` — a person reviews
 * and can edit the proposal first, and whatever they do save still passes
 * through `runProfile.ts`'s own fail-closed `validateRunProfile`.
 */

export interface ProposedRunService {
  executable: string;
  args: string[];
  /** The port the process itself binds to, when discoverable. */
  port?: number;
  /**
   * Where a browser should be pointed once the service is ready — distinct
   * from `port`/the bind address. A dev server can bind `0.0.0.0` while only
   * `localhost` is a sane browser origin, and an ASP.NET `launchUrl` can be a
   * sub-path ("swagger") the bind address alone never conveys.
   */
  browserOrigin?: string;
  source: 'package.json' | 'launchSettings.json';
}

const NODE_SCRIPT_PRIORITY = ['dev', 'start', 'serve'];

interface NodePackageJson {
  scripts?: Record<string, string>;
}

/** Proposes a service from a Node `package.json`'s own `scripts` — parses only, never runs any of them. */
export function proposeNodeRunService(packageJsonContent: string): ProposedRunService | undefined {
  let pkg: NodePackageJson;
  try {
    pkg = JSON.parse(packageJsonContent) as NodePackageJson;
  } catch {
    return undefined;
  }
  const scriptName = NODE_SCRIPT_PRIORITY.find(name => typeof pkg.scripts?.[name] === 'string');
  if (!scriptName) return undefined;
  return { executable: 'npm', args: ['run', scriptName], source: 'package.json' };
}

interface LaunchSettingsProfile {
  commandName?: string;
  applicationUrl?: string;
  launchBrowser?: boolean;
  launchUrl?: string;
}

interface LaunchSettingsFile {
  profiles?: Record<string, LaunchSettingsProfile>;
}

function firstPort(applicationUrl: string): { bindUrl?: string; port?: number } {
  const bindUrl = applicationUrl
    .split(';')
    .map(url => url.trim())
    .find(Boolean);
  if (!bindUrl) return {};
  try {
    const port = Number(new URL(bindUrl).port);
    return { bindUrl, ...(Number.isInteger(port) && port > 0 ? { port } : {}) };
  } catch {
    return { bindUrl };
  }
}

/** Proposes a service from an ASP.NET `Properties/launchSettings.json` — parses only, never runs `dotnet run`. */
export function proposeDotnetRunService(launchSettingsContent: string): ProposedRunService | undefined {
  let parsed: LaunchSettingsFile;
  try {
    parsed = JSON.parse(launchSettingsContent) as LaunchSettingsFile;
  } catch {
    return undefined;
  }
  const profiles = Object.entries(parsed.profiles ?? {});
  // Prefer a profile that actually launches the project executable, not IIS Express.
  const [, profile] = profiles.find(([, candidate]) => candidate.commandName === 'Project') ?? profiles[0] ?? [];
  if (!profile?.applicationUrl) return undefined;

  const { bindUrl, port } = firstPort(profile.applicationUrl);
  const browserOrigin =
    profile.launchBrowser && bindUrl
      ? profile.launchUrl
        ? `${bindUrl.replace(/\/+$/, '')}/${profile.launchUrl.replace(/^\/+/, '')}`
        : bindUrl
      : undefined;

  return {
    executable: 'dotnet',
    args: ['run'],
    ...(port ? { port } : {}),
    ...(browserOrigin ? { browserOrigin } : {}),
    source: 'launchSettings.json'
  };
}
