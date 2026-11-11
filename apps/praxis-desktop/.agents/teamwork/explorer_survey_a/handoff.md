# Exploration Report: Workstream A (Workflows FX-BE-197 / TASK-522 & TASK-523)

## 1. Observation

### 1.1 Requirements and Story Context
- **ORIGINAL_REQUEST.md** (`apps/praxis-desktop/.agents/teamwork/ORIGINAL_REQUEST.md`, lines 11-13 & 31-33):
  > "### R1. Workstream A: Complete Workflows (FX-BE-197) in `crates/praxis-workflows`
  > - Implement TASK-522: run service manager with readiness probes (HTTP, TCP, command exits).
  > - Implement TASK-523: cron scheduler, overdue run detection, and durable lease recovery.
  > 
  > ### Acceptance Criteria
  > ### Workstream A (Workflows)
  > - [ ] `cargo test -p praxis-workflows` runs and passes, verifying service manager readiness probes (HTTP, TCP, command exits), cron scheduling, overdue run detection, and durable lease recovery."

- **Story FX-BE-197** (`apps/praxis-desktop/docs/plans/features/fx-bf-114-rust-and-tauri-migration/stories/fx-be-197-workflows-run-profiles-and-scheduler/`):
  - `story.md`: In Progress. Covers porting workflow orchestrator, run profile service manager, deployments, and cron-based scheduled runs.
  - `task-521-port-workflow-state-machine-and-gates.md`: Marked Done on 2026-11-08.
  - `task-522-port-run-service-manager-and-deployments.md`: Marked In Progress. Comments note:
    > "2026-11-08: Partially done, in three commits (`f95265e7`, `7731cee9`, and the previews commit that follows). `crates/praxis-workflows` now has `run_profile` (validation, parse and serialize), `run_profile_store` and `run_profile_discovery` (`package.json` and `launchSettings.json` proposals), `run_reconciliation` (run-state persistence and pid liveness), `run_service_manager` (tokio supervisor per service: readiness via none, log-line, tcp and http probes; dependency waits; timeout; per-service start, stop and restart; process-group SIGTERM then SIGKILL) and `preview_verification` (assertions, outcome, failure context)... Not done: `directoryTarget`, `directDeploymentOrchestrator`, `directProcessExecutor`, and `githubActions*` under `packages/core/src/deployments/`."
  - `task-523-port-scheduled-runs-and-lease-recovery.md`: Marked In Progress. Comments note:
    > "2026-11-08: Six commits. The core of `packages/core/src/scheduledRuns/` is now in `crates/praxis-workflows`, split the way the TypeScript was: `scheduled_run` (the durable definition and its pure operations), `scheduled_run_store` (durable storage over a key-value backend), `scheduled_run_time` (IANA zones), `scheduled_budget` (which provider a ticket may run on), `scheduled_run_execution` (the transitions the runner applies), `scheduled_run_runner` (the orchestration, with every side effect behind a port), `scheduled_run_readiness`, `scheduled_ticket_status`, `exclusive_resource`, `scheduled_run_request`, `scheduled_run_forecast` and `scheduled_run_detail` (the stage order)..."

### 1.2 Current Codebase State in `crates/praxis-workflows`
- **Dependencies** (`crates/praxis-workflows/Cargo.toml`):
  - Dependencies include `praxis-contracts`, `praxis-core`, `async-trait`, `chrono`, `chrono-tz`, `cron` (workspace `cron = "0.15"`), `indexmap`, `portable-pty`, `serde`, `serde_json`, `sha2`, `thiserror`, `tokio`, `tokio-util`, `uuid`, and Unix `nix`.
- **Test Baseline**:
  - `cargo test -p praxis-workflows` executes cleanly:
    - `src/lib.rs` (unittests): 234 passed; 0 failed
    - `tests/orchestrator.rs`: 33 passed; 0 failed
    - `tests/run_parity.rs`: 1 passed; 0 failed
    - Total: 268 tests passed, 0 failed, duration ~2.26s.
  - `cargo clippy -p praxis-workflows --all-targets -- -D warnings`: compiles cleanly with 0 warnings.
  - `npm --prefix /Users/daveacres/dev/tools/praxis run test:core`: 2033 passed, 0 failed.

