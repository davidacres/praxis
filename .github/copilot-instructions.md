# Ticket Manager — Copilot / Agent Instructions

These rules apply to every autonomous session launched from the Ticket Manager
extension. They are also the rules the delivery workflow itself relies on.

## Permissions

- Ticket Manager agents run with full permissions by default.
- Never ask the user to confirm a permission prompt — the extension auto-approves
  every request coming from the Copilot SDK (`onPermissionRequest` always returns
  `approved`). If you ever observe a permission prompt, that is a bug, not a
  policy the agent should satisfy by pausing.
- You still must not attempt destructive operations outside the stated task
  scope. "Auto-approved" means "no user prompt", not "do anything".

## Git worktrees

- The extension creates a git worktree under `<repo-root>/.worktrees/<ISSUE-KEY>-<slug>`
  and checks out a new branch named identically to the worktree.
- Run every git command for a delivery task from **inside the worktree directory**
  (not from the main checkout). Use `cd <worktreePath>` first or pass
  `-C <worktreePath>` to git.
- Worktrees share the same `.git/config` as the main repo, so any credential or
  URL-rewrite rule set at the repo level automatically applies to every worktree.

## Pushing from a worktree (non-interactive)

The remote `origin` is configured as HTTPS:

```text
https://git.example.com/example/software/ai/tools/ticket-manager-extension.git
```

Use one of the following push patterns. Both avoid SSH prompts.

### Option A — `GITLAB_TOKEN` env var (preferred for agents)

```powershell
# From inside the worktree (or with -C <worktreePath>)
$auth = [Convert]::ToBase64String(
    [Text.Encoding]::UTF8.GetBytes("oauth2:$env:GITLAB_TOKEN")
)
git -c "http.extraHeader=Authorization: Basic $auth" push -u origin HEAD
```

Rules:
- Require `$env:GITLAB_TOKEN` to be present before pushing. If it is missing,
  stop and report the failure — do not fall back to SSH.
- Never write the token to a file, commit it, or echo it into the session
  transcript. Only pass it through `-c http.extraHeader=...` as shown above.
- The `oauth2:` username is required by GitLab for PAT-based HTTPS auth.

### Option B — Git Credential Manager (interactive developer flow)

```powershell
git push -u origin HEAD
```

This works on developer machines where Git Credential Manager has already cached
HTTPS credentials. It is NOT reliable inside agent sessions because the first
push may trigger a browser auth prompt — prefer Option A whenever the token is
available.

### What NOT to do

- Do not attempt `ssh-add`, `eval $(ssh-agent)`, or prompt the user for a
  passphrase.
- Do not rewrite `origin` with `git remote set-url` unless the task explicitly
  asks you to change remotes.
- Do not push with `--force` or `--force-with-lease` unless the task explicitly
  calls for it.

## Jira comment handling

- When the extension posts a clarification request and polls for a reply, it
  only treats a comment as a reply when the comment starts with the literal
  trigger `#AIbot` (case-insensitive). Any other commentary on the ticket is
  ignored so the bot never responds to unrelated discussion.
- When drafting clarification requests, tell the user to prefix their reply with
  `#AIbot` if they want the agent to pick it up. Example:
  `Reply with "#AIbot <your answer>" so the bot sees your response.`
