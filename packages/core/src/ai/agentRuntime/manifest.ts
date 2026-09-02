import * as path from 'node:path';

export type AgentActivation = 'onDemand' | 'startup';
export type AgentTransport = 'acp' | 'copilot-sdk' | 'http' | 'gateway' | 'custom';

export interface AgentEntry { command?: string; args?: string[]; url?: string; }
export interface AgentManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  type: AgentTransport;
  entry: string | AgentEntry;
  skills?: string[];
  config?: string;
  activation?: AgentActivation;
}
export interface AgentManifestError { path: string; message: string; }

/** Which discovery root an item came from: the user-data catalog or a project's `.praxis`. */
export type CatalogScope = 'global' | 'project';

export interface DiscoveredAgent {
  manifest: AgentManifest;
  manifestPath: string;
  rootPath: string;
  /** 'global' = user-data agents folder; 'project' = a project `.praxis/agents`. */
  scope: CatalogScope;
  trusted: boolean;
  errors: AgentManifestError[];
}

const transports = new Set<AgentTransport>(['acp', 'copilot-sdk', 'http', 'gateway', 'custom']);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export function validateAgentManifest(value: unknown, manifestPath: string): AgentManifestError[] {
  const errors: AgentManifestError[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [{ path: manifestPath, message: 'Manifest must be a JSON object.' }];
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== 1) errors.push({ path: 'schemaVersion', message: 'Only schemaVersion 1 is supported.' });
  for (const field of ['id', 'name', 'type']) if (!text(candidate[field])) errors.push({ path: field, message: `${field} is required.` });
  if (text(candidate.type) && !transports.has(candidate.type as AgentTransport)) errors.push({ path: 'type', message: `Unsupported transport: ${candidate.type}` });
  const entry = candidate.entry;
  if (text(entry)) {
    if (entry.includes('..')) errors.push({ path: 'entry', message: 'Entry paths may not contain traversal segments.' });
  } else if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    errors.push({ path: 'entry', message: 'entry must be a command/path string or an entry object.' });
  } else {
    const object = entry as Record<string, unknown>;
    if (!text(object.command) && !text(object.url)) errors.push({ path: 'entry', message: 'entry requires command or url.' });
    if (object.args !== undefined && (!Array.isArray(object.args) || object.args.some(arg => typeof arg !== 'string'))) errors.push({ path: 'entry.args', message: 'args must be an array of strings.' });
  }
  if (candidate.skills !== undefined && (!Array.isArray(candidate.skills) || candidate.skills.some(item => !text(item)))) errors.push({ path: 'skills', message: 'skills must be an array of non-empty paths.' });
  if (candidate.activation !== undefined && candidate.activation !== 'onDemand' && candidate.activation !== 'startup') errors.push({ path: 'activation', message: 'activation must be onDemand or startup.' });
  return errors;
}

export function resolveManifestPath(rootPath: string, value: string): string {
  const resolvedRoot = path.resolve(rootPath);
  const resolved = path.resolve(resolvedRoot, value);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw new Error(`Path escapes approved root: ${value}`);
  return resolved;
}
