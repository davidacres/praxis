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
    case 'github':
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
