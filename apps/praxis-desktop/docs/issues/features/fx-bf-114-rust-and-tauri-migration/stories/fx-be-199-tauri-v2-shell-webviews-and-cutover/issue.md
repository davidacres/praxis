# FX-BE-199 - Tauri desktop shell cutover

Status: In Progress. Local implementation only; no external issue has been created.

[Canonical story](../../../../../plans/features/fx-bf-114-rust-and-tauri-migration/stories/fx-be-199-tauri-v2-shell-webviews-and-cutover/story.md).

The user activated the shell migration on 2026-11-10. The Tauri shell is now the live desktop host: all 407
channels are registered and the functional e2e suite passes for the ported areas listed in the parity doc. Child-webview
browser isolation (compiled, not verified in a native window), packaged release verification and the TypeScript renderer
remain open. See the canonical story and migration document for the execution order, evidence and close conditions.
