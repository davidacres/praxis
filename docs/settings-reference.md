# Ticket Manager Settings Reference

This file documents the settings currently contributed by the extension.

## Backend and connection settings

| Setting | Type | Purpose |
| --- | --- | --- |
| `ticketManager.backendMode` | string | Selects the active backend mode. |
| `ticketManager.connections` | array | Stores named backend connections used by the Connections & Boards panel. |
| `ticketManager.boards` | array | Stores explicitly tracked boards. |

## Jira settings

| Setting | Type | Purpose |
| --- | --- | --- |
| `ticketManager.jiraMcpSiteUrl` | string | Base URL of the Jira instance that MCP tools connect to in Jira MCP mode. |
| `ticketManager.jiraMcpDefaultProjectKey` | string | Default Jira project key for new issues created through the Jira MCP backend. |
| `ticketManager.jiraMcpEpicKey` | string | Linked Jira epic key (MCP mode). |
| `ticketManager.jiraMcpEpicBoardName` | string | Friendly board name for the linked epic board (MCP mode). |
| `ticketManager.jiraMcpBoardJql` | string | Jira board query/JQL used for linked board behavior (MCP mode). |
| `ticketManager.jiraMcpBoardName` | string | Friendly name for the Jira MCP board. |

## Sidebar mode and UI settings

| Setting | Type | Purpose |
| --- | --- | --- |
| `ticketManager.enableNewProject` | boolean | Enables the preview New Project wizard command. |
| `ticketManager.boardsSidebarPreviewMode` | string | Selects the Boards sidebar layout (`classic` or `work`). |
| `ticketManager.priorityColors` | object | Configures priority indicator colors and gradients on ticket cards. |
| `ticketManager.jiraBoardListIconColor` | string | Optional accent color for Jira board list icons. |
| `ticketManager.demoBoardListIconColor` | string | Optional accent color for Demo board list icons. |
| `ticketManager.fileBoardListIconColor` | string | Optional accent color for file-backed board list icons. |
| `ticketManager.liveFolderBoardListIconColor` | string | Optional accent color for Live Folder board list icons. |

## Live Folder settings

| Setting | Type | Purpose |
| --- | --- | --- |
| `ticketManager.liveFolderPath` | string | Path to the `plans` or `features` tree used by Live Folder mode. |
| `ticketManager.liveFolderProjectKey` | string | Project key used for Live Folder-derived issues. |
| `ticketManager.liveFolderProjectName` | string | Human-readable project name for Live Folder mode. |
| `ticketManager.liveFolderAllowIssueCreation` | boolean | Allows the extension to create markdown issues while in Live Folder mode. |

## Polling, delivery, and MCP settings

| Setting | Type | Purpose |
| --- | --- | --- |
| `ticketManager.requestTimeoutMs` | number | Timeout for MCP/backend requests. |
| `ticketManager.defaultPageSize` | number | Page size for issue fetching. |
| `ticketManager.jiraPolling.enabled` | boolean | **Removed.** The built-in Jira poller was retired in favor of MCP-driven flows. |
| `ticketManager.delivery.defaultBaseBranch` | string | Default delivery workflow base branch. |
| `ticketManager.delivery.autoMergeSubTasks` | boolean | Controls whether completed sub-tasks auto-merge into the feature branch. |
| `ticketManager.workspaceMcpServerName` | string | Workspace MCP server name fallback. |
| `ticketManager.userMcpServerRef` | string | Application/profile MCP server fallback reference. |

## AI settings

| Setting | Type | Purpose |
| --- | --- | --- |
| `ticketManager.ai.provider` | string | Active AI provider (`none` or `vercel-gateway`). |
| `ticketManager.ai.credential` | string | Deprecated for Vercel Gateway (API key lives in Secret Storage). Kept for migration. |
| `ticketManager.ai.agentName` | string | Display and @mention name for the active provider. |
| `ticketManager.ai.runtimePath` | string | Unused for Vercel Gateway (kept for migration). |
| `ticketManager.ai.vercelUrl` | string | Base URL for the Vercel AI Gateway. |
| `ticketManager.ai.defaultModel` | string | Default model recorded on newly created Live Folder tickets. |
| `ticketManager.ai.analysisEnabled` | boolean | Enables the per-issue analysis gate before AI assignment. |
| `ticketManager.ai.analysisDefaultPrompt` | string | Required default prompt for the Analysis Window. |
| `ticketManager.ai.analysisDefaultModel` | string | Default model for the Analysis Window. |
| `ticketManager.ai.verboseActivityFeed` | boolean | Shows lower-level AI session activity events. |

## AI delivery workflow settings

| Setting | Type | Purpose |
| --- | --- | --- |
| `ticketManager.ai.deliveryWorkflowEnabled` | boolean | Enables delivery workflow execution instead of comment-only AI output. |
| `ticketManager.ai.deliveryPublishCommand` | string | Publish command run inside the dedicated delivery worktree. |
| `ticketManager.ai.deliveryArtifactPattern` | string | Artifact glob or relative path used to attach outputs back to Jira. |
| `ticketManager.ai.deliveryAgentWorkflowPath` | string | Path to the workflow-pack skill to enforce for delivery tasks. |
| `ticketManager.ai.deliveryAgentWorkflowUrl` | string | Optional URL surfaced in delivery comments. |
| `ticketManager.ai.deliverySummaryTemplate` | string | Template for successful Jira delivery summary comments. |
| `ticketManager.ai.deliveryFailureTemplate` | string | Template for failed Jira delivery comments. |

## Notes

- Use `ticketManager.boardsSidebarPreviewMode` to switch between classic and Work Mode.
