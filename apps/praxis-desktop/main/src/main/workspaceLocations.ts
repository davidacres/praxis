import * as path from 'node:path';
import { app } from 'electron';
import type { KeyValueStore } from '@praxis/core';
import { JsonKeyValueStore } from './adapters/jsonKeyValueStore';
import { WorkspaceFileStore } from './adapters/workspaceFileStore';
import type { UnionScope } from './adapters/unionKeyValueStore';

const LOCATIONS_KEY = 'praxis.workspaceLocations.v1';

/** Where a workspace kept outside the app lives. */
export interface WorkspaceLocation {
  id: string;
  path: string;
}

/**
 * The registry of workspaces stored outside the app's user folder.
 *
 * The user folder keeps only this pointer list — id and path. Everything the
 * workspace owns is in the file it points at, so deleting that file removes the
 * workspace's data in one action, and a stale pointer is a one-line repair
 * rather than orphaned records.
 *
 * Kept in its own registry file. It must not share `workspaces.json` with the
 * workspace record store because both stores do read-modify-write updates.
 */
let registry: KeyValueStore | undefined;
const openFiles = new Map<string, WorkspaceFileStore>();
const unreadable = new Set<string>();
let activeWorkspaceId: string | undefined;

function getRegistry(): KeyValueStore {
  registry ??= new JsonKeyValueStore(path.join(app.getPath('userData'), 'workspace-locations.json'));
  return registry;
}

export function listWorkspaceLocations(): WorkspaceLocation[] {
  const value = getRegistry().get<WorkspaceLocation[]>(LOCATIONS_KEY);
  return Array.isArray(value)
    ? value.filter(item => typeof item?.id === 'string' && typeof item?.path === 'string')
    : [];
}

export async function registerWorkspaceLocation(location: WorkspaceLocation): Promise<void> {
  const next = listWorkspaceLocations().filter(item => item.id !== location.id);
  next.push(location);
  await getRegistry().update(LOCATIONS_KEY, next);
  unreadable.delete(location.path);
}

/**
 * Forgets a located workspace. The file is deliberately left on disk: it is the
 * user's document, quite possibly tracked in a repo, and "remove from Praxis"
 * must not be a way to lose it. Deleting it is theirs to do.
 */
export async function deregisterWorkspaceLocation(workspaceId: string): Promise<void> {
  const remaining = listWorkspaceLocations().filter(item => item.id !== workspaceId);
  const dropped = listWorkspaceLocations().find(item => item.id === workspaceId);
  if (dropped) {
    openFiles.delete(dropped.path);
    await getRegistry().update(LOCATIONS_KEY, remaining);
  }
}

/**
 * Open stores for every registered location, as union scopes.
 *
 * A location whose file has gone (deleted, or a repo not cloned on this
 * machine) is reported once and then skipped, so a missing file degrades to
 * "that workspace isn't here" rather than breaking startup.
 */
export function getWorkspaceScopes(): UnionScope[] {
  const scopes: UnionScope[] = [];
  for (const location of listWorkspaceLocations()) {
    if (unreadable.has(location.path)) continue;
    let store = openFiles.get(location.path);
    if (!store) {
      try {
        store = new WorkspaceFileStore(location.path);
        openFiles.set(location.path, store);
      } catch (error) {
        unreadable.add(location.path);
        console.warn(
          `workspaces — cannot read "${location.path}": ${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }
    }
    scopes.push({ id: location.id, store });
  }
  return scopes;
}

/**
 * The workspace new records are stored with. Set by the renderer as the user
 * switches workspace, so a project created while a located workspace is open
 * lands in that workspace's file rather than the app's user folder.
 */
export function setActiveWorkspaceId(workspaceId: string | undefined): void {
  activeWorkspaceId = workspaceId;
}

export function getActiveWorkspaceId(): string | undefined {
  return activeWorkspaceId;
}

/** Drops cached file handles so the next read reloads from disk. */
export function resetWorkspaceScopes(): void {
  openFiles.clear();
  unreadable.clear();
  activeWorkspaceId = undefined;
}
