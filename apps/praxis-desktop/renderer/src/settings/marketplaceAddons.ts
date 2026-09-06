import { useCallback, useEffect, useState } from 'react';
import type {
  AddonKind,
  AddonUpdate,
  CatalogEntry,
  InstalledAddon,
  MarketplaceStatus
} from '@praxis/core';

/**
 * One kind's slice of the add-on marketplace, for the panel that owns that kind
 * (Themes, Surfaces, Agent Runtime, …). The central marketplace *config* —
 * owner, token, enable — lives in Settings → Add-ons; each panel only browses
 * and installs its own kind.
 *
 * `listCatalog` / `listInstalled` return every kind; this filters to one. The
 * hook subscribes to `marketplace:changed` so an install/remove anywhere keeps
 * every panel in sync.
 */

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface KindAddons {
  /** Marketplace config is complete enough to browse (`enabled` + owner + token). */
  ready: boolean;
  status: MarketplaceStatus | undefined;
  /** Catalogue entries for this kind — `undefined` until `browse()` has run once. */
  catalog: CatalogEntry[] | undefined;
  installed: InstalledAddon[];
  updates: AddonUpdate[];
  /** Key of the in-flight action (`browse`, `install:<pkg>`, `remove:<id>`, …), or undefined. */
  busy: string | undefined;
  error: string | undefined;
  browse(): Promise<void>;
  install(packageName: string, options?: { version?: string; trustAgent?: boolean }): Promise<void>;
  update(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  setTrust(id: string, enabled: boolean): Promise<void>;
  checkForUpdates(): Promise<void>;
  clearError(): void;
}

export function useKindAddons(kind: AddonKind): KindAddons {
  const [status, setStatus] = useState<MarketplaceStatus>();
  const [catalog, setCatalog] = useState<CatalogEntry[]>();
  const [installed, setInstalled] = useState<InstalledAddon[]>([]);
  const [updates, setUpdates] = useState<AddonUpdate[]>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await window.praxis.marketplace.getStatus());
    } catch {
      /* getStatus never rejects in practice; ignore */
    }
  }, []);

  const loadInstalled = useCallback(async () => {
    try {
      const all = await window.praxis.marketplace.listInstalled();
      setInstalled(all.filter(addon => addon.manifest.kind === kind));
    } catch (cause) {
      setError(message(cause));
    }
  }, [kind]);

  useEffect(() => {
    void loadStatus();
    void loadInstalled();
    return window.praxis.marketplace.onChanged(() => {
      void loadStatus();
      void loadInstalled();
    });
  }, [loadStatus, loadInstalled]);

  const run = useCallback(async (key: string, task: () => Promise<void>) => {
    setBusy(key);
    setError(undefined);
    try {
      await task();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(undefined);
    }
  }, []);

  const browse = useCallback(
    () =>
      run('browse', async () => {
        const all = await window.praxis.marketplace.listCatalog();
        setCatalog(all.filter(entry => entry.manifest.kind === kind));
      }),
    [kind, run]
  );

  const refreshCatalogSoftly = useCallback(async () => {
    try {
      const all = await window.praxis.marketplace.listCatalog();
      setCatalog(all.filter(entry => entry.manifest.kind === kind));
    } catch {
      /* leave the last catalogue in place */
    }
  }, [kind]);

  return {
    ready: status?.ready ?? false,
    status,
    catalog,
    installed,
    updates,
    busy,
    error,
    browse,
    install: (packageName, options) =>
      run(`install:${packageName}`, async () => {
        await window.praxis.marketplace.install(packageName, options);
        await loadInstalled();
        await refreshCatalogSoftly();
      }),
    update: id =>
      run(`update:${id}`, async () => {
        await window.praxis.marketplace.update(kind, id);
        await loadInstalled();
        setUpdates(current => current.filter(entry => !(entry.kind === kind && entry.id === id)));
      }),
    remove: id =>
      run(`remove:${id}`, async () => {
        await window.praxis.marketplace.remove(kind, id);
        await loadInstalled();
        await refreshCatalogSoftly();
      }),
    setTrust: (id, enabled) =>
      run(`trust:${id}`, async () => {
        await window.praxis.marketplace.setAgentTrust(id, enabled);
        await loadInstalled();
      }),
    checkForUpdates: () =>
      run('updates', async () => {
        const all = await window.praxis.marketplace.checkForUpdates();
        setUpdates(all.filter(entry => entry.kind === kind));
      }),
    clearError: () => setError(undefined)
  };
}
