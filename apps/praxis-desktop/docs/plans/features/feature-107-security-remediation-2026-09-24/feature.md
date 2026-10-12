# Security remediation — 2026-09-24

**Status:** In Progress
**Created:** 2026-09-24T15:41:50.591Z
**Type:** Feature
**Priority:** Highest

## Description

Prioritised remediation of the 19 findings in the Security Review of Praxis at commit `ab05ede`. This plan is the work breakdown. The October 10 status review records the four P0 fixes and the gitleaks gate as shipped. As of 2026-10-12, per child ticket statuses, six items are complete (107-1 to 107-4, 107-8 and task 107-3) and 13 P1–P3 items remain open (Proposed). This is recorded ticket evidence, not a fresh code verification.

## Dependencies

- 107-7 (local-only mobile access) depends on 107-6 (IP address classifier).
- 107-9 (Antigravity permission gate) depends on Decision 3 (whether `agy` can emit permission prompts upstream).
- 107-11 (workspace trust) is the L item; start its design during Phase 3.

## Decisions needed (updated)

1. **SEC-018 — GitHub Actions pinned to mutable tags (Info).** Open. Accept the first-party tag risk, or adopt SHA pinning? Owner: _unassigned_. Target: _TBD_.
2. **SEC-003 — history rewrite.** Resolved 2026-09-24 (see 107-3): the exposed tokens were revoked, so no `git filter-repo` or force-push. Rotation alone was chosen.
3. **SEC-004 — Antigravity's future.** Open. Confirm upstream `agy` capability to emit permission prompts under `--output-format stream-json`; this blocks 107-9. Owner: _unassigned_. Target: _TBD_.
4. **SEC-007 — blanket auto-approval of reads.** Open. Keep auto-approving `read`/`list` once realpath containment holds? Product call. Owner: _unassigned_. Target: _TBD_.
5. **Needs-verification items (a)–(e).** Open. Item (a), OAuth `state` handling in `@modelcontextprotocol/sdk`, may downgrade SEC-014 (107-13) to Info or change its fix. Owner: _unassigned_. Target: _TBD_.

## Work order — superseded

The 2026-10-11 work order is superseded. Its item 1 (107-8) is Done, and its other four tickets (PRX-B00-2, PRX-B00-5, PRX-F45, PRX-F52) belong to other features. Next F107 step: the Phase 2 quick wins 107-5, 107-6 and 107-10.

## Reference notes

- Bug and Task items share numbers 107.1–107.6 in the Items table. Refer to items by their file names or PRX ticket keys until the refs are made unique. Also remove the blank line under the Items table header so the table renders.
- SEC-013 is merged into the 107-1 item (SEC-001), and SEC-015 into the 107-12 item (SEC-012).

## Summary

| Priority | Items | Effort |
|---|---|---|
| P0 — fix immediately | 4 | 3 × S, 1 × M |
| P1 — next iteration | 7 | 4 × S, 3 × M |
| P2 — schedule | 5 | 4 × S, 1 × L |
| P3 — hardening backlog | 3 | 3 × S |
| **Total** | **19** | **14 × S, 4 × M, 1 × L** |

Roughly five to six engineer-weeks in total, but the P0 tier is three S-sized code changes plus one M that is mostly credential rotation and coordination.

**Fixed first, and why.** The two High findings reachable with no privileged user action lead: SEC-001, where the marketplace GitHub PAT is sent as a Bearer credential to a publisher-declared URL on a mere catalogue browse, and SEC-002, where the absent navigation guard turns one click on a model-authored markdown link into terminal RCE through the 299-channel preload bridge. SEC-003 (credentials in reachable git history) is P0 because rotation is the only control that works once clones exist. SEC-010 is Medium by severity but sits on the workflow that signs and publishes the installers users auto-update from, and the fix is a few lines — the largest risk reduction per hour in the whole set.

**Prioritisation.** Severity × exploitability × exposure, then quick wins pulled forward. Findings sharing a root cause or a fix were merged into one item; two findings (SEC-002, SEC-011) were split so their cheap, high-value halves ship without waiting on the expensive half.

**Register accounting.** The report's executive summary table reads 18 findings with 5 Low; its own findings register lists 19 (3 High, 8 Medium, 6 Low, 2 Info). This plan follows the register. Every ID appears in the Coverage table below.

## Suggested phases

