# Removed: built-in Jira polling and Atlassian OAuth

The Praxis extension used to ship its own Node.js poller that ran
inside the extension host, plus a bespoke Atlassian OAuth flow that stored
client secrets in VS Code secret storage. Both have been removed in favor of
delegating to a Jira MCP server.

## What changed for users

| Concern                              | Before                                                     | After                                                  |
| ------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------ |
| **Issue/board sync**                 | Built-in Node poller (every 30 s)                          | MCP-driven via `atlassian-jira_*` or `mcp_com_atlassian_*` tools |
| **Authentication**                   | Atlassian OAuth 2.0 (client ID + runtime secret prompt)    | Authenticated by the MCP server the user configures   |
| **Polling label / execution gates**  | `praxis.jiraPolling.requiredLabel`, `enabled`        | No equivalent — drive execution from explicit user actions or your MCP server workflow |
| **Jira site bookkeeping**            | `praxis.jiraCloudId/SiteName/SiteUrl`                | No equivalent — MCP server tracks its own connection  |
| **Token storage**                    | VS Code SecretStorage (`praxis.connection.<id>.jiraCloudToken`) | MCP server's own credential store |

## What users still see

- The **Connections** panel still works for `jiracloud` mode; it now points at
  the existing MCP connection (legacy stdio, HTTP, or `.vscode/mcp.json`) and
  uses the Workspace MCP server name plus the user MCP reference configured
  under `praxis.workspaceMcpServerName` and `praxis.userMcpServerRef`.
- The `Jira Cloud` setup wizard now renders the same stdio/HTTP connection form
  that the manual Jira MCP setup has always used. Epic key + board JQL are
  still saved (now under `praxis.jiraMcpEpicKey` /
  `praxis.jiraMcpBoardJql`).
- The `Run Live Folder → Jira` migration command still works. It now uses the
  active `backendService` (which is the MCP-backed service) instead of the old
  OAuth-based one.
- `Link Workspace to Jira Epic` and `Link Workspace to Jira Board Query` still
  work — both write to the workspace-scoped epic-key / board-JQL settings and
  validate the issue type via the active MCP connection.

## Deprecated settings (still accepted)

The legacy `praxis.jiraCloud*`, `jiraOAuthClientId`, `jiraOAuthScopes`,
and `jiraPolling.*` settings are now `@deprecated` no-ops. They are kept so
existing workspaces don't fail to load, but they no longer affect behavior:

- `praxis.jiraCloudBaseUrl` / `praxis.jiraCloudToken`
  — no longer read by the polling service.
- `praxis.jiraCloudEpicKey` / `praxis.jiraCloudEpicBoardName`
  / `praxis.jiraCloudBoardJql` / `praxis.jiraCloudBoardName`
  — writethrough still saves to `jiraMcpEpicKey`, `jiraMcpEpicBoardName`,
  `jiraMcpBoardJql`, `jiraMcpBoardName`. New writes should target the `jiraMcp*`
  keys directly.
- `praxis.jiraOAuthClientId` / `praxis.jiraOAuthScopes`
  — ignored. Configure auth inside your MCP server.
- `praxis.jiraCloudId` / `jiraCloudSiteName` / `jiraCloudSiteUrl`
  — unused.
- `praxis.jiraPolling.enabled` / `requiredLabel` / `clarificationAnalysis`
  — unused.

## Migrating an existing workspace

1. Install / configure a Jira MCP server (one of `jira-mcp-server` for stdio,
   `mcp.com.atlassian` for HTTP, or any compatible third-party server).
2. Add it to `.vscode/mcp.json` or to your user-level `~/.vscode/mcp.json`.
3. In **Praxis → Connections**, add (or update) the `Jira Cloud`
   connection and point `--site-url` /
   `JIRA_MINI_SITE_URL` at your Jira instance.
4. Open **Settings** and verify the new `praxis.jiraMcp*` keys hold your
   epic key and board JQL.
5. Restart VS Code so the MCP OAuth helper picks up the new connection.

After migration the workspace behaves identically: same boards, same agent
workflows, same delivery semantics. The only difference is that issue/board
mutations now go through MCP tools rather than the embedded REST client.
