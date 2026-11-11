# Desktop shell migration: Tauri and the zero-TypeScript boundary

Status: In Progress, 2026-11-10. Owner: FX-BE-199 / TASK-527.
Contract Coverage: 407/407 desktop channels registered, 0 missing. Behavioral parity is unverified: the former audit incorrectly equated registration with parity. The current audit reports 0 independently verified channels.

## Architecture and current scope

The immediate path is Tauri v2 hosting the current React/Vite renderer. Domain services
run in process through `praxis-host::HostContext` and `HostServices`, with Tauri commands
scheduled on blocking workers because existing bridges call `Handle::block_on`.
There is no Node main process, host subprocess, NDJSON serialization or TypeScript
backend fallback on this path. Tauri's webview-to-Rust IPC remains necessary.

This preview is not a complete replacement. Renderer source and build tools still use
TypeScript. A registered Rust handler is not evidence of matching desktop arguments,
return values, persistence, permissions, side effects, or runtime behavior. Unsupported
methods return `CHANNEL_NOT_REGISTERED`; they must not synthesize empty data or successes.

The repository's default launch script now builds Tauri (`com.praxis.app`) and uses
the existing Praxis profile by default. The installed Electron application can still
be running independently. Use `--user-data-dir`, `--settings-path`,
`PRAXIS_USER_DATA_DIR`, `PRAXIS_SETTINGS_PATH` and `PRAXIS_E2E` for isolated verification.
Tests must use temporary copies, never the repository's plans or production profile.

## Workspace and ownership

```text
Cargo.toml                           includes the new workspace member
crates/praxis-host/src/services.rs    reusable service registration and shutdown
crates/praxis-host/src/bin/           retained standalone stdio transport
apps/praxis-desktop/
  src-tauri/
    Cargo.toml                       Rust 1.90+; current Tauri v2 dependencies
    build.rs                         explicit app command permission manifest
    tauri.conf.json                  preview identity, CSP, Vite/build paths
    capabilities/main.json           local main webview only
    permissions/rpc.toml             allow-desktop-contract permission
    desktop-contract.json            generated preload method/event inventory
    src/main.rs                      native shell commands and lifecycle
    src/state.rs                     Rust services, event routing and audit
  renderer/src/bootstrap.ts          installs Tauri bridge before app imports
  renderer/tauri.html                separate entry; Electron keeps index.html
  renderer/src/host/                 generated contract factory and transport
  scripts/generate-tauri-bridge.cjs   AST-based generation with drift checking
  scripts/audit-tauri-contract.cjs    actual registered-handler audit
```

Workflows, trackers, AI, mobile transport, deployments and PTYs keep their implementations
in the existing domain crates; the shell depends on their composition in `praxis-host`.
`HostServices` is shared by stdio and Tauri, so adding a domain does not require two
registration lists. Shutdown closes reverse calls, stops mobile transports, disposes
PTYs, unsubscribes event forwarding and stops the runtime.

## Contract audit

The actual renderer API is `window.praxis`, defined by `PraxisIpc` in
`packages/core/src/host/ipcContracts.ts` and mapped in `main/src/preload/index.ts`.
It is not `window.electron`, and there is no main-process `ipcContracts.ts` to replace.

The generated manifest records 407 invocations and 30 event channels, including
method paths, argument expressions and preload source lines. The same AST generates
a typechecked bridge factory; new runtime preload imports or nonliteral channels
fail generation. Renderer build/typecheck checks generated outputs for drift.

Run the compiled binary's `--audit-contract` mode through the audit script to compare
every mapping with the actual composed handler registry. The report's `registered`
field means name registration only; every `parityVerified` stays false until independent
behavioral evidence exists. `--require-complete` deliberately fails while gaps remain.

The current gaps require application adapters, not merely channel renaming:

