import * as fs from 'node:fs';
import * as path from 'node:path';

import { app } from 'electron';
import {
  AGENT_RUNTIME_CHOICES,
  PROVIDER_DESCRIPTORS,
  isBundledAgent,
  mirrorBundledAgents,
  type ActiveAppearanceAddons,
  type AddonKind,
  type AddonSurfacePackContent,
  type AddonThemeContent,
  type InstalledAddon,
  type MarketplaceStatus,
  GitHubPackagesRegistryClient,
  MarketplaceService
} from '@praxis/core';

import { ElectronAddonStorage } from './adapters/electronAddonStorage';
import { getAgentRuntimeManager, getAgentRuntimeRoots } from './agentRuntimeInstance';
import { getSecretsStore } from './connectionStoreInstance';
import { getLogBus } from './logBusInstance';
import { getSettingsBackend } from './settingsBackendInstance';

/**
 * Wires `MarketplaceService` to the desktop host: config from `settings.marketplace`,
 * the GitHub token from the OS-encrypted secret store, and disk under
 * `userData/addons/`. Also owns *activation* — turning an installed add-on into
 * something the rest of the app sees:
 *
 * - `theme` / `surface-pack`: exposed through {@link readActiveAppearance} for the
 *   renderer to register alongside the user's own custom themes/packs.
 * - `agent` / `skill`: when trusted, the payload is mirrored into the global
 *   agents/skills root (`userData/agents/<id>` or `userData/skills/<id>`) so the
 *   existing discovery + trust model picks it up; the download itself stays
 *   under `userData/addons/<kind>/<id>`.
 * - `workflow-template`: read by `marketplaceWorkflowTemplates()` as a library tier.
 */

export const MARKETPLACE_TOKEN_KEY = 'marketplace:githubToken';

let storage: ElectronAddonStorage | undefined;
const changeListeners = new Set<() => void>();

function addonsRoot(): string {
  return path.join(app.getPath('userData'), 'addons');
}

export function getAddonStorage(): ElectronAddonStorage {
  if (!storage) {
    storage = new ElectronAddonStorage(addonsRoot());
  }
  return storage;
}

export function onMarketplaceChanged(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

export function emitMarketplaceChanged(): void {
  for (const listener of [...changeListeners]) {
    try {
      listener();
    } catch (error) {
      getLogBus().appendLine(`[marketplace] change listener failed: ${describe(error)}`);
    }
  }
}

async function getToken(): Promise<string | undefined> {
  // Env override first: the OS secret store has no keychain backend in the e2e
  // sandbox (see AGENTS.md), and CI/headless setups may not either.
  const fromEnv = process.env.PRAXIS_MARKETPLACE_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  try {
    const token = await getSecretsStore().get(MARKETPLACE_TOKEN_KEY);
    if (!token) {
      getLogBus().appendLine('[marketplace] no token in secure storage');
    }
    return token || undefined;
  } catch (error) {
    getLogBus().appendLine(`[marketplace] failed to retrieve token from secure storage: ${describe(error)}`);
    return undefined;
  }
}

export async function getMarketplaceStatus(): Promise<MarketplaceStatus> {
  const cfg = getSettingsBackend().read().marketplace;
  const hasToken = Boolean(await getToken());
  return {
    ready: cfg.enabled && cfg.owner.trim().length > 0 && hasToken,
    enabled: cfg.enabled,
    owner: cfg.owner,
    ownerType: cfg.ownerType,
    packageNamePrefix: cfg.packageNamePrefix,
    apiBaseUrl: cfg.apiBaseUrl,
    registryBaseUrl: cfg.registryBaseUrl,
    checkOnLaunch: cfg.checkOnLaunch,
    hasToken
  };
}

export async function configureMarketplace(patch: {
  enabled?: boolean;
  owner?: string;
  ownerType?: 'user' | 'org';
  packageNamePrefix?: string;
  apiBaseUrl?: string;
  registryBaseUrl?: string;
  checkOnLaunch?: boolean;
}): Promise<MarketplaceStatus> {
  await getSettingsBackend().write({ marketplace: patch });
  emitMarketplaceChanged();
  return getMarketplaceStatus();
}

export async function setMarketplaceToken(token: string | null): Promise<MarketplaceStatus> {
  try {
    if (token && token.trim()) {
      getLogBus().appendLine(`[marketplace] saving token to secure store...`);
      await getSecretsStore().store(MARKETPLACE_TOKEN_KEY, token.trim());
      getLogBus().appendLine(`[marketplace] token saved successfully`);
    } else {
      await getSecretsStore().delete(MARKETPLACE_TOKEN_KEY);
      getLogBus().appendLine(`[marketplace] token deleted`);
    }
  } catch (error) {
    getLogBus().appendLine(`[marketplace] failed to save token: ${describe(error)}`);
    throw error;
  }
  emitMarketplaceChanged();
  return getMarketplaceStatus();
}

/** Builds a service against the current config, or throws a user-facing reason why it cannot. */
export async function buildMarketplaceService(): Promise<MarketplaceService> {
  const cfg = getSettingsBackend().read().marketplace;
  if (!cfg.enabled) {
    throw new Error('The add-on marketplace is turned off in Settings.');
  }
  const owner = cfg.owner.trim();
  if (!owner) {
    throw new Error('Set a marketplace owner (a GitHub user or organisation) in Settings.');
  }
  const token = await getToken();
  if (!token) {
    throw new Error('Add a marketplace GitHub token in Settings (needs `read:packages`).');
  }

  const client = new GitHubPackagesRegistryClient({
    owner,
    ownerType: cfg.ownerType,
    token,
    packageNamePrefix: cfg.packageNamePrefix || undefined,
    apiBaseUrl: cfg.apiBaseUrl || undefined,
    registryBaseUrl: cfg.registryBaseUrl || undefined
  });

  return new MarketplaceService({
    client,
    storage: getAddonStorage(),
    appVersion: app.getVersion(),
    log: message => getLogBus().appendLine(message)
  });
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

function readPayloadJson(dir: string, file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function coerceStringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string') out[key] = entry;
    }
  }
  return out;
}

