/**
 * Project Run profiles (FX-BE-054 / TASK-141).
 *
 * Describes the frontend, API and dependent processes a project runs
 * locally for a diagnostic preview — deliberately separate from a deployment
 * profile (FX-BF-023): Run owns ephemeral local services, Deployments owns
 * persistent installed versions (delivery-debugging-roadmap.md's "Agreed
 * product decisions"). Stored as `run.praxis.json`, one form per
 * AGENTS.md's "Naming a file Praxis writes": `<name>.praxis.<ext>`.
 *
 * Everything here fails closed, matching `workflowValidation.ts`'s
 * discipline: a profile that cannot be proven safe is rejected rather than
 * repaired into something that merely runs, because the cost of silently
 * launching the wrong command, or leaking a secret into a committed file, is
 * far higher than the cost of refusing to save it.
 */

import { isPortableFolderPath } from '../workspaces/workspacePaths';

export const RUN_PROFILE_FILE_NAME = 'run.praxis.json';
export const RUN_PROFILE_SCHEMA_VERSION = 1;

export interface RunHttpProbe {
  kind: 'http';
  /** Relative to the service's own base URL, e.g. "/healthz". */
  path: string;
  /** Defaults to any 2xx when absent. */
  expectedStatus?: number;
}

export interface RunTcpProbe {
  kind: 'tcp';
  port: number;
}

/** A substring the service's own stdout must emit once ready — never a command, only ever matched, never run. */
export interface RunLogLineProbe {
  kind: 'log-line';
  match: string;
}

export type RunReadinessProbe = RunHttpProbe | RunTcpProbe | RunLogLineProbe;

export interface RunServiceDefinition {
  id: string;
  name: string;
  executable: string;
  args?: string[];
  /** Repo-relative, resolved against the project's workspace folder at launch — never stored absolute. */
  cwd?: string;
  /** Other service ids this one must be ready before starting. Must form a DAG — see `validateRunProfile`. */
  dependsOn?: string[];
  readinessProbe?: RunReadinessProbe;
  port?: number;
  /**
   * Environment variable NAMES this service needs. A secret-shaped key
   * (`SECRET_REFERENCE_PATTERN` — see below) must hold a `${secret:NAME}`
   * reference resolved from the secret store at launch, never a literal
   * value; a plain non-secret variable may hold a literal.
   */
  env?: Record<string, string>;
}

export interface RunProfile {
  schemaVersion: number;
  id: string;
  name: string;
  services: RunServiceDefinition[];
  createdAt: string;
  updatedAt: string;
}

export interface RunProfileIssue {
  path: string;
  message: string;
}

export interface RunProfileValidationResult {
  valid: boolean;
  errors: RunProfileIssue[];
}

/**
 * Same secret-shaped-key vocabulary `workspaceTypes.ts`'s `SECRET_SETTING_PATTERN`
 * uses for settings fields, adapted for `SCREAMING_SNAKE_CASE` env var names:
 * `\b` treats `_` as a word character, so plain `\bpat\b` never matches inside
 * `MY_PAT` — the underscore-aware `(?:^|_)pat(?:_|$)` does.
 */
const SECRET_KEY_PATTERN = /token|secret|password|api[_-]?key|(?:^|_)pat(?:_|$)/i;
const SECRET_REFERENCE_PATTERN = /^\$\{secret:[A-Za-z0-9_.-]+\}$/;
const PROBE_KINDS = new Set(['http', 'tcp', 'log-line']);

/** Whether an env/config key name looks like it holds a secret — exported so other "store references, not values" schemas (e.g. `deploymentProfile.ts`) share this exact vocabulary rather than a second copy. */
export function isSecretShapedKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/** Whether a value is a `${secret:NAME}` reference — the only shape a secret-shaped key's value may hold. */
export function isSecretReferenceValue(value: string): boolean {
  return SECRET_REFERENCE_PATTERN.test(value);
}

function isValidPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535;
}

/**
 * Fails closed on duplicate ids, a dependency cycle, an ill-shaped probe, an
 * absolute `cwd`, and a secret-shaped env key holding anything but a
 * `${secret:NAME}` reference.
 */
