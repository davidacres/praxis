# FX-BE-035 — Real GitHub backend

**Type:** Story  **Status:** Planned  **Priority:** P2  **Depends on:** —

## Business or operational impact
The target audience is mostly on GitHub, not Jira. A GitHub connection exists in the UI today but saves as metadata only — no real board behind it.

## Scope
- REST/GraphQL client authenticated via the already-stored PAT.
- Issue listing mapped to `IssueTrackerService`; an auto-synthesized board.
- Create/edit; OAuth as a later PAT alternative if warranted.

## Acceptance criteria
- A GitHub connection with a valid PAT lists real issues as a board.
- Create/edit round-trips to the real GitHub issue.
- An invalid PAT fails clearly, never falling back to demo data.

## Validation
- `npm run check-types`
- `npm run test:core`
- `npm run test:desktop`

## Close when
Connecting a GitHub repo gives the same real-board answer Jira Cloud and GitLab already do.
