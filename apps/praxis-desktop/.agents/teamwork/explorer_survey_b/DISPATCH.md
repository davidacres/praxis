## 2026-11-08T16:00:13Z
You are assigned as the Electron Core Wiring Explorer for Workstream B.

Your Identity and Context:
- Working directory: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop (Repo root is /Users/daveacres/dev/tools/praxis)
- State folder: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/explorer_survey_b
- Original Request path: /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/ORIGINAL_REQUEST.md

Task Objectives:
You are an exploration agent. Do NOT modify source code or implement fixes.
1. Read /Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/ORIGINAL_REQUEST.md.
2. Investigate Workstream B requirements:
   - Wire `praxis-core` services into Electron (`folder:*`, `plans:*`, `settings:*`).
   - Connect existing `FolderService`, plan front-matter parser, board synthesizer, and `AppSettings` stores from `crates/praxis-core` to `crates/praxis-host`.
   - Register them in `apps/praxis-desktop/main/src/main/rustHostInstance.ts` using `RustHostBridge.handleOrFallback`.
3. Investigate the codebase:
   - What exists in `crates/praxis-core` regarding `FolderService`, front-matter parser, board synthesizer, and `AppSettings`?
   - What exists in `crates/praxis-host` (Rust host bridge / IPC definitions / FFI or neon or napi or stdio IPC)?
   - How does `apps/praxis-desktop/main/src/main/rustHostInstance.ts` work currently? How does `RustHostBridge.handleOrFallback` operate?
   - How are `folder:*`, `plans:*`, and `settings:*` IPC channels registered and used in Electron main (`apps/praxis-desktop/main`) and renderer?
   - How do `npm run test:git` and `npm run test:desktop:smoke` verify these behaviors?
4. Document:
   - What is already implemented vs what is missing across `crates/praxis-core`, `crates/praxis-host`, and `apps/praxis-desktop/main`.
   - The exact interfaces, IPC message names, payloads, responses, and fallback mechanics.
   - Concrete, step-by-step technical plan for a Worker to complete the wiring cleanly without regressions.
5. Write your comprehensive exploration findings and handoff report to:
   `/Users/daveacres/dev/tools/praxis/apps/praxis-desktop/.agents/teamwork/explorer_survey_b/handoff.md`
6. Once complete, notify orchestrator via send_message with a brief summary and the path to your handoff.md.