function shapeTheme(id: string, raw: unknown): AddonThemeContent | undefined {
  if (!isRecord(raw)) return undefined;
  const mode = raw.mode === 'light' ? 'light' : raw.mode === 'dark' ? 'dark' : undefined;
  if (!mode) return undefined;
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : id,
    mode,
    description: typeof raw.description === 'string' ? raw.description : '',
    preview: coerceStringMap(raw.preview),
    terminal: isRecord(raw.terminal) ? coerceStringMap(raw.terminal) : undefined
  };
}

function shapeSurfacePack(id: string, raw: unknown): AddonSurfacePackContent | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : id,
    description: typeof raw.description === 'string' ? raw.description : '',
    basePackId: typeof raw.basePackId === 'string' ? raw.basePackId : undefined,
    tokens: coerceStringMap(raw.tokens),
    pattern: isRecord(raw.pattern) ? (raw.pattern as Record<string, unknown>) : undefined
  };
}

/** Enabled `theme` / `surface-pack` add-ons, shaped for the renderer to register. */
export async function readActiveAppearance(): Promise<ActiveAppearanceAddons> {
  const store = getAddonStorage();
  const installed = await store.list();
  const themes: AddonThemeContent[] = [];
  const surfacePacks: AddonSurfacePackContent[] = [];

  for (const addon of installed) {
    if (!addon.enabled) continue;
    const dir = store.addonDir(addon.manifest.kind, addon.manifest.id);
    if (addon.manifest.kind === 'theme') {
      const theme = shapeTheme(addon.manifest.id, readPayloadJson(dir, 'theme.json'));
      if (theme) themes.push(theme);
    } else if (addon.manifest.kind === 'surface-pack') {
      const pack = shapeSurfacePack(addon.manifest.id, readPayloadJson(dir, 'pack.json'));
      if (pack) surfacePacks.push(pack);
    }
  }
  return { themes, surfacePacks };
}

/** Enabled `workflow-template` add-on definitions, for the workflow library. */
export async function marketplaceWorkflowTemplates(): Promise<unknown[]> {
  const store = getAddonStorage();
  const installed = await store.list();
  const out: unknown[] = [];
  for (const addon of installed) {
    if (addon.manifest.kind !== 'workflow-template' || !addon.enabled) continue;
    const dir = store.addonDir('workflow-template', addon.manifest.id);
    const definition = readPayloadJson(dir, 'template.json');
    if (definition) out.push(definition);
  }
  return out;
}

/**
 * The built-in agent an agent add-on pins to its own runtime, if any. Early
 * packages did it by reusing the built-in's id; newer ones say `replaces`.
 */