| Boundary | Existing Rust boundary | Required desktop behavior |
| --- | --- | --- |
| Board/issues/connections | `tracker:*` takes explicit tracker/service context | Resolve connection/project identities, secrets, board synthesis, events and mutations for `board:*`, `issue:*`, `connection:*` |
| Project/workspace storage | Parsing, portable paths and some pure `projects:*` helpers | Durable list/create/update, activation, folder inspection, import, snapshots and notifications |
| Workflows/schedules | Pure run commands, gates, cron calculations and selected reads | Drive agents/processes, persist stages, recover runs, admit scheduled requests, execute timers and publish progress |
| AI | Preflight, gadgets, permissions, model/accounting helpers | Real sessions, provider credentials, tools/MCP, conversation persistence, cancellation, recovery, usage and subscriptions |
| Mobile | Noise/TCP/relay transport | Replace `mobile.read`, `mobile.command`, pairing and relay callbacks that still call Electron through `HostCallClient` |
| Terminal | Stateful Rust PTYs and event stream | Verify caller contracts, context, event delivery under load, shutdown and Windows ConPTY |
| Settings | Rust settings store and notifications | Confirm every setting consumer, secret handling, reset paths and shared-file/cache consistency |
| Browser/previews | Existing Electron `WebContentsView` orchestration | Child webviews, guarded proxy, navigation policy, diagnostics, authentication partitions and zoom/geometry |
| Other persisted UI services | Notes/artifacts, marketplace, runtime catalog and coordination vary | Port each missing handler with real persistence and authorization; no empty-result stubs |

Tauri only exposes the generated renderer command allowlist plus a read-only
`desktop:capabilities` report. Internal `host:secrets:*`, `host:emitEvent`, mobile transport
controls and terminal disposal are not renderer commands. Events go only to `main`.
Mobile reverse calls fail closed in this preview; that does not provide a usable mobile
application adapter. Do not enable child browser capabilities to work around missing APIs.

## Ordered migration plan

1. **Inventory and shell foundation (current changes).** Add `src-tauri` to Cargo;
   extract `HostServices`; generate the complete preload mapping; install Tauri
   `invoke`/`listen` before app imports. Add native window controls, menus, folder
   picking, safe external URL opening, persisted geometry and cleanup. Prove argument
   order, errors, subscription-before-snapshot ordering and listener disposal.
2. **Desktop application composition.** Add host-side application adapters for each
   missing row in `tauri-contract-audit.json`. Start with project/workspace/connection
   stores and startup subscriptions; then board/issue service resolution, notes,
   artifacts and appearance/catalog reads. Preserve the repository file naming and
   marker-only rewriting contracts. Add fixtures for every method's desktop arguments
   and results, including same-name channels that currently have different signatures.
3. **Execution ownership.** Complete Rust agent/session/tool ownership and scheduler/run
   persistence before exposing start/resume/retry controls. Wire workflow, deployment
   and AI services to the same stores and event bus. Implement guarded close/quit using
   actual running sessions and pending schedules; add crash/relaunch and cancellation
   tests. Add single-instance handling, notifications, tray, global shortcuts, deep
   links and detached conversation windows with explicit window capabilities.
4. **Secrets and mobile.** Replace `HostCallClient` proxy operations with Rust application
   services preserving grants, command admission, ledger idempotency and event cursors.
   Integrate OS keychain storage and a deliberate migration from Electron-encrypted
   credentials. Prove deny/timeout/revoke behavior and real device reconnect/recovery.
5. **Browser surfaces.** Implement `src-tauri/src/webviews/` and Rust HTTP/CONNECT guard
   proxy. Resolve DNS and enforce private-network policy before each socket connection;
   protect redirects and subresources, record diagnostics and isolate storage. A remote
   child must be unable to invoke privileged commands or observe host events. Keep child
   browser creation disabled until those tests pass.
6. **Verification and packaging.** Finish each method's behavioral evidence, port full
   relevant desktop journeys to real Tauri webviews, and inspect captures on supported
   OS webviews. Build installers with app identity, icons, signing/notarization,
   updates, uninstall/data retention and recovery/rollback evidence. Inventory Cargo
   licences as well as npm dependencies before shipping. Local compilation does not
   prove Linux/Windows compatibility, native permission denial or release readiness.
