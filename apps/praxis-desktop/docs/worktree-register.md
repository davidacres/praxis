# Local branch and worktree register

Snapshot: 2026-11-09. This is a manual inventory of this machine, not a live Git view. Refresh it whenever a branch or worktree is created, handed over, merged or removed. Paths and status can differ on another machine.

| Branch | Worktree | Purpose | Status and outstanding work |
| --- | --- | --- | --- |
| `main` | `/Users/daveacres/dev/tools/praxis` | Primary checkout and integration branch for the Rust migration. | Rust mobile transport integrated by fast-forward at `bae0753e` before this register refresh; 77 commits ahead of the local `origin/main` reference, which was not fetched. Untracked `apps/praxis-desktop/.agents/` remains untouched; review before removing. |
| `worktree-agent-a8abe85fe9cfcb5b9` | `/Users/daveacres/dev/tools/praxis/.claude/worktrees/agent-a8abe85fe9cfcb5b9` | TASK-520 mobile host foundations and projections. | At `f3178f5f`, with no unique commits (ten behind the `bae0753e` integration snapshot). Original untracked `crates/praxis-mobile/src/host/services.rs` and `scheduled_runs.rs` are preserved. Reviewed copies, fixes and tests are integrated at `50d82fef`; these older originals are superseded, not another unfinished handoff. |
| `codex/mobile-host` | `/private/tmp/praxis-mobile-host` | TASK-520: host-service handoff and Rust mobile transport. | At `bae0753e`, clean and merged into local `main`. TCP/Noise listener and outbound relay client implemented. Fresh evidence: 974 Rust workspace tests passed, 1 optional test ignored by the default run; that real TypeScript phone test passed explicitly over TCP and relay. Mobile Clippy, host build and formatting passed. See [transport evidence](rust-mobile-transport.md). Earlier 110 TypeScript and 4 desktop baseline checks were not rerun for this slice. Desktop adapters/interface discovery and Rust-backed mobile/Flutter/CI cutover proof remain open; no mobile IPC delegation is enabled. |

## Keeping this register current

When creating a branch or worktree, add its branch name, absolute path, purpose, owner or task, starting point and current status. Update the entry at handover and after integration; record uncommitted or untracked work and any remaining action. When retiring one, verify its unique commits and working-tree changes first, preserve needed work, then record its removal or remove its entry. Never force-delete unmerged history without explicit approval.

For a fresh inventory, run `git worktree list --porcelain`, `git branch -vv`, and `git status --short` in each worktree. Compare each branch against the intended integration branch with `git rev-list --left-right --count main...<branch>` and inspect any unique commits and diffs. A clean Git status does not establish that ignored files are disposable.