export function addonPinTarget(addon: Pick<InstalledAddon, 'manifest'>): string | undefined {
  if (addon.manifest.kind !== 'agent') return undefined;
  if (addon.manifest.replaces) return addon.manifest.replaces;
  return isBundledAgent(addon.manifest.id) ? addon.manifest.id : undefined;
}

/**
 * The discovery folder an add-on is mirrored into. Never a built-in agent's
 * own folder — that holds the built-in's instructions (`AGENT.md`), which a pin
 * keeps using — so an add-on reusing a built-in's id gets a folder of its own.
 */
function addonMirrorId(addon: Pick<InstalledAddon, 'manifest'>): string {
  return addon.manifest.kind === 'agent' && isBundledAgent(addon.manifest.id) ? `${addon.manifest.id}-addon` : addon.manifest.id;
}

/**
 * Mirrors a trusted `agent`/`skill` add-on's payload into the matching global
 * discovery root so the existing discovery + trust model runs it; clears the
 * mirror otherwise. Called on every trust change, remove, and once on launch.
 */
async function syncAddonKindIntoDiscovery(kind: 'agent' | 'skill', globalRoot: string): Promise<void> {
  const store = getAddonStorage();
  const installed = (await store.list()).filter(addon => addon.manifest.kind === kind);

  await fs.promises.mkdir(globalRoot, { recursive: true });

  for (const addon of installed) {
    const mirrorId = addonMirrorId(addon);
    const target = path.join(globalRoot, mirrorId);
    const source = store.addonDir(kind, addon.manifest.id);
    await fs.promises.rm(target, { recursive: true, force: true });
    if (addon.enabled) {
      await fs.promises.cp(source, target, { recursive: true });
      // The install record is bookkeeping, not part of the agent/skill.
      await fs.promises.rm(path.join(target, '.praxis-addon.json'), { force: true });
      const pinTarget = addonPinTarget(addon);
      if (pinTarget) await markAsPin(path.join(target, 'agent.json'), mirrorId, pinTarget);
    }
  }
}

/** Writes the pin's discovery id and the built-in it runs into its mirrored `agent.json`. */
async function markAsPin(manifestPath: string, id: string, replaces: string): Promise<void> {
  try {
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as Record<string, unknown>;
    await fs.promises.writeFile(manifestPath, JSON.stringify({ ...manifest, id, replaces }, null, 2), 'utf8');
  } catch (error) {
    getLogBus().appendLine(`[marketplace] could not prepare agent add-on ${id}: ${describe(error)}`);
  }
}

/**
 * One pin per built-in agent: installing one uninstalls any other add-on that
 * ran the same built-in, so what runs it is never a tie-break.
 */
export async function retireOtherPins(installed: InstalledAddon): Promise<string[]> {
  const target = addonPinTarget(installed);
  if (!target) return [];
  const others = (await getAddonStorage().list()).filter(
    addon => addon.manifest.kind === 'agent' && addon.manifest.id !== installed.manifest.id && addonPinTarget(addon) === target
  );
  for (const addon of others) {
    await getAddonStorage().remove('agent', addon.manifest.id);
    await fs.promises.rm(path.join(getAgentRuntimeRoots().agents.global, addonMirrorId(addon)), { recursive: true, force: true });
  }
  return others.map(addon => addon.manifest.name);
}

export async function syncAgentAddons(): Promise<void> {
  await syncAddonKindIntoDiscovery('agent', getAgentRuntimeRoots().agents.global);
}

export async function syncSkillAddons(): Promise<void> {
  await syncAddonKindIntoDiscovery('skill', getAgentRuntimeRoots().skills.global);
}

export async function refreshAgentRuntimeForAddons(): Promise<void> {
  await syncAgentAddons();
  await syncSkillAddons();
  try {
    await getAgentRuntimeManager().refresh();
  } catch (error) {
    getLogBus().appendLine(`[marketplace] agent runtime refresh failed: ${describe(error)}`);
  }
}

/**
 * Praxis's own runtime-pin packages (Claude/Codex Planner, Reviewer,
 * Implementer, and the older id-reusing Praxis ones) were retired in favour of
 * the per-agent "Runs on" setting. Carry an enabled one's choice over to the
 * setting — unless the user already chose — and uninstall them all.
 */
const RETIRED_PIN_PACKAGE = /^@davidacres\/praxis-addon-agent-(?:(?:claude|codex)-)?(?:planner|reviewer|implementer)$/;

