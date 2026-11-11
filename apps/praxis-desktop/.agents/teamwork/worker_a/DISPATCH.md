## 2026-11-08T16:12:56Z

You are assigned as Worker A to implement Milestone M1 (Workstream A: Workflows in `crates/praxis-workflows`).

Your Identity & Working Context:
- Working directory: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop (Repo root is /Users/daveacres/dev/tools/praxis)
- State folder: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/worker_a
- Original Request path: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/ORIGINAL_REQUEST.md
- Project Plan path: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/orchestrator_1/PROJECT.md
- Explorer Findings path: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/explorer_survey_a/handoff.md

Write Ownership:
You have exclusive write ownership of ONLY:
- `crates/praxis-workflows/src/cron_scheduler.rs`
- `crates/praxis-workflows/src/lib.rs`
- `apps/praxis-desktop/docs/plans/features/fx-bf-114-rust-and-tauri-migration/stories/fx-be-197-workflows-run-profiles-and-scheduler/task-522-port-run-service-manager-and-deployments.md`
- `apps/praxis-desktop/docs/plans/features/fx-bf-114-rust-and-tauri-migration/stories/fx-be-197-workflows-run-profiles-and-scheduler/task-523-port-scheduled-runs-and-lease-recovery.md`
Do NOT write to files outside this set!

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Task Objectives:
1. Read `ORIGINAL_REQUEST.md` and `explorer_survey_a/handoff.md`.
2. Follow Section 5 of `explorer_survey_a/handoff.md` to:
   - Create `crates/praxis-workflows/src/cron_scheduler.rs` using `cron::Schedule` and `chrono_tz::Tz`, implementing `CronSchedule`, error types, `next_after`, and `find_overdue_runs`.
   - Register `pub mod cron_scheduler;` in `crates/praxis-workflows/src/lib.rs`.
   - Add comprehensive unit tests in `cron_scheduler.rs` covering valid/invalid cron expressions, timezone conversions, next occurrences, and missed/overdue interval detection.
   - Verify `cargo test -p praxis-workflows` passes 100%.
   - Verify `cargo clippy -p praxis-workflows --all-targets --all-features -- -D warnings` is clean.
   - Update `task-522-port-run-service-manager-and-deployments.md` and `task-523-port-scheduled-runs-and-lease-recovery.md` task logs with progress/completion comments.
3. Write your completion report to `/Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/worker_a/handoff.md` including exact verification commands and results.
4. Notify orchestrator via send_message with a brief summary and handoff path.