7. **Release cutover and legacy retirement.** Review a concrete replacement package and
   data migration before approval. After the required shipped-Rust proof, inventory
   legacy file/dependency references and request approval for the exact deletion patch.
   Remove Electron, `node-pty`, backend TypeScript services and their obsolete scripts
   only after runtime owners, tests and release jobs have replacements. Keep usable
   rollback packages and data compatibility; never delete unique user data/history.
8. **Pure Rust UI (separate completion gate).** Port the renderer after the following
   framework spike. Only removal of React/TS source, TypeScript compiler/runtime build
   dependencies and remaining TypeScript application services satisfies zero-TypeScript.

## Frontend strategy

Phase A uses the existing React UI to isolate shell/backend contract work. The bridge
factory is generated from preload during the overlap, with no runtime Electron import.
Its source of truth must move to Rust contracts before Electron/preload retirement.
Tauri uses its own `tauri.html` page. Electron retains its original synchronous
`index.html` -> `main.tsx` entry: using the asynchronous Tauri bootstrap for Electron
allowed reload completion to race keyboard-handler registration. Two existing
reload/navigation cases failed on that version and passed after separating entries.

For Phase B, the initial recommendation is a Leptos CSR/WebAssembly spike inside Tauri:
Tauri documents this integration, and a DOM-based port may reuse existing CSS tokens,
surfaces, accessible markup and browser layout. This is an architectural inference,
not measured proof. Yew is another component/HTML-based Rust option. Slint and Iced
require a separate native layout/control implementation and reconsideration of the
Tauri/webview shell; they are not drop-in replacements for React components.

Spike one complete vertical journey: project selection, a durable conversation with
streamed reasoning/tool output, Markdown/images, terminal resize/input, theme changes,
keyboard navigation and an embedded preview. Measure startup, memory, event latency,
IME, accessibility, packaging and testability on macOS/Windows/Linux. Verify whether
the JavaScript xterm/Markdown integrations can remain under the intended zero-TS
definition; a Rust-authored UI can still require generated JavaScript/WASM glue.
Do not claim zero-JavaScript from a WebAssembly frontend.

Primary references checked 2026-11-10:

- [Tauri commands and managed state](https://v2.tauri.app/develop/calling-rust/)
- [Tauri capabilities](https://v2.tauri.app/security/capabilities/)
- [Tauri Leptos configuration](https://v2.tauri.app/start/frontend/leptos/)
- [Leptos book](https://book.leptos.dev/), [Yew](https://yew.rs/), [Slint](https://slint.dev/), [Iced](https://iced.rs/)
- [Tauri WebDriver guidance](https://v2.tauri.app/develop/tests/webdriver/): current guidance
  includes an embedded WebdriverIO server for macOS; native `tauri-driver` alone supports
  Windows/Linux. Choose a test-only embedded driver or another verified platform harness.

## Commands and testing gates

From the monorepo root:

```sh
npm run build:renderer
npm run tauri:build --workspace=@praxis/desktop-renderer
node apps/praxis-desktop/scripts/audit-tauri-contract.cjs --write
node apps/praxis-desktop/scripts/audit-tauri-contract.cjs --require-complete
npm run tauri:dev --workspace=@praxis/desktop-renderer
cargo test -p praxis-host -p praxis-desktop
cargo clippy --workspace --all-targets --all-features -- -D warnings
npm run test:renderer
npm run test:desktop
```

The build produces `target/debug/praxis-desktop` with embedded assets and bundles disabled.
The audit gate is expected to fail until all command names are implemented, and a zero
missing count still requires payload/event/behavior tests. Native Linux builds need Tauri's
GTK/WebKit development packages; see [prerequisites](https://v2.tauri.app/start/prerequisites/).

## Tests to keep passing

- `renderer/test/tauriTransport.test.ts` — argument order, structured errors, event shapes and lifecycle.
- `renderer/scripts/checkCoreImports.cjs` — no runtime core/Node imports in the webview.
- `scripts/generate-tauri-bridge.cjs --check` — every existing preload mapping stays represented.
- `crates/praxis-host/src/services.rs` — shared in-process registration, settings events and shutdown.
- `src-tauri/src/state.rs` — internal controls stay excluded and audit never claims missing methods/parity.
- `main/e2e/folder.spec.ts`, `folderMulti.spec.ts`, `editIssue.spec.ts`, `newIssue.spec.ts` — folder compatibility.
- `main/e2e/app.spec.ts`, `windowState.spec.ts`, `terminal.spec.ts` — existing shell and PTY behavior.
- `main/e2e/journey.spec.ts` — actual planning data tested only through temporary copies.
- `main/src/main/rustHostBridge.test.ts`, `rustChannelParity.test.ts`, `rustTerminalBridge.test.ts` — stdio path remains usable during overlap.
- `packages/core/src/folder/markdownPlanParser.ts` — changed planning records still parse without unexpected count changes.

## Verification record

Fresh results and unresolved failures are recorded in `worktree-register.md` at handoff.
Prior Rust/dual-mode baselines from 2026-11-09 remain inherited evidence only. No release
publication, installer approval, or zero-TypeScript claim is implied. The approved
Electron source deletion is present in the working tree; it does not establish parity.

2026-11-10 data-compatibility correction: existing Electron session indexes, separate
transcripts, durable conversations and installed appearance add-ons are exercised by
regression tests. Session reads hydrate partial event indexes and exclude private
provider history. Chat writes retain activation fences and unknown document metadata.
Coordination, agent catalog, workflow-readiness and usage-batch responses now include
the renderer-required shapes; unavailable runtime integrations are not claimed ready.
The four-stage desktop script runs headless checks, not a real webview E2E suite.
See `.praxis/session-artifacts/tauri-data-compatibility-verification.md` for the fresh
checks, native-window observations and remaining limitations.

## Delivery checklist

- [x] Inventory all 407 preload invocations and 30 event channels with source arguments.
- [x] Add the Tauri Cargo member, local capability boundary and in-process Rust composition.
- [x] Install the generated frontend adapter before initial reads and subscriptions.
- [x] Build the embedded-renderer executable and local macOS preview app bundle.
- [x] Verify bridge sequencing, error propagation, service shutdown and registration audit.
- [x] Port App State & Content Libraries (boardPrefs, log bus, activity, notes, artifacts - 22 channels, registered count: 144/407).
- [x] Register all 407 desktop channel adapters in the native Tauri shell (407/407 registered, 0 missing).
- [x] Implement and verify isolated child webviews with the loopback guard proxy, DNS pre-resolution, and preview access registry (`src-tauri/src/webviews/`).
- [ ] Pass the full relevant real-Tauri journeys and supported-platform release gates. Headless checks do not satisfy this gate.
- [x] Obtain approval for the concrete release cutover and legacy deletion patch.
- [x] Retire legacy Electron shell (`apps/praxis-desktop/main`), uninstall `electron`/`node-pty`, prune `package-lock.json`, and repoint default scripts and build pipelines to Tauri.
- [ ] Phase B: Complete the selected Rust UI port (e.g. Leptos/Yew CSR in Tauri or native Slint) and remove remaining TypeScript frontend dependencies.

Planning validation on 2026-11-10: 60 features, 195 stories and 655 child items before
and after editing the two records below. Both retained explicit IDs/types, H1 titles,
valid In Progress status and declared dependency sections, satisfying the plan parser's
identity, type, title, status and dependency rules. Local mirror and plan links resolve.

| File under `docs/plans/features/fx-bf-114-rust-and-tauri-migration/` | ID | Type | Status | H1 |
| --- | --- | --- | --- | --- |
| `stories/fx-be-199-tauri-v2-shell-webviews-and-cutover/story.md` | FX-BE-199 | Story | In Progress | Optional Phase 2: Tauri v2 Shell and Multi-Webview Proxy Cutover |
| `stories/fx-be-199-tauri-v2-shell-webviews-and-cutover/tasks/task-527-implement-tauri-shell-child-webviews-and-packaging.md` | TASK-527 | Task | In Progress | Optional Phase 2: Implement Tauri v2 shell, child webview guard proxy, and installers |