export async function migrateAddonPinsToSettings(): Promise<number> {
  const store = getAddonStorage();
  const backend = getSettingsBackend();
  const choices = { ...backend.read().ai.agentRuntimes };
  const migrated: string[] = [];
  for (const addon of await store.list()) {
    const target = addonPinTarget(addon);
    if (!target || !RETIRED_PIN_PACKAGE.test(addon.packageName)) continue;
    let command: string | undefined;
    try {
      const manifest = JSON.parse(await fs.promises.readFile(path.join(store.addonDir('agent', addon.manifest.id), 'agent.json'), 'utf8')) as { entry?: string | { command?: string } };
      command = typeof manifest.entry === 'string' ? manifest.entry : manifest.entry?.command;
    } catch {
      command = undefined;
    }
    const runtime = AGENT_RUNTIME_CHOICES.find(id => {
      const descriptor = PROVIDER_DESCRIPTORS[id];
      return descriptor.kind === 'cli-agent' && descriptor.defaultCommand === path.basename(command ?? '');
    });
    if (addon.enabled && runtime) choices[target] ??= runtime;
    await store.remove('agent', addon.manifest.id);
    await fs.promises.rm(path.join(getAgentRuntimeRoots().agents.global, addonMirrorId(addon)), { recursive: true, force: true });
    migrated.push(addon.enabled && runtime ? `${addon.manifest.name} → ${target} runs on ${runtime}` : `${addon.manifest.name} (removed)`);
  }
  if (migrated.length === 0) return 0;
  await backend.write({ ai: { agentRuntimes: choices } });
  // A retired package may have been mirrored over a built-in by an older Praxis.
  await mirrorBundledAgents(getAgentRuntimeRoots().agents.global);
  getLogBus().appendLine(`[marketplace] moved Praxis agent pins to Settings › Agent Runtime: ${migrated.join('; ')}`);
  return migrated.length;
}

export async function reconcileInstalledOnLaunch(): Promise<void> {
  const migrated = await migrateAddonPinsToSettings();
  await syncAgentAddons();
  if (migrated > 0) await getAgentRuntimeManager().refresh().catch(() => undefined);
  await syncSkillAddons();
  const cfg = getSettingsBackend().read().marketplace;
  if (!cfg.checkOnLaunch) return;
  let status: MarketplaceStatus;
  try {
    status = await getMarketplaceStatus();
  } catch {
    return;
  }
  if (!status.ready) return;
  try {
    const service = await buildMarketplaceService();
    const updates = await service.checkForUpdates();
    if (updates.length > 0) {
      getLogBus().appendLine(
        `[marketplace] ${updates.length} add-on update(s) available: ${updates
          .map(update => `${update.kind}/${update.id} ${update.installedVersion}→${update.latestVersion}`)
          .join(', ')}`
      );
    }
  } catch (error) {
    getLogBus().appendLine(`[marketplace] launch update check failed: ${describe(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Disk-only operations — no network, no token required
// ---------------------------------------------------------------------------

export function listInstalledAddons(): Promise<InstalledAddon[]> {
  return getAddonStorage().list();
}

export async function removeInstalledAddon(kind: AddonKind, id: string): Promise<void> {
  const addon = await getAddonStorage().get(kind, id);
  await getAddonStorage().remove(kind, id);
  if (kind === 'agent' || kind === 'skill') {
    // The discovery sync only visits add-ons that are still installed, so the
    // removed one's copy must be deleted here or it stays discoverable.
    const roots = getAgentRuntimeRoots();
    const root = kind === 'agent' ? roots.agents.global : roots.skills.global;
    await fs.promises.rm(path.join(root, addon ? addonMirrorId(addon) : id), { recursive: true, force: true });
    // Repairs a built-in folder an older Praxis mirrored an add-on over.
    if (kind === 'agent') await mirrorBundledAgents(roots.agents.global);
    await refreshAgentRuntimeForAddons();
  }
  emitMarketplaceChanged();
}

export async function setInstalledAddonTrust(kind: AddonKind, id: string, enabled: boolean): Promise<void> {
  const addon = await getAddonStorage().get(kind, id);
  if (!addon) throw new Error(`No installed ${kind} add-on with id "${id}".`);
  await getAddonStorage().setEnabled(kind, id, enabled);
  await refreshAgentRuntimeForAddons();
  emitMarketplaceChanged();
}

export type { InstalledAddon };

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
