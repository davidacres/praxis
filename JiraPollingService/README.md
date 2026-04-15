# JiraPollingService

`JiraPollingService` is the Node.js polling runtime used by the extension.

It polls Jira every 30 seconds and reports issues in project `KAMAI` that:

- have the label `syscfg`
- are in status `To Do`

They use the exact Jira access pattern verified in this repo: resolve the internal Atlassian load balancer DNS name, connect to the returned private `10.x.x.x` IPs, and preserve the hostname `jira.example.com` for TLS and bearer-token auth.

## What It Polls

Human board reference:

`https://jira.example.com/secure/RapidBoard.jspa?rapidView=9402&projectKey=KAMAI`

The service does not scrape the board page. It calls the Jira REST API search endpoint with this JQL:

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

To test the same linked-epic path the extension uses without editing `appsettings.json`:

```powershell
$env:JIRA_TOKEN = "your-jira-personal-access-token"
node .\JiraPollingService\node\cli.js --once --linked-epic KAMAI-123
```

Optional runtime overrides:

- `--config <path>` to point at a different `appsettings.json`
- `--linked-epic <ISSUE-123>` to supply the required epic key at runtime
- `--required-label <label>` to override the AI gate label
- `--required-status <status>` to override the Jira status filter

## Build

No separate build step is needed for the poller runtime. It runs directly with Node.

## Test The Node.js Rewrite

Run the standalone Node tests:

```powershell
node --test .\JiraPollingService\node\polling.test.js
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