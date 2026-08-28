# Praxis Command Reference

> This file is generated from `apps/vscode-extension/package.json` by `npm run docs:commands` (delegates to `node apps/vscode-extension/scripts/generate-command-reference.cjs`).

This document lists the user-facing commands contributed through the extension manifest.

Total contributed commands: 61

| Command Title | Command Id | Category | Icon |
| --- | --- | --- | --- |
| Abandon AI Session | `praxis.unassignAi` | Praxis | $(close) |
| Abort Agent Session | `praxis.abortAgentSession` | Praxis | $(debug-stop) |
| Add Connection | `praxis.addConnection` | Praxis | $(add) |
| Add Tracked Board | `praxis.addBoard` | Praxis | $(add) |
| AI Gateway Settings | `praxis.openAiGatewaySettings` | Praxis | $(key) |
| Assign to Me | `praxis.assignToMe` | Praxis | $(person) |
| Assign Workflow Pack | `praxis.assignWorkflowPack` | Praxis | $(symbol-key) |
| Change Status | `praxis.changeStatus` | Praxis | $(play-circle) |
| Check Connection | `praxis.checkConnection` | Praxis | $(debug-alt) |
| Clear Board Filters | `praxis.clearBoardFilters` | Praxis | $(clear-all) |
| Clear Filters | `praxis.clearFilters` | Praxis | $(clear-all) |
| Clear Parent Item Scope | `praxis.clearParentScope` | Praxis | $(close) |
| Configure AI | `praxis.configureAi` | Praxis | $(hubot) |
| Configure Board Settings | `praxis.configureBoardColumns` | Praxis | $(settings-gear) |
| Configure Jira MCP Connection | `praxis.configureConnection` | Praxis | $(plug) |
| Configure Project | `praxis.openSetup` | Praxis | $(gear) |
| Confirm Analysis Complete | `praxis.confirmAnalysisComplete` | Praxis | $(pass) |
| Copy Issue Key | `praxis.copyKey` | Praxis | $(copy) |
| Create Board | `praxis.createBoard` | Praxis | $(add) |
| Create EPIC | `praxis.createEpic` | Praxis | $(add) |
| Create Idea | `praxis.createIdea` | Praxis | $(lightbulb) |
| Create Issue | `praxis.createIssue` | Praxis | $(add) |
| Delegate to AI Agent | `praxis.delegateToAiAgent` | Praxis | $(hubot) |
| Delegate to AI Agent | `praxis.assignToAi` | Praxis | $(hubot) |
| Delegate to AI Agent (Deprecated) | `praxis.delegateToCopilot` | Praxis | $(hubot) |
| Import Markdown Files to Template Format | `praxis.importMarkdownFiles` | Praxis | $(file-code) |
| Import Plan from Markdown Features | `praxis.importMarkdownFeaturePlan` | Praxis | $(file-code) |
| Link Jira MCP Board Query | `praxis.linkJiraMcpBoardQuery` | Praxis | $(list-filter) |
| Link Jira MCP Epic | `praxis.linkJiraMcpEpic` | Praxis | $(link) |
| Load More | `praxis.loadMore` | Praxis | $(chevron-down) |
| Local Peer Review (LPR) | `praxis.localPeerReview` | Praxis | $(checklist) |
| Migrate Live Folder to Jira MCP | `praxis.migrateLiveFolderToJiraMcp` | Praxis | $(cloud-upload) |
| New Project | `praxis.newProject` | Praxis | $(rocket) |
| Open Board | `praxis.openBoard` | Praxis | $(go-to-file) |
| Open Connections & Boards | `praxis.openConnectionsManager` | Praxis | $(plug) |
| Open External Link | `praxis.openInBrowser` | Praxis | $(link-external) |
| Open Full Issue Details | `praxis.openIssueFullDetails` | Praxis | $(preview) |
| Open Settings | `praxis.openSettings` | Praxis | $(gear) |
| Open Task Designer | `praxis.openTaskDesigner` | Praxis | $(symbol-misc) |
| Refresh | `praxis.refresh` | Praxis | $(refresh) |
| Review Ticket with AI | `praxis.reviewWithAi` | Praxis | $(comment-discussion) |
| Search Boards | `praxis.searchBoards` | Praxis | $(search) |
| Search Boards | `praxis.searchBoardsActive` | Praxis | media/search-active-light.svg / media/search-active-dark.svg |
| Search EPICs | `praxis.searchEpics` | Praxis | $(search) |
| Search EPICs | `praxis.searchEpicsActive` | Praxis | media/search-active-light.svg / media/search-active-dark.svg |
| Search Issues | `praxis.searchIssues` | Praxis | $(search) |
| Search Issues | `praxis.searchIssuesActive` | Praxis | media/search-active-light.svg / media/search-active-dark.svg |
| Set Backend Mode | `praxis.setBackendMode` | Praxis | $(symbol-namespace) |
| Set Board Projects | `praxis.setBoardProjects` | Praxis | $(repo) |
| Set Board Search Text | `praxis.setBoardSearchText` | Praxis | $(search) |
| Set Board Types | `praxis.setBoardTypes` | Praxis | $(list-tree) |
| Set Issue Type Filter | `praxis.setIssueTypes` | Praxis | $(symbol-class) |
| Set Parent Item Scope | `praxis.setParentScope` | Praxis | $(milestone) |
| Set Projects | `praxis.setProjects` | Praxis | $(repo) |
| Set Search Text | `praxis.setSearchText` | Praxis | $(search) |
| Set Status Filter | `praxis.setStatuses` | Praxis | $(list-selection) |
| Start Sub-Task Delivery | `praxis.startSubTaskDelivery` | Praxis | $(play) |
| Toggle Assignee Scope | `praxis.toggleAssigneeMode` | Praxis | $(account) |
| Toggle Work Mode | `praxis.toggleWorkMode` | Praxis | $(layout-sidebar-right) |
| View AI Session | `praxis.viewAgentSession` | Praxis | $(eye) |
| View Analysis | `praxis.openAnalysisWindow` | Praxis | $(comment) |

## Notes

- This reference only covers manifest-contributed commands.
- Some internally registered commands and wiring helpers are intentionally not listed here.