### 1.3 State of TASK-522: Run Service Manager & Readiness Probes
- **File**: `crates/praxis-workflows/src/run_service_manager.rs` (1,368 lines)
  - **Readiness Probes**:
    - `Http`: Lines 740-750, 852-878 (`check_http_ok`). Sends `GET {path}` over raw TCP socket, parses HTTP status response, checks against `expected_status` (defaults to 200-299). Polled every `PROBE_POLL_INTERVAL` (100ms) until success or `readiness_timeout`. Tested in `an_http_probe_checks_the_declared_path_and_status` (line 1051) and `an_http_probe_without_a_declared_port_fails_before_anything_is_spawned` (line 1084).
    - `Tcp`: Lines 734-739, 837-850 (`probe_tcp`). Attempts `TcpStream::connect("127.0.0.1:{port}")`. Polled every 100ms. Tested in `a_tcp_probe_is_satisfied_once_the_port_accepts_connections` (line 1034) and `a_port_already_held_by_something_else_fails_the_service_without_spawning_it` (line 1108).
    - `LogLine`: Lines 621-646, 761-796 (`spawn_log_reader`). Spawns reader tasks for `child.stdout` and `child.stderr`. Checks lines against `match_text`. Notifies `ready_tx`. Tested in `a_log_line_probe_is_satisfied_by_matching_output_and_streams_it` (line 1006).
    - `None`: Line 733. Sleeps for `NO_PROBE_SETTLE` (150ms). Tested in `a_service_with_no_probe_becomes_ready_once_it_settles_and_stop_tears_it_down` (line 991).
  - **Command Exits**:
    - Exit before ready: Lines 653, 673-686. In `launch_and_probe`, `tokio::select!` listens on `status = child.wait() => Phase::Exited(status)`. Captures exit code and signal, sets state to `RunServiceState::Failed`, format message `"{name} exited before it became ready (code {code})."`. Tested in `a_service_that_exits_before_becoming_ready_is_failed_not_ready` (line 1129) and `a_service_is_never_spawned_once_something_it_depends_on_fails` (line 1148).
    - Unexpected exit after ready: Lines 711-723. In `watch_until_exit`, `status = running.child.wait()`. If not cancelled, marks service `Failed` with message `"{name} exited unexpectedly."`, exit code, and signal. Tested in `a_service_that_exits_unexpectedly_after_ready_is_marked_failed` (line 1235).
    - Process Tree Termination: Lines 880-928. Gracefully sends SIGTERM to process group (`nix::sys::signal::killpg`), waits up to 3s, then SIGKILL (`killpg(SIGKILL)`). On Windows, invokes `taskkill /PID {pid} /T /F`.
  - **Related Modules**:
    - `run_profile.rs`: validation, deserialization, serialization, and secret redaction.
    - `run_profile_store.rs`: durable storage of run profiles on disk (`run-profiles.json`).
    - `run_profile_discovery.rs`: automated project scanning for scripts in `package.json` (`dev`, `start`, `serve`) and `launchSettings.json`.
    - `run_reconciliation.rs`: persistence in `run-state.json` and PID liveness checking via signal 0 (`is_pid_alive`).
    - `preview_verification.rs`: DOM and network assertions against running preview services.
  - **Remaining / Out-of-Crate Scope for TASK-522**:
    - `packages/core/src/deployments/` (`directoryTarget.ts`, `directProcessExecutor.ts`, `directDeploymentOrchestrator.ts`, `githubActions*`). These depend on deployment profile types not yet ported to `praxis-core` / `praxis-workflows`, and on GitHub client from TASK-518.

