import { BrowserMcpServer, type AcpHttpMcpServer } from '@praxis/core';
import { AiBrowserBridge } from './aiBrowser';
import { getAcpAgentHost } from './aiInstance';
import { getSettingsBackend } from './settingsBackendInstance';
import { holdBrowserForSequence } from './coordinationInstance';

/**
 * Bridges the in-app browser to ACP agents (Claude Code, Codex): a loopback
 * HTTP MCP server whose `browser_*` tools drive the same `WebContentsView` the
 * gateway path uses. One endpoint per session; navigation permission is raised
 * on that session's permission card via `AcpAgentHost.promptExternalPermission`.
 *
 * The endpoint lives for the whole session, not one turn — a follow-up message
 * reuses the same URL/token so the agent's MCP connection never drops. It is
 * torn down only when the session is deleted (`disposeBrowserMcpForSession`).
 */

let server: BrowserMcpServer | undefined;
const registrations = new Map<string, { config: AcpHttpMcpServer; dispose: () => void }>();

function browserServer(): BrowserMcpServer {
  if (!server) {
    server = new BrowserMcpServer({
      bridge: new AiBrowserBridge(),
      allowPrivateHosts: process.env.PRAXIS_BROWSER_ALLOW_LOOPBACK === '1'
    });
  }
  return server;
}

/**
 * Returns the ACP `mcpServers` entry that gives `issueKey`'s session the in-app
 * browser, or `undefined` when the feature is off / not full-tools. Reused
 * across turns of the same session.
 */
export async function browserMcpServerForSession(
  issueKey: string,
  toolMode: string | undefined
): Promise<AcpHttpMcpServer | undefined> {
  if (toolMode !== 'full') return undefined;
  const backend = getSettingsBackend();
  if (!backend.read().ai.browserTools.enabled) return undefined;

  const existing = registrations.get(issueKey);
  if (existing) return existing.config;

  const registration = await browserServer().register({
    allowedHosts: () => backend.read().ai.browserTools.allowedHosts,
    requestNavigatePermission: (host) =>
      getAcpAgentHost().promptExternalPermission(
        issueKey,
        `Open ${host} in the in-app browser`,
        'browser-navigate'
      ),
    onHostAllowed: (host) => {
      const current = backend.read().ai.browserTools.allowedHosts;
      if (!current.includes(host)) {
        void backend.write({ ai: { browserTools: { allowedHosts: [...current, host] } } });
      }
    },
    onToolCall: (name, ok, content) => {
      getAcpAgentHost().appendExternalToolEvent(issueKey, name, ok, content);
    },
    // One agent drives the in-app browser at a time: held from its first browser call
    // until its turn ends, so another session cannot navigate away mid-sequence.
    beforeToolCall: () => holdBrowserForSequence(issueKey)
  });

  const config: AcpHttpMcpServer = {
    name: 'praxis-browser',
    url: registration.url,
    headers: { authorization: `Bearer ${registration.token}` }
  };
  registrations.set(issueKey, { config, dispose: registration.dispose });
  return config;
}

/** Tears down a session's browser MCP endpoint — call when the session is deleted. */
export function disposeBrowserMcpForSession(issueKey: string): void {
  registrations.get(issueKey)?.dispose();
  registrations.delete(issueKey);
}
