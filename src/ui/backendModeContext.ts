import type { BackendMode } from '../types';

export interface BackendModeContextState {
  mode: BackendMode | undefined;
  configured: boolean;
}

export function resolveBackendModeContextState(
  storedMode: BackendMode | undefined,
  _jiraMcpConfigured: boolean,
  jiraCloudConfigured: boolean
): BackendModeContextState {
  switch (storedMode) {
    case 'demo':
    case 'livefolder':
    case 'userworkspace':
      return { mode: storedMode, configured: true };
    case 'github':
    case 'gitlab':
      return { mode: storedMode, configured: false };
    case 'jiracloud':
      return { mode: 'jiracloud', configured: jiraCloudConfigured };
    default:
      return jiraCloudConfigured
        ? { mode: 'jiracloud', configured: true }
        : { mode: undefined, configured: false };
  }
}
