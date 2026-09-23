/**
 * The desktop side of other AI tools' agents, skills and instruction files
 * (`@praxis/core` `nativeSources`): where to look, whether the project's files
 * are approved, the instructions a session should receive, and the two user
 * actions — approving a project and copying an item into Praxis.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { shell } from 'electron';
import {
  DEFAULT_WORKING_STYLE,
  PROVIDER_DESCRIPTORS,
  buildSessionInstructions,
  discoverNativeSources,
  findProjectRoot,
  type AgentRuntimeSnapshot,
  type AiProvider,
  type NativeSourceOptions
} from '@praxis/core';
import { getSettingsBackend } from './settingsBackendInstance';
import { getAgentRuntimeManager, getAgentRuntimeRoots } from './agentRuntimeInstance';

/** Home folder other tools keep user-level files in (overridable so tests never read a real home). */
export function nativeHomeDir(): string {
  return process.env.PRAXIS_NATIVE_SOURCES_HOME?.trim() || os.homedir();
}

export async function nativeSourceOptionsFor(workingDirectory?: string): Promise<NativeSourceOptions> {
  const settings = getSettingsBackend().read();
  const config = settings.ai.nativeSources;
  // Same folder chain sessions use; with no working folder there is no project
  // (never the app's own cwd), and only the user-level files are discovered.
  const start = workingDirectory?.trim() || settings.ai.workingDirectory.trim() || process.env.PRAXIS_AI_WORKING_DIR?.trim();
  const projectRoot = start ? await findProjectRoot(start) : undefined;
  return {
    projectRoot,
    homeDir: nativeHomeDir(),
    enabled: config.ecosystems,
    projectApproved: projectRoot !== undefined && config.approvedProjects.includes(projectRoot),
    extraSkillPaths: config.extraSkillPaths,
    extraAgentPaths: config.extraAgentPaths
  };
}

/**
 * Which runtime really runs a launch: an API provider reads no tool files; a
 * built-in CLI runtime reads its own; a custom ACP binding reads none of the
 * files Praxis knows about ('custom').
 */
export function effectiveRuntime(provider: AiProvider, plan: { state: string; command?: string }): string {
  if (plan.state !== 'acp') return provider;
  const providers = getSettingsBackend().read().ai.providers;
  const commandOf = (id: AiProvider) => {
    const descriptor = PROVIDER_DESCRIPTORS[id];
    return descriptor.kind === 'cli-agent' ? providers[id]?.cliPath?.trim() || descriptor.defaultCommand : undefined;
  };
  if (PROVIDER_DESCRIPTORS[provider].kind === 'cli-agent' && (!plan.command || plan.command === commandOf(provider))) return provider;
  // A custom ACP binding that launches one of the known runtimes reads what it reads.
  const launched = (Object.keys(PROVIDER_DESCRIPTORS) as AiProvider[]).find(
    id => PROVIDER_DESCRIPTORS[id].kind === 'cli-agent' && plan.command !== undefined && path.basename(plan.command) === path.basename(commandOf(id) ?? '')
  );
  return launched ?? 'custom';
}

/** The project instructions a session on `runtime` in `workingDirectory` should carry. */
export async function sessionInstructionsFor(runtime: string, workingDirectory?: string): Promise<string | undefined> {
  if (!getSettingsBackend().read().ai.nativeSources.injectInstructions) return undefined;
  const options = await nativeSourceOptionsFor(workingDirectory);
  const { instructions } = await discoverNativeSources(options);
  const source = getSettingsBackend().read().ai.nativeSources.instructionSource;
  return buildSessionInstructions(instructions, runtime, { projectApproved: options.projectApproved, source }).text || undefined;
}

/** The working style every session carries, whichever AI runs it (Settings › Agent Runtime). */
export function sessionWorkingStyle(): string | undefined {
  const style = getSettingsBackend().read().ai.workingStyle;
  return style.enabled ? style.text.trim() || DEFAULT_WORKING_STYLE : undefined;
}

export async function setNativeProjectApproval(projectRoot: string, approved: boolean): Promise<AgentRuntimeSnapshot> {
  const backend = getSettingsBackend();
  const current = backend.read().ai.nativeSources.approvedProjects;
  const next = approved ? [...new Set([...current, projectRoot])] : current.filter(root => root !== projectRoot);
  await backend.write({ ai: { nativeSources: { approvedProjects: next } } });
  return getAgentRuntimeManager().refresh();
}

/** Paths discovery found — the only ones the renderer may ask to reveal. */
function discoveredPaths(snapshot: AgentRuntimeSnapshot): Set<string> {
  return new Set([
    ...(snapshot.profiles ?? []).filter(profile => profile.source).map(profile => profile.source!.path),
    ...snapshot.skills.filter(skill => skill.source).flatMap(skill => [skill.source!.path, skill.instructionsPath]),
    ...(snapshot.instructions ?? []).map(file => file.path)
  ]);
}

export async function revealNativeItem(itemPath: string): Promise<void> {
  const snapshot = await getAgentRuntimeManager().list();
  if (!discoveredPaths(snapshot).has(itemPath)) throw new Error('That file was not found by discovery.');
  shell.showItemInFolder(itemPath);
}

function yamlText(value: string): string {
  return /^[\w .,()&'/-]*$/.test(value) ? value : JSON.stringify(value);
}

/**
 * Copies an agent or skill found in another tool's folder into Praxis's own
 * global folder, where it can be edited; Praxis's own items take precedence
 * over other tools' files, so the copy replaces the original in the catalog.
 */
export async function copyNativeItem(kind: 'agent' | 'skill', id: string): Promise<AgentRuntimeSnapshot> {
  const manager = getAgentRuntimeManager();
  const snapshot = await manager.refresh();
  const roots = getAgentRuntimeRoots();
  if (kind === 'agent') {
    const entry = (snapshot.profiles ?? []).find(profile => profile.profile.id === id && profile.source);
    if (!entry?.source) throw new Error(`No agent “${id}” from another AI tool was found.`);
    if (!entry.trusted) throw new Error('Approve this project’s files before copying its agents.');
    const target = path.join(roots.agents.global, id);
    if (fs.existsSync(target)) throw new Error(`Praxis already has an agent folder named “${id}”.`);
    await fs.promises.mkdir(target, { recursive: true });
    const { profile } = entry;
    await fs.promises.writeFile(
      path.join(target, 'AGENT.md'),
      [
        '---',
        `id: ${profile.id}`,
        `name: ${yamlText(profile.name)}`,
        ...(profile.description ? [`description: ${yamlText(profile.description)}`] : []),
        `copiedFrom: ${yamlText(entry.source.path)}`,
        '---',
        '',
        profile.instructions.trim(),
        ''
      ].join('\n'),
      'utf8'
    );
    // `entry: session` — runs on the session's runtime, like the built-in agents.
    await fs.promises.writeFile(
      path.join(target, 'agent.json'),
      JSON.stringify({ schemaVersion: 1, id: profile.id, name: profile.name, type: 'gateway', entry: 'session' }, null, 2),
      'utf8'
    );
  } else {
    const skill = snapshot.skills.find(candidate => candidate.metadata.name === id && candidate.source);
    if (!skill?.source) throw new Error(`No skill “${id}” from another AI tool was found.`);
    if (!skill.trusted) throw new Error('Approve this project’s files before copying its skills.');
    const target = path.join(roots.skills.global, id);
    if (fs.existsSync(target)) throw new Error(`Praxis already has a skill folder named “${id}”.`);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.cp(skill.skillPath, target, { recursive: true });
  }
  return manager.refresh();
}