### 1.4 State of TASK-523: Scheduled Runs, Overdue Run Detection, Durable Lease Recovery & Cron
- **Overdue Run Detection**:
  - `crates/praxis-workflows/src/scheduled_run.rs` (lines 853-864): `reconcile_scheduled_run_on_launch(run, now)` checks if `run.status == ScheduledRunStatus::Scheduled` and `run.scheduled_start_at <= now`. If so, transitions run status to `ScheduledRunStatus::Missed` with event `Missed` (`"Due {scheduled_start_at} while Praxis was not running."`).
  - `crates/praxis-workflows/src/scheduled_run_store.rs` (lines 336-352): `reconcile_on_launch(&mut self, now: &str) -> Result<Vec<ScheduledRun>, String>` iterates all runs, reconciles overdue scheduled runs to `Missed`, and writes back to disk in one atomic save if changed. Tested in `reconcile_on_launch_marks_only_overdue_armed_runs_missed_and_persists_once` (line 644).
- **Durable Lease Recovery & Runner**:
  - `crates/praxis-workflows/src/scheduled_run_runner.rs`:
    - Lines 417-443 (`recover()`): Scans all stored runs in `Running` or `Paused` status. Calls `settle_interrupted_launch()`.
    - Lines 745-794 (`settle_interrupted_launch()`): Identifies entries with status `Running`, a `launch_token`, but no `workflow_run_id`. Queries `ports.find_by_launch_token(&token)`.
      - If found: Binds existing workflow run ID via `bind_entry_workflow()`.
      - If not found: Pauses schedule with `ScheduledPauseReason::LaunchInterrupted` and message `"Praxis stopped while starting {issue_key}. Retry it to start it again, or skip it."`.
      - Guarantees: Never launches a ticket twice; prevents duplicate workflow creation on crash.
      - Tested in:
        - `a_crash_between_saving_and_launching_never_launches_twice` (line 2192)
        - `a_crash_before_the_workflow_run_existed_pauses_as_launch_interrupted` (line 2211)
  - `crates/praxis-workflows/src/exclusive_resource.rs`:
    - Provides `ExclusiveResources` ensuring that concurrent parallel runs do not concurrently mutate shared resources (e.g. git worktree/repo base checkout). Tested in `work_on_one_resource_never_overlaps_and_different_resources_run_side_by_side` (line 89).
- **The "Cron" Aspect**:
  - In TypeScript (`packages/core/src/scheduledRuns/scheduledRun.ts`, lines 18-20):
    > "One-off only. There is one `scheduledStartAt` (an absolute UTC instant) plus an IANA `timezone` used purely for display and editing. Repeat rules can be added later without migrating this shape."
  - However, `crates/praxis-workflows/Cargo.toml` line 17 declares:
    `cron.workspace = true` (which references `cron = "0.15"` in root `Cargo.toml`).
  - Grep check for `cron::` in `crates/praxis-workflows/src/`: currently 0 references. The crate is pulled in as a dependency but not yet invoked.

---

## 2. Logic Chain

1. **Alignment with Acceptance Criteria**:
   - The Acceptance Criteria in ORIGINAL_REQUEST.md state:
     "`cargo test -p praxis-workflows` runs and passes, verifying service manager readiness probes (HTTP, TCP, command exits), cron scheduling, overdue run detection, and durable lease recovery."
   - The existing test suite already passes with 268 tests, covering:
     - Service manager readiness probes: HTTP (`check_http_ok`), TCP (`probe_tcp`), log-line matching (`spawn_log_reader`), settle delay.
     - Service manager command exits: child exit before becoming ready (`Phase::Exited`), unexpected exit after ready (`watch_until_exit`).
     - Overdue run detection: `reconcile_on_launch` and `reconcile_scheduled_run_on_launch`.
     - Durable lease recovery: `recover()` + `settle_interrupted_launch()` with durable launch tokens and `ExclusiveResources`.

2. **The "Cron" Gap**:
   - Although the TypeScript baseline only supported one-off `scheduledStartAt` instances, the task is named "Port cron scheduler and durable lease recovery" (TASK-523) and the acceptance criteria explicitly mention "cron scheduling".
   - `cron = "0.15"` and `chrono-tz = "0.10"` are already configured in `crates/praxis-workflows/Cargo.toml`.
   - Therefore, implementing a first-class `cron_scheduler.rs` module in `crates/praxis-workflows` that utilizes `cron::Schedule` and `chrono_tz::Tz` directly addresses the explicit "cron scheduling" acceptance criterion and activates the dormant `cron` dependency.

