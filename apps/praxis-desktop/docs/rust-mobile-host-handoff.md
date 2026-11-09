# Rust mobile host draft handoff

Verified 2026-11-09 against base `781a1e32`. This completes review and integration preparation of the preserved `services.rs` and `scheduled_runs.rs` drafts. TASK-520 remains In Progress: these are library handlers over injected dependencies, not a running desktop mobile host.

## Reviewed implementation

- Registered `host::services` and `host::scheduled_runs` in `crates/praxis-mobile`.
- Compared every read and command branch with `main/src/main/mobileHostServices.ts`, and schedule projection, ticket resolution, persistence, notifications and missed-run resolution with `mobileScheduledRuns.ts`.
- Fixed JavaScript array string coercion for null elements and falsy usage/cost omission. Kept zero context counts.
- Made default-workflow lookup and runner wake-up fallible. Lookup failures leave storage untouched. A wake failure propagates after the schedule has been saved and its change announced, matching TypeScript.
- Added 117 reproducible TypeScript reference cases checking returned JSON, error messages and dependency calls across all 17 reads and 14 commands. They cover missing/mismatched resource ids, standalone access, verified actors, provider/model/mode choices, image arguments, gadget approval and follow-up behavior, and schedule arguments. A source hash rejects stale service fixtures. This is bounded fixture parity, not a proof for every possible input.
- Added application-boundary tests for capabilities and command replay, and schedule tests for ambiguous tickets, default workflow, persistence failure, missed-run resolution, notification order and runner wake failures.

## Authorization boundary

The service handlers verify that a session or run belongs to the requested project. For standalone session requests they also check the device grant and conversation key. They derive audit actors from the caller supplied by the host, ignoring payload actor fields. Gadget approval effects require the approve capability in addition to the execute capability checked by the application dispatcher.

These handlers do **not** authenticate a wire-supplied caller or authorize the target project against the paired device. The TypeScript listener (`mobileLanServer.ts`) replaces the supplied caller, checks the paired device's allowed project ids, filters project lists and event/replay delivery, and enforces access policy. The Rust transport must retain those checks before invoking this library. The TypeScript composition (`mobileHostComposition.ts`) also supplies permission ownership, safe image/file reads, workspace trust and session/workflow runtime side effects. Those implementations are dependencies here, not ported desktop adapters.

## Fresh verification

| Check | Result | Scope |
| --- | --- | --- |
| `cargo test --workspace --locked` | 955 passed, 0 failed, 0 ignored | All Rust workspace tests, with localhost access; includes 135 mobile unit tests and 9 protocol/relay integration tests. |
| `cargo clippy -p praxis-mobile --all-targets --locked -- -D warnings` | Passed | Reviewed crate and test targets. |
| `cargo build -p praxis-host --locked` | Passed | Builds the host binary consuming the reviewed mobile library. |
| `rustfmt --edition 2024 --check crates/praxis-mobile/src/host/services.rs crates/praxis-mobile/src/host/scheduled_runs.rs` | Passed | Includes their test modules. |
| TypeScript reference generator | 117 cases generated and matched by Rust | Loads this worktree's service source. Installed dependencies and built core came from the primary checkout at the same base. |
| `node --test out/main/mobile*.test.js` | 110 passed, 0 failed/skipped | Existing compiled TypeScript mobile runtime baseline in the primary checkout; not a fresh TypeScript build. The two compared service source files were confirmed identical between checkouts. |
| `PRAXIS_RUST_CHANNELS=none .../playwright test --project=functional e2e/mobileAccess.spec.ts --workers=1` | 4 passed | Existing built Electron/renderer in the primary checkout. TypeScript runtime regression evidence, not Rust mobile integration evidence. |
| Plan parser before/after | Unchanged | 60 features, 195 stories and 655 child items; TASK-520 remains In Progress. |

The full desktop functional/theme suites, remote CI, a live Flutter-to-Rust host session and packaged Rust delegation were not run or established. No UI code or snapshots changed. The mobile-access spec's routine diagnostic screenshot adds no evidence about these Rust library handlers; no visual artifact is part of this handoff.

Regenerate the service vectors from the repository root with Node supporting `module.stripTypeScriptTypes`:

```sh
node crates/praxis-mobile/tests/fixtures/generate_host_services.cjs
cargo test -p praxis-mobile --locked host::services::tests
```

For an isolated worktree without npm dependencies, the generator accepts a dependency-checkout root as its optional argument. The service source always comes from the generator's own checkout. No dependencies or lockfiles changed in this handoff.

## Remaining TASK-520 work

1. Port the real TCP/Noise responder and relay client, retaining handshake timeouts, connection limits, pairing, authenticated caller replacement, project authorization, filtered events/replay and policy enforcement for existing peers.
2. Implement desktop dependency adapters and lifecycle composition for these handlers, including permission ownership, workspace trust, safe file/image access, schedule notifications and runner wake-up.
3. Prove host integration with the phone protocol and the mobile-access desktop specs against both backend modes, with diagnostics showing which runtime actually served mobile requests. Obtain matching CI evidence under FX-BE-203 before changing delegation.

The original worktree and its two untracked source drafts are retained. The reviewed copies and their tests belong on `main`; keeping the original files does not imply they contain the later fixes or constitute another pending integration.
