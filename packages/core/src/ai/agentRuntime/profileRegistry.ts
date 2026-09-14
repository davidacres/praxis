import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import * as path from 'node:path';
import type { AgentProfile } from '../agentContracts';
import type { CatalogScope } from './manifest';
import { BUNDLED_AGENT_DEFINITIONS } from './bundledAgents';

export interface DiscoveredAgentProfile {
  profile: AgentProfile;
  profilePath: string;
  rootPath: string;
  fingerprint: string;
  scope: CatalogScope;
  trusted: boolean;
  legacy: boolean;
  error?: string;
}

async function directories(root: string): Promise<string[]> {
  try {
    return (await readdir(root, { withFileTypes: true }))
      .filter(entry => entry.isDirectory())
      .map(entry => path.join(root, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function frontMatter(content: string): { values: Map<string, string>; body: string; error?: string } {
  if (!content.startsWith('---')) return { values: new Map(), body: content.trim() };
  const end = content.indexOf('\n---', 3);
  if (end < 0) return { values: new Map(), body: '', error: 'AGENT.md front matter is not closed.' };
  const values = new Map<string, string>();
  for (const line of content.slice(3, end).split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line.trim());
    if (match) values.set(match[1], match[2].replace(/^['"]|['"]$/g, '').trim());
  }
  return { values, body: content.slice(end + 4).trim() };
}

export function parseAgentProfile(content: string, fallbackId: string): { profile: AgentProfile; error?: string } {
  const parsed = frontMatter(content);
  const id = parsed.values.get('id') || fallbackId;
  const name = parsed.values.get('name') || id;
  const preferredSkills = (parsed.values.get('skills') ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const description = parsed.values.get('description');
  const version = parsed.values.get('version');
  const profile: AgentProfile = {
    id,
    name,
    instructions: parsed.body,
    ...(description ? { description } : {}),
    ...(version ? { version } : {}),
    ...(preferredSkills.length ? { preferredSkills } : {})
  };
  if (parsed.error) return { profile, error: parsed.error };
  if (!id.trim() || !name.trim() || !parsed.body) {
    return { profile, error: 'Agent profile requires an id, name and instruction body.' };
  }
  return { profile };
}

async function readProfile(
  rootPath: string,
  scope: CatalogScope,
  trusted: boolean
): Promise<DiscoveredAgentProfile | undefined> {
  const canonical = path.join(rootPath, 'AGENT.md');
  const legacy = path.join(rootPath, 'brief.md');
  let profilePath = canonical;
  let isLegacy = false;
  let content: string;
  try {
    content = await readFile(canonical, 'utf8');
  } catch {
    try {
      content = await readFile(legacy, 'utf8');
      profilePath = legacy;
      isLegacy = true;
    } catch {
      return undefined;
    }
  }
  const parsed = parseAgentProfile(content, path.basename(rootPath));
  return {
    profile: parsed.profile,
    profilePath,
    rootPath,
    fingerprint: createHash('sha256').update(content).digest('hex'),
    scope,
    trusted,
    legacy: isLegacy,
    ...(parsed.error ? { error: parsed.error } : {})
  };
}

/** Discovers canonical AGENT.md profiles and legacy brief.md profiles without executing anything. */
export async function discoverAgentProfiles(
  roots: string[],
  trustedRoots = roots,
  includeBundled = false
): Promise<DiscoveredAgentProfile[]> {
  const resolvedTrusted = trustedRoots.map(value => path.resolve(value));
  const result: DiscoveredAgentProfile[] = [];
  const seen = new Set<string>();
  for (const root of roots.map(value => path.resolve(value))) {
    const trusted = resolvedTrusted.includes(root);
    for (const profileRoot of await directories(root)) {
      const found = await readProfile(profileRoot, trusted ? 'global' : 'project', trusted);
      if (!found || seen.has(found.profile.id)) continue;
      seen.add(found.profile.id);
      result.push(found);
    }
  }
  if (includeBundled) {
    for (const [id, definition] of Object.entries(BUNDLED_AGENT_DEFINITIONS)) {
      if (seen.has(id)) continue;
      seen.add(id);
      result.push({
        profile: { id, name: definition.manifest.name, instructions: definition.brief },
        profilePath: path.join('/bundled', id, 'AGENT.md'),
        rootPath: path.join('/bundled', id),
        fingerprint: createHash('sha256').update(definition.brief).digest('hex'),
        scope: 'global',
        trusted: true,
        legacy: false
      });
    }
  }
  return result.sort((a, b) => a.profile.name.localeCompare(b.profile.name));
}

export async function loadAgentProfileInstructions(profile: DiscoveredAgentProfile): Promise<string> {
  if (profile.error) throw new Error(`Agent profile ${profile.profile.id} is invalid: ${profile.error}`);
  return profile.profile.instructions;
}