**Phase 1 — stop the bleeding (P0).** Restrict marketplace tarball fetches to the configured registry origin; block top-level navigation and window.open; pass `github.ref_name` through the environment and scope the release token. In parallel, and on a separate track because it is not a code change: rotate the exposed credentials and untrack `.vscode/settings.json`. Ships as one release.

**Phase 2 — P1 quick wins (all S).** Resolve symlinks in the agent path sandbox; classify IP addresses properly in the browser SSRF guard; enforce ACP read-only on the tool kind; refuse repo-sourced auto permission mode and stop leaking the app environment to checks. Four self-contained changes, each with its own unit test.

**Phase 3 — P1 structural work (M).** Make local-only mobile access enforce locality (depends on Phase 2's classifier); route Antigravity tool calls through the permission gate; validate the sender frame on every ipcMain handler. These touch running behaviour and need device or provider testing, so they want their own release.

**Phase 4 — P2.** Workspace trust for project-committed workflows (the L item; start its design during Phase 3); harden the mobile LAN listener; validate the OAuth state parameter; delete or rewrite the shell auto-allow list; put gitleaks in CI and in a pre-commit hook.

**Phase 5 — P3 hardening.** The extraction escape check, the GitLab CI `npm install` fallback, and the secrets file mode. Three S items that can ride along with any other release.

## Decisions needed

These need an owner's call and deliberately have no work item.

1. **SEC-018 — GitHub Actions pinned to mutable tags (Info).** Every reference is a first-party `actions/*` repository and `build.yml` already restricts its token to `contents: read`, which is why the review rated it Info. Pinning all nine references to 40-character SHAs plus adopting Dependabot's `github-actions` ecosystem is real ongoing maintenance. **Accept the first-party tag risk, or adopt SHA pinning?** No item either way until this is answered.

The following are scope calls on items that do exist, and should be settled before that item starts:

2. **SEC-003 — history rewrite.** Rotation is non-negotiable and is in the P0 item. Whether to also `git filter-repo` and force-push is a separate call: it invalidates every clone and fork, rewrites every commit SHA after `704b06d9`, and breaks in-flight worktrees and any SHA referenced in a ticket. Rotation alone may be the right answer.

3. **SEC-004 — Antigravity's future.** Implementing the ACP `session/request_permission` relay in the Python wrapper assumes `agy` can emit permission prompts under `--output-format stream-json`. If it cannot, the choice is to ship the loud opt-in permanently or drop the provider. Confirm upstream capability first.

4. **SEC-007 — blanket auto-approval of reads.** The symlink fix is unambiguous and is in the item. Whether to keep auto-approving every `read`/`list` once realpath containment holds is a product call — prompting on out-of-tree reads costs UX on a very hot path.

5. **The report's five Needs-verification items** are not findings and get no item, but need an owner: (a) whether `@modelcontextprotocol/sdk` supplies and verifies OAuth `state` through a provider hook — answering it may downgrade SEC-014 to Info or change its fix; (b) whether `safeStorage` can degrade to `basic_text`, which only matters if a Linux target is ever added; (c) IPv6 behaviour of the mobile allowlists on a dual-stack host — a deny-direction functional defect, folded into the SEC-006 item as a test case; (d) whether `previewAccess.ts` shares the SSRF predicate at a reachable sink — if so it is fixed for free by the classifier item; (e) whether `allowScripts`' `electron@43.4.1` key still matches the installed 43.7.0, which may mean Electron's install script is silently ungated.

## Coverage

| ID | Severity | Item |
|---|---|---|
| SEC-001 | High | Restrict marketplace tarball fetches to the configured registry origin |
| SEC-002 | High | Block top-level navigation and window.open in the main window; **and** Validate the sender frame on every ipcMain handler |
| SEC-003 | High | Rotate the credentials exposed in git history and untrack .vscode/settings.json; **and** Gate commits and CI on gitleaks with fixture fingerprints suppressed |
| SEC-004 | Medium | Route Antigravity tool calls through the permission gate |
| SEC-005 | Medium | Classify IP addresses properly in the browser SSRF guard |
| SEC-006 | Medium | Make local-only mobile access enforce locality and bind to the chosen interfaces |
| SEC-007 | Medium | Resolve symlinks in the agent path sandbox before reading |
| SEC-008 | Medium | Delete or rewrite the shell auto-allow list before it can be reconnected |
| SEC-009 | Medium | Enforce ACP read-only mode on the tool kind, not the agent's prose |
| SEC-010 | Medium | Pass github.ref_name through the environment and scope the release workflow token |
| SEC-011 | Medium | Refuse auto permission mode from project-sourced workflows and stop leaking the app environment to checks; **and** Require workspace trust before a project-committed workflow can run |
| SEC-012 | Low | Harden the mobile LAN listener: handshake timeout, connection caps, deny-by-default authorization |
| SEC-013 | Low | Restrict marketplace tarball fetches to the configured registry origin |
| SEC-014 | Low | Validate the OAuth state parameter on the loopback callback |
| SEC-015 | Low | Harden the mobile LAN listener: handshake timeout, connection caps, deny-by-default authorization |
| SEC-016 | Low | Remove the npm install fallback from GitLab CI |
| SEC-017 | Low | Make the add-on extraction escape check real, or remove it |
| SEC-018 | Info | *No item — see Decisions needed #1 (accept or adopt SHA pinning)* |
| SEC-019 | Info | Write the secrets file with mode 0600 and repair permissive files on read |

## Items

| Ref | Type | Name | Status |
| --- | --- | --- | --- |

| 107.1 | Bug | [P0] Restrict marketplace tarball fetches to the configured registry origin | ✅ Complete |
| 107.2 | Bug | [P0] Block top-level navigation and window.open in the main window | ✅ Complete |
| 107.3 | Bug | [P0] Rotate the credentials exposed in git history and untrack .vscode/settings.json | ✅ Complete |
| 107.4 | Bug | [P0] Pass github.ref_name through the environment and scope the release workflow token | ✅ Complete |
| 107.5 | Bug | [P1] Resolve symlinks in the agent path sandbox before reading | 📋 Proposed |
| 107.6 | Bug | [P1] Classify IP addresses properly in the browser SSRF guard | 📋 Proposed |
| 107.7 | Bug | [P1] Make local-only mobile access enforce locality and bind to the chosen interfaces | 📋 Proposed |
| 107.8 | Bug | [P1] Enforce ACP read-only mode on the tool kind, not the agent's prose | ✅ Complete |
| 107.9 | Bug | [P1] Route Antigravity tool calls through the permission gate | 📋 Proposed |
| 107.1 | Task | [P1] Validate the sender frame on every ipcMain handler | 📋 Proposed |
| 107.10 | Bug | [P1] Refuse auto permission mode from project-sourced workflows and stop leaking the app environment to checks | 📋 Proposed |
| 107.11 | Bug | [P2] Require workspace trust before a project-committed workflow can run | 📋 Proposed |
| 107.12 | Bug | [P2] Harden the mobile LAN listener: handshake timeout, connection caps, deny-by-default authorization | 📋 Proposed |
| 107.13 | Bug | [P2] Validate the OAuth state parameter on the loopback callback | 📋 Proposed |
| 107.2 | Task | [P2] Delete or rewrite the shell auto-allow list before it can be reconnected | 📋 Proposed |
| 107.3 | Task | [P2] Gate commits and CI on gitleaks with fixture fingerprints suppressed | ✅ Complete |
| 107.4 | Task | [P3] Make the add-on extraction escape check real, or remove it | 📋 Proposed |
| 107.5 | Task | [P3] Remove the npm install fallback from GitLab CI | 📋 Proposed |
| 107.6 | Task | [P3] Write the secrets file with mode 0600 and repair permissive files on read | 📋 Proposed |
## Dependencies


## Work order — 2026-10-11

The recommended work queue is limited to the five reviewed tickets:

| Order | Ticket | Next bounded action |
| --- | --- | --- |
| 1 | PRX-F107 | Implement and verify the existing [ACP read-only enforcement item](bug-107-8-p1-enforce-acp-read-only-mode-on-the-tool-kind-not-the-agent-s-prose.md) (SEC-009). |
| 2 | PRX-B00-2 | Fix sidebar clipping; verify minimum-height scrolling and keyboard access. |
| 3 | PRX-B00-5 | Keep both paused and not_started sessions visible beyond the collapse limit and in Live. |
| 4 | PRX-F45 | Reconcile the successful delivery run with acceptance evidence; close or fix demonstrated gaps. |
| 5 | PRX-F52 | Resolve existing story readiness questions, then deliver Capture → What Changed → Daily Review. |

Order 1 selects the existing ACP child, not completion of the whole remediation feature. Other F107 findings remain open with their existing priorities. The P0/gitleaks rows above now match their child ticket statuses; no completed security fix was independently re-verified in this requirements update.

## Comments

**2026-10-10:** Status corrected during backlog review: the four P0 items (107-1..107-4) and the gitleaks gate shipped; 13 P1-P3 items were re-checked against the code and are all still unfixed, so the feature stays open.

### 2026-10-11 — SEC-009 closeout

107-8 is Done with core coverage and the prior desktop read-only denial test passing. The earlier work queue and count of 13 open findings predate this fix; 12 P1–P3 items remain open. F107 remains open. The prior full desktop run had 590 passed, 3 skipped and 1 workflow-model-tier failure; no E2E rerun was performed.


**PRX-F107** — 2026-10-11T23:57:02.658Z
Kickoff plan. Ticket already In Progress; P0s, 107-8 and gitleaks gate are recorded complete, so no rework. Next per feature.md: Phase 2 quick wins 107-5 (symlink sandbox), 107-6 (SSRF IP classifier), 107-10 (auto permission mode/env leak). First I'll verify against code (commit c66dec2b may already cover some items), then implement only what is missing, with unit tests, and update the item statuses.

**PRX-F107** — 2026-10-11T23:57:48.858Z
Progress summary (verified against code, not just ticket text).
Verified already implemented in the tree (commit c66dec2b and earlier): 107-5 (realpath sandbox + pathSandbox.test), 107-6 (non-public IP classifier + DNS check), 107-10 (project 'auto' downgraded to ask with warning; check env allowlist), task 107-5 (no npm install fallback), task 107-6 (secrets file 0600). Only gap found: no test for the check-process env allowlist — added one in apps/praxis-desktop/main/src/main/workflowCheckProcess.test.ts.
Verification: npm run test:core 1529/1529 pass; npm run test:workflows 61/61 pass. Plan statuses for those five items set to Complete.
NOT verified/left open: 107-7, 107-9 (blocked on Decision 3: can agy emit permission prompts), 107-11, 107-12, 107-13, task 107-1, 107-2, 107-4. Commit c66dec2b claims some of these (IPC senders, mobile hardening, OAuth state, trust) but I did not review them, so the ticket stays In Progress. Nothing committed.

**PRX-F107** — 2026-10-12T00:15:23.679Z
**Workflow run failed: Governed delivery — Security remediation — 2026-09-24**

Status: Failed · Duration: 18m 23s

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ✅ Praxis Test contracts: succeeded
- ⏳ Review: running
- ⏳ Install dependencies: running
- ⏳ Build: pending
- ⏳ QA: pending
- ❌ Security scan: failed

Required stage "security" failed.

**PRX-F107** — 2026-10-12T06:47:53.284Z
**Workflow run failed: Run - Security remediation — 2026-09-24**

Status: Failed · Duration: 6h 50m

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ✅ Praxis Test contracts: succeeded
- ✅ Review: succeeded
- ✅ Install dependencies: succeeded
- ✅ Build: succeeded
- ❌ QA: failed
- ✅ Security scan: succeeded

Required stage "qa" failed.

**PRX-F107** — 2026-10-12T07:11:21.025Z
**Workflow run failed: Run - Security remediation — 2026-09-24**

Status: Failed · Duration: 7h 14m

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ✅ Praxis Test contracts: succeeded
- ✅ Review: succeeded
- ✅ Install dependencies: succeeded
- ✅ Build: succeeded
- ❌ QA: failed
- ✅ Security scan: succeeded

Required stage "qa" failed.

**PRX-F107** — 2026-10-12T09:00:28.186Z
**Workflow run failed: Run - Security remediation — 2026-09-24**

Status: Failed · Duration: 9h 3m

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ✅ Praxis Test contracts: succeeded
- ✅ Review: succeeded
- ✅ Install dependencies: succeeded
- ✅ Build: succeeded
- ❌ QA: failed
- ✅ Security scan: succeeded

Required stage "qa" failed.

**PRX-F107** — 2026-10-12T10:08:12.758Z
**Workflow run succeeded: Run - Security remediation — 2026-09-24**

Status: Succeeded · Duration: 10h 11m

- ✅ Plan: succeeded
- ✅ Implement: succeeded
- ✅ Praxis Test contracts: succeeded
- ✅ Review: succeeded
- ✅ Install dependencies: succeeded
- ✅ Build: succeeded
- ✅ QA: succeeded
- ✅ Security scan: succeeded