# Praxis Settings Reference

This file documents the settings currently contributed by the extension.

## Backend and connection settings

| Setting | Type | Purpose |
| --- | --- | --- |
| `praxis.backendMode` | string | Selects the active backend mode. |
| `praxis.connections` | array | Stores named backend connections used by the Connections & Boards panel. |
| `praxis.boards` | array | Stores explicitly tracked boards. |

## Jira settings

| Setting | Type | Purpose |
| --- | --- | --- |
| `praxis.jiraMcpSiteUrl` | string | Base URL of the Jira instance that MCP tools connect to in Jira MCP mode. |
| `praxis.jiraMcpDefaultProjectKey` | string | Default Jira project key for new issues created through the Jira MCP backend. |
| `praxis.jiraMcpEpicKey` | string | Linked Jira epic key (MCP mode). |
| `praxis.jiraMcpEpicBoardName` | string | Friendly board name for the linked epic board (MCP mode). |
| `praxis.jiraMcpBoardJql` | string | Jira board query/JQL used for linked board behavior (MCP mode). |
| `praxis.jiraMcpBoardName` | string | Friendly name for the Jira MCP board. |

## Sidebar mode and UI settings

| Setting | Type | Purpose |
| --- | --- | --- |
| `praxis.enableNewProject` | boolean | Enables the preview New Project wizard command. |
| `praxis.boardsSidebarPreviewMode` | string | Selects the Boards sidebar layout (`classic` or `work`). |
| `praxis.priorityColors` | object | Configures priority indicator colors and gradients on ticket cards. |
| `praxis.jiraBoardListIconColor` | string | Optional accent color for Jira board list icons. |
| `praxis.demoBoardListIconColor` | string | Optional accent color for Demo board list icons. |
| `praxis.fileBoardListIconColor` | string | Optional accent color for file-backed board list icons. |
| `praxis.liveFolderBoardListIconColor` | string | Optional accent color for Live Folder board list icons. |

## Live Folder settings

| Setting | Type | Purpose |
| --- | --- | --- |
| `praxis.liveFolderPath` | string | Path to the `plans` or `features` tree used by Live Folder mode. |
| `praxis.liveFolderProjectKey` | string | Project key used for Live Folder-derived issues. |
| `praxis.liveFolderProjectName` | string | Human-readable project name for Live Folder mode. |
| `praxis.liveFolderAllowIssueCreation` | boolean | Allows the extension to create markdown issues while in Live Folder mode. |

## Polling, delivery, and MCP settings

| Setting | Type | Purpose |
| --- | --- | --- |
| `praxis.requestTimeoutMs` | number | Timeout for MCP/backend requests. |
| `praxis.defaultPageSize` | number | Page size for issue fetching. |
| `praxis.jiraPolling.enabled` | boolean | **Removed.** The built-in Jira poller was retired in favor of MCP-driven flows. |
| `praxis.delivery.defaultBaseBranch` | string | Default delivery workflow base branch. |
| `praxis.delivery.autoMergeSubTasks` | boolean | Controls whether completed sub-tasks auto-merge into the feature branch. |
| `praxis.workspaceMcpServerName` | string | Workspace MCP server name fallback. |
| `praxis.userMcpServerRef` | string | Application/profile MCP server fallback reference. |

## AI settings

| Setting | Type | Purpose |
| --- | --- | --- |
| `praxis.ai.provider` | string | Active AI provider (`none` or `vercel-gateway`). |
| `praxis.ai.credential` | string | Deprecated for Vercel Gateway (API key lives in Secret Storage). Kept for migration. |
| `praxis.ai.agentName` | string | Display and @mention name for the active provider. |
| `praxis.ai.runtimePath` | string | Unused for Vercel Gateway (kept for migration). |
| `praxis.ai.vercelUrl` | string | Base URL for the Vercel AI Gateway. |
| `praxis.ai.defaultModel` | string | Default model recorded on newly created Live Folder tickets. |
| `praxis.ai.analysisEnabled` | boolean | Enables the per-issue analysis gate before AI assignment. |
| `praxis.ai.analysisDefaultPrompt` | string | Required default prompt for the Analysis Window. |
| `praxis.ai.analysisDefaultModel` | string | Default model for the Analysis Window. |
| `praxis.ai.verboseActivityFeed` | boolean | Shows lower-level AI session activity events. |

## AI delivery workflow settings

| Setting | Type | Purpose |
| --- | --- | --- |
| `praxis.ai.deliveryWorkflowEnabled` | boolean | Enables delivery workflow execution instead of comment-only AI output. |
| `praxis.ai.deliveryPublishCommand` | string | Publish command run inside the dedicated delivery worktree. |
| `praxis.ai.deliveryArtifactPattern` | string | Artifact glob or relative path used to attach outputs back to Jira. |
| `praxis.ai.deliveryAgentWorkflowPath` | string | Path to the workflow-pack skill to enforce for delivery tasks. |
| `praxis.ai.deliveryAgentWorkflowUrl` | string | Optional URL surfaced in delivery comments. |
| `praxis.ai.deliverySummaryTemplate` | string | Template for successful Jira delivery summary comments. |
| `praxis.ai.deliveryFailureTemplate` | string | Template for failed Jira delivery comments. |

## Notes

- Use `praxis.boardsSidebarPreviewMode` to switch between classic and Work Mode.