3. **Status of TASK-522 and TASK-523**:
   - TASK-522's core requirements for `run_service_manager` (readiness probes and command exit lifecycle) are fully implemented and verified in Rust.
   - TASK-523's core requirements for scheduled run execution, overdue run reconciliation, and durable lease recovery are fully implemented and verified in Rust.
   - Adding a dedicated `cron_scheduler` module with timezone-aware calculation and overdue detection bridges the gap between the one-off schedule contract and recurring cron expressions.

---

## 3. Caveats

1. **Deployments Scope in TASK-522**:
   - `task-522-port-run-service-manager-and-deployments.md` also mentions deployment targets (`packages/core/src/deployments/`: `directoryTarget`, `directDeploymentOrchestrator`, etc.). As documented in TASK-522 comments, these depend on deployment profile types not yet in `praxis-core` and GitHub tracker client from TASK-518. The prompt and ORIGINAL_REQUEST.md specifically scope TASK-522 to "run service manager with readiness probes (HTTP, TCP, command exits)", which is fully self-contained in `run_service_manager.rs`.
2. **Scheduled Run Daemon Electron Integration**:
   - `apps/praxis-desktop/main/src/main/scheduledRunRunnerInstance.ts` connects the runner to Electron's power monitor, IPC, and live providers. This host wiring is part of subsequent integration (when `praxis-host` exposes `workflow:*` and `scheduled:*` channels). In `crates/praxis-workflows`, the runner is tested with a comprehensive mock harness (`Ports`).
3. **No Direct Source Changes by Explorer**:
   - In accordance with the Explorer archetype rules, no source files have been edited or created outside `.agents/teamwork/explorer_survey_a/`.

---

## 4. Conclusion

1. **TASK-522 (`run_service_manager.rs`)**:
   - **Status**: Implemented and verified.
   - **Coverage**: HTTP probes (`check_http_ok`), TCP probes (`probe_tcp`), stdout/stderr regex matching (`spawn_log_reader`), settle delay (`NO_PROBE_SETTLE`), pre-ready command exit detection (`Phase::Exited`), post-ready command exit detection (`watch_until_exit`), and process tree teardown (Unix `killpg` / Windows `taskkill`).

2. **TASK-523 (`scheduled_run*.rs`, `exclusive_resource.rs`)**:
   - **Status**: Scheduled run state machine, overdue run reconciliation (`reconcile_on_launch`), and durable lease recovery (`recover`, `settle_interrupted_launch`, `launch_token`) are implemented and verified.
   - **Identified Enhancement / Missing Component**: A dedicated cron scheduling module (`cron_scheduler.rs`) to utilize the declared `cron = "0.15"` crate for parsing standard cron expressions, calculating timezone-aware next occurrences, and detecting overdue runs against cron schedules.

---

## 5. Concrete Technical Plan for Worker

A Worker assigned to finalize Workstream A should execute the following step-by-step plan:

### Step 1: Add `src/cron_scheduler.rs` in `crates/praxis-workflows`
Create `crates/praxis-workflows/src/cron_scheduler.rs` using `cron::Schedule` and `chrono_tz::Tz`:
```rust
//! Cron-based schedule calculation and overdue run detection.

use std::str::FromStr;
use chrono::{DateTime, Utc};
use chrono_tz::Tz;
use cron::Schedule;
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum CronScheduleError {
    #[error("Invalid cron expression: {0}")]
    InvalidExpression(String),
    #[error("Invalid timezone: {0}")]
    InvalidTimeZone(String),
}

#[derive(Debug, Clone)]
pub struct CronSchedule {
    expression: String,
    schedule: Schedule,
    timezone: Tz,
}

impl CronSchedule {
    pub fn new(expression: &str, timezone_str: &str) -> Result<Self, CronScheduleError> {
        let schedule = Schedule::from_str(expression)
            .map_err(|e| CronScheduleError::InvalidExpression(e.to_string()))?;
        let timezone = timezone_str
            .parse::<Tz>()
            .map_err(|_| CronScheduleError::InvalidTimeZone(timezone_str.to_string()))?;
        Ok(Self {
            expression: expression.to_string(),
            schedule,
            timezone,
        })
    }

    /// Calculates the next occurrence after `after_utc`.
    #[must_use]
    pub fn next_after(&self, after_utc: DateTime<Utc>) -> Option<DateTime<Utc>> {
        let zoned = after_utc.with_timezone(&self.timezone);
        self.schedule
            .after(&zoned)
            .next()
            .map(|dt| dt.with_timezone(&Utc))
    }

    /// Detects all overdue runs between `last_run_utc` and `now_utc`.
    #[must_use]
    pub fn find_overdue_runs(
        &self,
        last_run_utc: DateTime<Utc>,
        now_utc: DateTime<Utc>,
    ) -> Vec<DateTime<Utc>> {
        let mut overdue = Vec::new();
        let mut cursor = last_run_utc;
        while let Some(next) = self.next_after(cursor) {
            if next <= now_utc {
                overdue.push(next);
                cursor = next;
            } else {
                break;
            }
        }
        overdue
    }
}
```

### Step 2: Register in `crates/praxis-workflows/src/lib.rs`
Add `pub mod cron_scheduler;` to `crates/praxis-workflows/src/lib.rs`.

### Step 3: Implement Unit Tests in `src/cron_scheduler.rs`
Add tests covering:
- Parsing standard 5-to-7 field cron expressions (`"0 0 12 * * * *"` or `"0 30 9 * * * *"`).
- Timezone awareness (e.g. `America/New_York`, `UTC`, `Europe/London`).
- `next_after` precision.
- `find_overdue_runs` returning missed occurrences during simulated downtime intervals.
- Handling invalid cron expressions and invalid timezones.

### Step 4: Verify Integration Tests
Ensure that all existing tests and new tests pass:
```bash
cargo test -p praxis-workflows
cargo clippy -p praxis-workflows --all-targets --all-features -- -D warnings
```

### Step 5: Update Task Documentation
Update `apps/praxis-desktop/docs/plans/features/fx-bf-114-rust-and-tauri-migration/stories/fx-be-197-workflows-run-profiles-and-scheduler/`:
- In `task-522-port-run-service-manager-and-deployments.md`: Record completion of run service manager, readiness probes, and command exit handling.
- In `task-523-port-scheduled-runs-and-lease-recovery.md`: Record completion of cron scheduler, overdue run detection, and durable lease recovery.

---

## 6. Verification Method

To independently verify the exploration findings and test results:

1. **Verify `praxis-workflows` Tests**:
   ```bash
   cargo test -p praxis-workflows
   ```
   *Expected*: All 268 tests pass (234 unit, 33 orchestrator, 1 parity).

2. **Verify Clippy Workspace Lints**:
   ```bash
   cargo clippy -p praxis-workflows --all-targets --all-features -- -D warnings
   ```
   *Expected*: Zero warnings/errors.

3. **Verify TypeScript Core Tests**:
   ```bash
   npm --prefix /Users/daveacres/dev/tools/praxis run test:core
   ```
   *Expected*: 2033 passed, 0 failed.

4. **Verify Readiness Probes in Code**:
   Inspect `crates/praxis-workflows/src/run_service_manager.rs`:
   - Line 740: HTTP probe loop calling `check_http_ok`.
   - Line 734: TCP probe loop calling `probe_tcp`.
   - Line 626: Log reader calling `spawn_log_reader`.
   - Line 653 & 673: Command exit before ready handling.
   - Line 711: Command exit after ready handling.

5. **Verify Overdue & Lease Recovery in Code**:
   - Inspect `crates/praxis-workflows/src/scheduled_run_store.rs`: Line 336 (`reconcile_on_launch`).
   - Inspect `crates/praxis-workflows/src/scheduled_run_runner.rs`: Line 417 (`recover`) and Line 745 (`settle_interrupted_launch`).
