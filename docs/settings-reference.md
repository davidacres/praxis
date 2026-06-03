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
| `ticketManager.jiraCloudBaseUrl` | string | Jira Cloud polling/delivery base URL (legacy key name). |
| `ticketManager.jiraCloudToken` | string | Jira Cloud polling/delivery bearer token (legacy key name). |
| `ticketManager.jiraCloudEpicKey` | string | Linked Jira epic key. |
| `ticketManager.jiraCloudEpicBoardName` | string | Friendly board name for the linked epic board. |
| `ticketManager.jiraCloudBoardJql` | string | Jira board query/JQL used for linked board behavior. |
| `ticketManager.jiraCloudBoardName` | string | Friendly name for the Jira Cloud board. |
| `ticketManager.jiraOAuthClientId` | string | OAuth client id for Jira Cloud sign-in. |
| `ticketManager.jiraOAuthScopes` | array | OAuth scopes requested during Jira Cloud auth. |
| `ticketManager.jiraCloudId` | string | Jira Cloud site id captured after OAuth connection. |
| `ticketManager.jiraCloudSiteName` | string | Jira Cloud site display name. |
| `ticketManager.jiraCloudSiteUrl` | string | Jira Cloud site URL. |

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

## GitHub and GitLab settings

| Setting | Type | Purpose |
| --- | --- | --- |
| `ticketManager.githubPat` | string | GitHub Personal Access Token. |
| `ticketManager.githubUrl` | string | GitHub API base URL. |
| `ticketManager.githubOwner` | string | GitHub owner or organization name. |
| `ticketManager.gitlabUrl` | string | GitLab instance URL. |
| `ticketManager.gitlabApiKey` | string | Deprecated GitLab PAT compatibility setting. SecretStorage is preferred. |

## Polling, delivery, and MCP settings

| Setting | Type | Purpose |
| --- | --- | --- |
| `ticketManager.requestTimeoutMs` | number | Timeout for MCP/backend requests. |
| `ticketManager.defaultPageSize` | number | Page size for issue fetching. |
| `ticketManager.jiraPolling.enabled` | boolean | Starts the built-in Jira poller on activation in supported modes (disabled by default). |
| `ticketManager.jiraPolling.requiredLabel` | string | Label gate used for AI execution eligibility. |
| `ticketManager.jiraPolling.clarificationAnalysis` | boolean | Enables readiness analysis before AI execution. |
| `ticketManager.delivery.defaultBaseBranch` | string | Default delivery workflow base branch. |
| `ticketManager.delivery.autoMergeSubTasks` | boolean | Controls whether completed sub-tasks auto-merge into the feature branch. |
| `ticketManager.workspaceMcpServerName` | string | Workspace MCP server name fallback. |
| `ticketManager.userMcpServerRef` | string | Application/profile MCP server fallback reference. |

## AI settings

| Setting | Type | Purpose |
| --- | --- | --- |
| `ticketManager.ai.openaiApiKey` | string | OpenAI API key. |
| `ticketManager.ai.claudeApiKey` | string | Claude/Anthropic API key. |
| `ticketManager.ai.cursorCliPath` | string | Path to the Cursor CLI executable. |
| `ticketManager.ai.copilotEnabled` | boolean | Enables GitHub Copilot SDK-powered features. |
| `ticketManager.ai.copilotCliPath` | string | Legacy compatibility override for Copilot runtime. |
| `ticketManager.ai.copilotAgentName` | string | Display/@mention name for the Copilot agent. |
| `ticketManager.ai.claudeCliPath` | string | Path to the Claude Code CLI executable. |
| `ticketManager.ai.defaultProvider` | string | Default AI provider used for assignments. |
| `ticketManager.ai.defaultModel` | string | Default model recorded on newly created Live Folder tickets. |
| `ticketManager.ai.openaiAgentName` | string | Friendly display name for OpenAI assignment. |
| `ticketManager.ai.claudeAgentName` | string | Friendly display name for Claude assignment. |
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
- `ticketManager.gitlabApiKey` is deprecated; current GitLab credentials are intended to be stored through VS Code SecretStorage.
