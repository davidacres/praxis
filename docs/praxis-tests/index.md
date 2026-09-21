# Praxis Test catalogue

This catalogue describes **378 Playwright tests** under `apps/praxis-desktop/main/e2e`. Each entry is a structured English contract linked to its exact source file and line. Run `npm run test:praxis-contracts` to detect drift before QA.

| ID | Area | Test | Automation |
| --- | --- | --- | --- |
| PT-BDCF16C604 | agent Hub | the sidebar tree lists agent profiles and skills only; a profile shows its record and bound runtime | `apps/praxis-desktop/main/e2e/agentHub.spec.ts:87` |
| PT-D808543E8F | agent Hub | Agent Runtime settings separate AI runtimes from agent profiles, and manage standalone launch bindings | `apps/praxis-desktop/main/e2e/agentHub.spec.ts:115` |
| PT-62CDFA4F00 | agent Hub | starting, restarting, and stopping a host moves its lifecycle state | `apps/praxis-desktop/main/e2e/agentHub.spec.ts:147` |
| PT-C1ABBDD4C2 | agent Hub | activating a skill and opening a session carries the agent context | `apps/praxis-desktop/main/e2e/agentHub.spec.ts:168` |
| PT-B94DDF73DF | agent Hub | the New launch binding wizard writes a validated, discoverable manifest | `apps/praxis-desktop/main/e2e/agentHub.spec.ts:188` |
| PT-37CF86E277 | agent Hub | import validates a folder without executing it and rejects a bad manifest | `apps/praxis-desktop/main/e2e/agentHub.spec.ts:223` |
| PT-24D83F9928 | ai Acp Browser | an ACP session drives the in-app browser via the MCP server | `apps/praxis-desktop/main/e2e/aiAcpBrowser.spec.ts:49` |
| PT-8FEB544D20 | ai Acp Browser | the browser stays connected across a follow-up turn | `apps/praxis-desktop/main/e2e/aiAcpBrowser.spec.ts:68` |
| PT-29C3297F5E | ai Acp Browser | an unlisted host prompts on the session card, then proceeds when allowed | `apps/praxis-desktop/main/e2e/aiAcpBrowser.spec.ts:97` |
| PT-4143D95C22 | ai Acp Modes And Commands | Session Modes advertised at start switch over the live connection and update the composer | `apps/praxis-desktop/main/e2e/aiAcpModesAndCommands.spec.ts:39` |
| PT-CE3B0BEF15 | ai Acp Modes And Commands | the agent's own slash commands populate the composer and insert into the follow-up box | `apps/praxis-desktop/main/e2e/aiAcpModesAndCommands.spec.ts:70` |
| PT-50968F20CE | ai Acp Modes And Commands | context compaction is offered only when the ACP provider advertises /compact | `apps/praxis-desktop/main/e2e/aiAcpModesAndCommands.spec.ts:97` |
| PT-2BC663AF85 | ai Agent Resilience | aborting an agent that ignores cancel returns promptly | `apps/praxis-desktop/main/e2e/aiAgentResilience.spec.ts:53` |
| PT-4E0F437EDA | ai Browser | restores the selected session and browser URL and keeps an explicit close closed | `apps/praxis-desktop/main/e2e/aiBrowser.spec.ts:41` |
| PT-155F86379C | ai Browser | a full-tools session drives the in-app browser and reads the page | `apps/praxis-desktop/main/e2e/aiBrowser.spec.ts:83` |
| PT-B7CF05FBB3 | ai Browser | the toolbar navigates the in-app browser by hand | `apps/praxis-desktop/main/e2e/aiBrowser.spec.ts:131` |
| PT-3E533BE77B | ai Cli Agent Host | delegate completes a session against a real ACP agent subprocess | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:126` |
| PT-8B3835312A | ai Cli Agent Host | an Agent Hub ACP binding launches its declared host entry point | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:154` |
| PT-59941C287E | ai Cli Agent Host | ACP resume replay does not duplicate the previous answer into a follow-up | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:202` |
| PT-1999DA8875 | ai Cli Agent Host | a pasted image reaches an ACP agent as an image content block | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:225` |
| PT-E868E41A8C | ai Cli Agent Host | an ACP diff tool call renders as a red/green diff in the console | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:257` |
| PT-81CB515D12 | ai Cli Agent Host | ticket-selected Claude Code runs review and analysis without using Vercel | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:277` |
| PT-1868BD4BF4 | ai Cli Agent Host | an in-flight turn shows one live status line, not streamed tool blocks | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:324` |
| PT-18A9C6783D | ai Cli Agent Host | abort kills the ACP agent subprocess cleanly | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:345` |
| PT-B20B70A423 | ai Cli Agent Host | listCliModelOptions reads the real model list from session/new | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:374` |
| PT-FCC07A19B5 | ai Cli Agent Host | delegating with a model override applies it via session/set_config_option | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:384` |
| PT-F9FE6B89E2 | ai Coding Task | a ticket for a one-line fix is delegated to an agent and lands on disk | `apps/praxis-desktop/main/e2e/aiCodingTask.spec.ts:35` |
| PT-41267424E7 | ai Coding Task | a read-only session cannot write the file | `apps/praxis-desktop/main/e2e/aiCodingTask.spec.ts:126` |
| PT-3CFB8F109B | ai Coding Task | each turn records its reply once, and follow-ups carry the earlier answer | `apps/praxis-desktop/main/e2e/aiCodingTask.spec.ts:172` |
| PT-8CF13E78B8 | ai Coding Task | a finished session shows its changeset and can commit it | `apps/praxis-desktop/main/e2e/aiCodingTask.spec.ts:226` |
| PT-5117CABD96 | ai Coding Task | committing a session leaves work in progress the session never touched | `apps/praxis-desktop/main/e2e/aiCodingTask.spec.ts:293` |
| PT-19FFBA78F5 | ai Coding Task | a changed file can be read whole, not just as a diff | `apps/praxis-desktop/main/e2e/aiCodingTask.spec.ts:361` |
| PT-B68CC8A647 | ai Coding Task | a single hunk can be discarded without losing the rest of the file's edits | `apps/praxis-desktop/main/e2e/aiCodingTask.spec.ts:423` |
| PT-BE2FD9BEA0 | ai Coding Task | a CLI-agent session reports no token count rather than a misleading zero | `apps/praxis-desktop/main/e2e/aiCodingTask.spec.ts:504` |
| PT-CFC3ABC6AB | ai Coding Task | an edit can be undone straight from the transcript | `apps/praxis-desktop/main/e2e/aiCodingTask.spec.ts:544` |
| PT-E31436F97C | ai Context Indicator | a comfortable context stays compact and opens its details on demand | `apps/praxis-desktop/main/e2e/aiContextIndicator.spec.ts:81` |
| PT-9A394D20A8 | ai Context Indicator | the runtime facts sit on the composer as chips, not tucked in a side panel | `apps/praxis-desktop/main/e2e/aiContextIndicator.spec.ts:102` |
| PT-1C5A0DA21B | ai Context Indicator | a filling context warns, and says what is causing it | `apps/praxis-desktop/main/e2e/aiContextIndicator.spec.ts:126` |
| PT-664519101F | ai Context Indicator | a nearly-full context escalates and tells the user what to do | `apps/praxis-desktop/main/e2e/aiContextIndicator.spec.ts:153` |
| PT-EE24F3F2AE | ai Copilot Agent Host | copilot-cli delegates over ACP just like the other CLI-hosted agents | `apps/praxis-desktop/main/e2e/aiCopilotAgentHost.spec.ts:113` |
| PT-C5A7EBC4F3 | ai Copilot Agent Host | copilot-cli reports its model list via session/new, same as Claude/Codex | `apps/praxis-desktop/main/e2e/aiCopilotAgentHost.spec.ts:127` |
| PT-B3EC95A0BB | ai Copilot Agent Host | abort kills the copilot-cli subprocess cleanly | `apps/praxis-desktop/main/e2e/aiCopilotAgentHost.spec.ts:137` |
| PT-97D010C2BF | ai Live Agent.live | a real agent takes a ticket and makes the failing suite pass | `apps/praxis-desktop/main/e2e/aiLiveAgent.live.spec.ts:86` |
| PT-DCA7E03194 | ai Live Agent.live | a real agent handles a multi-file change and uses the shell | `apps/praxis-desktop/main/e2e/aiLiveAgent.live.spec.ts:168` |
| PT-92B4DC40CA | ai Live Conversation.live | two real CLI agents visibly alternate in a capped read-only consult | `apps/praxis-desktop/main/e2e/aiLiveConversation.live.spec.ts:54` |
| PT-820CD80860 | ai Live Handover.live | a real agent hands the session to another real agent that finishes the work | `apps/praxis-desktop/main/e2e/aiLiveHandover.live.spec.ts:204` |
| PT-D71A4C8575 | ai Live Handover.live | one agent does a single part of a task then another agent completes it | `apps/praxis-desktop/main/e2e/aiLiveHandover.live.spec.ts:354` |
| PT-5B702019B8 | ai Permissions | allowing a pending permission lets the session continue to completion | `apps/praxis-desktop/main/e2e/aiPermissions.spec.ts:36` |
| PT-B2588D9089 | ai Permissions | denying a pending permission is honored by the agent | `apps/praxis-desktop/main/e2e/aiPermissions.spec.ts:118` |
| PT-69E9211A87 | ai Provider | AI provider settings store the API key in the keychain and persist across relaunch | `apps/praxis-desktop/main/e2e/aiProvider.spec.ts:57` |
| PT-158157DEA6 | ai Provider | delegate streams session events over the push channel and completes against the mock gateway | `apps/praxis-desktop/main/e2e/aiProvider.spec.ts:103` |
| PT-F860463D91 | ai Provider | abort stops an in-flight session | `apps/praxis-desktop/main/e2e/aiProvider.spec.ts:175` |
| PT-34D61FAFDF | ai Provider | delegate completes against an OpenAI-provider mock (same wire format as Vercel) | `apps/praxis-desktop/main/e2e/aiProvider.spec.ts:251` |
| PT-771E4C8FAF | ai Provider | delegate completes against an Anthropic-provider mock (Messages API wire format) | `apps/praxis-desktop/main/e2e/aiProvider.spec.ts:294` |
| PT-E6E895AE5B | ai Provider | listApiModelOptions reads the real model list from the mock gateway's /v1/models | `apps/praxis-desktop/main/e2e/aiProvider.spec.ts:359` |
| PT-9AE71AF930 | ai Provider | listApiModelOptions reads Anthropic's /v1/models via x-api-key auth (not Bearer) | `apps/praxis-desktop/main/e2e/aiProvider.spec.ts:382` |
| PT-857CBE8BD0 | ai Provider | delegating with a model override sends that model in the gateway request | `apps/praxis-desktop/main/e2e/aiProvider.spec.ts:394` |
| PT-9D55F29198 | ai Provider | the New Session composer lists configured providers and can start a session on a non-default one | `apps/praxis-desktop/main/e2e/aiProvider.spec.ts:442` |
| PT-0922787177 | ai Provider | the model manager panel curates which models the composer offers | `apps/praxis-desktop/main/e2e/aiProvider.spec.ts:477` |
| PT-151720A16D | ai Provider Tabs | the page is split into tabs and each tab shows only its own settings | `apps/praxis-desktop/main/e2e/aiProviderTabs.spec.ts:59` |
| PT-5B34596812 | ai Provider Tabs | each provider is one row with a switch; the default and unconfigured ones cannot be switched | `apps/praxis-desktop/main/e2e/aiProviderTabs.spec.ts:91` |
| PT-5C9FEE4A22 | ai Provider Tabs | turning a provider off removes it from the composer and refuses new sessions on it; turning it on restores it | `apps/praxis-desktop/main/e2e/aiProviderTabs.spec.ts:128` |
| PT-A950D62678 | ai Provider Tabs | making another provider the default frees the previous default to be switched off | `apps/praxis-desktop/main/e2e/aiProviderTabs.spec.ts:172` |
| PT-CD171F469C | ai Provider Tabs | pressing the switch on a provider that is not set up opens its setup, and it turns on once a key is saved | `apps/praxis-desktop/main/e2e/aiProviderTabs.spec.ts:182` |
| PT-49F972B78B | ai Provider Tabs | the Recommendations provider list leaves out providers that are turned off, but keeps a chosen one visible | `apps/praxis-desktop/main/e2e/aiProviderTabs.spec.ts:212` |
| PT-16A529CAF6 | ai Session Mode | switching a finished session to Review sends the mode transition and resumes it | `apps/praxis-desktop/main/e2e/aiSessionMode.spec.ts:32` |
| PT-E5CDA49312 | ai Sessions | closing Praxis warns before interrupting an active AI session | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:45` |
| PT-391BE89930 | ai Sessions | composer selects a board and open ticket, names the session, and streams to completion | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:81` |
| PT-C5EEB040ED | ai Sessions | issue detail starts a prompted ticket session and opens its console | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:238` |
| PT-B888C57744 | ai Sessions | API session executes a tracker tool and shows the call and result inline | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:314` |
| PT-3CC04EDF51 | ai Sessions | composer surfaces the provider-not-configured error when no API key exists | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:352` |
| PT-4BA1F5064F | ai Sessions | a write_file tool call renders a red/green diff after the write is approved | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:368` |
| PT-5084A64AC6 | ai Sessions | the inspector is tabbed state, not a second copy of the conversation | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:414` |
| PT-58DC72B588 | ai Sessions | the agent's reply uses the pane it has; yours stays a reply beside it | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:464` |
| PT-CEBA29D1BE | ai Sessions | change model and handover stay unreachable while a turn is running | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:515` |
| PT-8B498DBD6E | ai Sessions | a completed session can edit its brief, change model, and hand over | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:543` |
| PT-E8718CE61D | ai Sessions | an opt-in conversation alternates attributed AI turns and stops at its cap | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:618` |
| PT-C4D6CE19FD | ai Sessions | a human can direct a message to either participant during an AI conversation | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:658` |
| PT-0002CA30E9 | ai Sessions | an image pasted during a conversation rides with the directed message | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:718` |
| PT-3FBB5F9EAE | ai Sessions | focus mode presents sessions as tabs and keeps them available while starting a new session | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:780` |
| PT-3849E1CAB4 | ai Sessions | session failure displays unified error banner above the chat panel and not scattered in chat | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:836` |
| PT-E4F45D8F5D | ai Sessions | composer paste and drop carries an image to the agent and the transcript | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:902` |
| PT-6FD9400441 | ai Sessions | a transcript attachment enlarges in a lightbox and closes on click | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:975` |
| PT-CC6C44E927 | ai Sessions | a file dropped outside the composer never navigates the window | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:1021` |
| PT-7D4DE7FD50 | ai Sessions | a session can be archived from its row and restored from the inspector browser | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:1058` |
| PT-3B9205BF7B | ai Session Tasks | the task list updates live as the agent works through it, then settles once the turn ends | `apps/praxis-desktop/main/e2e/aiSessionTasks.spec.ts:37` |
| PT-7F852938F4 | ai Session Tasks | a fully completed plan shows all three done | `apps/praxis-desktop/main/e2e/aiSessionTasks.spec.ts:74` |
| PT-48E536B7E9 | ai Session Tasks | a session that never reports a plan shows no Tasks block at all | `apps/praxis-desktop/main/e2e/aiSessionTasks.spec.ts:92` |
| PT-74F1E91B3A | ai Session Tasks | an ACP agent reporting usage drives the context indicator and shows its cost | `apps/praxis-desktop/main/e2e/aiSessionTasks.spec.ts:110` |
| PT-10644FFE61 | ai Spend Limit | spend well under the limit says nothing | `apps/praxis-desktop/main/e2e/aiSpendLimit.spec.ts:49` |
| PT-CB699F4EDD | ai Spend Limit | approaching the limit warns, and totals across sessions rather than per session | `apps/praxis-desktop/main/e2e/aiSpendLimit.spec.ts:60` |
| PT-642D967396 | ai Spend Limit | over the limit says so, and is honest that nothing is blocked | `apps/praxis-desktop/main/e2e/aiSpendLimit.spec.ts:80` |
| PT-F98EAD7F26 | ai Spend Limit | mixed currencies show no total rather than a meaningless one | `apps/praxis-desktop/main/e2e/aiSpendLimit.spec.ts:95` |
| PT-17F2E7A63C | ai Spend Report | totals real ACP cost and real gateway tokens, never blended, grouped by provider and connection | `apps/praxis-desktop/main/e2e/aiSpendReport.spec.ts:55` |
| PT-F4FF17FF93 | ai Spend Report | a range with no sessions shows the empty state, not an empty report | `apps/praxis-desktop/main/e2e/aiSpendReport.spec.ts:127` |
| PT-F3833555DA | ai Workflows | workflow pack picker lists discovered packs and assigns one | `apps/praxis-desktop/main/e2e/aiWorkflows.spec.ts:126` |
| PT-3269A847C9 | ai Workflows | review page streams the review markdown and posts it as a comment | `apps/praxis-desktop/main/e2e/aiWorkflows.spec.ts:156` |
| PT-2F1B96DE92 | ai Workflows | analysis uses the selected runtime and continues implementation in the same session | `apps/praxis-desktop/main/e2e/aiWorkflows.spec.ts:188` |
| PT-6099BC2E97 | ai Workflows | configured CLI agents remain available in ticket details when analysis is gated | `apps/praxis-desktop/main/e2e/aiWorkflows.spec.ts:255` |
| PT-6A6DA95A53 | ai Workflows | analysis runs through the selected OpenAI provider and model | `apps/praxis-desktop/main/e2e/aiWorkflows.spec.ts:271` |
| PT-77F4F08B13 | ai Workflows | delivery run completes and the watcher finalizes it from the DELIVERY_RESULT block | `apps/praxis-desktop/main/e2e/aiWorkflows.spec.ts:306` |
| PT-45E6380505 | ai Workflows | delivery refuses to start when the workflow is disabled in settings | `apps/praxis-desktop/main/e2e/aiWorkflows.spec.ts:338` |
| PT-2D32AEE248 | ai Workflows | feature decomposition creates the sub-task issues and lists them | `apps/praxis-desktop/main/e2e/aiWorkflows.spec.ts:351` |
| PT-A5306CD7F1 | ai Workflows | local peer review runs the three sections against the gateway | `apps/praxis-desktop/main/e2e/aiWorkflows.spec.ts:427` |
| PT-3F16D9601E | ai Workflows | merge requests list empty, then create after a delivery recorded a branch | `apps/praxis-desktop/main/e2e/aiWorkflows.spec.ts:467` |
| PT-CBE42CD885 | ai Worktree | a worktree session creates the branch + checkout and the console can remove it | `apps/praxis-desktop/main/e2e/aiWorktree.spec.ts:54` |
| PT-142C2B7A1B | app | groups all layout toggles on the right side of the title bar | `apps/praxis-desktop/main/e2e/app.spec.ts:17` |
| PT-865C5ABA3C | app | focus mode button in titlebar is available in a session and toggles panels | `apps/praxis-desktop/main/e2e/app.spec.ts:34` |
| PT-4D5169B00E | app | Praxis section in sidebar can expand to full sidebar and restore | `apps/praxis-desktop/main/e2e/app.spec.ts:67` |
| PT-8287929558 | app | remembers which panels are open across a relaunch | `apps/praxis-desktop/main/e2e/app.spec.ts:91` |
| PT-CF9F8E1A1A | app | displays the running Praxis version in the title bar | `apps/praxis-desktop/main/e2e/app.spec.ts:108` |
| PT-2DDEE2CB06 | app | boards render on launch | `apps/praxis-desktop/main/e2e/app.spec.ts:114` |
| PT-50D9451E47 | app | normal launch does not include built-in demo data | `apps/praxis-desktop/main/e2e/app.spec.ts:121` |
| PT-07AE341C04 | app | selecting a board renders its columns and issue cards | `apps/praxis-desktop/main/e2e/app.spec.ts:132` |
| PT-7DBFACF20E | app | opening an issue card shows the issue detail panel | `apps/praxis-desktop/main/e2e/app.spec.ts:155` |
| PT-6E62D61719 | app | adding a comment appears in the issue detail panel | `apps/praxis-desktop/main/e2e/app.spec.ts:164` |
| PT-A6199352B5 | app | closing the issue detail panel hides it | `apps/praxis-desktop/main/e2e/app.spec.ts:176` |
| PT-CD88DD8E19 | app | navigating to Connections shows the connection management screen | `apps/praxis-desktop/main/e2e/app.spec.ts:184` |
| PT-9C84544990 | app | adding and removing a connection updates the list | `apps/praxis-desktop/main/e2e/app.spec.ts:191` |
| PT-BBA9C83046 | app | a returning user gets the brief splash, not the full crawl | `apps/praxis-desktop/main/e2e/app.spec.ts:216` |
| PT-0C494CCBEC | appearance Settings | opens Settings from the title bar as a dismissible popover dialog | `apps/praxis-desktop/main/e2e/appearanceSettings.spec.ts:31` |
| PT-554DF61623 | appearance Settings | theme gallery previews and persists the selected complete palette | `apps/praxis-desktop/main/e2e/appearanceSettings.spec.ts:42` |
| PT-E7281D960A | appearance Settings | persists the selected theme and mode through app settings | `apps/praxis-desktop/main/e2e/appearanceSettings.spec.ts:68` |
| PT-7FCBAD6580 | appearance Settings | startup splash inherits the saved app theme | `apps/praxis-desktop/main/e2e/appearanceSettings.spec.ts:81` |
| PT-77C9928C26 | appearance Settings | installs a marketplace theme and makes it available on reload | `apps/praxis-desktop/main/e2e/appearanceSettings.spec.ts:151` |
| PT-33995E247F | appearance Settings | creates a custom theme with editable colors and persists it | `apps/praxis-desktop/main/e2e/appearanceSettings.spec.ts:162` |
| PT-D0CA7FE649 | appearance Settings | gradient priorities expose a picker per stop plus a direction control | `apps/praxis-desktop/main/e2e/appearanceSettings.spec.ts:177` |
| PT-AD98619129 | appearance Settings | terminal settings expose detected profiles and persist appearance preferences | `apps/praxis-desktop/main/e2e/appearanceSettings.spec.ts:190` |
| PT-AC8A2AC5A6 | appearance Settings | solid and gradient round trip through the mode toggle and survive a reload | `apps/praxis-desktop/main/e2e/appearanceSettings.spec.ts:209` |
| PT-5FBF86763F | app Shell | the Agent Hub and Workflow designer sit inside the normal app shell | `apps/praxis-desktop/main/e2e/appShell.spec.ts:59` |
| PT-F380FCD2FD | app Zoom | whole-window zoom scales the Praxis shell and supports VS Code shortcuts | `apps/praxis-desktop/main/e2e/appZoom.spec.ts:14` |
| PT-A9888638A2 | board Filters | load-more fetches the next ten for a busy status without starving the other lanes | `apps/praxis-desktop/main/e2e/boardFilters.spec.ts:31` |
| PT-41ED9F62A9 | board Filters | dropping a ticket into another lane still applies its workflow transition | `apps/praxis-desktop/main/e2e/boardFilters.spec.ts:64` |
| PT-EF38C043F4 | board Filters | dragging shows a precise insertion rule instead of highlighting a whole lane | `apps/praxis-desktop/main/e2e/boardFilters.spec.ts:96` |
| PT-7A16E887CC | board Filters | search and status filters narrow the board | `apps/praxis-desktop/main/e2e/boardFilters.spec.ts:129` |
| PT-C9A1B7EBB7 | board Filters | assignee and parent scope filters narrow the board | `apps/praxis-desktop/main/e2e/boardFilters.spec.ts:166` |
| PT-E3F2976653 | board Filters | switching boards resets hidden title-bar criteria | `apps/praxis-desktop/main/e2e/boardFilters.spec.ts:185` |
| PT-9D8E84D850 | board Issue Hierarchy | a feature clusters its children behind a collapsed stack, expanding in sequence order | `apps/praxis-desktop/main/e2e/boardIssueHierarchy.spec.ts:86` |
| PT-56EA607200 | board Issue Hierarchy | right-click moves a ticket to the top or bottom of its column, carrying a parent's children with it | `apps/praxis-desktop/main/e2e/boardIssueHierarchy.spec.ts:149` |
| PT-9CFC31F38D | board Issue Hierarchy | list view shows the same grouping and ordering | `apps/praxis-desktop/main/e2e/boardIssueHierarchy.spec.ts:174` |
| PT-371A2136C2 | board Prefs | board toolbar keeps creation actions left and icon-only tools right | `apps/praxis-desktop/main/e2e/boardPrefs.spec.ts:30` |
| PT-6EF59933BC | board Prefs | kanban keeps lane headers pinned while one canvas owns board scrolling | `apps/praxis-desktop/main/e2e/boardPrefs.spec.ts:54` |
| PT-3A02218027 | board Prefs | list view persists across relaunch | `apps/praxis-desktop/main/e2e/boardPrefs.spec.ts:100` |
| PT-8701251A63 | board Prefs | custom status color paints the column dot and persists | `apps/praxis-desktop/main/e2e/boardPrefs.spec.ts:120` |
| PT-31A820D249 | board Prefs | swim lanes group columns by assignee | `apps/praxis-desktop/main/e2e/boardPrefs.spec.ts:145` |
| PT-71E8AE1556 | board Prefs | max-age preference hides stale issues | `apps/praxis-desktop/main/e2e/boardPrefs.spec.ts:160` |
| PT-61B27019F4 | board Prefs | column visibility and order reshape the board | `apps/praxis-desktop/main/e2e/boardPrefs.spec.ts:177` |
| PT-3FBDC87E44 | board Settings File | importing a plans folder writes board.praxis.json into it | `apps/praxis-desktop/main/e2e/boardSettingsFile.spec.ts:46` |
| PT-65BD9654AD | board Settings File | editing a live-folder connection re-syncs board.praxis.json | `apps/praxis-desktop/main/e2e/boardSettingsFile.spec.ts:74` |
| PT-8B95C37D51 | brand Icons | board list shows brand artwork by default | `apps/praxis-desktop/main/e2e/brandIcons.spec.ts:26` |
| PT-36E42F0CFF | brand Icons | seeded off, board rows use the generic board-type icons | `apps/praxis-desktop/main/e2e/brandIcons.spec.ts:41` |
| PT-6F1DDF2300 | brand Icons | toggling the Board Settings artwork option swaps board icons live | `apps/praxis-desktop/main/e2e/brandIcons.spec.ts:53` |
| PT-2EA6439EB4 | brand Icons | a GitLab board row carries the GitLab brand mark | `apps/praxis-desktop/main/e2e/brandIcons.spec.ts:81` |
| PT-C1978ED838 | chat Gadgets | tool activity is grouped into one completion gadget | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:84` |
| PT-5C9F4FE628 | chat Gadgets | a long tool history is grouped into family summaries with one detail view | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:104` |
| PT-485DA32DEB | chat Gadgets | assistant Markdown renders tables and emphasis in the chat bubble | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:128` |
| PT-F693D22426 | chat Gadgets | image links and filenames render as clickable chat previews | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:164` |
| PT-4611F1236E | chat Gadgets | image artifacts render as clickable chat previews | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:203` |
| PT-879C206255 | chat Gadgets | internal memory citations stay persisted but do not render in the transcript | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:259` |
| PT-9150BEE3BB | chat Gadgets | chat producers receive the choice-gadget policy for genuine decisions | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:290` |
| PT-2217E3B9FE | chat Gadgets | Settings lists each built-in gadget with its purpose | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:309` |
| PT-2E564A2389 | chat Gadgets | a provider message asking for gadgets renders every kind in place | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:324` |
| PT-FCBFDD5937 | chat Gadgets | answering a choice records it through the ledger and leaves it answered | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:351` |
| PT-C7CABCFC69 | chat Gadgets | a second answer to the same gadget is refused, not applied twice | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:408` |
| PT-659552377A | chat Gadgets | a malformed, unknown or unsafe gadget degrades to readable text | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:442` |
| PT-F20C4A5ADE | chat Gadgets | an expired gadget says so and refuses an answer | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:469` |
| PT-AA1505255A | chat Gadgets | an action aimed at another session is refused by scope | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:507` |
| PT-A4143950C7 | chat Gadgets | gadget surfaces are keyboard reachable and carry their semantics | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:524` |
| PT-7BC7E2071E | chat Gadgets | a form will not submit until its required fields are filled | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:577` |
| PT-7134E97BD0 | chat Gadgets | a conflict gadget refuses to resolve until every side is chosen | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:594` |
| PT-59DA0C8AD7 | command Palette | opens with the shortcut, filters, and navigates on Enter | `apps/praxis-desktop/main/e2e/commandPalette.spec.ts:21` |
| PT-FA69F53102 | command Palette | closes on Escape without navigating | `apps/praxis-desktop/main/e2e/commandPalette.spec.ts:39` |
| PT-41E36CF713 | command Palette | finds a demo issue by summary text and navigates to it on Enter | `apps/praxis-desktop/main/e2e/commandPalette.spec.ts:50` |
| PT-502E0DC766 | command Palette | surfaces a settings page and opens the settings dialog | `apps/praxis-desktop/main/e2e/commandPalette.spec.ts:69` |
| PT-DE1AE73B0C | connections Manager | the new-connection form renders the per-mode field sets | `apps/praxis-desktop/main/e2e/connectionsManager.spec.ts:39` |
| PT-2AB651383F | connections Manager | saving a live folder connection auto-tracks its board | `apps/praxis-desktop/main/e2e/connectionsManager.spec.ts:94` |
| PT-53DD1D137C | connections Manager | testing an unconfigured Jira connection surfaces the stub error | `apps/praxis-desktop/main/e2e/connectionsManager.spec.ts:121` |
| PT-F00954D241 | connections Manager | saving a demo connection synthesizes its tracked board | `apps/praxis-desktop/main/e2e/connectionsManager.spec.ts:144` |
| PT-C3D6DFD5C4 | connections Manager | connection rows edit names, lock backend type, and require boards to be removed first | `apps/praxis-desktop/main/e2e/connectionsManager.spec.ts:155` |
| PT-C7D59124B0 | connections Manager | a saved GitLab API key shows as saved when the connection is re-opened | `apps/praxis-desktop/main/e2e/connectionsManager.spec.ts:184` |
| PT-4C058F707A | connections Manager | saving a Jira Cloud connection in API-token mode writes the expected on-disk shape | `apps/praxis-desktop/main/e2e/connectionsManager.spec.ts:206` |
| PT-EAE28B8DCD | connections Manager | saving a Jira Cloud connection with a BYO OAuth app writes the client id | `apps/praxis-desktop/main/e2e/connectionsManager.spec.ts:257` |
| PT-F55156EA04 | dead Connection | an unreachable connection is skipped instead of blanking the board list | `apps/praxis-desktop/main/e2e/deadConnection.spec.ts:30` |
| PT-60D8BF1214 | edit Issue | editing a live folder issue writes the priority back to markdown | `apps/praxis-desktop/main/e2e/editIssue.spec.ts:107` |
| PT-B5CC8CC324 | edit Issue | changing a folder ticket parent moves it to the selected feature | `apps/praxis-desktop/main/e2e/editIssue.spec.ts:142` |
| PT-AB88717169 | folder | folder board lists the fixture feature task | `apps/praxis-desktop/main/e2e/folder.spec.ts:62` |
| PT-842ED9B41E | folder | transitioning a live folder issue writes the new status back to markdown | `apps/praxis-desktop/main/e2e/folder.spec.ts:74` |
| PT-F6DA248F8B | folder | adding a comment on a live folder issue writes it back to markdown | `apps/praxis-desktop/main/e2e/folder.spec.ts:91` |
| PT-5B255858B0 | folder Issue Mirror Phantom Board | an issue-mirror stories/ folder next to a real plans root does not surface as its own board | `apps/praxis-desktop/main/e2e/folderIssueMirrorPhantomBoard.spec.ts:51` |
| PT-2D1F18B0CC | folder Multi | a parent folder with two plans roots lists one board per root | `apps/praxis-desktop/main/e2e/folderMulti.spec.ts:101` |
| PT-AA021C9550 | folder Multi | each board shows only its own root’s issues | `apps/praxis-desktop/main/e2e/folderMulti.spec.ts:118` |
| PT-996985A023 | git Graph | renders the visual Git graph and commit inspector | `apps/praxis-desktop/main/e2e/gitGraph.spec.ts:112` |
| PT-87E898E104 | git Graph | Refresh reloads the project repository, not the app working directory | `apps/praxis-desktop/main/e2e/gitGraph.spec.ts:204` |
| PT-2DA4C4A369 | git Graph | keeps the graph usable in a narrow reduced-motion window | `apps/praxis-desktop/main/e2e/gitGraph.spec.ts:227` |
| PT-23037916A6 | git Graph | presents a clear three-way conflict editor and saves a resolution | `apps/praxis-desktop/main/e2e/gitGraph.spec.ts:246` |
| PT-F917800DC6 | github | test connection against the mock REST server reports success | `apps/praxis-desktop/main/e2e/github.spec.ts:87` |
| PT-0CAF76F9FE | github | board renders every synthesized column with its issue | `apps/praxis-desktop/main/e2e/github.spec.ts:102` |
| PT-9C108229F6 | github | adding a comment and editing summary round-trips through the mock | `apps/praxis-desktop/main/e2e/github.spec.ts:115` |
| PT-3B749865A9 | github | moving a card to a status column adds the label and preserves unrelated labels | `apps/praxis-desktop/main/e2e/github.spec.ts:143` |
| PT-61A5FF6B13 | github | issue creation is disabled until the connection allows it | `apps/praxis-desktop/main/e2e/github.spec.ts:157` |
| PT-932B4018E4 | github | issue creation round-trips a new issue once enabled | `apps/praxis-desktop/main/e2e/github.spec.ts:167` |
| PT-902227C624 | gitlab | test connection against the mock REST server reports success | `apps/praxis-desktop/main/e2e/gitlab.spec.ts:95` |
| PT-12BB7CE87C | gitlab | board picker lists the boards the mock REST server reports | `apps/praxis-desktop/main/e2e/gitlab.spec.ts:116` |
| PT-E18BCAB4A2 | gitlab | tracked board renders issue cards and accepts a new comment via the mock | `apps/praxis-desktop/main/e2e/gitlab.spec.ts:134` |
| PT-3FFA8FE2C9 | git Onboarding | Git Graph explains that a project workspace is required | `apps/praxis-desktop/main/e2e/gitOnboarding.spec.ts:13` |
| PT-64BEE7E4CE | git Onboarding | project Git navigation opens the graph for its workspace repository | `apps/praxis-desktop/main/e2e/gitOnboarding.spec.ts:37` |
| PT-ECB4AC0EC3 | import Projects | importing a plans folder creates a folder-backed project whose board shows its markdown | `apps/praxis-desktop/main/e2e/importProjects.spec.ts:80` |
| PT-BA81D1CAC5 | import Projects | a repository with no plans content is skipped, not guessed at | `apps/praxis-desktop/main/e2e/importProjects.spec.ts:116` |
| PT-C951BA9B1E | import Projects | a repository whose plans sit outside docs/plans is still found | `apps/praxis-desktop/main/e2e/importProjects.spec.ts:131` |
| PT-BBA8B1C7D0 | import Projects | the wizard is reachable from the sidebar New menu and imports through the UI | `apps/praxis-desktop/main/e2e/importProjects.spec.ts:147` |
| PT-A3B1E13B09 | import Projects | re-scanning an imported folder flags it rather than offering it twice | `apps/praxis-desktop/main/e2e/importProjects.spec.ts:169` |
| PT-0F0FBD8AD5 | issue Detail | issue detail shows sub-tasks, linked issues, attachments and essential header actions | `apps/praxis-desktop/main/e2e/issueDetail.spec.ts:21` |
| PT-574710978E | jira | test connection against the mock MCP server reports success | `apps/praxis-desktop/main/e2e/jira.spec.ts:77` |
| PT-8342401BB6 | jira | board picker lists the boards the mock MCP server reports | `apps/praxis-desktop/main/e2e/jira.spec.ts:91` |
| PT-F0EE39C8BA | jira Auth | jiracloud api-token connection injects Authorization: Basic on every MCP request | `apps/praxis-desktop/main/e2e/jiraAuth.spec.ts:147` |
| PT-BFEB9A190C | jira Auth | jiracloud oauth connection runs the full SDK OAuth loop without a browser | `apps/praxis-desktop/main/e2e/jiraAuth.spec.ts:212` |
| PT-79B214506B | jira Auth | jiracloud oauth connection can use a pre-registered client (BYO) | `apps/praxis-desktop/main/e2e/jiraAuth.spec.ts:293` |
| PT-4B39900D85 | journey | a project created from a folder of existing plans shows them on its board | `apps/praxis-desktop/main/e2e/journey.spec.ts:133` |
| PT-580F518F3D | journey | a project created from a folder with no plans stays on app storage | `apps/praxis-desktop/main/e2e/journey.spec.ts:209` |
| PT-54F79B0024 | journey | a broken-era project record heals to folder-backed at startup | `apps/praxis-desktop/main/e2e/journey.spec.ts:239` |
| PT-209BAE8A67 | keyboard Focus | every control reached by Tab paints a visible focus ring | `apps/praxis-desktop/main/e2e/keyboardFocus.spec.ts:51` |
| PT-459F7A49D9 | keyboard Focus | the ring is themed, and pointer clicks stay quiet | `apps/praxis-desktop/main/e2e/keyboardFocus.spec.ts:73` |
| PT-8C7A4CF782 | marketplace | Add-ons panel holds only the central config and points at the per-kind panels | `apps/praxis-desktop/main/e2e/marketplace.spec.ts:133` |
| PT-713A6F0AA9 | marketplace | Themes panel: the marketplace section installs a theme into the gallery, then removes it | `apps/praxis-desktop/main/e2e/marketplace.spec.ts:153` |
| PT-E53CD33CCE | marketplace | Surfaces panel: the marketplace section installs a pack, and it can be removed from the gallery | `apps/praxis-desktop/main/e2e/marketplace.spec.ts:200` |
| PT-990BEA6576 | marketplace | Agent Runtime panel: an agent installs untrusted and only runs after trust is granted | `apps/praxis-desktop/main/e2e/marketplace.spec.ts:223` |
| PT-213CF51606 | marketplace | an unconfigured marketplace is explained inside each panel | `apps/praxis-desktop/main/e2e/marketplace.spec.ts:249` |
| PT-B98611683A | marketplace | Themes marketplace filter toggle shows All and Installed views with screenshots | `apps/praxis-desktop/main/e2e/marketplace.spec.ts:280` |
| PT-2C5A984D24 | marketplace | Marketplace loads real GitHub packages with token configured | `apps/praxis-desktop/main/e2e/marketplace.spec.ts:321` |
| PT-F027143814 | new Issue | creating a demo issue with the full field set shows it on the board | `apps/praxis-desktop/main/e2e/newIssue.spec.ts:66` |
| PT-EBCB12B9AA | new Issue | creating a live folder task under a feature writes the markdown file | `apps/praxis-desktop/main/e2e/newIssue.spec.ts:89` |
| PT-067D93638F | new Issue | live folder without allowIssueCreation shows a disabled create button with a hint | `apps/praxis-desktop/main/e2e/newIssue.spec.ts:131` |
| PT-24034BC9B8 | new Issue | the New idea button is hidden unless the preview setting is enabled | `apps/praxis-desktop/main/e2e/newIssue.spec.ts:146` |
| PT-CD33498B00 | new Issue | New idea opens the create form preset to Idea with the research transcript field | `apps/praxis-desktop/main/e2e/newIssue.spec.ts:155` |
| PT-201D18C39C | new Issue | creating a live folder idea writes the research transcript into the markdown | `apps/praxis-desktop/main/e2e/newIssue.spec.ts:182` |
| PT-55715AB01F | new Issue | the demo board offers Subtask with a required story/task/bug parent | `apps/praxis-desktop/main/e2e/newIssue.spec.ts:238` |
| PT-5870B4F60C | overview | renders the workspace overview dashboard | `apps/praxis-desktop/main/e2e/overview.spec.ts:9` |
| PT-E884FD1A67 | projects | creates a folderless Product project through the full wizard and opens its board | `apps/praxis-desktop/main/e2e/projects.spec.ts:14` |
| PT-624D8DD2F6 | projects | opens a focused Create from existing folder flow from the New menu | `apps/praxis-desktop/main/e2e/projects.spec.ts:195` |
| PT-445F9E991F | projects | a first project is three steps: type, name, review | `apps/praxis-desktop/main/e2e/projects.spec.ts:222` |
| PT-543BB59CA0 | projects | retains an existing project.praxis.md and supports local board transitions and edits | `apps/praxis-desktop/main/e2e/projects.spec.ts:251` |
| PT-E8FB985783 | projects | uses a folder connection for an existing-folder project with plans | `apps/praxis-desktop/main/e2e/projects.spec.ts:280` |
| PT-9A5E822F46 | projects | reuses an existing project record for the same folder instead of duplicating it | `apps/praxis-desktop/main/e2e/projects.spec.ts:322` |
| PT-B4A9AEAC96 | projects | rejects prohibited folderless types and new-folder collisions without changing the folder | `apps/praxis-desktop/main/e2e/projects.spec.ts:342` |
| PT-E0776B569A | projects | rolls back a newly-created folder and project.praxis.md when project persistence fails | `apps/praxis-desktop/main/e2e/projects.spec.ts:372` |
| PT-E178D1C798 | projects | rolls back the project record and created artifacts when workspace persistence fails | `apps/praxis-desktop/main/e2e/projects.spec.ts:387` |
| PT-2C18F54E60 | projects | ships deterministic workflows and five editable starters for every project type | `apps/praxis-desktop/main/e2e/projects.spec.ts:419` |
| PT-82D52D4465 | projects | a folder-backed project board is served by its folder connection | `apps/praxis-desktop/main/e2e/projects.spec.ts:431` |
| PT-EC0F2F4589 | projects | attaches a folder later and enforces one-project ownership for linked boards | `apps/praxis-desktop/main/e2e/projects.spec.ts:460` |
| PT-20E8DEA5C2 | projects | nests unlinked boards under the sidebar "Boards" heading | `apps/praxis-desktop/main/e2e/projects.spec.ts:511` |
| PT-351A726967 | projects | shows a connected board only beneath its owning Praxis project | `apps/praxis-desktop/main/e2e/projects.spec.ts:546` |
| PT-6E2027D3E8 | projects | unlinks a board that was cross-linked from another project's own connection | `apps/praxis-desktop/main/e2e/projects.spec.ts:616` |
| PT-02C7A5F8B0 | projects | an existing folder is three steps too, and confirms the detected identity | `apps/praxis-desktop/main/e2e/projects.spec.ts:653` |
| PT-3A93C1738D | projects | ticking advanced setup restores all six steps in existing-folder mode | `apps/praxis-desktop/main/e2e/projects.spec.ts:688` |
| PT-F3FE778F2D | projects | the command palette can add a project from an existing folder | `apps/praxis-desktop/main/e2e/projects.spec.ts:711` |
| PT-AAC7A98AEE | saved Workspaces | project creation requires a valid workspace and assigns the first project as default | `apps/praxis-desktop/main/e2e/savedWorkspaces.spec.ts:21` |
| PT-E4A652D7E0 | saved Workspaces | deleting the active workspace returns to Getting Started without deleting projects | `apps/praxis-desktop/main/e2e/savedWorkspaces.spec.ts:42` |
| PT-6A873CE029 | saved Workspaces | closing the active workspace returns to the Open Workspace screen | `apps/praxis-desktop/main/e2e/savedWorkspaces.spec.ts:58` |
| PT-BD6D9C8527 | saved Workspaces | Create New Workspace uses the Open Workspace screen while blank creation stays separate | `apps/praxis-desktop/main/e2e/savedWorkspaces.spec.ts:69` |
| PT-491CCAB290 | saved Workspaces | each workspace resumes at its own last route, not the other one's | `apps/praxis-desktop/main/e2e/savedWorkspaces.spec.ts:83` |
| PT-67020F5525 | settings Reset | reset to defaults asks separately before clearing saved AI session data | `apps/praxis-desktop/main/e2e/settingsReset.spec.ts:22` |
| PT-3BA46A8FF8 | settings Reset | clears app-owned project, workspace, and board data without deleting shared connections | `apps/praxis-desktop/main/e2e/settingsReset.spec.ts:36` |
| PT-9201555682 | shell Polish | output tab backfills the main-process log buffer | `apps/praxis-desktop/main/e2e/shellPolish.spec.ts:50` |
| PT-20DAB5A632 | shell Polish | output tab streams lines appended while it is open | `apps/praxis-desktop/main/e2e/shellPolish.spec.ts:62` |
| PT-C43ACAD8DC | shell Polish | selecting an issue pins a peek card above the sidebar footer | `apps/praxis-desktop/main/e2e/shellPolish.spec.ts:88` |
| PT-3DA72EF9DD | shell Polish | connection groups carry a health dot from connection checks | `apps/praxis-desktop/main/e2e/shellPolish.spec.ts:112` |
| PT-6FBE330A09 | startup Experience | first launch leads directly into creating the first project | `apps/praxis-desktop/main/e2e/startupExperience.spec.ts:13` |
| PT-C830C9989C | startup Experience | workspace setup can be skipped to the empty Praxis shell | `apps/praxis-desktop/main/e2e/startupExperience.spec.ts:34` |
| PT-1B93A7E22D | startup Experience | workspace setup offers project handoff and cancelling the wizard opens the empty shell | `apps/praxis-desktop/main/e2e/startupExperience.spec.ts:54` |
| PT-F440E4A3CF | startup Experience | walks through every workspace and project onboarding screen to a created project | `apps/praxis-desktop/main/e2e/startupExperience.spec.ts:82` |
| PT-638E30E516 | startup Experience | reopens a validated workspace and its last durable route | `apps/praxis-desktop/main/e2e/startupExperience.spec.ts:149` |
| PT-5EA9DB4BA4 | startup Experience | disabled restoration and a missing saved workspace both fail safely to Getting Started | `apps/praxis-desktop/main/e2e/startupExperience.spec.ts:171` |
| PT-734A6AC91D | startup Experience | Getting Started remains usable in a narrow reduced-motion window and light theme | `apps/praxis-desktop/main/e2e/startupExperience.spec.ts:195` |
| PT-F28949A7D1 | startup Experience | recent workspaces follow actual opens, show five, and expose View all | `apps/praxis-desktop/main/e2e/startupExperience.spec.ts:210` |
| PT-96C9B65554 | surface Packs | ships default-on with the Parchment surface over the Praxis theme | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:63` |
| PT-D3B6ABACF1 | surface Packs | the pack renders its hexagon watermark on every pane and the tile actually loads | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:74` |
| PT-49CDF1858D | surface Packs | built-in surfaces use their intended default pattern | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:90` |
| PT-E48EA1B37B | surface Packs | selecting a surface restores its default motif after a custom override | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:114` |
| PT-01F3970A62 | surface Packs | the watermark is tinted from the live theme and re-bakes when the palette changes | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:127` |
| PT-A5575F6EC6 | surface Packs | the default motif is one anchored corner mark, not wallpaper | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:144` |
| PT-AD68B83770 | surface Packs | the corner picker mirrors the motif into every selected corner | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:166` |
| PT-8A32C1FFDC | surface Packs | the motif rides over any pack, and Reset hands it back | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:209` |
| PT-AE3511C1BB | surface Packs | solid cells scatter through a super-tile rather than repeating in step | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:234` |
| PT-70E51BE580 | surface Packs | the letterpress outline is opt-in and draws a second offset line | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:258` |
| PT-38F6482663 | surface Packs | motif strength is normalised so one value reads the same on every palette | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:275` |
| PT-FADD47BAE7 | surface Packs | the startup splash carries the same watermark as the panes | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:299` |
| PT-2B568CA335 | surface Packs | the Mandelbrot motif paints as real geometry and its tile actually loads | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:332` |
| PT-C67A595CDB | surface Packs | with animation off the motif is baked complete, with no keyframes at all | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:347` |
| PT-139EBECEEC | surface Packs | Draw bakes the reveal into the motif SVG and rests on the complete mark | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:371` |
| PT-0D46EB5152 | surface Packs | Repeat is what turns a one-shot reveal into a loop | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:389` |
| PT-B23F337F10 | surface Packs | layer-family styles drive CSS and leave the motif SVG untouched | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:402` |
| PT-66D5C443AB | surface Packs | an animated motif never raises the declared strength past the contrast ceiling | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:427` |
| PT-1935F3B61F | surface Packs | the master switch stops every motif animation, whatever the style says | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:443` |
| PT-5C13E30EE9 | surface Packs | the motif rides over any pack, and animation rides over any motif | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:460` |
| PT-7F7BEA8A08 | surface Packs | switches surface pack, composing over the current theme, and persists it | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:477` |
| PT-1D825C6EA3 | surface Packs | the Intensity dial scales the texture and is disabled for Flat | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:491` |
| PT-421C9A899C | surface Packs | contrast guard: flat is inert and every pack keeps a readable panel ground | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:511` |
| PT-D670937702 | surface Packs | contrast guard: no pack pushes its watermark past a readable ceiling | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:547` |
| PT-0ABEA3D057 | surface Packs | Aurora Glass frosts the sidebar and the translucency dial collapses it | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:577` |
| PT-6BEBA0C5C1 | surface Packs | Noir is offered under a dark theme and hidden under a light one | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:621` |
| PT-9D9EE14B14 | surface Packs | a custom surface pack can be created, applied, and survives a reload | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:634` |
| PT-4D94D83CA7 | surface Packs | a user can swap the material by picking a pattern — no code, no new CSS | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:653` |
| PT-1046026F79 | surface Packs | the Window-blur toggle is present on a vibrancy-capable OS and persists | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:678` |
| PT-C8E9630E66 | surface Packs | the Texture toggle gates the grain layer without changing the pack | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:693` |
| PT-5590097221 | task Designer | designer canvas round-trips nodes, a link and zoom across view close and app relaunch | `apps/praxis-desktop/main/e2e/taskDesigner.spec.ts:79` |
| PT-05D9C84B86 | task Designer | link mode connects two items by selecting source then target | `apps/praxis-desktop/main/e2e/taskDesigner.spec.ts:162` |
| PT-2CB761CD9E | task Designer | note resize adorner sits on the item corner and resizes the outer node | `apps/praxis-desktop/main/e2e/taskDesigner.spec.ts:190` |
| PT-2BC0402306 | task Designer | designer sidebar shows board tickets, supports drag to canvas, and restores workspace on exit | `apps/praxis-desktop/main/e2e/taskDesigner.spec.ts:222` |
| PT-A9ADF6DF41 | task Designer | AI recommend flow previews an ordering and applying stacks the tickets vertically | `apps/praxis-desktop/main/e2e/taskDesigner.spec.ts:258` |
| PT-55CBD1F16D | task Designer | generate master plan writes plans/master-plan.md under the working directory | `apps/praxis-desktop/main/e2e/taskDesigner.spec.ts:298` |
| PT-98B1DBFD7A | terminal | runs a real PTY and preserves it when the panel is closed | `apps/praxis-desktop/main/e2e/terminal.spec.ts:10` |
| PT-2832CE2917 | terminal | captures shell-integrated command records and exposes failed-command actions | `apps/praxis-desktop/main/e2e/terminal.spec.ts:39` |
| PT-0D89836F29 | terminal | creates and kills terminal sessions from the panel toolbar | `apps/praxis-desktop/main/e2e/terminal.spec.ts:58` |
| PT-B16C06BF15 | terminal | opens per-terminal settings and applies an active-session override | `apps/praxis-desktop/main/e2e/terminal.spec.ts:70` |
| PT-249786566B | terminal | detects installed shell profiles and launches a selected profile | `apps/praxis-desktop/main/e2e/terminal.spec.ts:86` |
| PT-12759B4DF5 | theme Looks | ships the four built-in Looks with Parchment active | `apps/praxis-desktop/main/e2e/themeLooks.spec.ts:49` |
| PT-E667F1ABE8 | theme Looks | selecting a Look swaps theme + surface together and persists | `apps/praxis-desktop/main/e2e/themeLooks.spec.ts:57` |
| PT-3A65DBB9C9 | theme Looks | editing a dial while a Look is active is folded into that Look | `apps/praxis-desktop/main/e2e/themeLooks.spec.ts:69` |
| PT-495E7EE92F | theme Looks | Save current as Look adds a card that survives a reload | `apps/praxis-desktop/main/e2e/themeLooks.spec.ts:95` |
| PT-E63862928F | theme Looks | built-in Looks cannot be renamed or deleted, while custom Looks can | `apps/praxis-desktop/main/e2e/themeLooks.spec.ts:108` |
| PT-049E5F19E5 | theme Looks | factory appearance reset restores the theme, Look, surface, and libraries | `apps/praxis-desktop/main/e2e/themeLooks.spec.ts:127` |
| PT-1B0F699E2E | verify marketplace | VERIFY: Marketplace loads and displays real GitHub packages | `apps/praxis-desktop/main/e2e/verify-marketplace.spec.ts:10` |
| PT-A17BEBD0BC | walkthrough | walks the shell, rings each control, and remembers it was seen | `apps/praxis-desktop/main/e2e/walkthrough.spec.ts:68` |
| PT-3FCE413FDD | walkthrough | the ring is visibly not a control, and not the focus ring | `apps/praxis-desktop/main/e2e/walkthrough.spec.ts:102` |
| PT-872EAC1D71 | walkthrough | the ring never blocks the control it highlights | `apps/praxis-desktop/main/e2e/walkthrough.spec.ts:145` |
| PT-953FE9CFAB | walkthrough | Escape dismisses the tour, and that counts as seen | `apps/praxis-desktop/main/e2e/walkthrough.spec.ts:159` |
| PT-5D746924EB | walkthrough | a stop whose target disappears mid-tour is skipped, not shown empty | `apps/praxis-desktop/main/e2e/walkthrough.spec.ts:171` |
| PT-D5A9FA2834 | whats New | What's new opens over the workspace and provides version history | `apps/praxis-desktop/main/e2e/whatsNew.spec.ts:13` |
| PT-73402155F3 | workflow Agent Stage | an agent stage runs a real session and produces its declared artifact | `apps/praxis-desktop/main/e2e/workflowAgentStage.spec.ts:67` |
| PT-09CEDDAEF8 | workflow Agent Stage | an agent stage with a missing Agent Hub binding is rejected before a run or session exists | `apps/praxis-desktop/main/e2e/workflowAgentStage.spec.ts:200` |
| PT-095333D691 | workflow Build Stage | without a build stage the built product is missing in a fresh worktree, so what needs it fails | `apps/praxis-desktop/main/e2e/workflowBuildStage.spec.ts:102` |
| PT-01868F6849 | workflow Build Stage | a governed run refuses a dirty product checkout instead of testing an older committed snapshot | `apps/praxis-desktop/main/e2e/workflowBuildStage.spec.ts:110` |
| PT-E0ECD22131 | workflow Build Stage | a build stage produces the output in the run's worktree, so QA passes — and the main checkout gets none | `apps/praxis-desktop/main/e2e/workflowBuildStage.spec.ts:130` |
| PT-F75C48C431 | workflow Build Stage | a project with no build script is not failed by the build stage having nothing to say | `apps/praxis-desktop/main/e2e/workflowBuildStage.spec.ts:142` |
| PT-DC013E489D | workflow Designer | creates a workflow from a template, edits a stage in the right pane, and persists it | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:84` |
| PT-E049A4DE12 | workflow Designer | blocks save while the graph is invalid and announces the errors | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:115` |
| PT-BA2D4525C8 | workflow Designer | the canvas moves a stage with the keyboard and stays in sync with the rail | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:133` |
| PT-814CF4A563 | workflow Designer | nudging a stage past the canvas edge clamps its position instead of losing it off-screen | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:153` |
| PT-D7BA2AF937 | workflow Designer | builds an agent handoff stage from the palette and attaches a specialist skill | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:171` |
| PT-B1FCE4E164 | workflow Designer | a folder-backed project commits its workflow to .praxis/workflows and reloads it | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:196` |
| PT-C90D5C8EDD | workflow Designer | instantiating Full SDLC (.NET) identifies and installs missing agent dependencies automatically | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:247` |
| PT-9B225D3890 | workflow Designer | validates workflow connections, flow, and configuration via validate workflow button | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:272` |
| PT-4B8346DC79 | workflow Designer | clicking a connection on the canvas selects it and deletes it | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:316` |
| PT-D0F572C234 | workflow Designer | selecting a connection and pressing Delete key removes it | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:337` |
| PT-2CBC383956 | workflow Designer | clicking delete on an agent task removes it from the canvas | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:354` |
| PT-1748C28492 | workflow Designer | selecting an agent task and pressing Delete key removes it | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:368` |
| PT-2CA87FB459 | workflow Environment Pause | a registry that cannot audit pauses the run instead of failing it; siblings finish and Resume completes it | `apps/praxis-desktop/main/e2e/workflowEnvironmentPause.spec.ts:127` |
| PT-4B8D3275C8 | workflow Environment Pause | a genuine audit finding still fails the run, and the sibling it left running is stopped and recorded | `apps/praxis-desktop/main/e2e/workflowEnvironmentPause.spec.ts:176` |
| PT-F5764CCA2F | workflow Install Deps | without an install stage a fresh run worktree cannot load the dependency, so QA fails — however good the change is | `apps/praxis-desktop/main/e2e/workflowInstallDeps.spec.ts:111` |
| PT-C525D5E06F | workflow Install Deps | an install stage gives the worktree its own dependencies, QA passes, and the main checkout is left untouched | `apps/praxis-desktop/main/e2e/workflowInstallDeps.spec.ts:124` |
| PT-B0842DA89F | workflow Policy | creating a project policy from the sidebar persists it and composes it into the effective policy | `apps/praxis-desktop/main/e2e/workflowPolicy.spec.ts:50` |
| PT-9BA804745D | workflow Policy | a global policy composes strictest-wins with a project policy | `apps/praxis-desktop/main/e2e/workflowPolicy.spec.ts:77` |
| PT-5E977102C0 | workflow Run | runs the governed pipeline: parallel branches converge, then approval unlocks | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:101` |
| PT-9FE32CECFE | workflow Run | a run can be cancelled from the monitor | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:144` |
| PT-5A88D7A45B | workflow Run | completed stages are not re-run after an app restart | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:156` |
| PT-9E73225070 | workflow Run | a deterministic check runs on its own in the run worktree and unblocks approval | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:194` |
| PT-354EF7395F | workflow Run | a gate the workflow allows bypassing, but no policy has granted, explains why in the run monitor | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:282` |
| PT-0BDE1D2468 | workflow Run | approving one of two simultaneously-awaiting approval nodes never touches the other | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:397` |
| PT-5421ABC27D | workflow Run | the run monitor shows one Approve button per simultaneously-awaiting approval node, each targeting its own | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:505` |
| PT-AA73D62E79 | workflow Run | the run monitor reflects an unattended run as the orchestrator drives it | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:676` |
| PT-8EEB06754D | workflow Run | a run started against a ticket writes its outcome back as a comment once it settles | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:698` |
| PT-7CC1A86833 | workflow Run | a write-back that fails is visible in the Output tab, not just the main-process console | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:819` |
| PT-519C8E31CC | workflow Run | a check that outruns its timeout is failed with a stated reason | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:851` |
| PT-897905ACD7 | workflow Run | the stage detail panel opens a failed check’s retained log, reachable by keyboard, with an echoed secret redacted | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:870` |
| PT-718FF673F2 | workflow Run | the stage detail panel shows the empty state for a check that produced no output | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:908` |
| PT-13ACC04A37 | workflow Run Work | the delete confirm says what work the run has, and deleting the run keeps its branch by default | `apps/praxis-desktop/main/e2e/workflowRunWork.spec.ts:102` |
| PT-5CE920C30E | workflow Run Work | ticking the option deletes the run's branch and worktree too — and only those | `apps/praxis-desktop/main/e2e/workflowRunWork.spec.ts:137` |
| PT-4F95DF8F4A | workflow Run Work | cancelling the confirm deletes nothing | `apps/praxis-desktop/main/e2e/workflowRunWork.spec.ts:158` |
| PT-67CA1933D2 | workflow Run Workspace | a controller session starts a run: the run is a tree node, its stage session nests under the controller and fills the centre | `apps/praxis-desktop/main/e2e/workflowRunWorkspace.spec.ts:159` |
| PT-B6EB737E60 | workflow Run Workspace | deleting a live run cancels it first, then removes it | `apps/praxis-desktop/main/e2e/workflowRunWorkspace.spec.ts:269` |
| PT-DD166C47F2 | workflow Run Workspace | the start-run dialog opens from a workflow row with that workflow preselected, and lands on the new run | `apps/praxis-desktop/main/e2e/workflowRunWorkspace.spec.ts:295` |
| PT-59D76BB99D | workflow Run Workspace | an out-of-credits provider pauses the run instead of failing it, and resumes once credits are back | `apps/praxis-desktop/main/e2e/workflowRunWorkspace.spec.ts:313` |
| PT-5C5F154311 | workflow Run Workspace | a run in Ask mode stops the stage for a tool permission; the same run in Auto-approve mode does not | `apps/praxis-desktop/main/e2e/workflowRunWorkspace.spec.ts:380` |
| PT-05BE089E81 | workflow Run Workspace | auto-approve does not widen a stage: a read-only stage still cannot write | `apps/praxis-desktop/main/e2e/workflowRunWorkspace.spec.ts:447` |
| PT-839FD63748 | workflow Session Chips | an existing project session selects and starts governed workflows from one chat chip | `apps/praxis-desktop/main/e2e/workflowSessionChips.spec.ts:42` |
| PT-713053459D | workflow Themes | the designer and run monitor hold up on a dark theme | `apps/praxis-desktop/main/e2e/workflowThemes.spec.ts:63` |
| PT-F578B530B6 | workspace File | save and open filter on the .workspace.praxis.json extension and round-trip | `apps/praxis-desktop/main/e2e/workspaceFile.spec.ts:22` |
| PT-F32A737E1C | workspace File | creates a self-contained workspace in a chosen folder and routes its connections there | `apps/praxis-desktop/main/e2e/workspaceFile.spec.ts:68` |

## Contract shape

Every entry carries **Given / When / Then** fields in `catalog.json`. The inventory is generated from the test source, so the count and links are deterministic; the Praxis Test Author agent can enrich individual flows where a test represents an important user journey.
