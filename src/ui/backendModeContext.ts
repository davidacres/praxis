import type { BackendMode } from '../types';

export interface BackendModeContextState {
  mode: BackendMode | undefined;
  configured: boolean;
}

export function resolveBackendModeContextState(
  storedMode: BackendMode | undefined,
  jiraMcpConfigured: boolean,
  jiraApiConfigured: boolean
): BackendModeContextState {
  switch (storedMode) {
    case 'demo':
    case 'livefolder':
    case 'userworkspace':
      return { mode: storedMode, configured: true };
    case 'github':
    case 'gitlab':
      return { mode: storedMode, configured: false };
    case 'jira':
      return { mode: 'jiraapi', configured: jiraApiConfigured };
    case 'jiraapi':
      return { mode: 'jiraapi', configured: jiraApiConfigured };
    default:
      return jiraApiConfigured
        ? { mode: 'jiraapi', configured: true }
        : { mode: undefined, configured: false };
  }
}