export function validateRunProfile(profile: RunProfile): RunProfileValidationResult {
  const errors: RunProfileIssue[] = [];

  if (!profile.id.trim()) errors.push({ path: 'id', message: 'id is required.' });
  if (!profile.name.trim()) errors.push({ path: 'name', message: 'name is required.' });
  if (profile.services.length === 0) errors.push({ path: 'services', message: 'A run profile needs at least one service.' });

  const seenIds = new Set<string>();
  for (const [index, service] of profile.services.entries()) {
    const at = `services[${index}]`;

    if (!service.id.trim()) {
      errors.push({ path: `${at}.id`, message: 'id is required.' });
    } else if (seenIds.has(service.id)) {
      errors.push({ path: `${at}.id`, message: `Duplicate service id "${service.id}".` });
    } else {
      seenIds.add(service.id);
    }

    if (!service.executable.trim()) errors.push({ path: `${at}.executable`, message: 'executable is required.' });

    if (service.cwd !== undefined && !isPortableFolderPath(service.cwd)) {
      errors.push({ path: `${at}.cwd`, message: `cwd must be repo-relative, not absolute: "${service.cwd}".` });
    }

    if (service.port !== undefined && !isValidPort(service.port)) {
      errors.push({ path: `${at}.port`, message: 'port must be an integer between 1 and 65535.' });
    }

    if (service.readinessProbe) {
      const probe = service.readinessProbe;
      if (!PROBE_KINDS.has(probe.kind)) {
        errors.push({ path: `${at}.readinessProbe.kind`, message: `Unknown readiness probe kind "${(probe as { kind: string }).kind}".` });
      } else if (probe.kind === 'http' && !probe.path?.trim()) {
        errors.push({ path: `${at}.readinessProbe.path`, message: 'An http probe needs a path.' });
      } else if (probe.kind === 'tcp' && !isValidPort(probe.port)) {
        errors.push({ path: `${at}.readinessProbe.port`, message: 'A tcp probe needs a valid port (1-65535).' });
      } else if (probe.kind === 'log-line' && !probe.match?.trim()) {
        errors.push({ path: `${at}.readinessProbe.match`, message: 'A log-line probe needs a non-empty match string.' });
      }
    }

    for (const [key, value] of Object.entries(service.env ?? {})) {
      if (SECRET_KEY_PATTERN.test(key) && !SECRET_REFERENCE_PATTERN.test(value)) {
        errors.push({
          path: `${at}.env.${key}`,
          message: `"${key}" looks like a secret; use a \${secret:NAME} reference, never a literal value.`
        });
      }
    }
  }

  for (const [index, service] of profile.services.entries()) {
    for (const dep of service.dependsOn ?? []) {
      if (!seenIds.has(dep)) {
        errors.push({ path: `services[${index}].dependsOn`, message: `Unknown service id "${dep}".` });
      }
    }
  }

  const cycle = findDependencyCycle(profile.services);
  if (cycle) {
    errors.push({ path: 'services', message: `Service dependencies form a cycle: ${cycle.join(' → ')}.` });
  }

  return { valid: errors.length === 0, errors };
}

/** DFS cycle detection over `dependsOn`; returns the cycle (for a clear message) or undefined when the graph is a DAG. */
function findDependencyCycle(services: RunServiceDefinition[]): string[] | undefined {
  const byId = new Map(services.map(service => [service.id, service]));
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (id: string, path: string[]): string[] | undefined => {
    const current = state.get(id);
    if (current === 'done') return undefined;
    if (current === 'visiting') return [...path, id];

    state.set(id, 'visiting');
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (!byId.has(dep)) continue; // reported separately as an unknown id
      const found = visit(dep, [...path, id]);
      if (found) return found;
    }
    state.set(id, 'done');
    return undefined;
  };

  for (const service of services) {
    const found = visit(service.id, []);
    if (found) return found;
  }
  return undefined;
}

/** Round-trips a profile through JSON, failing closed on anything malformed rather than repairing it. */
export function parseRunProfile(value: unknown): { profile?: RunProfile; issues: RunProfileIssue[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { issues: [{ path: '', message: 'A run profile must be a JSON object.' }] };
  }
  const raw = value as Record<string, unknown>;
  if (typeof raw.schemaVersion === 'number' && raw.schemaVersion > RUN_PROFILE_SCHEMA_VERSION) {
    return { issues: [{ path: 'schemaVersion', message: `Unsupported run profile schema version ${raw.schemaVersion}.` }] };
  }

  const profile: RunProfile = {
    schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0,
    id: typeof raw.id === 'string' ? raw.id : '',
    name: typeof raw.name === 'string' ? raw.name : '',
    services: Array.isArray(raw.services) ? (raw.services as RunServiceDefinition[]) : [],
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : ''
  };

  const { valid, errors } = validateRunProfile(profile);
  if (!valid) return { issues: errors };
  return { profile, issues: [] };
}

export function serializeRunProfile(profile: RunProfile): string {
  return `${JSON.stringify(profile, null, 2)}\n`;
}
