# Praxis Test catalogue

This catalogue describes **706 Playwright tests** under `apps/praxis-desktop/main/e2e`. Each entry is a structured English contract linked to its exact source file and line. Run `npm run test:praxis-contracts` to detect drift before QA.

| ID | Area | Test | Automation |
| --- | --- | --- | --- |
| PT-DD79DC7C96 | agent Hub | Agent Runtime record buttons follow the app theme | `apps/praxis-desktop/main/e2e/agentHub.spec.ts:88` |
| PT-FC45EDF59E | agent Hub | Agent Runtime lists profiles and skills and opens their Agent Hub records | `apps/praxis-desktop/main/e2e/agentHub.spec.ts:132` |
| PT-D808543E8F | agent Hub | Agent Runtime settings separate AI runtimes from agent profiles, and manage standalone launch bindings | `apps/praxis-desktop/main/e2e/agentHub.spec.ts:151` |
| PT-62CDFA4F00 | agent Hub | starting, restarting, and stopping a host moves its lifecycle state | `apps/praxis-desktop/main/e2e/agentHub.spec.ts:184` |
| PT-C1ABBDD4C2 | agent Hub | activating a skill and opening a session carries the agent context | `apps/praxis-desktop/main/e2e/agentHub.spec.ts:205` |
| PT-B94DDF73DF | agent Hub | the New launch binding wizard writes a validated, discoverable manifest | `apps/praxis-desktop/main/e2e/agentHub.spec.ts:224` |
| PT-37CF86E277 | agent Hub | import validates a folder without executing it and rejects a bad manifest | `apps/praxis-desktop/main/e2e/agentHub.spec.ts:256` |
| PT-71F430C936 | agent Tree Kinds | Agent Hub is absent from the sidebar and Agent Runtime owns agent and skill options | `apps/praxis-desktop/main/e2e/agentTreeKinds.spec.ts:35` |
| PT-24D83F9928 | ai Acp Browser | an ACP session drives the in-app browser via the MCP server | `apps/praxis-desktop/main/e2e/aiAcpBrowser.spec.ts:50` |
| PT-8FEB544D20 | ai Acp Browser | the browser stays connected across a follow-up turn | `apps/praxis-desktop/main/e2e/aiAcpBrowser.spec.ts:68` |
| PT-29C3297F5E | ai Acp Browser | an unlisted host prompts on the session card, then proceeds when allowed | `apps/praxis-desktop/main/e2e/aiAcpBrowser.spec.ts:96` |
| PT-4143D95C22 | ai Acp Modes And Commands | Session Modes advertised at start switch over the live connection and update the composer | `apps/praxis-desktop/main/e2e/aiAcpModesAndCommands.spec.ts:40` |
| PT-CE3B0BEF15 | ai Acp Modes And Commands | the agent's own slash commands populate the composer and insert into the follow-up box | `apps/praxis-desktop/main/e2e/aiAcpModesAndCommands.spec.ts:72` |
| PT-50968F20CE | ai Acp Modes And Commands | context compaction is offered only when the ACP provider advertises /compact | `apps/praxis-desktop/main/e2e/aiAcpModesAndCommands.spec.ts:98` |
| PT-2BC663AF85 | ai Agent Resilience | aborting an agent that ignores cancel returns promptly | `apps/praxis-desktop/main/e2e/aiAgentResilience.spec.ts:53` |
| PT-4E0F437EDA | ai Browser | restores the selected session and browser URL and keeps an explicit close closed | `apps/praxis-desktop/main/e2e/aiBrowser.spec.ts:42` |
| PT-155F86379C | ai Browser | a full-tools session drives the in-app browser and reads the page | `apps/praxis-desktop/main/e2e/aiBrowser.spec.ts:84` |
| PT-B7CF05FBB3 | ai Browser | the toolbar navigates the in-app browser by hand | `apps/praxis-desktop/main/e2e/aiBrowser.spec.ts:132` |
| PT-3E533BE77B | ai Cli Agent Host | delegate completes a session against a real ACP agent subprocess | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:145` |
| PT-1433666F22 | ai Cli Agent Host | ACP read-only permission denial survives neutral titles, missing kinds and allow-only wire options | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:172` |
| PT-8B3835312A | ai Cli Agent Host | an Agent Hub ACP binding launches its declared host entry point | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:205` |
| PT-BB6D2FEAF8 | ai Cli Agent Host | a CLI-hosted turn shows the agent's thought in a collapsed Thought block | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:253` |
| PT-61152B8378 | ai Cli Agent Host | Codex CLI ACP updates appear as Activity with the latest update in the summary | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:271` |
| PT-56863C8E2F | ai Cli Agent Host | MCP servers the user added reach a CLI agent at session start | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:293` |
| PT-59941C287E | ai Cli Agent Host | ACP resume replay does not duplicate the previous answer into a follow-up | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:335` |
| PT-1999DA8875 | ai Cli Agent Host | a pasted image reaches an ACP agent as an image content block | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:394` |
| PT-E868E41A8C | ai Cli Agent Host | an ACP diff tool call renders as a red/green diff in the console | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:425` |
| PT-81CB515D12 | ai Cli Agent Host | ticket-selected Claude Code runs review and analysis without using Vercel | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:444` |
| PT-1868BD4BF4 | ai Cli Agent Host | an in-flight turn shows one live status line, not streamed tool blocks | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:491` |
| PT-18A9C6783D | ai Cli Agent Host | abort kills the ACP agent subprocess cleanly | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:512` |
| PT-B20B70A423 | ai Cli Agent Host | listCliModelOptions reads the real model list from session/new | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:541` |
| PT-5FE459F9D3 | ai Cli Agent Host | ACP model menus show context sizes and published pricing for model aliases | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:551` |
| PT-FCC07A19B5 | ai Cli Agent Host | delegating with a model override applies it via session/set_config_option | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:617` |
| PT-0019D9276D | ai Cli Agent Host | a CLI model reasoning default applies through ACP thought_level | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:630` |
| PT-478356E0FC | ai Cli Agent Host | a CLI agent's reply shows the turn's time, tokens, cost and model, and the session total grows | `apps/praxis-desktop/main/e2e/aiCliAgentHost.spec.ts:653` |
| PT-F9FE6B89E2 | ai Coding Task | a ticket for a one-line fix is delegated to an agent and lands on disk | `apps/praxis-desktop/main/e2e/aiCodingTask.spec.ts:36` |
| PT-41267424E7 | ai Coding Task | a read-only session cannot write the file | `apps/praxis-desktop/main/e2e/aiCodingTask.spec.ts:126` |
| PT-3CFB8F109B | ai Coding Task | each turn records its reply once, and follow-ups carry the earlier answer | `apps/praxis-desktop/main/e2e/aiCodingTask.spec.ts:172` |
| PT-8CF13E78B8 | ai Coding Task | a finished session shows its changeset and can commit it | `apps/praxis-desktop/main/e2e/aiCodingTask.spec.ts:239` |
| PT-5117CABD96 | ai Coding Task | committing a session leaves work in progress the session never touched | `apps/praxis-desktop/main/e2e/aiCodingTask.spec.ts:305` |
| PT-19FFBA78F5 | ai Coding Task | a changed file can be read whole, not just as a diff | `apps/praxis-desktop/main/e2e/aiCodingTask.spec.ts:372` |
| PT-B68CC8A647 | ai Coding Task | a single hunk can be discarded without losing the rest of the file's edits | `apps/praxis-desktop/main/e2e/aiCodingTask.spec.ts:433` |
| PT-BE2FD9BEA0 | ai Coding Task | a CLI-agent session reports no token count rather than a misleading zero | `apps/praxis-desktop/main/e2e/aiCodingTask.spec.ts:513` |
| PT-CFC3ABC6AB | ai Coding Task | an edit can be undone straight from the transcript | `apps/praxis-desktop/main/e2e/aiCodingTask.spec.ts:552` |
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
| PT-766B7E0801 | ai Mcp Servers | an API-provider session can call a tool from a user-added server | `apps/praxis-desktop/main/e2e/aiMcpServers.spec.ts:80` |
| PT-C6701FFC42 | ai Mcp Servers | a server that requires approval asks before each call, and a denial never reaches it | `apps/praxis-desktop/main/e2e/aiMcpServers.spec.ts:90` |
| PT-97563CF1B0 | ai Mcp Servers | a read-only session is never given user-added servers | `apps/praxis-desktop/main/e2e/aiMcpServers.spec.ts:101` |
| PT-83E23D12A8 | ai Mcp Servers | servers are added, tested, switched off and removed from Settings | `apps/praxis-desktop/main/e2e/aiMcpServers.spec.ts:122` |
| PT-5B702019B8 | ai Permissions | allowing a pending permission lets the session continue to completion | `apps/praxis-desktop/main/e2e/aiPermissions.spec.ts:36` |
| PT-2617964146 | ai Permissions | the composer Autopilot mode starts a CLI session without a permission pause | `apps/praxis-desktop/main/e2e/aiPermissions.spec.ts:126` |
| PT-B2588D9089 | ai Permissions | denying a pending permission is honored by the agent | `apps/praxis-desktop/main/e2e/aiPermissions.spec.ts:158` |
| PT-69E9211A87 | ai Provider | AI provider settings store the API key in the keychain and persist across relaunch | `apps/praxis-desktop/main/e2e/aiProvider.spec.ts:60` |
| PT-158157DEA6 | ai Provider | delegate streams session events over the push channel and completes against the mock gateway | `apps/praxis-desktop/main/e2e/aiProvider.spec.ts:107` |
| PT-F860463D91 | ai Provider | abort stops an in-flight session | `apps/praxis-desktop/main/e2e/aiProvider.spec.ts:179` |
| PT-34D61FAFDF | ai Provider | delegate completes against an OpenAI-provider mock (same wire format as Vercel) | `apps/praxis-desktop/main/e2e/aiProvider.spec.ts:255` |
| PT-771E4C8FAF | ai Provider | delegate completes against an Anthropic-provider mock (Messages API wire format) | `apps/praxis-desktop/main/e2e/aiProvider.spec.ts:298` |
| PT-E6E895AE5B | ai Provider | listApiModelOptions reads the real model list from the mock gateway's /v1/models | `apps/praxis-desktop/main/e2e/aiProvider.spec.ts:363` |
| PT-9AE71AF930 | ai Provider | listApiModelOptions reads Anthropic's /v1/models via x-api-key auth (not Bearer) | `apps/praxis-desktop/main/e2e/aiProvider.spec.ts:386` |
| PT-857CBE8BD0 | ai Provider | delegating with a model override sends that model in the gateway request | `apps/praxis-desktop/main/e2e/aiProvider.spec.ts:398` |
| PT-9D55F29198 | ai Provider | the New Session composer lists configured providers and can start a session on a non-default one | `apps/praxis-desktop/main/e2e/aiProvider.spec.ts:446` |
| PT-0922787177 | ai Provider | the model manager panel curates which models the composer offers | `apps/praxis-desktop/main/e2e/aiProvider.spec.ts:481` |
| PT-B6E3F16A12 | ai Provider | every provider model exposes a persisted reasoning default and composer override | `apps/praxis-desktop/main/e2e/aiProvider.spec.ts:560` |
| PT-A6D487C514 | ai Provider | delegate succeeds without a working folder in chat/conversation mode and coerces toolMode to project-only | `apps/praxis-desktop/main/e2e/aiProvider.spec.ts:609` |
| PT-8CB9FFA8F8 | ai Provider | updateSessionToolAccess attaches a working folder and elevates toolMode mid-session | `apps/praxis-desktop/main/e2e/aiProvider.spec.ts:649` |
| PT-5076A71A1F | ai Provider Catalog | the list shows only providers in use; Add provider lists the rest and adds a built-in | `apps/praxis-desktop/main/e2e/aiProviderCatalog.spec.ts:109` |
| PT-F9BECEBC0F | ai Provider Catalog | ACP settings clearly show installed and latest package versions | `apps/praxis-desktop/main/e2e/aiProviderCatalog.spec.ts:166` |
| PT-00BF5CC846 | ai Provider Catalog | a custom endpoint is tested, saved, listed with its capabilities and runs an agent session | `apps/praxis-desktop/main/e2e/aiProviderCatalog.spec.ts:204` |
| PT-185C7CB6E3 | ai Provider Catalog | an endpoint without tool calling is listed as chat only, kept out of sessions, and removable | `apps/praxis-desktop/main/e2e/aiProviderCatalog.spec.ts:275` |
| PT-5635A02231 | ai Provider Catalog | the built-in API key row keeps its buttons inside the row without overlapping | `apps/praxis-desktop/main/e2e/aiProviderCatalog.spec.ts:331` |
| PT-B7B0B106AD | ai Provider Catalog | configured providers can be removed, re-added, and replace the default while keeping one | `apps/praxis-desktop/main/e2e/aiProviderCatalog.spec.ts:343` |
| PT-EE66B0B29E | ai Provider Catalog | a custom endpoint can be the only provider and its default removal uses the chosen replacement | `apps/praxis-desktop/main/e2e/aiProviderCatalog.spec.ts:387` |
| PT-151720A16D | ai Provider Tabs | the page is split into tabs and each tab shows only its own settings | `apps/praxis-desktop/main/e2e/aiProviderTabs.spec.ts:60` |
| PT-5B34596812 | ai Provider Tabs | each provider is one row with a switch; the default and unconfigured ones cannot be switched | `apps/praxis-desktop/main/e2e/aiProviderTabs.spec.ts:88` |
| PT-5C9FEE4A22 | ai Provider Tabs | turning a provider off removes it from the composer and refuses new sessions on it; turning it on restores it | `apps/praxis-desktop/main/e2e/aiProviderTabs.spec.ts:131` |
| PT-A950D62678 | ai Provider Tabs | making another provider the default frees the previous default to be switched off | `apps/praxis-desktop/main/e2e/aiProviderTabs.spec.ts:177` |
| PT-CD171F469C | ai Provider Tabs | pressing the switch on a provider that is not set up opens its setup, and it turns on once a key is saved | `apps/praxis-desktop/main/e2e/aiProviderTabs.spec.ts:189` |
| PT-49F972B78B | ai Provider Tabs | the Recommendations provider list leaves out providers that are turned off, but keeps a chosen one visible | `apps/praxis-desktop/main/e2e/aiProviderTabs.spec.ts:219` |
| PT-16A529CAF6 | ai Session Mode | switching a finished session to Review sends the mode transition and resumes it | `apps/praxis-desktop/main/e2e/aiSessionMode.spec.ts:33` |
| PT-E5CDA49312 | ai Sessions | closing Praxis warns before interrupting an active AI session | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:100` |
| PT-391BE89930 | ai Sessions | composer selects a board and open ticket, names the session, and streams to completion | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:136` |
| PT-C5EEB040ED | ai Sessions | issue detail starts a prompted ticket session and opens its console | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:350` |
| PT-B888C57744 | ai Sessions | API session executes a tracker tool and shows the call and result inline | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:430` |
| PT-3CC04EDF51 | ai Sessions | composer surfaces the provider-not-configured error when no API key exists | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:468` |
| PT-4BA1F5064F | ai Sessions | a write_file tool call renders a red/green diff after the write is approved | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:484` |
| PT-5084A64AC6 | ai Sessions | the inspector is tabbed state, not a second copy of the conversation | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:530` |
| PT-58DC72B588 | ai Sessions | the agent's reply uses the pane it has; yours stays a reply beside it | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:584` |
| PT-CEBA29D1BE | ai Sessions | change model and handover stay unreachable while a turn is running | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:635` |
| PT-C862FEE311 | ai Sessions | the session composer model picker honours the curated enabled models | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:663` |
| PT-8B498DBD6E | ai Sessions | a completed session can edit its brief, change model, and hand over | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:729` |
| PT-E8718CE61D | ai Sessions | an opt-in conversation alternates attributed AI turns and stops at its cap | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:818` |
| PT-C4D6CE19FD | ai Sessions | a human can direct a message to either participant during an AI conversation | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:858` |
| PT-0002CA30E9 | ai Sessions | an image pasted during a conversation rides with the directed message | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:918` |
| PT-3FBB5F9EAE | ai Sessions | focus mode presents sessions as tabs and keeps them available while starting a new session | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:980` |
| PT-3849E1CAB4 | ai Sessions | session failure displays unified error banner above the chat panel and not scattered in chat | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:1038` |
| PT-E4F45D8F5D | ai Sessions | composer paste and drop carries an image to the agent and the transcript | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:1105` |
| PT-6FD9400441 | ai Sessions | a transcript attachment enlarges in a lightbox and closes on click | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:1178` |
| PT-CC6C44E927 | ai Sessions | a file dropped outside the composer never navigates the window | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:1224` |
| PT-7D4DE7FD50 | ai Sessions | a session can be archived from its row and restored from the inspector browser | `apps/praxis-desktop/main/e2e/aiSessions.spec.ts:1261` |
| PT-3B9205BF7B | ai Session Tasks | the task list updates live as the agent works through it, then settles once the turn ends | `apps/praxis-desktop/main/e2e/aiSessionTasks.spec.ts:38` |
| PT-7F852938F4 | ai Session Tasks | a fully completed plan shows all three done | `apps/praxis-desktop/main/e2e/aiSessionTasks.spec.ts:74` |
| PT-48E536B7E9 | ai Session Tasks | a session that never reports a plan shows no Tasks block at all | `apps/praxis-desktop/main/e2e/aiSessionTasks.spec.ts:91` |
| PT-74F1E91B3A | ai Session Tasks | an ACP agent reporting usage drives the context indicator and shows its cost | `apps/praxis-desktop/main/e2e/aiSessionTasks.spec.ts:108` |
| PT-21434948BE | ai Setup Wizard | an unconfigured profile must connect one provider before reaching the app | `apps/praxis-desktop/main/e2e/aiSetupWizard.spec.ts:42` |
| PT-B2538F46F4 | ai Setup Wizard | a profile that already has a usable provider never sees the wizard | `apps/praxis-desktop/main/e2e/aiSetupWizard.spec.ts:97` |
| PT-10644FFE61 | ai Spend Limit | spend well under the limit says nothing | `apps/praxis-desktop/main/e2e/aiSpendLimit.spec.ts:49` |
| PT-CB699F4EDD | ai Spend Limit | approaching the limit warns, and totals across sessions rather than per session | `apps/praxis-desktop/main/e2e/aiSpendLimit.spec.ts:60` |
| PT-642D967396 | ai Spend Limit | over the limit says so, and is honest that nothing is blocked | `apps/praxis-desktop/main/e2e/aiSpendLimit.spec.ts:80` |
| PT-F98EAD7F26 | ai Spend Limit | mixed currencies show no total rather than a meaningless one | `apps/praxis-desktop/main/e2e/aiSpendLimit.spec.ts:95` |
| PT-17F2E7A63C | ai Spend Report | totals real ACP cost and real gateway tokens, never blended, grouped by provider and connection | `apps/praxis-desktop/main/e2e/aiSpendReport.spec.ts:54` |
| PT-F4FF17FF93 | ai Spend Report | a range with no sessions shows the empty state, not an empty report | `apps/praxis-desktop/main/e2e/aiSpendReport.spec.ts:126` |
| PT-2271218D9A | ai Subagents | parent session displays subagents with status, tokens, and model across inspector, header, and agent runtime | `apps/praxis-desktop/main/e2e/aiSubagents.spec.ts:28` |
| PT-324EB0D27C | ai Thought Display Verification | reasoning streams open and settles into the same widget | `apps/praxis-desktop/main/e2e/aiThoughtDisplayVerification.spec.ts:111` |
| PT-0F440DC449 | ai Thought Display Verification | a route that cannot return reasoning says so instead of blanking | `apps/praxis-desktop/main/e2e/aiThoughtDisplayVerification.spec.ts:198` |
| PT-7039C1B532 | ai Thought Display Verification | a turn with reasoning turned off says it was not requested | `apps/praxis-desktop/main/e2e/aiThoughtDisplayVerification.spec.ts:273` |
| PT-BB8E8E328A | ai Thought Grouping | a turn that narrates between tool calls renders as one assistant card | `apps/praxis-desktop/main/e2e/aiThoughtGrouping.spec.ts:51` |
| PT-D2277F149F | ai Thought Grouping | an image read by a tool reaches the model on the next round trip | `apps/praxis-desktop/main/e2e/aiThoughtGrouping.spec.ts:152` |
| PT-78ECB0BB8B | ai Thought Grouping | a gadget in the final reply of a multi-round-trip turn still renders | `apps/praxis-desktop/main/e2e/aiThoughtGrouping.spec.ts:234` |
| PT-E2E1F64448 | ai Ticket Review | ticket reviews retain project ownership and recover older records into the project sidebar | `apps/praxis-desktop/main/e2e/aiTicketReview.spec.ts:23` |
| PT-9F30E499BC | ai Ticket Review | a review offers its findings as choices, and applying the chosen update writes the ticket | `apps/praxis-desktop/main/e2e/aiTicketReview.spec.ts:115` |
| PT-DBC8B98477 | ai Ticket Review | applying is refused when the ticket was edited after the review started | `apps/praxis-desktop/main/e2e/aiTicketReview.spec.ts:170` |
| PT-1CE803593B | ai Ticket Review | a follow-up is an ordinary turn of the review session, and the review can be posted as a comment | `apps/praxis-desktop/main/e2e/aiTicketReview.spec.ts:191` |
| PT-CCAAF11C93 | ai Ticket Review | a sloppily formatted gadget — glued fence, unescaped quote, over-long text — still renders as a gadget | `apps/praxis-desktop/main/e2e/aiTicketReview.spec.ts:218` |
| PT-C6B3CB3919 | ai Ticket Review | a gadget that cannot be repaired is asked for again, and the second attempt renders | `apps/praxis-desktop/main/e2e/aiTicketReview.spec.ts:239` |
| PT-63E4F41B94 | ai Ticket Review | an agent that never fixes its gadget is asked at most twice, not forever | `apps/praxis-desktop/main/e2e/aiTicketReview.spec.ts:250` |
| PT-76C301771C | ai Ticket Review | the review composer can queue, edit and cancel a follow-up while the reviewer is working | `apps/praxis-desktop/main/e2e/aiTicketReview.spec.ts:272` |
| PT-C813BD711A | ai Ticket Review | a queued review follow-up is sent exactly once when the current turn completes | `apps/praxis-desktop/main/e2e/aiTicketReview.spec.ts:299` |
| PT-47C95EBD35 | ai Ticket Review | the review composer pastes and drops images, removes one and sends the retained image to the agent | `apps/praxis-desktop/main/e2e/aiTicketReview.spec.ts:317` |
| PT-348197C67C | ai Ticket Review | review exposes shared runtime controls while preserving its review boundaries | `apps/praxis-desktop/main/e2e/aiTicketReview.spec.ts:349` |
| PT-4C644762B5 | ai Ticket Review | a pending read permission is answered directly in the review composer | `apps/praxis-desktop/main/e2e/aiTicketReview.spec.ts:420` |
| PT-B44F5463D3 | ai Usage Dashboard Redesign | AI Usage & Provider Fleet Dashboard renders pixel-perfect with full functionality | `apps/praxis-desktop/main/e2e/aiUsageDashboardRedesign.spec.ts:11` |
| PT-F3833555DA | ai Workflows | workflow pack picker lists discovered packs and assigns one | `apps/praxis-desktop/main/e2e/aiWorkflows.spec.ts:127` |
| PT-3269A847C9 | ai Workflows | review page streams the review markdown and posts it as a comment | `apps/praxis-desktop/main/e2e/aiWorkflows.spec.ts:157` |
| PT-2F1B96DE92 | ai Workflows | analysis uses the selected runtime and continues implementation in the same session | `apps/praxis-desktop/main/e2e/aiWorkflows.spec.ts:189` |
| PT-CB069003D1 | ai Workflows | analysis for a project ticket starts in the project folder | `apps/praxis-desktop/main/e2e/aiWorkflows.spec.ts:257` |
| PT-6099BC2E97 | ai Workflows | configured CLI agents remain available in ticket details when analysis is gated | `apps/praxis-desktop/main/e2e/aiWorkflows.spec.ts:299` |
| PT-6A6DA95A53 | ai Workflows | analysis runs through the selected OpenAI provider and model | `apps/praxis-desktop/main/e2e/aiWorkflows.spec.ts:315` |
| PT-77F4F08B13 | ai Workflows | delivery run completes and the watcher finalizes it from the DELIVERY_RESULT block | `apps/praxis-desktop/main/e2e/aiWorkflows.spec.ts:350` |
| PT-45E6380505 | ai Workflows | delivery refuses to start when the workflow is disabled in settings | `apps/praxis-desktop/main/e2e/aiWorkflows.spec.ts:382` |
| PT-2D32AEE248 | ai Workflows | feature decomposition creates the sub-task issues and lists them | `apps/praxis-desktop/main/e2e/aiWorkflows.spec.ts:395` |
| PT-A5306CD7F1 | ai Workflows | local peer review runs the three sections against the gateway | `apps/praxis-desktop/main/e2e/aiWorkflows.spec.ts:471` |
| PT-3F16D9601E | ai Workflows | merge requests list empty, then create after a delivery recorded a branch | `apps/praxis-desktop/main/e2e/aiWorkflows.spec.ts:524` |
| PT-CBE42CD885 | ai Worktree | a worktree session creates the branch + checkout and the console can remove it | `apps/praxis-desktop/main/e2e/aiWorktree.spec.ts:55` |
| PT-46C81218A5 | alibaba Coding Plan Usage | Coding Plan quota is read through the Praxis-hosted Alibaba console sign-in | `apps/praxis-desktop/main/e2e/alibabaCodingPlanUsage.spec.ts:77` |
| PT-67A9D74A51 | alibaba Provider | Alibaba Model Studio presets carry paired base URLs, key help and the Alibaba Cloud mark | `apps/praxis-desktop/main/e2e/alibabaProvider.spec.ts:9` |
| PT-142C2B7A1B | app | groups all layout toggles on the right side of the title bar | `apps/praxis-desktop/main/e2e/app.spec.ts:19` |
| PT-865C5ABA3C | app | focus mode button in titlebar is available in a session and toggles panels | `apps/praxis-desktop/main/e2e/app.spec.ts:36` |
| PT-4D5169B00E | app | Praxis section in sidebar can expand to full sidebar and restore | `apps/praxis-desktop/main/e2e/app.spec.ts:69` |
| PT-8287929558 | app | remembers which panels are open across a relaunch | `apps/praxis-desktop/main/e2e/app.spec.ts:93` |
| PT-CF9F8E1A1A | app | displays the running Praxis version in the title bar | `apps/praxis-desktop/main/e2e/app.spec.ts:110` |
| PT-2DDEE2CB06 | app | boards render on launch | `apps/praxis-desktop/main/e2e/app.spec.ts:116` |
| PT-50D9451E47 | app | normal launch does not include built-in demo data | `apps/praxis-desktop/main/e2e/app.spec.ts:123` |
| PT-2F0F85516F | app | a folder conversation without trackers does not claim to use demo boards | `apps/praxis-desktop/main/e2e/app.spec.ts:134` |
| PT-07AE341C04 | app | selecting a board renders its columns and issue cards | `apps/praxis-desktop/main/e2e/app.spec.ts:153` |
| PT-7DBFACF20E | app | opening an issue card shows the issue detail panel | `apps/praxis-desktop/main/e2e/app.spec.ts:176` |
| PT-6E62D61719 | app | adding a comment appears in the issue detail panel | `apps/praxis-desktop/main/e2e/app.spec.ts:185` |
| PT-A6199352B5 | app | closing the issue detail panel hides it | `apps/praxis-desktop/main/e2e/app.spec.ts:197` |
| PT-B7E9ACDDB7 | app | Connections is absent from the sidebar and opens through the command palette | `apps/praxis-desktop/main/e2e/app.spec.ts:205` |
| PT-9C84544990 | app | adding and removing a connection updates the list | `apps/praxis-desktop/main/e2e/app.spec.ts:214` |
| PT-BBA9C83046 | app | a returning user gets the brief splash, not the full crawl | `apps/praxis-desktop/main/e2e/app.spec.ts:239` |
| PT-0C494CCBEC | appearance Settings | opens Settings from the title bar as a dismissible popover dialog | `apps/praxis-desktop/main/e2e/appearanceSettings.spec.ts:33` |
| PT-554DF61623 | appearance Settings | theme gallery previews and persists the selected complete palette | `apps/praxis-desktop/main/e2e/appearanceSettings.spec.ts:44` |
| PT-E7281D960A | appearance Settings | persists the selected theme and mode through app settings | `apps/praxis-desktop/main/e2e/appearanceSettings.spec.ts:70` |
| PT-7FCBAD6580 | appearance Settings | startup splash inherits the saved app theme | `apps/praxis-desktop/main/e2e/appearanceSettings.spec.ts:83` |
| PT-77C9928C26 | appearance Settings | installs a marketplace theme and makes it available on reload | `apps/praxis-desktop/main/e2e/appearanceSettings.spec.ts:153` |
| PT-33995E247F | appearance Settings | creates a custom theme with editable colors and persists it | `apps/praxis-desktop/main/e2e/appearanceSettings.spec.ts:242` |
| PT-D0CA7FE649 | appearance Settings | gradient priorities expose a picker per stop plus a direction control | `apps/praxis-desktop/main/e2e/appearanceSettings.spec.ts:257` |
| PT-AD98619129 | appearance Settings | terminal settings expose detected profiles and persist appearance preferences | `apps/praxis-desktop/main/e2e/appearanceSettings.spec.ts:270` |
| PT-AC8A2AC5A6 | appearance Settings | solid and gradient round trip through the mode toggle and survive a reload | `apps/praxis-desktop/main/e2e/appearanceSettings.spec.ts:289` |
| PT-FC37B447BF | app Shell | agent records and the Workflow designer sit inside the normal app shell | `apps/praxis-desktop/main/e2e/appShell.spec.ts:59` |
| PT-F380FCD2FD | app Zoom | whole-window zoom scales the Praxis shell and supports VS Code shortcuts | `apps/praxis-desktop/main/e2e/appZoom.spec.ts:14` |
| PT-002739DAF5 | app Zoom | zoom setting is preserved across app restart | `apps/praxis-desktop/main/e2e/appZoom.spec.ts:33` |
| PT-396814BC61 | assistant | ⌘J summons the floating assistant; pin docks it, keeping the conversation | `apps/praxis-desktop/main/e2e/assistant.spec.ts:78` |
| PT-DA3DC9B1D8 | assistant | floating assistant drags by its header and resizes from its corner | `apps/praxis-desktop/main/e2e/assistant.spec.ts:105` |
| PT-161D626D8D | assistant | assistant composer selects provider, model, reasoning, and permission mode for the next turn | `apps/praxis-desktop/main/e2e/assistant.spec.ts:135` |
| PT-99F1FB5440 | assistant | assistant composer collapses and animates its border while the team replies | `apps/praxis-desktop/main/e2e/assistant.spec.ts:208` |
| PT-6BF3BFEE6B | assistant | an image can be dropped or pasted into the assistant composer and is sent with the turn | `apps/praxis-desktop/main/e2e/assistant.spec.ts:240` |
| PT-B21CE8C307 | assistant | assistant full tools uses the selected working folder through an agent session | `apps/praxis-desktop/main/e2e/assistant.spec.ts:270` |
| PT-567A553B13 | assistant | an @mention routes to that persona and transcript suggestions are read-only | `apps/praxis-desktop/main/e2e/assistant.spec.ts:299` |
| PT-746D1BA14C | assistant | selected team members reply in order, then the selected lead synthesises | `apps/praxis-desktop/main/e2e/assistant.spec.ts:331` |
| PT-3412C6D2C6 | assistant | deselecting every seat sends a general chat to the Tech Lead | `apps/praxis-desktop/main/e2e/assistant.spec.ts:353` |
| PT-450D784024 | assistant | page context follows navigation, can be detached, and chats persist in the tree | `apps/praxis-desktop/main/e2e/assistant.spec.ts:365` |
| PT-9ADE9F9E42 | assistant | an update-ticket proposal is informational and has no transcript controls | `apps/praxis-desktop/main/e2e/assistant.spec.ts:426` |
| PT-E27C5BEA0C | assistant | a create-subtask proposal does not create a task without a composer send | `apps/praxis-desktop/main/e2e/assistant.spec.ts:443` |
| PT-B8B9837347 | assistant | an update-workflow proposal is informational and leaves the workflow unchanged | `apps/praxis-desktop/main/e2e/assistant.spec.ts:457` |
| PT-A62081453E | assistant | Git changes context carries the file list and the diff hunks | `apps/praxis-desktop/main/e2e/assistant.spec.ts:496` |
| PT-6BA3D0980D | assistant | a chat can be renamed, survives an app restart, and the docked width persists | `apps/praxis-desktop/main/e2e/assistant.spec.ts:515` |
| PT-5E8DFAD0E8 | assistant | the assistant IPC reports a missing provider as an error message, not a crash | `apps/praxis-desktop/main/e2e/assistant.spec.ts:554` |
| PT-C9FF04A5E3 | assistant | every persona renders with its own distinct colour and a readable badge | `apps/praxis-desktop/main/e2e/assistant.spec.ts:573` |
| PT-6CF9CAE63A | assistant | the assistant's controls show a focus ring and carry tooltips | `apps/praxis-desktop/main/e2e/assistant.spec.ts:590` |
| PT-D850AA5BDC | assistant | the assistant stays readable on every theme and surface pack | `apps/praxis-desktop/main/e2e/assistant.spec.ts:654` |
| PT-C34A6897DE | assistant | the composer grows with its text up to the shared cap, then scrolls | `apps/praxis-desktop/main/e2e/assistant.spec.ts:745` |
| PT-0000309442 | auto Update | an unpackaged build reports that updates are unsupported and offers no check | `apps/praxis-desktop/main/e2e/autoUpdate.spec.ts:22` |
| PT-24D162FA28 | auto Update | shows download progress, then offers a restart once the update is ready | `apps/praxis-desktop/main/e2e/autoUpdate.spec.ts:32` |
| PT-92B7424B04 | auto Update | an update this build cannot install links to the release page | `apps/praxis-desktop/main/e2e/autoUpdate.spec.ts:48` |
| PT-CC54F83A0D | background Tasks | background completion arrives after the turn, updates the session, and notifies once | `apps/praxis-desktop/main/e2e/backgroundTasks.spec.ts:26` |
| PT-B61A27A5EB | background Tasks | background failure is reported after the foreground reply | `apps/praxis-desktop/main/e2e/backgroundTasks.spec.ts:69` |
| PT-0D80392F88 | background Tasks | a lost background connection becomes unknown rather than completed | `apps/praxis-desktop/main/e2e/backgroundTasks.spec.ts:71` |
| PT-FE74B5E007 | background Tasks | native subagent completion is distinct from successful spawn | `apps/praxis-desktop/main/e2e/backgroundTasks.spec.ts:73` |
| PT-A1760EEA2F | background Tasks | AIR child completion and its result reach the owning session separately from the parent transcript | `apps/praxis-desktop/main/e2e/backgroundTasks.spec.ts:75` |
| PT-A9058D99D0 | background Tasks | a direct API agent shell process reports its exit after the AI reply without inventing success | `apps/praxis-desktop/main/e2e/backgroundTasks.spec.ts:78` |
| PT-E3A403D47C | bifrost Provider | Bifrost preset saves a virtual key and runs a streamed session on its exact endpoint | `apps/praxis-desktop/main/e2e/bifrostProvider.spec.ts:7` |
| PT-A9888638A2 | board Filters | load-more fetches the next ten for a busy status without starving the other lanes | `apps/praxis-desktop/main/e2e/boardFilters.spec.ts:32` |
| PT-41ED9F62A9 | board Filters | dropping a ticket into another lane still applies its workflow transition | `apps/praxis-desktop/main/e2e/boardFilters.spec.ts:65` |
| PT-EF38C043F4 | board Filters | dragging shows a precise insertion rule instead of highlighting a whole lane | `apps/praxis-desktop/main/e2e/boardFilters.spec.ts:97` |
| PT-7A16E887CC | board Filters | search and status filters narrow the board | `apps/praxis-desktop/main/e2e/boardFilters.spec.ts:130` |
| PT-C9A1B7EBB7 | board Filters | assignee and parent scope filters narrow the board | `apps/praxis-desktop/main/e2e/boardFilters.spec.ts:167` |
| PT-E3F2976653 | board Filters | switching boards resets hidden title-bar criteria | `apps/praxis-desktop/main/e2e/boardFilters.spec.ts:186` |
| PT-9D8E84D850 | board Issue Hierarchy | a feature clusters its children behind a collapsed stack, expanding in sequence order | `apps/praxis-desktop/main/e2e/boardIssueHierarchy.spec.ts:86` |
| PT-D16D9ED705 | board Issue Hierarchy | task children in the same column are grouped like story children (parent-child grouping by parentKey) | `apps/praxis-desktop/main/e2e/boardIssueHierarchy.spec.ts:149` |
| PT-56EA607200 | board Issue Hierarchy | right-click moves a ticket to the top or bottom of its column, carrying a parent's children with it | `apps/praxis-desktop/main/e2e/boardIssueHierarchy.spec.ts:186` |
| PT-9CFC31F38D | board Issue Hierarchy | list view shows the same grouping and ordering | `apps/praxis-desktop/main/e2e/boardIssueHierarchy.spec.ts:211` |
| PT-4160DBB887 | board Issue Hierarchy | grouping by parentKey prevents regression (collapsed stacks hide children) | `apps/praxis-desktop/main/e2e/boardIssueHierarchy.spec.ts:244` |
| PT-46BD39C955 | board Issue Hierarchy | children must have parentKey set to be grouped | `apps/praxis-desktop/main/e2e/boardIssueHierarchy.spec.ts:274` |
| PT-463F325286 | board Issue Hierarchy | parent shows child count badge only when there are children | `apps/praxis-desktop/main/e2e/boardIssueHierarchy.spec.ts:297` |
| PT-371A2136C2 | board Prefs | board toolbar keeps creation actions left and icon-only tools right | `apps/praxis-desktop/main/e2e/boardPrefs.spec.ts:31` |
| PT-6EF59933BC | board Prefs | kanban keeps lane headers pinned while one canvas owns board scrolling | `apps/praxis-desktop/main/e2e/boardPrefs.spec.ts:55` |
| PT-3A02218027 | board Prefs | list view persists across relaunch | `apps/praxis-desktop/main/e2e/boardPrefs.spec.ts:101` |
| PT-8701251A63 | board Prefs | custom status color paints the column dot and persists | `apps/praxis-desktop/main/e2e/boardPrefs.spec.ts:121` |
| PT-31A820D249 | board Prefs | swim lanes group columns by assignee | `apps/praxis-desktop/main/e2e/boardPrefs.spec.ts:146` |
| PT-71E8AE1556 | board Prefs | max-age preference hides stale issues | `apps/praxis-desktop/main/e2e/boardPrefs.spec.ts:161` |
| PT-61B27019F4 | board Prefs | column visibility and order reshape the board | `apps/praxis-desktop/main/e2e/boardPrefs.spec.ts:178` |
| PT-3FBDC87E44 | board Settings File | importing a plans folder writes board.praxis.json into it | `apps/praxis-desktop/main/e2e/boardSettingsFile.spec.ts:46` |
| PT-65BD9654AD | board Settings File | editing a live-folder connection re-syncs board.praxis.json | `apps/praxis-desktop/main/e2e/boardSettingsFile.spec.ts:74` |
| PT-8B95C37D51 | brand Icons | board list shows brand artwork by default | `apps/praxis-desktop/main/e2e/brandIcons.spec.ts:26` |
| PT-36E42F0CFF | brand Icons | seeded off, board rows use the generic board-type icons | `apps/praxis-desktop/main/e2e/brandIcons.spec.ts:41` |
| PT-6F1DDF2300 | brand Icons | toggling the Board Settings artwork option swaps board icons live | `apps/praxis-desktop/main/e2e/brandIcons.spec.ts:53` |
| PT-2EA6439EB4 | brand Icons | a GitLab board row carries the GitLab brand mark | `apps/praxis-desktop/main/e2e/brandIcons.spec.ts:81` |
| PT-AB6D51C637 | cancel Turn.live | cancelling a real Claude Code turn stops the command it is running | `apps/praxis-desktop/main/e2e/cancelTurn.live.spec.ts:31` |
| PT-81B07770E0 | cancel Turn | cancelling a CLI agent mid-request stops it and the commands it started | `apps/praxis-desktop/main/e2e/cancelTurn.spec.ts:55` |
| PT-08753BF835 | cancel Turn | a CLI agent that ignores the cancel is stopped anyway, commands included | `apps/praxis-desktop/main/e2e/cancelTurn.spec.ts:66` |
| PT-9A77416629 | cancel Turn | a follow-up cancelled while the CLI agent is still starting is never delivered | `apps/praxis-desktop/main/e2e/cancelTurn.spec.ts:78` |
| PT-7883F80124 | cancel Turn | cancelling an API agent stops the shell command it is running and its next step | `apps/praxis-desktop/main/e2e/cancelTurn.spec.ts:121` |
| PT-AE5ED7A305 | chat Code Intel Badge | a turn that used code intelligence shows a lowercase badge without a count | `apps/praxis-desktop/main/e2e/chatCodeIntelBadge.spec.ts:38` |
| PT-9F4944C1D2 | chat Code Intel Badge | an ACP MCP call reported completed first still shows the code intelligence badge | `apps/praxis-desktop/main/e2e/chatCodeIntelBadge.spec.ts:81` |
| PT-C1978ED838 | chat Gadgets | tool activity is grouped into one completion gadget | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:87` |
| PT-5C9F4FE628 | chat Gadgets | a long tool history is grouped into family summaries with one detail view | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:107` |
| PT-485DA32DEB | chat Gadgets | assistant Markdown renders tables and emphasis in the chat bubble | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:131` |
| PT-F693D22426 | chat Gadgets | image links and filenames render as clickable chat previews | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:167` |
| PT-4611F1236E | chat Gadgets | image artifacts render as clickable chat previews | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:206` |
| PT-81AFCEE43F | chat Gadgets | artifact gadget renders handover metadata and item category badges | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:262` |
| PT-DC8F7E7093 | chat Gadgets | HTML artifacts open in an isolated in-app preview | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:330` |
| PT-879C206255 | chat Gadgets | internal memory citations stay persisted but do not render in the transcript | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:394` |
| PT-9150BEE3BB | chat Gadgets | chat producers receive the choice-gadget policy for genuine decisions | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:427` |
| PT-2217E3B9FE | chat Gadgets | Settings lists each built-in gadget with its purpose | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:446` |
| PT-2E564A2389 | chat Gadgets | a provider message asking for gadgets renders every kind in place | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:461` |
| PT-FCBFDD5937 | chat Gadgets | answering a choice records it through the ledger and leaves it answered | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:488` |
| PT-C7CABCFC69 | chat Gadgets | a second answer to the same gadget is refused, not applied twice | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:556` |
| PT-659552377A | chat Gadgets | a malformed, unknown or unsafe gadget degrades to readable text | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:590` |
| PT-F20C4A5ADE | chat Gadgets | an expired gadget says so and refuses an answer | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:617` |
| PT-AA1505255A | chat Gadgets | an action aimed at another session is refused by scope | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:655` |
| PT-A4143950C7 | chat Gadgets | gadget surfaces are keyboard reachable and carry their semantics | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:672` |
| PT-7BC7E2071E | chat Gadgets | a form will not submit until its required fields are filled | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:725` |
| PT-7134E97BD0 | chat Gadgets | a conflict gadget refuses to resolve until every side is chosen | `apps/praxis-desktop/main/e2e/chatGadgets.spec.ts:742` |
| PT-92A2628B78 | chat Links | markdown, autolink and bare URLs open in the in-app browser; file names stay plain text | `apps/praxis-desktop/main/e2e/chatLinks.spec.ts:45` |
| PT-9EFD52ABD4 | chat Links | a link to a private host is refused with a visible reason | `apps/praxis-desktop/main/e2e/chatLinks.spec.ts:76` |
| PT-3EDDE51138 | chat Project Assignment.visual | assign chat picker and project session placement | `apps/praxis-desktop/main/e2e/chatProjectAssignment.visual.spec.ts:16` |
| PT-CDB77B83E7 | chat Project Assignment.visual | assign chat ticket field lists tickets for a folder-backed project | `apps/praxis-desktop/main/e2e/chatProjectAssignment.visual.spec.ts:111` |
| PT-DCF22F6C16 | code Intelligence | rebuild and relocation use the themed recovery flow and refresh status | `apps/praxis-desktop/main/e2e/codeIntelligence.spec.ts:84` |
| PT-E62E1E2707 | code Intelligence | semantic search card shows status, allows downloading model, and deleting model | `apps/praxis-desktop/main/e2e/codeIntelligence.spec.ts:104` |
| PT-5BF47317FF | code Intelligence | model details show the pinned model read-only once installed | `apps/praxis-desktop/main/e2e/codeIntelligence.spec.ts:138` |
| PT-78118CB321 | code Intelligence | an earlier model on disk is offered as an update, and updating activates semantic search | `apps/praxis-desktop/main/e2e/codeIntelligence.spec.ts:158` |
| PT-7FCFECEB42 | code Intelligence | code intelligence panel maintains accessibility in light and dark modes | `apps/praxis-desktop/main/e2e/codeIntelligence.spec.ts:171` |
| PT-3B358AC6C4 | code Intelligence | factory reset clears repositories and resets code intelligence | `apps/praxis-desktop/main/e2e/codeIntelligence.spec.ts:191` |
| PT-5B3236513C | code Intelligence | overview section provides reset code intelligence to factory defaults | `apps/praxis-desktop/main/e2e/codeIntelligence.spec.ts:209` |
| PT-CF6B30DD7E | code Intelligence Model Activation | a repository registered after the model is installed gets semantic search | `apps/praxis-desktop/main/e2e/codeIntelligenceModelActivation.spec.ts:66` |
| PT-CE78AF73E1 | code Intelligence Model Activation | a repository indexed without the model is caught up when the app starts | `apps/praxis-desktop/main/e2e/codeIntelligenceModelActivation.spec.ts:79` |
| PT-7FB8C6A6FF | code Intelligence Native | packaged service supports desktop search, source navigation and repository recovery | `apps/praxis-desktop/main/e2e/codeIntelligenceNative.spec.ts:10` |
| PT-E0C72B383E | code Intelligence Service | settings shows the service and can stop, start and restart it | `apps/praxis-desktop/main/e2e/codeIntelligenceService.spec.ts:50` |
| PT-EE63B08817 | code Intelligence Service | app launch replaces a service left running by another build | `apps/praxis-desktop/main/e2e/codeIntelligenceService.spec.ts:89` |
| PT-3026C05A2E | code Search Dialog | opens code search from command palette, searches symbols, and displays source and usages | `apps/praxis-desktop/main/e2e/codeSearchDialog.spec.ts:133` |
| PT-DB30AC0DD5 | code Search Dialog | opens code search via shortcut ControlOrMeta+Shift+F and from session code intel chip | `apps/praxis-desktop/main/e2e/codeSearchDialog.spec.ts:205` |
| PT-F61652F676 | code Search Layout | every result row is the full list width and the same height | `apps/praxis-desktop/main/e2e/codeSearchLayout.spec.ts:68` |
| PT-231C55EEB1 | code Search Layout | changing the mode searches again and the dialog reports fallback and coverage | `apps/praxis-desktop/main/e2e/codeSearchLayout.spec.ts:98` |
| PT-0724A8103E | code Search Layout | while the semantic index builds only keyword search is offered, and hybrid returns when it is ready | `apps/praxis-desktop/main/e2e/codeSearchLayout.spec.ts:126` |
| PT-A2B456E947 | code Search Layout | a page trimmed to the response budget offers Show more instead of a cursor note | `apps/praxis-desktop/main/e2e/codeSearchLayout.spec.ts:189` |
| PT-3C60A499B5 | code Search Modes | keyword, semantic and hybrid each find what they should with the real model | `apps/praxis-desktop/main/e2e/codeSearchModes.spec.ts:89` |
| PT-63AC1BD157 | code Search Modes | without a model, only keyword search is offered and the dialog says why | `apps/praxis-desktop/main/e2e/codeSearchModes.spec.ts:126` |
| PT-59DA0C8AD7 | command Palette | opens with the shortcut, filters, and navigates on Enter | `apps/praxis-desktop/main/e2e/commandPalette.spec.ts:21` |
| PT-FA69F53102 | command Palette | closes on Escape without navigating | `apps/praxis-desktop/main/e2e/commandPalette.spec.ts:39` |
| PT-41E36CF713 | command Palette | finds a demo issue by summary text and navigates to it on Enter | `apps/praxis-desktop/main/e2e/commandPalette.spec.ts:50` |
| PT-502E0DC766 | command Palette | surfaces a settings page and opens the settings dialog | `apps/praxis-desktop/main/e2e/commandPalette.spec.ts:69` |
| PT-13EFC73594 | composer Code Intelligence | composer code intelligence control shows in new session, toggles preferences, and inspects status | `apps/praxis-desktop/main/e2e/composerCodeIntelligence.spec.ts:11` |
| PT-6669BC1F99 | composer Code Intelligence | virtual team assistant composer displays code intelligence chip and control | `apps/praxis-desktop/main/e2e/composerCodeIntelligence.spec.ts:74` |
| PT-82655C5AB5 | composer Code Intelligence | existing session follow-up composer shows code intelligence chip and status | `apps/praxis-desktop/main/e2e/composerCodeIntelligence.spec.ts:91` |
| PT-9E73125D69 | composer Code Intelligence | composer code intelligence chip allows searching directly and changing search mode | `apps/praxis-desktop/main/e2e/composerCodeIntelligence.spec.ts:128` |
| PT-4BA2448F9C | composer Model Configuration | composer model settings curate provider chips and preserve the conversation draft | `apps/praxis-desktop/main/e2e/composerModelConfiguration.spec.ts:18` |
| PT-2E55D7925C | composer Model Configuration | an existing session configures its selected provider rather than the app default | `apps/praxis-desktop/main/e2e/composerModelConfiguration.spec.ts:90` |
| PT-B902DE0E5F | composer Model Configuration | model search stays fixed when scrolling models in the model menu and manager | `apps/praxis-desktop/main/e2e/composerModelConfiguration.spec.ts:127` |
| PT-C4C9115D0B | composer Provider Brand Icons | the new-session composer lists providers with their brand logo, not a glyph | `apps/praxis-desktop/main/e2e/composerProviderBrandIcons.spec.ts:40` |
| PT-0229E7D2BF | composer Provider Brand Icons | the composer provider chip keeps the brand logo after a choice | `apps/praxis-desktop/main/e2e/composerProviderBrandIcons.spec.ts:56` |
| PT-EAA442BBB4 | composer Provider Brand Icons | Settings' provider row names its provider in text, so the logo beside it stays decorative | `apps/praxis-desktop/main/e2e/composerProviderBrandIcons.spec.ts:67` |
| PT-DE1AE73B0C | connections Manager | the new-connection form renders the per-mode field sets | `apps/praxis-desktop/main/e2e/connectionsManager.spec.ts:43` |
| PT-2AB651383F | connections Manager | saving a live folder connection auto-tracks its board | `apps/praxis-desktop/main/e2e/connectionsManager.spec.ts:98` |
| PT-53DD1D137C | connections Manager | testing an unconfigured Jira connection surfaces the stub error | `apps/praxis-desktop/main/e2e/connectionsManager.spec.ts:127` |
| PT-F00954D241 | connections Manager | saving a demo connection synthesizes its tracked board | `apps/praxis-desktop/main/e2e/connectionsManager.spec.ts:150` |
| PT-C3D6DFD5C4 | connections Manager | connection rows edit names, lock backend type, and require boards to be removed first | `apps/praxis-desktop/main/e2e/connectionsManager.spec.ts:161` |
| PT-C7D59124B0 | connections Manager | a saved GitLab API key shows as saved when the connection is re-opened | `apps/praxis-desktop/main/e2e/connectionsManager.spec.ts:190` |
| PT-4C058F707A | connections Manager | saving a Jira Cloud connection in API-token mode writes the expected on-disk shape | `apps/praxis-desktop/main/e2e/connectionsManager.spec.ts:212` |
| PT-EAE28B8DCD | connections Manager | saving a Jira Cloud connection with a BYO OAuth app writes the client id | `apps/praxis-desktop/main/e2e/connectionsManager.spec.ts:263` |
| PT-4D8075BFEA | coordination | a file another session holds is not written; recovery is a person's call, then the fix lands | `apps/praxis-desktop/main/e2e/coordination.spec.ts:48` |
| PT-761127B80B | coordination Wait | an agent refused a held file waits for it once, is woken when it is released, and then writes | `apps/praxis-desktop/main/e2e/coordinationWait.spec.ts:58` |
| PT-8B10456AD1 | coordination Wait | a server an agent left running stays claimed after its turn, and Stop in the inspector ends it | `apps/praxis-desktop/main/e2e/coordinationWait.spec.ts:112` |
| PT-FEA2A13581 | coordination Wait | a person clicking in the in-app browser takes it from the agent driving it | `apps/praxis-desktop/main/e2e/coordinationWait.spec.ts:147` |
| PT-3DF668A3C4 | css Tokens | --border-subtle follows the theme border and --radius-xs scales with the display | `apps/praxis-desktop/main/e2e/cssTokens.spec.ts:13` |
| PT-F55156EA04 | dead Connection | an unreachable connection is skipped instead of blanking the board list | `apps/praxis-desktop/main/e2e/deadConnection.spec.ts:30` |
| PT-842B523925 | easymode | default sidebar is standard when enableEasyMode is false | `apps/praxis-desktop/main/e2e/easymode.spec.ts:29` |
| PT-E4A09A92CD | easymode | toggling EasyMode in settings switches to EasyModeSidebar | `apps/praxis-desktop/main/e2e/easymode.spec.ts:39` |
| PT-3403539E7A | easymode | EasyMode sidebar renders Sessions and Automations with + buttons and handles selection and navigation | `apps/praxis-desktop/main/e2e/easymode.spec.ts:71` |
| PT-78A9780217 | easymode | toggling EasyMode via titlebar button switches between standard sidebar and EasyModeSidebar | `apps/praxis-desktop/main/e2e/easymode.spec.ts:346` |
| PT-594C7ED7EF | easymode | opening a folder from Getting Started enables EasyMode | `apps/praxis-desktop/main/e2e/easymode.spec.ts:375` |
| PT-3B8F38ED21 | easymode | opening a folder from TitleBar workspace menu enables EasyMode | `apps/praxis-desktop/main/e2e/easymode.spec.ts:407` |
| PT-E864C7EB0E | easymode | global keyboard shortcut Cmd+Shift+E / Ctrl+Shift+E toggles EasyMode | `apps/praxis-desktop/main/e2e/easymode.spec.ts:436` |
| PT-F2FE06D85F | easymode | EasyMode canvas renders on project root with prompt hero, starter chips, and theme switch | `apps/praxis-desktop/main/e2e/easymode.spec.ts:457` |
| PT-3960246515 | easymode | EasyMode sidebar displays onboarding empty cards when lists are empty | `apps/praxis-desktop/main/e2e/easymode.spec.ts:497` |
| PT-8B7CA7EEE6 | easymode | EasyMode session card displays live ticker, hover actions, and automations show stage badge | `apps/praxis-desktop/main/e2e/easymode.spec.ts:521` |
| PT-797C06EBE5 | easymode | opening a folder in EasyMode scopes sessions to that folder and excludes unrelated sessions | `apps/praxis-desktop/main/e2e/easymode.spec.ts:642` |
| PT-8C982E7F97 | easymode | automation stage sessions appear nested under automation and are excluded from sessions list | `apps/praxis-desktop/main/e2e/easymode.spec.ts:739` |
| PT-ED816D0823 | easymode | automation rows have rename, archive, delete and run actions like a session row | `apps/praxis-desktop/main/e2e/easymode.spec.ts:874` |
| PT-C7547B818D | easymode | classic mode: automation stage sessions appear nested under automation run and are excluded from sessions tree | `apps/praxis-desktop/main/e2e/easymode.spec.ts:974` |
| PT-D6E1059F2C | easymode | in EasyMode selecting a session opens details in the center | `apps/praxis-desktop/main/e2e/easymode.spec.ts:1104` |
| PT-2516802E6F | easymode | capture visual verification of redesigned EasyMode sidebar in real Electron app | `apps/praxis-desktop/main/e2e/easymode.spec.ts:1277` |
| PT-21C54F260E | easymode | a long session list folds behind "Show more" and leaves the Runs section on screen | `apps/praxis-desktop/main/e2e/easymode.spec.ts:1499` |
| PT-BD3466D9E5 | easymode | easy mode has no filter tabs and unfinished sessions beyond the first five stay visible | `apps/praxis-desktop/main/e2e/easymode.spec.ts:1645` |
| PT-60D8BF1214 | edit Issue | editing a live folder issue writes the priority back to markdown | `apps/praxis-desktop/main/e2e/editIssue.spec.ts:108` |
| PT-B5CC8CC324 | edit Issue | changing a folder ticket parent moves it to the selected feature | `apps/praxis-desktop/main/e2e/editIssue.spec.ts:143` |
| PT-AB88717169 | folder | folder board lists the fixture feature task | `apps/praxis-desktop/main/e2e/folder.spec.ts:64` |
| PT-842ED9B41E | folder | transitioning a live folder issue writes the new status back to markdown | `apps/praxis-desktop/main/e2e/folder.spec.ts:76` |
| PT-F6DA248F8B | folder | adding a comment on a live folder issue writes it back to markdown | `apps/praxis-desktop/main/e2e/folder.spec.ts:93` |
| PT-5B255858B0 | folder Issue Mirror Phantom Board | an issue-mirror stories/ folder next to a real plans root does not surface as its own board | `apps/praxis-desktop/main/e2e/folderIssueMirrorPhantomBoard.spec.ts:51` |
| PT-2D1F18B0CC | folder Multi | a parent folder with two plans roots lists one board per root | `apps/praxis-desktop/main/e2e/folderMulti.spec.ts:101` |
| PT-AA021C9550 | folder Multi | each board shows only its own root’s issues | `apps/praxis-desktop/main/e2e/folderMulti.spec.ts:118` |
| PT-B11747EA92 | folder Multi | a secondary plans root disables New issue up front and says why | `apps/praxis-desktop/main/e2e/folderMulti.spec.ts:160` |
| PT-996985A023 | git Graph | renders the visual Git graph and commit inspector | `apps/praxis-desktop/main/e2e/gitGraph.spec.ts:113` |
| PT-87E898E104 | git Graph | Refresh reloads the project repository, not the app working directory | `apps/praxis-desktop/main/e2e/gitGraph.spec.ts:205` |
| PT-2DA4C4A369 | git Graph | keeps the graph usable in a narrow reduced-motion window | `apps/praxis-desktop/main/e2e/gitGraph.spec.ts:228` |
| PT-23037916A6 | git Graph | presents a clear three-way conflict editor and saves a resolution | `apps/praxis-desktop/main/e2e/gitGraph.spec.ts:247` |
| PT-F917800DC6 | github | test connection against the mock REST server reports success | `apps/praxis-desktop/main/e2e/github.spec.ts:89` |
| PT-0CAF76F9FE | github | board renders every synthesized column with its issue | `apps/praxis-desktop/main/e2e/github.spec.ts:104` |
| PT-9C108229F6 | github | adding a comment and editing summary round-trips through the mock | `apps/praxis-desktop/main/e2e/github.spec.ts:117` |
| PT-3B749865A9 | github | moving a card to a status column adds the label and preserves unrelated labels | `apps/praxis-desktop/main/e2e/github.spec.ts:145` |
| PT-61A5FF6B13 | github | issue creation is disabled until the connection allows it | `apps/praxis-desktop/main/e2e/github.spec.ts:159` |
| PT-932B4018E4 | github | issue creation round-trips a new issue once enabled | `apps/praxis-desktop/main/e2e/github.spec.ts:169` |
| PT-902227C624 | gitlab | test connection against the mock REST server reports success | `apps/praxis-desktop/main/e2e/gitlab.spec.ts:97` |
| PT-12BB7CE87C | gitlab | board picker lists the boards the mock REST server reports | `apps/praxis-desktop/main/e2e/gitlab.spec.ts:118` |
| PT-E18BCAB4A2 | gitlab | tracked board renders issue cards and accepts a new comment via the mock | `apps/praxis-desktop/main/e2e/gitlab.spec.ts:136` |
| PT-E36EB5DBF5 | gitlab | New issue is disabled on a GitLab board until the connection allows creation | `apps/praxis-desktop/main/e2e/gitlab.spec.ts:210` |
| PT-AC09DFAB68 | gitlab | New issue is enabled on a GitLab board once the connection allows creation | `apps/praxis-desktop/main/e2e/gitlab.spec.ts:217` |
| PT-3FFA8FE2C9 | git Onboarding | Git Graph explains that a project workspace is required | `apps/praxis-desktop/main/e2e/gitOnboarding.spec.ts:13` |
| PT-64BEE7E4CE | git Onboarding | project Git navigation opens the graph for its workspace repository | `apps/praxis-desktop/main/e2e/gitOnboarding.spec.ts:37` |
| PT-6B6471DE4C | governed Application.live | a real AI creates a calculator application through Governed delivery and passes QA | `apps/praxis-desktop/main/e2e/governedApplication.live.spec.ts:26` |
| PT-9D9D7DC61F | governed Delivery Loop.live | Governed delivery with a real AI: review findings loop back to Implement and the run converges or escalates | `apps/praxis-desktop/main/e2e/governedDeliveryLoop.live.spec.ts:64` |
| PT-0EE345E8DC | icon Button Tooltips | every visible icon-only control on the main screens has a tooltip | `apps/praxis-desktop/main/e2e/iconButtonTooltips.spec.ts:96` |
| PT-4031809C97 | icon Button Tooltips | an icon-only button shows its accessible name as its tooltip | `apps/praxis-desktop/main/e2e/iconButtonTooltips.spec.ts:160` |
| PT-ECB4AC0EC3 | import Projects | importing a plans folder creates a folder-backed project whose board shows its markdown | `apps/praxis-desktop/main/e2e/importProjects.spec.ts:80` |
| PT-BA81D1CAC5 | import Projects | a repository with no plans content is skipped, not guessed at | `apps/praxis-desktop/main/e2e/importProjects.spec.ts:116` |
| PT-C951BA9B1E | import Projects | a repository whose plans sit outside docs/plans is still found | `apps/praxis-desktop/main/e2e/importProjects.spec.ts:131` |
| PT-BBA8B1C7D0 | import Projects | the wizard is reachable from the sidebar New menu and imports through the UI | `apps/praxis-desktop/main/e2e/importProjects.spec.ts:147` |
| PT-A3B1E13B09 | import Projects | re-scanning an imported folder flags it rather than offering it twice | `apps/praxis-desktop/main/e2e/importProjects.spec.ts:169` |
| PT-9B5C7A32A7 | improve And Map.live | Improve until target with a real AI ends on its best-scoring commit and records every pass | `apps/praxis-desktop/main/e2e/improveAndMap.live.spec.ts:91` |
| PT-AEE67315AD | improve And Map.live | a map stage with a real AI fixes each finding in its own worktree and merges them back | `apps/praxis-desktop/main/e2e/improveAndMap.live.spec.ts:179` |
| PT-62E497E328 | issue Ai Session Uncommitted | starting an AI session from a ticket warns about uncommitted changes and offers choices | `apps/praxis-desktop/main/e2e/issueAiSessionUncommitted.spec.ts:38` |
| PT-5183AA83ED | issue Ai Session Uncommitted | starting an AI session from a ticket can omit uncommitted files | `apps/praxis-desktop/main/e2e/issueAiSessionUncommitted.spec.ts:165` |
| PT-0F0FBD8AD5 | issue Detail | issue detail shows sub-tasks, linked issues, attachments and essential header actions | `apps/praxis-desktop/main/e2e/issueDetail.spec.ts:21` |
| PT-574710978E | jira | test connection against the mock MCP server reports success | `apps/praxis-desktop/main/e2e/jira.spec.ts:78` |
| PT-8342401BB6 | jira | board picker lists the boards the mock MCP server reports | `apps/praxis-desktop/main/e2e/jira.spec.ts:92` |
| PT-F0EE39C8BA | jira Auth | jiracloud api-token connection injects Authorization: Basic on every MCP request | `apps/praxis-desktop/main/e2e/jiraAuth.spec.ts:148` |
| PT-BFEB9A190C | jira Auth | jiracloud oauth connection runs the full SDK OAuth loop without a browser | `apps/praxis-desktop/main/e2e/jiraAuth.spec.ts:213` |
| PT-79B214506B | jira Auth | jiracloud oauth connection can use a pre-registered client (BYO) | `apps/praxis-desktop/main/e2e/jiraAuth.spec.ts:294` |
| PT-4B39900D85 | journey | a project created from a folder of existing plans shows them on its board | `apps/praxis-desktop/main/e2e/journey.spec.ts:133` |
| PT-580F518F3D | journey | a project created from a folder with no plans stays on app storage | `apps/praxis-desktop/main/e2e/journey.spec.ts:210` |
| PT-54F79B0024 | journey | a broken-era project record heals to folder-backed at startup | `apps/praxis-desktop/main/e2e/journey.spec.ts:240` |
| PT-209BAE8A67 | keyboard Focus | every control reached by Tab paints a visible focus ring | `apps/praxis-desktop/main/e2e/keyboardFocus.spec.ts:51` |
| PT-459F7A49D9 | keyboard Focus | the ring is themed, and pointer clicks stay quiet | `apps/praxis-desktop/main/e2e/keyboardFocus.spec.ts:73` |
| PT-47C9FD95ED | large Token Usage | AI Usage displays million, billion and trillion token totals with compact units | `apps/praxis-desktop/main/e2e/largeTokenUsage.spec.ts:7` |
| PT-8C7A4CF782 | marketplace | Add-ons panel holds only the central config and points at the per-kind panels | `apps/praxis-desktop/main/e2e/marketplace.spec.ts:149` |
| PT-E53CD33CCE | marketplace | Surfaces panel: the marketplace section installs a pack, and it can be removed from the gallery | `apps/praxis-desktop/main/e2e/marketplace.spec.ts:216` |
| PT-50545241D6 | marketplace | Agent Runtime panel: installing an agent asks first, then it can be uninstalled | `apps/praxis-desktop/main/e2e/marketplace.spec.ts:239` |
| PT-7639917547 | marketplace | Agent Runtime panel: a marketplace skill installs after confirmation and agents can load it | `apps/praxis-desktop/main/e2e/marketplace.spec.ts:271` |
| PT-213CF51606 | marketplace | an unconfigured marketplace is explained inside each panel | `apps/praxis-desktop/main/e2e/marketplace.spec.ts:303` |
| PT-B98611683A | marketplace | Themes marketplace filter toggle shows All and Installed views with screenshots | `apps/praxis-desktop/main/e2e/marketplace.spec.ts:334` |
| PT-2C5A984D24 | marketplace | Marketplace loads real GitHub packages with token configured | `apps/praxis-desktop/main/e2e/marketplace.spec.ts:375` |
| PT-4EE82C7277 | mobile Access | mobile access pairing controls stay off until the listener is enabled | `apps/praxis-desktop/main/e2e/mobileAccess.spec.ts:24` |
| PT-95E35930BA | mobile Access | creating a pairing code shows a single-use token and never a private key | `apps/praxis-desktop/main/e2e/mobileAccess.spec.ts:33` |
| PT-C909B8DB44 | mobile Access | resetting the host key asks for confirmation in-app | `apps/praxis-desktop/main/e2e/mobileAccess.spec.ts:48` |
| PT-112E148947 | mobile Access | an allowed-subnet entry the policy cannot match is rejected inline, and a legacy prefix migrates | `apps/praxis-desktop/main/e2e/mobileAccess.spec.ts:57` |
| PT-E0F71811D0 | model Display Badges | Manage models shows a context and price badge for every model the catalog prices | `apps/praxis-desktop/main/e2e/modelDisplayBadges.spec.ts:75` |
| PT-F5B741CBE6 | model Display Badges | a tier dropdown carries the same badges as Manage models, and omits them for unpriced models | `apps/praxis-desktop/main/e2e/modelDisplayBadges.spec.ts:96` |
| PT-3F41D6370B | model Display Badges | a settings row shows the model name and badges without a raw model id | `apps/praxis-desktop/main/e2e/modelDisplayBadges.spec.ts:130` |
| PT-372C7E1F65 | native Sources | other AI tools’ agents, skills and instructions are discovered, approved, copied, and used in a session | `apps/praxis-desktop/main/e2e/nativeSources.spec.ts:49` |
| PT-7EA609AC58 | native Sources | an agent from another AI tool can be placed on a workflow stage and bound to its skill | `apps/praxis-desktop/main/e2e/nativeSources.spec.ts:160` |
| PT-F027143814 | new Issue | creating a demo issue with the full field set shows it on the board | `apps/praxis-desktop/main/e2e/newIssue.spec.ts:69` |
| PT-EBCB12B9AA | new Issue | creating a live folder task under a feature writes the markdown file | `apps/praxis-desktop/main/e2e/newIssue.spec.ts:92` |
| PT-067D93638F | new Issue | live folder without allowIssueCreation shows a disabled create button with a hint | `apps/praxis-desktop/main/e2e/newIssue.spec.ts:136` |
| PT-24034BC9B8 | new Issue | the New idea button is hidden unless the preview setting is enabled | `apps/praxis-desktop/main/e2e/newIssue.spec.ts:152` |
| PT-CD33498B00 | new Issue | New idea opens the create form preset to Idea with the research transcript field | `apps/praxis-desktop/main/e2e/newIssue.spec.ts:161` |
| PT-201D18C39C | new Issue | creating a live folder idea writes the research transcript into the markdown | `apps/praxis-desktop/main/e2e/newIssue.spec.ts:188` |
| PT-55715AB01F | new Issue | the demo board offers Subtask with a required story/task/bug parent | `apps/praxis-desktop/main/e2e/newIssue.spec.ts:245` |
| PT-5870B4F60C | overview | renders the workspace overview dashboard | `apps/praxis-desktop/main/e2e/overview.spec.ts:9` |
| PT-D0D129AB73 | overview Ai Usage | shows exact period totals, peaks, cost and ranked models from a seeded ledger | `apps/praxis-desktop/main/e2e/overviewAiUsage.spec.ts:59` |
| PT-41BEE977CD | overview Ai Usage | says cost comes from ACP agents only when no cost is reported | `apps/praxis-desktop/main/e2e/overviewAiUsage.spec.ts:115` |
| PT-461248FADB | overview Ai Usage | invites a first conversation when the ledger is empty | `apps/praxis-desktop/main/e2e/overviewAiUsage.spec.ts:125` |
| PT-BFCB003F53 | overview Provider Budgets | a provider with no usage API is shown as no data, with the reason | `apps/praxis-desktop/main/e2e/overviewProviderBudgets.spec.ts:30` |
| PT-79318F44E0 | overview Provider Budgets | a disabled provider gets no card | `apps/praxis-desktop/main/e2e/overviewProviderBudgets.spec.ts:52` |
| PT-BEDB697014 | overview Provider Budgets | every enabled provider gets its own card, whatever each one reports | `apps/praxis-desktop/main/e2e/overviewProviderBudgets.spec.ts:63` |
| PT-4C4C5FD0FD | overview Provider Budgets | provider budgets render even when the usage ledger is empty | `apps/praxis-desktop/main/e2e/overviewProviderBudgets.spec.ts:87` |
| PT-CE935C432D | overview Provider Budgets | no enabled providers explains how to add one | `apps/praxis-desktop/main/e2e/overviewProviderBudgets.spec.ts:101` |
| PT-32EEAB3A9B | overview Provider Budgets | a provider that exposes no usage API is never badged Offline | `apps/praxis-desktop/main/e2e/overviewProviderBudgets.spec.ts:109` |
| PT-7768AC7D0C | overview Provider Budgets | a card shows no invented spend, rate limit or reset figures | `apps/praxis-desktop/main/e2e/overviewProviderBudgets.spec.ts:122` |
| PT-5951674B1E | pane Inset | the centre pane is inset by 4px on every side and rounded on all four corners | `apps/praxis-desktop/main/e2e/paneInset.spec.ts:19` |
| PT-22F5EE9E77 | project Review | project review scopes history, surfaces blocked and stale work, and acts through the board rules | `apps/praxis-desktop/main/e2e/projectReview.spec.ts:21` |
| PT-031B958FB6 | project Review | daily review: a configurable aging rule, a re-opened review for new blockers, board-only moves, and a ten-item pass with no page load | `apps/praxis-desktop/main/e2e/projectReview.spec.ts:116` |
| PT-D248A18A8B | project Review | moving an item to Blocked from the review asks why, and the reason is kept with the item | `apps/praxis-desktop/main/e2e/projectReview.spec.ts:186` |
| PT-DC65C6F2E6 | project Review | daily review previews only the five most recently active unfinished project sessions | `apps/praxis-desktop/main/e2e/projectReview.spec.ts:236` |
| PT-A093EBE8D0 | projects | creates a folderless Product project through advanced setup, then adds its board | `apps/praxis-desktop/main/e2e/projects.spec.ts:23` |
| PT-F168CE8C6E | projects | opens the unified Add Project flow from the New menu | `apps/praxis-desktop/main/e2e/projects.spec.ts:206` |
| PT-445F9E991F | projects | a first project is three steps: type, name, review | `apps/praxis-desktop/main/e2e/projects.spec.ts:236` |
| PT-543BB59CA0 | projects | retains an existing project.praxis.md and supports local board transitions and edits | `apps/praxis-desktop/main/e2e/projects.spec.ts:267` |
| PT-E8FB985783 | projects | uses a folder connection for an existing-folder project with plans | `apps/praxis-desktop/main/e2e/projects.spec.ts:296` |
| PT-9A5E822F46 | projects | reuses an existing project record for the same folder instead of duplicating it | `apps/praxis-desktop/main/e2e/projects.spec.ts:340` |
| PT-B4A9AEAC96 | projects | rejects prohibited folderless types and new-folder collisions without changing the folder | `apps/praxis-desktop/main/e2e/projects.spec.ts:360` |
| PT-E0776B569A | projects | rolls back a newly-created folder and project.praxis.md when project persistence fails | `apps/praxis-desktop/main/e2e/projects.spec.ts:390` |
| PT-E178D1C798 | projects | rolls back the project record and created artifacts when workspace persistence fails | `apps/praxis-desktop/main/e2e/projects.spec.ts:405` |
| PT-2C18F54E60 | projects | ships deterministic workflows and five editable starters for every project type | `apps/praxis-desktop/main/e2e/projects.spec.ts:437` |
| PT-82D52D4465 | projects | a folder-backed project board is served by its folder connection | `apps/praxis-desktop/main/e2e/projects.spec.ts:449` |
| PT-EC0F2F4589 | projects | attaches a folder later and enforces one-project ownership for linked boards | `apps/praxis-desktop/main/e2e/projects.spec.ts:478` |
| PT-20E8DEA5C2 | projects | nests unlinked boards under the sidebar "Boards" heading | `apps/praxis-desktop/main/e2e/projects.spec.ts:529` |
| PT-351A726967 | projects | shows a connected board only beneath its owning Praxis project | `apps/praxis-desktop/main/e2e/projects.spec.ts:564` |
| PT-6E2027D3E8 | projects | unlinks a board that was cross-linked from another project's own connection | `apps/praxis-desktop/main/e2e/projects.spec.ts:635` |
| PT-02C7A5F8B0 | projects | an existing folder is three steps too, and confirms the detected identity | `apps/praxis-desktop/main/e2e/projects.spec.ts:673` |
| PT-508D8D1DB5 | projects | ticking advanced setup adds brief and tool access in existing-folder mode | `apps/praxis-desktop/main/e2e/projects.spec.ts:709` |
| PT-F3FE778F2D | projects | the command palette can add a project from an existing folder | `apps/praxis-desktop/main/e2e/projects.spec.ts:733` |
| PT-401BD32A9D | project Session Actions | General and Ticket project sessions expose rename, archive, and delete actions | `apps/praxis-desktop/main/e2e/projectSessionActions.spec.ts:18` |
| PT-372B4C8AC9 | provider Usage History | provider history stays separate, handles keys, coverage, zero and unavailable summaries | `apps/praxis-desktop/main/e2e/providerUsageHistory.spec.ts:7` |
| PT-58E206C861 | quick Capture | global capture requires a destination, creates through the ordinary path, and clears only on success | `apps/praxis-desktop/main/e2e/quickCapture.spec.ts:26` |
| PT-F6DDEAD096 | quick Capture | the capture shortcut opens over Settings and over another open dialog, on top of both | `apps/praxis-desktop/main/e2e/quickCapture.spec.ts:82` |
| PT-0EBCAEDC04 | quick Capture | a capture stamps its creation time; Escape creates nothing | `apps/praxis-desktop/main/e2e/quickCapture.spec.ts:108` |
| PT-9A577BE2F0 | quick Capture | successive captures each create their own item | `apps/praxis-desktop/main/e2e/quickCapture.spec.ts:135` |
| PT-30F6F66DDC | quick Capture | failed capture retains title, body and destination after dismiss and reopen | `apps/praxis-desktop/main/e2e/quickCapture.spec.ts:167` |
| PT-4580B168D4 | quick Capture | folder creation opt-in is enforced with an explanation and no discarded input | `apps/praxis-desktop/main/e2e/quickCapture.spec.ts:191` |
| PT-B0971395E1 | quick Capture | an enabled folder capture explicitly requires a feature for its task | `apps/praxis-desktop/main/e2e/quickCapture.spec.ts:212` |
| PT-7D99970CA9 | quick Capture | a captured folder item is marked on disk and badged until it leaves the first column | `apps/praxis-desktop/main/e2e/quickCapture.spec.ts:237` |
| PT-668B1806B5 | quick Capture | the capture dialog fits and stays readable across themes, surface packs and zoom | `apps/praxis-desktop/main/e2e/quickCapture.spec.ts:279` |
| PT-E65F2B46F5 | quick Session | the title-bar quick session opens the composer scoped to the current project with quick-change ready | `apps/praxis-desktop/main/e2e/quickSession.spec.ts:61` |
| PT-515B50E6B1 | quick Session | a project session action scopes the composer to that project | `apps/praxis-desktop/main/e2e/quickSession.spec.ts:102` |
| PT-4B8B596B62 | quick Session | draft and existing sessions share the composer frame and input layout | `apps/praxis-desktop/main/e2e/quickSession.spec.ts:168` |
| PT-AAC7A98AEE | saved Workspaces | project creation requires a valid workspace and assigns the first project as default | `apps/praxis-desktop/main/e2e/savedWorkspaces.spec.ts:21` |
| PT-E4A652D7E0 | saved Workspaces | deleting the active workspace returns to Getting Started without deleting projects | `apps/praxis-desktop/main/e2e/savedWorkspaces.spec.ts:42` |
| PT-6A873CE029 | saved Workspaces | closing the active workspace returns to the Open Workspace screen | `apps/praxis-desktop/main/e2e/savedWorkspaces.spec.ts:58` |
| PT-2907C48991 | saved Workspaces | New workspace opens the workspace creation dialog | `apps/praxis-desktop/main/e2e/savedWorkspaces.spec.ts:69` |
| PT-491CCAB290 | saved Workspaces | each workspace resumes at its own last route, not the other one's | `apps/praxis-desktop/main/e2e/savedWorkspaces.spec.ts:79` |
| PT-8DC4807D76 | scheduled Runs | builds a schedule on the belt, saves it, and it survives a restart in the same order | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:91` |
| PT-20627BB23E | scheduled Runs | edit, schedule, hold and delete a schedule | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:151` |
| PT-74238ECE73 | scheduled Runs | a start that passed while Praxis was closed is missed, and only a choice resolves it | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:187` |
| PT-3FCAD42C44 | scheduled Runs | a run with no usable provider cannot be scheduled, and says why | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:226` |
| PT-644A8319CA | scheduled Runs | the whole surface is hidden until the preview is switched on | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:240` |
| PT-3954D0B1FE | scheduled Runs | the board toolbar offers a shortcut to the scheduled runs of its project, only while the preview is on | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:247` |
| PT-6050135CF2 | scheduled Runs | selected board tickets are saved in a new schedule | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:257` |
| PT-0498B7BAAE | scheduled Runs | selected board tickets are appended directly to an existing schedule | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:280` |
| PT-07C623F1C9 | scheduled Runs | without the preview the board toolbar has no schedule shortcut | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:307` |
| PT-225AEDFF55 | scheduled Runs | tickets can be dragged from the hopper onto the belt and reordered on it | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:316` |
| PT-273152A227 | scheduled Runs | dragging a group ticket from the scheduler sidebar adds its unfinished child tickets | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:348` |
| PT-8738E01F29 | scheduled Runs | capture the composer and lineup for visual review (opt-in) | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:394` |
| PT-78DB6CEAAE | scheduled Runs | the armed processor rings stay concentric while they spin | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:446` |
| PT-4FBFA8B98D | scheduled Runs | scheduled runs have a grouped sidebar and project tickets stay outside the main pane | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:468` |
| PT-D31B062F2D | scheduled Runs | sidebar uses classic recency groups and expands group tickets | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:593` |
| PT-706E3FFD23 | scheduled Runs | a due schedule starts by itself, and a provider at its allowance pauses it before anything launches | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:728` |
| PT-9EEC436CE9 | scheduled Runs | Run now starts drafts and future schedules immediately, records one attempt and opens the live view | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:766` |
| PT-76F292ED66 | scheduled Runs | the editor can Run now without a scheduled start time and still obeys the provider budget gate | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:790` |
| PT-9EBCCE6CC4 | scheduled Runs | a ticket that cannot be launched pauses the run with the reason, keeps its order, and can be skipped | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:807` |
| PT-6890A4393F | scheduled Runs | quitting with a schedule pending asks first, and offers to minimise instead | `apps/praxis-desktop/main/e2e/scheduledRuns.spec.ts:845` |
| PT-4BED3303D0 | security Remediation | unregistered renderers cannot read settings or emit privileged one-way messages | `apps/praxis-desktop/main/e2e/securityRemediation.spec.ts:14` |
| PT-119034639B | security Remediation | OAuth rejects missing, mismatched and replayed state without consuming the legitimate authorization | `apps/praxis-desktop/main/e2e/securityRemediation.spec.ts:26` |
| PT-29ECE51EF8 | security Remediation | secret reads repair permissive file modes and encrypted values remain retrievable | `apps/praxis-desktop/main/e2e/securityRemediation.spec.ts:49` |
| PT-440193CE0B | security Remediation | repository workflows require command review, preserve trust on restart, and revoke it after changes | `apps/praxis-desktop/main/e2e/securityRemediation.spec.ts:68` |
| PT-19BEAE532A | security Remediation | Antigravity selection rejects restricted tool modes and displays unrestricted consent | `apps/praxis-desktop/main/e2e/securityRemediation.spec.ts:108` |
| PT-0933C80ACE | security Review Run | Security Review: findings, readable report, and an approved plan created on the board with its id | `apps/praxis-desktop/main/e2e/securityReviewRun.spec.ts:179` |
| PT-2119B9F4E9 | security Review Run | Security Review: skipping the plan ends the run as succeeded with no plan created | `apps/praxis-desktop/main/e2e/securityReviewRun.spec.ts:265` |
| PT-30FBAD1922 | security Review Self.live | Security Review on this repository with a real AI | `apps/praxis-desktop/main/e2e/securityReviewSelf.live.spec.ts:30` |
| PT-06D12D29D3 | semantic Search Notification | shows semantic search recommendation notification on startup if model not installed | `apps/praxis-desktop/main/e2e/semanticSearchNotification.spec.ts:17` |
| PT-D83E9876EA | semantic Search Notification | enables semantic search from startup notification and shows success feedback | `apps/praxis-desktop/main/e2e/semanticSearchNotification.spec.ts:63` |
| PT-EB2FB567E1 | semantic Search Notification | configure button in notification opens Code Intelligence settings page | `apps/praxis-desktop/main/e2e/semanticSearchNotification.spec.ts:105` |
| PT-E83CF2C725 | semantic Search Notification | a finished download that the service then refuses is reported, never shown as enabled | `apps/praxis-desktop/main/e2e/semanticSearchNotification.spec.ts:139` |
| PT-A0C7008A04 | semantic Search Notification | offers an update instead of enable when an earlier model is installed | `apps/praxis-desktop/main/e2e/semanticSearchNotification.spec.ts:162` |
| PT-4874B92CC2 | semantic Search Notification | the real main process reports a previously downloaded MiniLM bundle as an update | `apps/praxis-desktop/main/e2e/semanticSearchNotification.spec.ts:197` |
| PT-E9A2A4583D | session Ai Icons | session list displays single and multiple pixel-perfect AI brand icons beside each session | `apps/praxis-desktop/main/e2e/sessionAiIcons.spec.ts:15` |
| PT-71A99A13A6 | session Groups | chat and project session groups reorder, rename inline, and persist | `apps/praxis-desktop/main/e2e/sessionGroups.spec.ts:19` |
| PT-228E76C299 | session Provider Limit | a session whose AI ran out can switch to another AI and carry on | `apps/praxis-desktop/main/e2e/sessionProviderLimit.spec.ts:47` |
| PT-E181B9FAF4 | session Provider Limit | a session whose AI ran out can be stopped instead | `apps/praxis-desktop/main/e2e/sessionProviderLimit.spec.ts:64` |
| PT-4F044C6563 | session Provider Limit | a CLI agent reporting a provider limit does not put the limit notice into the chat thread | `apps/praxis-desktop/main/e2e/sessionProviderLimit.spec.ts:77` |
| PT-9C70634712 | session Provider Limit Recovery | Given an exhausted provider, When the replacement also exhausts credits, Then its new failure remains actionable | `apps/praxis-desktop/main/e2e/sessionProviderLimitRecovery.spec.ts:131` |
| PT-A28FC55003 | session Provider Limit Recovery | Given model chips, When choosing a non-default model, Then only Switch sends the exact draft pair once | `apps/praxis-desktop/main/e2e/sessionProviderLimitRecovery.spec.ts:148` |
| PT-FBA79BBA7E | session Provider Limit Recovery | Given a topped-up original provider and changed draft model, When Retry is selected, Then the original runtime retries and stale warnings clear | `apps/praxis-desktop/main/e2e/sessionProviderLimitRecovery.spec.ts:162` |
| PT-C6AA603168 | session Provider Limit Recovery | Given a recovery menu, When it is dismissed or Stop is selected, Then selection alone changes nothing and Stop keeps history | `apps/praxis-desktop/main/e2e/sessionProviderLimitRecovery.spec.ts:179` |
| PT-B18E72FAE1 | session Provider Limit Recovery | Given six providers, When recovery appears in wide and narrow panes, Then only two chips and a split action remain inline | `apps/praxis-desktop/main/e2e/sessionProviderLimitRecovery.spec.ts:198` |
| PT-D6D59E4CE6 | session Provider Limit Recovery | Given a configured default absent from the catalog, When choosing its provider, Then that default is pinned and sent | `apps/praxis-desktop/main/e2e/sessionProviderLimitRecovery.spec.ts:229` |
| PT-0F53B96868 | session Provider Limit Recovery | Given failing model discovery, When reloading models, Then Switch stays blocked until a valid model is loaded | `apps/praxis-desktop/main/e2e/sessionProviderLimitRecovery.spec.ts:241` |
| PT-4156A629FE | session Provider Limit Recovery | Given slow model discovery for one provider, When changing provider again, Then the late catalog cannot overwrite the new selection | `apps/praxis-desktop/main/e2e/sessionProviderLimitRecovery.spec.ts:259` |
| PT-CFB30E2E50 | session Provider Limit Recovery | Given a runtime without a model catalog, When it is selected, Then provider-default fallback is explicit | `apps/praxis-desktop/main/e2e/sessionProviderLimitRecovery.spec.ts:281` |
| PT-AE941F1B18 | session Recovery | startup waits for approval, resumes only selected sessions, and logs provider and time | `apps/praxis-desktop/main/e2e/sessionRecovery.spec.ts:31` |
| PT-BB25CA1B96 | session Recovery | Leave stopped persists across restart without launching requests | `apps/praxis-desktop/main/e2e/sessionRecovery.spec.ts:54` |
| PT-C79C27B44C | session Recovery | Select all resumes both, and a stale recovery request is rejected | `apps/praxis-desktop/main/e2e/sessionRecovery.spec.ts:65` |
| PT-52EA94800B | session Recovery | unconfigured providers show a recovery error and remain stopped | `apps/praxis-desktop/main/e2e/sessionRecovery.spec.ts:75` |
| PT-0FBAAEEA42 | session Recovery | keyboard focus stays in recovery, and Escape leaves sessions stopped | `apps/praxis-desktop/main/e2e/sessionRecovery.spec.ts:85` |
| PT-0F10648F67 | session Recovery | interrupted CLI sessions also wait for selection and resume through ACP | `apps/praxis-desktop/main/e2e/sessionRecovery.spec.ts:99` |
| PT-75B0F93373 | session Recovery | teardown drains an ACP task even when the session list already reports completion | `apps/praxis-desktop/main/e2e/sessionRecovery.spec.ts:110` |
| PT-3C45DBB445 | session Team | a session can add several team members; a lone reviewer offers to draft an ask | `apps/praxis-desktop/main/e2e/sessionTeam.spec.ts:20` |
| PT-1EF3C80135 | session Usage Quota | composer usage panel draws provider quota windows as bars with a collapsed meter | `apps/praxis-desktop/main/e2e/sessionUsageQuota.spec.ts:42` |
| PT-4F96A39603 | session Usage Quota | collapsed usage animates both bars while account limits load | `apps/praxis-desktop/main/e2e/sessionUsageQuota.spec.ts:173` |
| PT-EEEE457808 | session Usage Quota | collapsed usage skips the count-up under reduced motion | `apps/praxis-desktop/main/e2e/sessionUsageQuota.spec.ts:250` |
| PT-217FC849F2 | session Usage Quota | a session that ran without token reports shows a dash, never Not reported | `apps/praxis-desktop/main/e2e/sessionUsageQuota.spec.ts:273` |
| PT-288744FF07 | session Usage Quota | draft usage follows the selected model and keeps unfiltered dashboard totals | `apps/praxis-desktop/main/e2e/sessionUsageQuota.spec.ts:299` |
| PT-665B3B7D14 | session Usage Quota | session usage follows the active conversation speaker and its runtime tokens | `apps/praxis-desktop/main/e2e/sessionUsageQuota.spec.ts:333` |
| PT-EB19D7A97A | session Usage Quota | usage attribution preserves missing tokens, currencies and legacy session totals | `apps/praxis-desktop/main/e2e/sessionUsageQuota.spec.ts:455` |
| PT-67020F5525 | settings Reset | reset to defaults asks separately before clearing saved AI session data | `apps/praxis-desktop/main/e2e/settingsReset.spec.ts:22` |
| PT-3BA46A8FF8 | settings Reset | clears app-owned project, workspace, and board data without deleting shared connections | `apps/praxis-desktop/main/e2e/settingsReset.spec.ts:38` |
| PT-9201555682 | shell Polish | output tab backfills the main-process log buffer | `apps/praxis-desktop/main/e2e/shellPolish.spec.ts:50` |
| PT-20DAB5A632 | shell Polish | output tab streams lines appended while it is open | `apps/praxis-desktop/main/e2e/shellPolish.spec.ts:62` |
| PT-31AED72E90 | shell Polish | output tab filters, copies and clears the log | `apps/praxis-desktop/main/e2e/shellPolish.spec.ts:88` |
| PT-2A163FAD48 | shell Polish | output history survives a restart | `apps/praxis-desktop/main/e2e/shellPolish.spec.ts:110` |
| PT-C43ACAD8DC | shell Polish | selecting an issue pins a peek card above the sidebar footer | `apps/praxis-desktop/main/e2e/shellPolish.spec.ts:130` |
| PT-3DA72EF9DD | shell Polish | connection groups carry a health dot from connection checks | `apps/praxis-desktop/main/e2e/shellPolish.spec.ts:154` |
| PT-E59A37BF1C | sidebar Long Names | long workflow, run and session names leave their action buttons reachable at the narrowest widths | `apps/praxis-desktop/main/e2e/sidebarLongNames.spec.ts:52` |
| PT-0753F0246D | sidebar Sticky Headers | tree headers stick nested beneath their parents as the top sidebar panel scrolls | `apps/praxis-desktop/main/e2e/sidebarStickyHeaders.spec.ts:27` |
| PT-856185D4D7 | sidebar Sticky Headers | recency buckets stack below the project row and hand over within their own lists | `apps/praxis-desktop/main/e2e/sidebarStickyHeaders.spec.ts:161` |
| PT-750ACA1C1D | sidebar Tree Alignment | rows at the same depth of the project tree share an icon column and a label column | `apps/praxis-desktop/main/e2e/sidebarTreeAlignment.spec.ts:25` |
| PT-A370DC483D | standalone Conversations | detached-chat IPC refuses a window outside the trusted renderer | `apps/praxis-desktop/main/e2e/standaloneConversations.spec.ts:9` |
| PT-B82F563EB2 | standalone Conversations | standalone conversation persists and resumes across floating-window pop-in, close and app restart | `apps/praxis-desktop/main/e2e/standaloneConversations.spec.ts:29` |
| PT-A21E3FDD8F | startup Experience | first launch offers one folder-first workspace entry flow | `apps/praxis-desktop/main/e2e/startupExperience.spec.ts:17` |
| PT-A35C1F2EBD | startup Experience | opening an existing folder creates a portable workspace and file-only project | `apps/praxis-desktop/main/e2e/startupExperience.spec.ts:40` |
| PT-C830C9989C | startup Experience | workspace setup can be skipped to the empty Praxis shell | `apps/praxis-desktop/main/e2e/startupExperience.spec.ts:97` |
| PT-1B93A7E22D | startup Experience | workspace setup offers project handoff and cancelling the wizard opens the empty shell | `apps/praxis-desktop/main/e2e/startupExperience.spec.ts:117` |
| PT-CCD26C2CF1 | startup Experience | workspace Add Project opens a folder without a board and adds planning later | `apps/praxis-desktop/main/e2e/startupExperience.spec.ts:149` |
| PT-F9609B37B1 | startup Experience | advanced project setup remains available without forcing a board | `apps/praxis-desktop/main/e2e/startupExperience.spec.ts:213` |
| PT-638E30E516 | startup Experience | reopens a validated workspace and its last durable route | `apps/praxis-desktop/main/e2e/startupExperience.spec.ts:272` |
| PT-5EA9DB4BA4 | startup Experience | disabled restoration and a missing saved workspace both fail safely to Getting Started | `apps/praxis-desktop/main/e2e/startupExperience.spec.ts:294` |
| PT-734A6AC91D | startup Experience | Getting Started remains usable in a narrow reduced-motion window and light theme | `apps/praxis-desktop/main/e2e/startupExperience.spec.ts:318` |
| PT-F28949A7D1 | startup Experience | recent workspaces follow actual opens, show five, and expose View all | `apps/praxis-desktop/main/e2e/startupExperience.spec.ts:332` |
| PT-96C9B65554 | surface Packs | ships default-on with the Parchment surface over the Praxis theme | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:64` |
| PT-D3B6ABACF1 | surface Packs | the pack renders its hexagon watermark on every pane and the tile actually loads | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:75` |
| PT-49CDF1858D | surface Packs | built-in surfaces use their intended default pattern | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:91` |
| PT-E48EA1B37B | surface Packs | selecting a surface restores its default motif after a custom override | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:115` |
| PT-01F3970A62 | surface Packs | the watermark is tinted from the live theme and re-bakes when the palette changes | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:128` |
| PT-A5575F6EC6 | surface Packs | the default motif is one anchored corner mark, not wallpaper | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:145` |
| PT-AD68B83770 | surface Packs | the corner picker mirrors the motif into every selected corner | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:167` |
| PT-8A32C1FFDC | surface Packs | the motif rides over any pack, and Reset hands it back | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:210` |
| PT-AE3511C1BB | surface Packs | solid cells scatter through a super-tile rather than repeating in step | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:235` |
| PT-70E51BE580 | surface Packs | the letterpress outline is opt-in and draws a second offset line | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:273` |
| PT-38F6482663 | surface Packs | motif strength is normalised so one value reads the same on every palette | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:290` |
| PT-FADD47BAE7 | surface Packs | the startup splash carries the same watermark as the panes | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:319` |
| PT-2B568CA335 | surface Packs | the Mandelbrot motif paints as real geometry and its tile actually loads | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:352` |
| PT-C67A595CDB | surface Packs | with animation off the motif is baked complete, with no keyframes at all | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:367` |
| PT-139EBECEEC | surface Packs | Draw bakes the reveal into the motif SVG and rests on the complete mark | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:391` |
| PT-0D46EB5152 | surface Packs | Repeat is what turns a one-shot reveal into a loop | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:409` |
| PT-B23F337F10 | surface Packs | layer-family styles drive CSS and leave the motif SVG untouched | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:422` |
| PT-66D5C443AB | surface Packs | an animated motif never raises the declared strength past the contrast ceiling | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:447` |
| PT-1935F3B61F | surface Packs | the master switch stops every motif animation, whatever the style says | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:463` |
| PT-5C13E30EE9 | surface Packs | the motif rides over any pack, and animation rides over any motif | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:480` |
| PT-7F7BEA8A08 | surface Packs | switches surface pack, composing over the current theme, and persists it | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:497` |
| PT-1D825C6EA3 | surface Packs | the Intensity dial scales the texture and is disabled for Flat | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:511` |
| PT-421C9A899C | surface Packs | contrast guard: flat is inert and every pack keeps a readable panel ground | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:531` |
| PT-D670937702 | surface Packs | contrast guard: no pack pushes its watermark past a readable ceiling | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:567` |
| PT-0ABEA3D057 | surface Packs | Aurora Glass frosts the sidebar and the translucency dial collapses it | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:600` |
| PT-6BEBA0C5C1 | surface Packs | Noir is offered under a dark theme and hidden under a light one | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:644` |
| PT-9D9EE14B14 | surface Packs | a custom surface pack can be created, applied, and survives a reload | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:661` |
| PT-4D94D83CA7 | surface Packs | a user can swap the material by picking a pattern — no code, no new CSS | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:680` |
| PT-1046026F79 | surface Packs | the Window-blur toggle is present on a vibrancy-capable OS and persists | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:705` |
| PT-C8E9630E66 | surface Packs | the Texture toggle gates the grain layer without changing the pack | `apps/praxis-desktop/main/e2e/surfacePacks.spec.ts:720` |
| PT-5590097221 | task Designer | designer canvas round-trips nodes, a link and zoom across view close and app relaunch | `apps/praxis-desktop/main/e2e/taskDesigner.spec.ts:79` |
| PT-05D9C84B86 | task Designer | link mode connects two items by selecting source then target | `apps/praxis-desktop/main/e2e/taskDesigner.spec.ts:162` |
| PT-2CB761CD9E | task Designer | note resize adorner sits on the item corner and resizes the outer node | `apps/praxis-desktop/main/e2e/taskDesigner.spec.ts:190` |
| PT-2BC0402306 | task Designer | designer sidebar shows board tickets, supports drag to canvas, and restores workspace on exit | `apps/praxis-desktop/main/e2e/taskDesigner.spec.ts:222` |
| PT-A9ADF6DF41 | task Designer | AI recommend flow previews an ordering and applying stacks the tickets vertically | `apps/praxis-desktop/main/e2e/taskDesigner.spec.ts:258` |
| PT-55CBD1F16D | task Designer | generate master plan writes plans/master-plan.md under the working directory | `apps/praxis-desktop/main/e2e/taskDesigner.spec.ts:298` |
| PT-DECD91D299 | task Notifications | desktop notification preferences persist, live transitions deliver once, and clicks open the session | `apps/praxis-desktop/main/e2e/taskNotifications.spec.ts:9` |
| PT-E3EDB999D6 | task Notifications | workflow transitions notify once and clicking opens the run in its project | `apps/praxis-desktop/main/e2e/taskNotifications.spec.ts:84` |
| PT-98B1DBFD7A | terminal | runs a real PTY and preserves it when the panel is closed | `apps/praxis-desktop/main/e2e/terminal.spec.ts:11` |
| PT-2832CE2917 | terminal | captures shell-integrated command records and exposes failed-command actions | `apps/praxis-desktop/main/e2e/terminal.spec.ts:40` |
| PT-0D89836F29 | terminal | creates and kills terminal sessions from the panel toolbar | `apps/praxis-desktop/main/e2e/terminal.spec.ts:59` |
| PT-B16C06BF15 | terminal | opens per-terminal settings and applies an active-session override | `apps/praxis-desktop/main/e2e/terminal.spec.ts:71` |
| PT-249786566B | terminal | detects installed shell profiles and launches a selected profile | `apps/praxis-desktop/main/e2e/terminal.spec.ts:87` |
| PT-A78EE346F5 | test App Cleanup | normal teardown exits Electron and removes its isolated profile | `apps/praxis-desktop/main/e2e/testAppCleanup.spec.ts:5` |
| PT-95EBB52521 | test App Cleanup | stalled renderer cleanup is bounded and reported after terminating its app | `apps/praxis-desktop/main/e2e/testAppCleanup.spec.ts:15` |
| PT-CEBD73E498 | test App Cleanup | vetoed Electron shutdown is bounded and remains a failure | `apps/praxis-desktop/main/e2e/testAppCleanup.spec.ts:31` |
| PT-12759B4DF5 | theme Looks | ships the four built-in Looks with Parchment active | `apps/praxis-desktop/main/e2e/themeLooks.spec.ts:49` |
| PT-E667F1ABE8 | theme Looks | selecting a Look swaps theme + surface together and persists | `apps/praxis-desktop/main/e2e/themeLooks.spec.ts:57` |
| PT-3A65DBB9C9 | theme Looks | editing a dial while a Look is active is folded into that Look | `apps/praxis-desktop/main/e2e/themeLooks.spec.ts:69` |
| PT-495E7EE92F | theme Looks | Save current as Look adds a card that survives a reload | `apps/praxis-desktop/main/e2e/themeLooks.spec.ts:95` |
| PT-E63862928F | theme Looks | built-in Looks cannot be renamed or deleted, while custom Looks can | `apps/praxis-desktop/main/e2e/themeLooks.spec.ts:108` |
| PT-049E5F19E5 | theme Looks | factory appearance reset restores the theme, Look, surface, and libraries | `apps/praxis-desktop/main/e2e/themeLooks.spec.ts:127` |
| PT-89AABA02B9 | titlebar Code Intel | the title bar chip shows indexing, semantic build progress and the search type | `apps/praxis-desktop/main/e2e/titlebarCodeIntel.spec.ts:22` |
| PT-F38C436911 | titlebar Code Intel | the chip shows keyword search without a model and never wakes an idle service | `apps/praxis-desktop/main/e2e/titlebarCodeIntel.spec.ts:72` |
| PT-F4258423A5 | titlebar Code Intel | an unindexed folder shows Build index without starting the service, and clicking it builds | `apps/praxis-desktop/main/e2e/titlebarCodeIntel.spec.ts:136` |
| PT-11D6DA9B59 | titlebar Code Intel | on launch an unindexed folder asks once to build its index, before the model notice | `apps/praxis-desktop/main/e2e/titlebarCodeIntel.spec.ts:159` |
| PT-9187B3ECD5 | titlebar Code Intel | "Not now" is remembered for the folder; the chip still builds on click | `apps/praxis-desktop/main/e2e/titlebarCodeIntel.spec.ts:179` |
| PT-47C5E579CC | titlebar Layout | titlebar scheduled-runs shortcut stays clickable at medium window widths | `apps/praxis-desktop/main/e2e/titlebarLayout.spec.ts:4` |
| PT-1B0F699E2E | verify marketplace | VERIFY: Marketplace loads and displays real GitHub packages | `apps/praxis-desktop/main/e2e/verify-marketplace.spec.ts:10` |
| PT-A17BEBD0BC | walkthrough | walks the shell, rings each control, and remembers it was seen | `apps/praxis-desktop/main/e2e/walkthrough.spec.ts:68` |
| PT-3FCE413FDD | walkthrough | the ring is visibly not a control, and not the focus ring | `apps/praxis-desktop/main/e2e/walkthrough.spec.ts:99` |
| PT-872EAC1D71 | walkthrough | the ring never blocks the control it highlights | `apps/praxis-desktop/main/e2e/walkthrough.spec.ts:142` |
| PT-953FE9CFAB | walkthrough | Escape dismisses the tour, and that counts as seen | `apps/praxis-desktop/main/e2e/walkthrough.spec.ts:156` |
| PT-5D746924EB | walkthrough | a stop whose target disappears mid-tour is skipped, not shown empty | `apps/praxis-desktop/main/e2e/walkthrough.spec.ts:168` |
| PT-81822F8874 | what Changed | What Changed records every source, says who made each change, and opens each in one click | `apps/praxis-desktop/main/e2e/whatChanged.spec.ts:45` |
| PT-7609557DB7 | what Changed | a week of several hundred changes renders and filters without a long main-thread task | `apps/praxis-desktop/main/e2e/whatChanged.spec.ts:171` |
| PT-D5A9FA2834 | whats New | What's new opens over the workspace and provides version history | `apps/praxis-desktop/main/e2e/whatsNew.spec.ts:13` |
| PT-E2CF066538 | window State | window state remembers previous position, width, and height across restarts | `apps/praxis-desktop/main/e2e/windowState.spec.ts:4` |
| PT-73402155F3 | workflow Agent Stage | an agent stage runs a real session and produces its declared artifact | `apps/praxis-desktop/main/e2e/workflowAgentStage.spec.ts:68` |
| PT-09CEDDAEF8 | workflow Agent Stage | an agent stage with a missing Agent Hub binding is rejected before a run or session exists | `apps/praxis-desktop/main/e2e/workflowAgentStage.spec.ts:201` |
| PT-095333D691 | workflow Build Stage | without a build stage the built product is missing in a fresh worktree, so what needs it fails | `apps/praxis-desktop/main/e2e/workflowBuildStage.spec.ts:102` |
| PT-01868F6849 | workflow Build Stage | a governed run refuses a dirty product checkout instead of testing an older committed snapshot | `apps/praxis-desktop/main/e2e/workflowBuildStage.spec.ts:110` |
| PT-E0ECD22131 | workflow Build Stage | a build stage produces the output in the run's worktree, so QA passes — and the main checkout gets none | `apps/praxis-desktop/main/e2e/workflowBuildStage.spec.ts:131` |
| PT-F75C48C431 | workflow Build Stage | a project with no build script is not failed by the build stage having nothing to say | `apps/praxis-desktop/main/e2e/workflowBuildStage.spec.ts:143` |
| PT-DC013E489D | workflow Designer | creates a workflow from a template, edits a stage in the right pane, and persists it | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:93` |
| PT-E049A4DE12 | workflow Designer | blocks save while the graph is invalid and announces the errors | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:124` |
| PT-37B15BC378 | workflow Designer | the canvas moves a stage with the keyboard and selects it | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:140` |
| PT-2576004142 | workflow Designer | auto arrange lays out workflow stages in dependency order without overlap | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:158` |
| PT-0B66AF09D4 | workflow Designer | auto arrange vertical lays out workflow stages top to bottom in dependency order without overlap | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:199` |
| PT-5AFE08A88C | workflow Designer | edge badge shows condition tooltip and opens edge inspector in sidebar when clicked | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:238` |
| PT-81DBC1358A | workflow Designer | workflow nodes display distinct green success and red failure handles and color-code connector strokes | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:254` |
| PT-814CF4A563 | workflow Designer | nudging a stage past the canvas edge clamps its position instead of losing it off-screen | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:278` |
| PT-D7BA2AF937 | workflow Designer | builds an agent handoff stage from the palette and attaches a specialist skill | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:296` |
| PT-B1FCE4E164 | workflow Designer | a folder-backed project commits its workflow to .praxis/workflows and reloads it | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:323` |
| PT-C90D5C8EDD | workflow Designer | instantiating Full SDLC (.NET) identifies and installs missing agent dependencies automatically | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:374` |
| PT-9B225D3890 | workflow Designer | validates workflow connections, flow, and configuration via validate workflow button | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:403` |
| PT-4B8346DC79 | workflow Designer | clicking a connection on the canvas selects it and deletes it | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:455` |
| PT-D0F572C234 | workflow Designer | selecting a connection and pressing Delete key removes it | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:476` |
| PT-2CBC383956 | workflow Designer | clicking delete on an agent task removes it from the canvas | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:493` |
| PT-1748C28492 | workflow Designer | selecting an agent task and pressing Delete key removes it | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:507` |
| PT-AA92BCD6EA | workflow Designer | a stage can run on its own AI and model, chosen from the AIs that are set up | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:522` |
| PT-91A53C6CCE | workflow Designer | stage skills are added from the picker dialog and removed from their chip | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:576` |
| PT-FA495A15F3 | workflow Designer | a connection selected on the canvas is edited in the inspector, with no separate tab | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:603` |
| PT-05295BB166 | workflow Designer | floating toolbar provides stage tools, canvas tools, and deletion | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:626` |
| PT-693476E991 | workflow Designer | clicking and dragging on the designer surface pans the canvas without changing zoom | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:695` |
| PT-7AF3949BE5 | workflow Designer | floating toolbar provides agent and skill submenus with scrolling list, icon, and text | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:730` |
| PT-44E72F938B | workflow Designer | submenu displays search box when items exceed 10, filters real-time, and clears on escape or button click | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:853` |
| PT-F895248CB0 | workflow Designer | walks the workflow designer, rings each area, and directs the user through all steps | `apps/praxis-desktop/main/e2e/workflowDesigner.spec.ts:922` |
| PT-2CA87FB459 | workflow Environment Pause | a registry that cannot audit pauses the run instead of failing it; siblings finish and Resume completes it | `apps/praxis-desktop/main/e2e/workflowEnvironmentPause.spec.ts:126` |
| PT-4B8D3275C8 | workflow Environment Pause | a genuine audit finding still fails the run, and the sibling it left running is stopped and recorded | `apps/praxis-desktop/main/e2e/workflowEnvironmentPause.spec.ts:175` |
| PT-F5764CCA2F | workflow Install Deps | without an install stage a fresh run worktree cannot load the dependency, so QA fails — however good the change is | `apps/praxis-desktop/main/e2e/workflowInstallDeps.spec.ts:111` |
| PT-C525D5E06F | workflow Install Deps | an install stage gives the worktree its own dependencies, QA passes, and the main checkout is left untouched | `apps/praxis-desktop/main/e2e/workflowInstallDeps.spec.ts:124` |
| PT-311E757F0F | workflow Loops | a loop edge is drawn distinctly, edited in the inspector, and survives save and reload | `apps/praxis-desktop/main/e2e/workflowLoops.spec.ts:85` |
| PT-99CC50B3E7 | workflow Loops | a back-edge is a cycle unless it carries a loop budget | `apps/praxis-desktop/main/e2e/workflowLoops.spec.ts:131` |
| PT-B198D5BAF8 | workflow Loops | a review that keeps finding a high bug loops back, then waits for a decision that is recorded | `apps/praxis-desktop/main/e2e/workflowLoops.spec.ts:156` |
| PT-635AD53BB9 | workflow Loops | improve until target asks for its goal and target and checks them before it starts | `apps/praxis-desktop/main/e2e/workflowLoops.spec.ts:222` |
| PT-CDF14E0758 | workflow Loops | the loop views read in dark mode too | `apps/praxis-desktop/main/e2e/workflowLoops.spec.ts:253` |
| PT-DE2926E8C8 | workflow Model Tiers | a stage runs on the model its tier maps to, and its report reaches the next stage | `apps/praxis-desktop/main/e2e/workflowModelTiers.spec.ts:131` |
| PT-B34C2C3E33 | workflow Model Tiers | two stage sessions are reached through their project run rather than Conversations | `apps/praxis-desktop/main/e2e/workflowModelTiers.spec.ts:156` |
| PT-52E2281D4E | workflow Model Tiers | Suggest model tiers fills only unset stages of the draft, and settings maps each tier | `apps/praxis-desktop/main/e2e/workflowModelTiers.spec.ts:178` |
| PT-A812915A34 | workflow Model Tiers | a provider row maps tiers by picking its models, and the designer sets a stage tier that survives a save | `apps/praxis-desktop/main/e2e/workflowModelTiers.spec.ts:197` |
| PT-06291D4ECD | workflow Model Tiers | archiving a completed project run retains its sessions and deleting the run removes them | `apps/praxis-desktop/main/e2e/workflowModelTiers.spec.ts:279` |
| PT-B0842DA89F | workflow Policy | creating a project policy from the sidebar persists it and composes it into the effective policy | `apps/praxis-desktop/main/e2e/workflowPolicy.spec.ts:50` |
| PT-9BA804745D | workflow Policy | a global policy composes strictest-wins with a project policy | `apps/praxis-desktop/main/e2e/workflowPolicy.spec.ts:77` |
| PT-3C3795C3D1 | workflow Retry Failed | a failed step on a failed run has a retry icon button that reopens the run | `apps/praxis-desktop/main/e2e/workflowRetryFailed.spec.ts:97` |
| PT-5E977102C0 | workflow Run | runs the governed pipeline: parallel branches converge, then approval unlocks | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:109` |
| PT-9FE32CECFE | workflow Run | a run can be cancelled from the monitor | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:152` |
| PT-5A88D7A45B | workflow Run | completed stages are not re-run after an app restart | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:164` |
| PT-9E73225070 | workflow Run | a deterministic check runs on its own in the run worktree and unblocks approval | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:202` |
| PT-354EF7395F | workflow Run | a gate the workflow allows bypassing, but no policy has granted, explains why in the run monitor | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:290` |
| PT-0BDE1D2468 | workflow Run | approving one of two simultaneously-awaiting approval nodes never touches the other | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:405` |
| PT-5421ABC27D | workflow Run | the run monitor shows one Approve button per simultaneously-awaiting approval node, each targeting its own | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:513` |
| PT-AA73D62E79 | workflow Run | the run monitor reflects an unattended run as the orchestrator drives it | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:684` |
| PT-8EEB06754D | workflow Run | a run started against a ticket writes its outcome back as a comment once it settles | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:706` |
| PT-7CC1A86833 | workflow Run | a write-back that fails is visible in the Output tab, not just the main-process console | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:827` |
| PT-519C8E31CC | workflow Run | a check that outruns its timeout is failed with a stated reason | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:859` |
| PT-897905ACD7 | workflow Run | the stage detail panel opens a failed check’s retained log, reachable by keyboard, with an echoed secret redacted | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:878` |
| PT-718FF673F2 | workflow Run | the stage detail panel shows the empty state for a check that produced no output | `apps/praxis-desktop/main/e2e/workflowRun.spec.ts:916` |
| PT-13ACC04A37 | workflow Run Work | the delete confirm says what work the run has, and deleting the run keeps its branch by default | `apps/praxis-desktop/main/e2e/workflowRunWork.spec.ts:100` |
| PT-5CE920C30E | workflow Run Work | ticking the option deletes the run's branch and worktree too — and only those | `apps/praxis-desktop/main/e2e/workflowRunWork.spec.ts:135` |
| PT-4F95DF8F4A | workflow Run Work | cancelling the confirm deletes nothing | `apps/praxis-desktop/main/e2e/workflowRunWork.spec.ts:156` |
| PT-93F88A4EA2 | workflow Run Workspace | a controller session starts a project run and its stage session fills the run workspace | `apps/praxis-desktop/main/e2e/workflowRunWorkspace.spec.ts:180` |
| PT-B6EB737E60 | workflow Run Workspace | deleting a live run cancels it first, then removes it | `apps/praxis-desktop/main/e2e/workflowRunWorkspace.spec.ts:299` |
| PT-B1E9275BF7 | workflow Run Workspace | an automation run can be renamed and the name persists after reload | `apps/praxis-desktop/main/e2e/workflowRunWorkspace.spec.ts:325` |
| PT-DD166C47F2 | workflow Run Workspace | the start-run dialog opens from a workflow row with that workflow preselected, and lands on the new run | `apps/praxis-desktop/main/e2e/workflowRunWorkspace.spec.ts:374` |
| PT-259EE959B0 | workflow Run Workspace | the Automations header opens a new workflow run | `apps/praxis-desktop/main/e2e/workflowRunWorkspace.spec.ts:393` |
| PT-CCE9452AFD | workflow Run Workspace | a long automation uses a bounded dot rail and exposes every step in the workflow sheet | `apps/praxis-desktop/main/e2e/workflowRunWorkspace.spec.ts:428` |
| PT-D18B652AC9 | workflow Run Workspace | a dirty checkout offers to include its changes: the run sees them, the checkout is untouched | `apps/praxis-desktop/main/e2e/workflowRunWorkspace.spec.ts:515` |
| PT-63B5C57146 | workflow Run Workspace | a dirty checkout can instead start from the last commit without its changes | `apps/praxis-desktop/main/e2e/workflowRunWorkspace.spec.ts:528` |
| PT-AC2482A561 | workflow Run Workspace | a dirty checkout can commit its changes, then the run starts from that commit | `apps/praxis-desktop/main/e2e/workflowRunWorkspace.spec.ts:536` |
| PT-26466F3922 | workflow Run Workspace | starting a run against a workspace folder that is no longer a Git repository shows an actionable message, not raw git plumbing output | `apps/praxis-desktop/main/e2e/workflowRunWorkspace.spec.ts:546` |
| PT-59D76BB99D | workflow Run Workspace | an out-of-credits provider pauses the run instead of failing it, and resumes once credits are back | `apps/praxis-desktop/main/e2e/workflowRunWorkspace.spec.ts:574` |
| PT-3C9A1A5834 | workflow Run Workspace | a stage whose AI ran out can be switched to another AI and carries on | `apps/praxis-desktop/main/e2e/workflowRunWorkspace.spec.ts:641` |
| PT-522BA7819F | workflow Run Workspace | with "Switch AI automatically" the stage moves to another AI without asking | `apps/praxis-desktop/main/e2e/workflowRunWorkspace.spec.ts:681` |
| PT-951522F605 | workflow Run Workspace | with "Stop the run" the run ends saying which AI ran out, and can still carry on with another AI | `apps/praxis-desktop/main/e2e/workflowRunWorkspace.spec.ts:695` |
| PT-5C5F154311 | workflow Run Workspace | a run in Ask mode stops the stage for a tool permission; the same run in Auto-approve mode does not | `apps/praxis-desktop/main/e2e/workflowRunWorkspace.spec.ts:721` |
| PT-05BE089E81 | workflow Run Workspace | auto-approve does not widen a stage: a read-only stage still cannot write | `apps/praxis-desktop/main/e2e/workflowRunWorkspace.spec.ts:791` |
| PT-79DD10EF59 | workflow Run Workspace | a terminal run can be archived, removing it from the sidebar and listing it in the workflow runs browser | `apps/praxis-desktop/main/e2e/workflowRunWorkspace.spec.ts:814` |
| PT-839FD63748 | workflow Session Chips | an existing project session selects and starts governed workflows from one chat chip | `apps/praxis-desktop/main/e2e/workflowSessionChips.spec.ts:43` |
| PT-8B8CDC8743 | workflow Template Addon | the Security Review add-on installs and creates a workflow from its template | `apps/praxis-desktop/main/e2e/workflowTemplateAddon.spec.ts:28` |
| PT-713053459D | workflow Themes | the designer and run monitor hold up on a dark theme | `apps/praxis-desktop/main/e2e/workflowThemes.spec.ts:63` |
| PT-87E3840A56 | working Style | every AI gets the working style; your own wording replaces it, and it can be turned off | `apps/praxis-desktop/main/e2e/workingStyle.spec.ts:35` |
| PT-7C185E0069 | working Style | Praxis’s retired runtime-pin add-ons are removed and never shadow a built-in agent | `apps/praxis-desktop/main/e2e/workingStyle.spec.ts:72` |
| PT-F578B530B6 | workspace File | save and open filter on the .workspace.praxis.json extension and round-trip | `apps/praxis-desktop/main/e2e/workspaceFile.spec.ts:22` |
| PT-F32A737E1C | workspace File | creates a self-contained workspace in a chosen folder and routes its connections there | `apps/praxis-desktop/main/e2e/workspaceFile.spec.ts:68` |
| PT-1FB0CDC71E | zz Ai Provider Redesign Capture | capture implemented first-run wizard | `apps/praxis-desktop/main/e2e/zzAiProviderRedesignCapture.spec.ts:149` |
| PT-EE009E9AE9 | zz Thought Geometry | measure thought + turn geometry | `apps/praxis-desktop/main/e2e/zzThoughtGeometry.spec.ts:22` |

## Contract shape

Every entry carries **Given / When / Then** fields in `catalog.json`. The inventory is generated from the test source, so the count and links are deterministic.

The Praxis Test Author agent may enrich any entry's `flow` prose where a test represents an important user journey. Hand-written prose is never reported stale: `npm run test:praxis-contracts -- --write` carries it over by id. Only the generated identity (id, title, file, project) must match the test source; a moved line number is a warning, not a failure.

Known gaps in the generated inventory: tests whose title is a template literal with expressions are skipped, so parameterized cases are not counted, and every entry is labelled `project: functional` regardless of the Playwright project that actually runs it.
