import { useCallback, useEffect, useState } from 'react';
import type { AppSettings, AppSettingsPatch } from '@praxis/core';

interface SettingsState {
  settings: AppSettings | undefined;
  error: string | undefined;
}

/**
 * Loads settings on mount via `window.ticketManager.settings.get()` and keeps
 * the value live in sync with the `settings:changed` push channel (which
 * fires for both local writes and external changes — e.g. the VS Code
 * extension editing the shared file).
 *
 * `update` applies a deep patch through the `settings:set` IPC. The patch
 * resolves with the merged settings, but we don't bother reflecting it
 * optimistically — the broadcaster echoes in milliseconds.
 */
export function useSettings(): {
  settings: AppSettings | undefined;
  update: (patch: AppSettingsPatch) => Promise<void>;
  error: string | undefined;
} {
  const [state, setState] = useState<SettingsState>({ settings: undefined, error: undefined });

  useEffect(() => {
    let cancelled = false;
    void window.ticketManager.settings
      .get()
      .then(settings => {
        if (cancelled) {
          return;
        }
        setState(current => ({ ...current, settings }));
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return;
        }
        setState(current => ({ ...current, error: err instanceof Error ? err.message : String(err) }));
      });

    const unsubscribe = window.ticketManager.settings.onChanged(settings => {
      if (cancelled) {
        return;
      }
      setState(current => ({ ...current, settings, error: undefined }));
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const update = useCallback(async (patch: AppSettingsPatch): Promise<void> => {
    try {
      await window.ticketManager.settings.set(patch);
    } catch (err) {
      setState(current => ({ ...current, error: err instanceof Error ? err.message : String(err) }));
      throw err;
    }
  }, []);

  return { settings: state.settings, update, error: state.error };
}
