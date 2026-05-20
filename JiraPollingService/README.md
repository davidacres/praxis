# JiraPollingService

`JiraPollingService` is the Node.js polling and delivery runtime used by the extension and by standalone local debugging commands.

The extension can start the poller when `ticketManager.jiraPolling.enabled` is true and the active backend is Jira via MCP or Jira Cloud. This setting is disabled by default, so polling is opt-in. In Jira Cloud mode, the poller also follows the linked workspace epic from `ticketManager.jiraCloudEpicKey`; linked-epic tasks are synced regardless of label, while the required label controls which tasks are eligible for AI execution.

In its default standalone configuration, it polls Jira every 30 seconds and reports issues in project `KAMAI` that:

- have the label `syscfg`
- are in status `To Do`

They use the exact Jira access pattern verified in this repo: resolve the internal Atlassian load balancer DNS name, connect to the returned private `10.x.x.x` IPs, and preserve the hostname `jira.example.com` for TLS and bearer-token auth.

## What It Polls

Human board reference:

`https://jira.example.com/secure/RapidBoard.jspa?rapidView=9402&projectKey=KAMAI`

The service does not scrape the board page. In standalone/default mode, it calls the Jira REST API search endpoint with this JQL:

```text
project = "KAMAI" AND labels = "syscfg" AND status = "To Do" ORDER BY updated DESC
```

## Jira Access Quirks

These are the important Jira-specific quirks discovered while testing this environment:

1. Direct calls to `https://jira.example.com` can fail in corporate environments due to certificate revocation or SSO-related network behavior.
2. The reliable pattern is to resolve `internal-Atlassian-Prod-LB-Jira-Internal-195841951.eu-west-1.elb.amazonaws.com` and connect to one of the returned private `10.x.x.x` addresses.
3. You must still use the hostname `jira.example.com` for the request target and TLS host.
4. Jira authentication works with `Authorization: Bearer <personal-access-token>`.
5. The internal IPs are dynamic. Do not hardcode a single IP long-term. This service resolves them on each connection attempt and tries all available candidates.

## Configuration

Configuration lives in `appsettings.json` under the `JiraPolling` section.

Preferred token setup is via environment variable:

```powershell
$env:JIRA_TOKEN = "your-jira-personal-access-token"
```

You can also place the token in `JiraPolling:Token`, but environment variable is preferred.

Available settings:

- `BaseUrl`: Jira base URL. Default is `https://jira.example.com`
- `InternalDns`: internal Jira LB DNS name
- `PreferredResolveIp`: optional preferred private IP to try first
- `Token`: optional fallback token if `JIRA_TOKEN` is not set
- `BoardUrl`: human reference only
- `ProjectKey`: Jira project key to query
- `RequiredLabel`: required label filter
- `RequiredStatus`: required Jira issue status filter
- `PollIntervalSeconds`: polling interval in seconds
- `MaxResults`: search page size

## Run

From the repo root:

```powershell
$env:JIRA_TOKEN = "your-jira-personal-access-token"
node .\JiraPollingService\node\cli.js
```

For a single isolated polling pass:

```powershell
$env:JIRA_TOKEN = "your-jira-personal-access-token"
node .\JiraPollingService\node\cli.js --once
```

To test the same linked-epic path the extension uses in Jira Cloud mode without editing `appsettings.json`:

```powershell
$env:JIRA_TOKEN = "your-jira-personal-access-token"
node .\JiraPollingService\node\cli.js --once --linked-epic KAMAI-123
```

Optional runtime overrides:

- `--config <path>` to point at a different `appsettings.json`
- `--linked-epic <ISSUE-123>` to supply the required epic key at runtime
- `--required-label <label>` to override the AI gate label
- `--required-status <status>` to override the Jira status filter

## Extension Settings

When launched by the extension, the poller is controlled by Ticket Manager settings:

- `ticketManager.jiraPolling.enabled`
- `ticketManager.jiraPolling.requiredLabel`
- `ticketManager.jiraPolling.clarificationAnalysis`
- `ticketManager.jiraCloudBaseUrl`
- `ticketManager.jiraCloudToken` or `JIRA_TOKEN`
- `ticketManager.jiraCloudEpicKey`
- `ticketManager.delivery.defaultBaseBranch`
- `ticketManager.delivery.autoMergeSubTasks`
- `ticketManager.ai.deliveryWorkflowEnabled`
- `ticketManager.ai.deliveryPublishCommand`
- `ticketManager.ai.deliveryArtifactPattern`
- `ticketManager.ai.deliveryAgentWorkflowPath`
- `ticketManager.ai.deliveryAgentWorkflowUrl`
- `ticketManager.ai.deliverySummaryTemplate`
- `ticketManager.ai.deliveryFailureTemplate`

Delivery mode uses the Jira Cloud REST path for comments, attachments, linked epic/sub-task data, and artifact publication. Jira MCP mode can still be used for browsing, but direct attachment upload/download is handled through the Jira Cloud backend.

## Build

No separate build step is needed for the poller runtime. It runs directly with Node.

## Test The Node.js Rewrite

Run the standalone Node tests:

```powershell
node --test .\JiraPollingService\node\polling.test.js
```

## Standalone Jira MR Poller

There is now a second standalone runtime for local MR-driven testing:

```powershell
node .\JiraPollingService\node\standalone-cli.js --repo-path C:\dev\system-configurator --issue-key KAMAI-999991
```

This service reuses the Jira poller structure, but runs independently of the extension and adds GitLab merge-request polling with local JSON state.

What it does:

- tracks either Jira-linked issue keys or explicit `--issue-key` values
- resolves the GitLab project from `--repo-path` when `GITLAB_URL` and `GITLAB_PROJECT` are not set
- polls matching merge requests and discussions using `GITLAB_TOKEN`
- establishes a baseline on first sight of an MR, then logs newly added or updated comments on later polls
- keeps merge-request state in `.standalone-jira-mr-state.json` by default
- arms merge-time MSI generation only when the service itself later reports code edits on an existing MR

Useful flags:

- `--once`
- `--repo-path <path>`
- `--issue-key <ISSUE-123>` (repeatable)
- `--state-path <path>`
- `--poll-interval <seconds>`
- `--gitlab-url <url>`
- `--gitlab-project <group/project>`
- `--mode dry-run|mutable`
- `--executor-command <shell command>`
- `--publish-command <shell command>`
- `--artifact-pattern <glob or relative path>`

To run the standalone unit tests:

```powershell
node --test .\JiraPollingService\node\standalone.test.js
```

## Expected Output

On startup, the service logs the Jira board reference and JQL. On each polling cycle it logs:

- the number of matching issues
- each matching issue key and summary
- newly matching issues since the previous poll
- issues that no longer match the filter

## Notes

1. This project is intentionally isolated from the existing TokenWise application structure.
2. It is kept in its own folder so the standalone poller can still be run independently of the extension during debugging.
3. If board-column filtering is needed beyond project, label, and raw Jira status, the next step would be to query Jira Agile board/filter metadata and fold that into the polling logic.

