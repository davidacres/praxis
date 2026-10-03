import {
  TrackerMcpServer,
  type AcpHttpMcpServer,
  type AgentToolMode,
  type IssueTrackerService
} from '@praxis/core';
import { getAcpAgentHost } from './aiInstance';

let server: TrackerMcpServer | undefined;
const registrations = new Map<string, { config: AcpHttpMcpServer; dispose: () => void }>();

function trackerServer(): TrackerMcpServer {
  if (!server) {
    server = new TrackerMcpServer();
  }
  return server;
}

/**
 * Returns the ACP `mcpServers` entry that gives `issueKey`'s session access
 * to the tracker tools (e.g. tracker_add_comment, tracker_transition_ticket),
 * or `undefined` when no issue tracker service is bound or toolMode is project-only.
 */
export async function trackerMcpServerForSession(
  issueKey: string,
  service: IssueTrackerService | undefined,
  toolMode: AgentToolMode | undefined
): Promise<AcpHttpMcpServer | undefined> {
  if (!service || toolMode === 'project-only') return undefined;

  const existing = registrations.get(issueKey);
  if (existing) return existing.config;

  const registration = await trackerServer().register({
    service,
    toolMode: toolMode ?? 'full',
    requestPermission: async request =>
      getAcpAgentHost().promptExternalPermission(
        issueKey,
        `${request.description}: ${request.detail || request.toolName}`,
        'tracker-write'
      ),
    onToolCall: (name, ok, content) => {
      getAcpAgentHost().appendExternalToolEvent(issueKey, name, ok, content);
    }
  });

  const config: AcpHttpMcpServer = {
    name: 'praxis-tracker',
    url: registration.url,
    headers: { authorization: `Bearer ${registration.token}` }
  };
  registrations.set(issueKey, { config, dispose: registration.dispose });
  return config;
}

/** Tears down a session's tracker MCP endpoint — call when the session is deleted. */
export function disposeTrackerMcpForSession(issueKey: string): void {
  registrations.get(issueKey)?.dispose();
  registrations.delete(issueKey);
}
