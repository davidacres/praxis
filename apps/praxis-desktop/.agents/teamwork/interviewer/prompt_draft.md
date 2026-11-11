Execute the recommended next steps for moving Praxis to Rust across three parallel workstreams for production: Workstream A (Workflows in `crates/praxis-workflows`), Workstream B (Wiring `praxis-core` services into Electron), and Workstream C (AI MCP / ACP Runtime in `crates/praxis-ai`).

Integrity mode: development

## Requirements

### R1. Workstream A: Complete Workflows (FX-BE-197) in `crates/praxis-workflows`
- Implement TASK-522: run service manager with readiness probes (HTTP, TCP, command exits).
- Implement TASK-523: cron scheduler, overdue run detection, and durable lease recovery.

### R2. Workstream B: Wire `praxis-core` services into Electron (`folder:*`, `plans:*`, `settings:*`)
- Connect existing `FolderService`, plan front-matter parser, board synthesizer, and `AppSettings` stores from `crates/praxis-core` to `crates/praxis-host`.
- Register them in `apps/praxis-desktop/main/src/main/rustHostInstance.ts` using `RustHostBridge.handleOrFallback`.

### R3. Workstream C: AI MCP / ACP Runtime (FX-BE-198) in `crates/praxis-ai`
- Implement TASK-525: MCP server registry, stdio/HTTP tool transports, and ACP stdio bridge.
- Implement TASK-526: durable team chat message persistence and gadget validation.

## Verification Resources
- `cargo test -p praxis-workflows`
- `npm run test:git`
- Desktop Playwright smoke tests (`npm run test:desktop:smoke`)
- `cargo test -p praxis-ai`

## Acceptance Criteria

### Workstream A (Workflows)
- [ ] `cargo test -p praxis-workflows` runs and passes, verifying service manager readiness probes (HTTP, TCP, command exits), cron scheduling, overdue run detection, and durable lease recovery.

### Workstream B (Electron Core Wiring)
- [ ] `npm run test:git` passes without regressions.
- [ ] Desktop Playwright smoke tests (`npm run test:desktop:smoke`) pass with `folder:*`, `plans:*`, and `settings:*` routed through `RustHostBridge.handleOrFallback`.

### Workstream C (AI MCP / ACP Runtime)
- [ ] `cargo test -p praxis-ai` runs and passes, verifying MCP server registry, stdio/HTTP tool transports, ACP stdio bridge, team chat message persistence, and gadget validation.
