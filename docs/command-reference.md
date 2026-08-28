# Ticket Manager Command Reference

> This file is generated from `apps/vscode-extension/package.json` by `npm run docs:commands` (delegates to `node apps/vscode-extension/scripts/generate-command-reference.cjs`).

This document lists the user-facing commands contributed through the extension manifest.

Total contributed commands: 61

| Command Title | Command Id | Category | Icon |
| --- | --- | --- | --- |
| Abandon AI Session | `ticketManager.unassignAi` | Ticket Manager | $(close) |
| Abort Agent Session | `ticketManager.abortAgentSession` | Ticket Manager | $(debug-stop) |
| Add Connection | `ticketManager.addConnection` | Ticket Manager | $(add) |
| Add Tracked Board | `ticketManager.addBoard` | Ticket Manager | $(add) |
| AI Gateway Settings | `ticketManager.openAiGatewaySettings` | Ticket Manager | $(key) |
| Assign to Me | `ticketManager.assignToMe` | Ticket Manager | $(person) |
| Assign Workflow Pack | `ticketManager.assignWorkflowPack` | Ticket Manager | $(symbol-key) |
| Change Status | `ticketManager.changeStatus` | Ticket Manager | $(play-circle) |
| Check Connection | `ticketManager.checkConnection` | Ticket Manager | $(debug-alt) |
| Clear Board Filters | `ticketManager.clearBoardFilters` | Ticket Manager | $(clear-all) |
| Clear Filters | `ticketManager.clearFilters` | Ticket Manager | $(clear-all) |
| Clear Parent Item Scope | `ticketManager.clearParentScope` | Ticket Manager | $(close) |
| Configure AI | `ticketManager.configureAi` | Ticket Manager | $(hubot) |
| Configure Board Settings | `ticketManager.configureBoardColumns` | Ticket Manager | $(settings-gear) |
| Configure Jira MCP Connection | `ticketManager.configureConnection` | Ticket Manager | $(plug) |
| Configure Project | `ticketManager.openSetup` | Ticket Manager | $(gear) |
| Confirm Analysis Complete | `ticketManager.confirmAnalysisComplete` | Ticket Manager | $(pass) |
| Copy Issue Key | `ticketManager.copyKey` | Ticket Manager | $(copy) |
| Create Board | `ticketManager.createBoard` | Ticket Manager | $(add) |
| Create EPIC | `ticketManager.createEpic` | Ticket Manager | $(add) |
| Create Idea | `ticketManager.createIdea` | Ticket Manager | $(lightbulb) |
| Create Issue | `ticketManager.createIssue` | Ticket Manager | $(add) |
| Delegate to AI Agent | `ticketManager.delegateToAiAgent` | Ticket Manager | $(hubot) |
| Delegate to AI Agent | `ticketManager.assignToAi` | Ticket Manager | $(hubot) |
| Delegate to AI Agent (Deprecated) | `ticketManager.delegateToCopilot` | Ticket Manager | $(hubot) |
| Import Markdown Files to Template Format | `ticketManager.importMarkdownFiles` | Ticket Manager | $(file-code) |
| Import Plan from Markdown Features | `ticketManager.importMarkdownFeaturePlan` | Ticket Manager | $(file-code) |
| Link Jira MCP Board Query | `ticketManager.linkJiraMcpBoardQuery` | Ticket Manager | $(list-filter) |
| Link Jira MCP Epic | `ticketManager.linkJiraMcpEpic` | Ticket Manager | $(link) |
| Load More | `ticketManager.loadMore` | Ticket Manager | $(chevron-down) |
| Local Peer Review (LPR) | `ticketManager.localPeerReview` | Ticket Manager | $(checklist) |
| Migrate Live Folder to Jira MCP | `ticketManager.migrateLiveFolderToJiraMcp` | Ticket Manager | $(cloud-upload) |
| New Project | `ticketManager.newProject` | Ticket Manager | $(rocket) |
| Open Board | `ticketManager.openBoard` | Ticket Manager | $(go-to-file) |
| Open Connections & Boards | `ticketManager.openConnectionsManager` | Ticket Manager | $(plug) |
| Open External Link | `ticketManager.openInBrowser` | Ticket Manager | $(link-external) |
| Open Full Issue Details | `ticketManager.openIssueFullDetails` | Ticket Manager | $(preview) |
| Open Settings | `ticketManager.openSettings` | Ticket Manager | $(gear) |
| Open Task Designer | `ticketManager.openTaskDesigner` | Ticket Manager | $(symbol-misc) |
| Refresh | `ticketManager.refresh` | Ticket Manager | $(refresh) |
| Review Ticket with AI | `ticketManager.reviewWithAi` | Ticket Manager | $(comment-discussion) |
| Search Boards | `ticketManager.searchBoards` | Ticket Manager | $(search) |
| Search Boards | `ticketManager.searchBoardsActive` | Ticket Manager | media/search-active-light.svg / media/search-active-dark.svg |
| Search EPICs | `ticketManager.searchEpics` | Ticket Manager | $(search) |
| Search EPICs | `ticketManager.searchEpicsActive` | Ticket Manager | media/search-active-light.svg / media/search-active-dark.svg |
| Search Issues | `ticketManager.searchIssues` | Ticket Manager | $(search) |
| Search Issues | `ticketManager.searchIssuesActive` | Ticket Manager | media/search-active-light.svg / media/search-active-dark.svg |
| Set Backend Mode | `ticketManager.setBackendMode` | Ticket Manager | $(symbol-namespace) |
| Set Board Projects | `ticketManager.setBoardProjects` | Ticket Manager | $(repo) |
| Set Board Search Text | `ticketManager.setBoardSearchText` | Ticket Manager | $(search) |
| Set Board Types | `ticketManager.setBoardTypes` | Ticket Manager | $(list-tree) |
| Set Issue Type Filter | `ticketManager.setIssueTypes` | Ticket Manager | $(symbol-class) |
| Set Parent Item Scope | `ticketManager.setParentScope` | Ticket Manager | $(milestone) |
| Set Projects | `ticketManager.setProjects` | Ticket Manager | $(repo) |
| Set Search Text | `ticketManager.setSearchText` | Ticket Manager | $(search) |
| Set Status Filter | `ticketManager.setStatuses` | Ticket Manager | $(list-selection) |
| Start Sub-Task Delivery | `ticketManager.startSubTaskDelivery` | Ticket Manager | $(play) |
| Toggle Assignee Scope | `ticketManager.toggleAssigneeMode` | Ticket Manager | $(account) |
| Toggle Work Mode | `ticketManager.toggleWorkMode` | Ticket Manager | $(layout-sidebar-right) |
| View AI Session | `ticketManager.viewAgentSession` | Ticket Manager | $(eye) |
| View Analysis | `ticketManager.openAnalysisWindow` | Ticket Manager | $(comment) |

## Notes

- This reference only covers manifest-contributed commands.
- Some internally registered commands and wiring helpers are intentionally not listed here.
