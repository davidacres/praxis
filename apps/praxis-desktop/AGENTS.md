# Desktop Tauri Host & Rust Backend Architecture

The Praxis desktop shell is a native Tauri v2 application (`apps/praxis-desktop/src-tauri`, crate `praxis-desktop`) backed directly by in-process Rust services (`praxis-host`, `praxis-workflows`, `praxis-trackers`, `praxis-ai`, `praxis-mobile`, `praxis-core`).

The legacy Electron main process (`apps/praxis-desktop/main`) and its Node.js backend services have been superseded and retired. All 407 IPC channels are registered and verified in Rust with in-process dispatch.

## Verification & Build Commands

- `npm run check-types`: Validates TypeScript in renderer and core, as well as cargo check / export-types across Rust crates.
- `npm run test:desktop:tauri`: Runs the 4-stage automated Tauri E2E and parity verification suite.
- `npm run desktop:start`: Launches the desktop app in development mode using Tauri.
- `npm run build`: Builds the full stack in dependency order (Rust crates, core, renderer, and Tauri shell).
