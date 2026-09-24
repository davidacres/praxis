# [P0] Rotate the credentials exposed in git history and untrack .vscode/settings.json

**Status:** 📋 Proposed
**Created:** 2026-09-24T15:41:51.911Z
**Type:** Bug
**Priority:** Medium
**Severity:** Medium
**Reported By:**
**Parent:** PRX-F107

## Description
**Priority:** P0 · Part of plan PRX-F107: Security remediation — 2026-09-24

## Findings

- **SEC-003** (High, CWE-540 / CWE-798) — `.vscode/settings.json:8` and `:14` at commits `c957547f` and `a96a7200` (GitLab PAT, GitLab API key); `.vscode/settings.json:10` and `:17` at `eeb14143` and `a96a7200` (Jira OAuth client id); `claude-bedrock-capture.json:6,24,42,61,92,123` at `704b06d9` (AWS access tokens).

The prevention half — wiring gitleaks into a hook and CI — is tracked separately as *Gate commits and CI on gitleaks with fixture fingerprints suppressed*.

## Why this priority

High and already exposed to everyone who has ever cloned, forked or run CI on this repository. The working tree is clean (`.vscode/settings.json` is literally `{}` and the capture file was deleted at `abf4558`) but the blobs remain reachable — verified with `git cat-file -e`. Two were committed under corporate author addresses, which is the review's reason for treating them as real rather than fixtures. Rotation is the only remediation that actually works, and it cannot wait on anything else.

## Change

No application code.

- Rotate at each issuer and audit access logs since the commit dates: the GitLab personal access token and GitLab API key, the Atlassian/Jira OAuth client credential, and the AWS access tokens. Treat all four types as compromised.
- Add `.vscode/settings.json` to `.gitignore` — it currently covers only `.vscode-test/` — and `git rm --cached` it, committing a `.vscode/settings.example.json` placeholder so the intended keys are still discoverable.
- If the owner approves the history rewrite (see the feature's Decisions needed), purge the blobs with `git filter-repo` and coordinate a force-push with every clone and fork holder.

## Verification

Confirm at each issuer that the old credential is revoked — an API call carrying it returns 401. After any purge, `git log --all --patch -- .vscode/settings.json claude-bedrock-capture.json` shows no credential values, and a gitleaks history scan reports nothing for the `gitlab-pat`, `generic-api-key` and `aws-access-token` rules. What keeps it fixed is the CI gate in the companion item, not this one.

## Effort

M

## Depends on

None.

## Risk

Rotation breaks whatever CI job or local tooling consumes those credentials — identify the consumers before revoking. A history rewrite changes every commit SHA from the earliest purged commit onward: open PRs, live agent worktrees under `.worktrees/`, and any SHA referenced in a ticket or doc all break. Do it in a scheduled window with every clone holder notified, or accept rotation alone.

## Steps to Reproduce
1. 

## Expected Behavior


## Actual Behavior


## Dependencies


## Comments

