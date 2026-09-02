import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { validateAgentManifest, type AgentManifest, type CatalogScope, type DiscoveredAgent } from './manifest';

export interface AgentRuntimeConfig { schemaVersion: 1; agentsPath?: string; skillsPath?: string; defaultAgent?: string; logging?: boolean; allowProjectAgents?: boolean; allowProjectSkillScripts?: boolean; }
export interface DiscoveryOptions { userAgentsPath?: string; projectAgentsPath?: string; allowProjectAgents?: boolean; explicitAgentsPaths?: string[]; }
async function directories(root: string): Promise<string[]> {
  try { return (await readdir(root, { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name)).sort(); } catch { return []; }
}
async function readManifest(rootPath: string, scope: CatalogScope): Promise<DiscoveredAgent | undefined> {
  const manifestPath = path.join(rootPath, 'agent.json');
  try {
    const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    const errors = validateAgentManifest(parsed, manifestPath);
    return { manifest: parsed as AgentManifest, manifestPath, rootPath, scope, trusted: scope === 'global' && errors.length === 0, errors };
  } catch { return undefined; }
}
/** Reads manifests only; process startup is intentionally deferred to a host loader. */
export async function discoverAgents(options: DiscoveryOptions): Promise<DiscoveredAgent[]> {
  const userRoot = options.userAgentsPath ? path.resolve(options.userAgentsPath) : undefined;
  const roots = [...(options.userAgentsPath ? [options.userAgentsPath] : []), ...(options.allowProjectAgents && options.projectAgentsPath ? [options.projectAgentsPath] : []), ...(options.explicitAgentsPaths ?? [])].map(value => path.resolve(value));
  const result: DiscoveredAgent[] = [];
  const seen = new Set<string>();
  for (const root of roots) for (const agentRoot of await directories(root)) {
    const found = await readManifest(agentRoot, root === userRoot ? 'global' : 'project');
    const id = found?.manifest?.id;
    if (!found || !id || seen.has(id)) continue;
    seen.add(id); result.push(found);
  }
  return result.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}
