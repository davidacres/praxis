import type { BackendMode } from '../types';

export interface BackendModeContextState {
  mode: BackendMode | undefined;
  configured: boolean;
}

export function resolveBackendModeContextState(
  storedMode: BackendMode | undefined,
  _jiraMcpConfigured: boolean,
  jiraMcpConfigured: boolean
): BackendModeContextState {
  switch (storedMode) {
    case 'demo':
    case 'folder':
    case 'app':
    case 'project':
      return { mode: storedMode, configured: true };
    // Split from a shared `case 'github': case 'gitlab':` arm now that GitHub
    // has a real backend (FX-BE-035). This module has no runtime consumers
    // (nothing under apps/ imports it) — kept split anyway so its own
    // contract stays honest, not because a caller depends on it today.
    case 'github':
      return { mode: storedMode, configured: true };
    case 'gitlab':
      return { mode: storedMode, configured: false };
    case 'jiracloud':
      return { mode: 'jiracloud', configured: jiraMcpConfigured };
    default:
      return jiraMcpConfigured
        ? { mode: 'jiracloud', configured: true }
        : { mode: undefined, configured: false };
  }
}
