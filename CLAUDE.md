# CLAUDE.md

All project guidance for AI coding agents lives in **[AGENTS.md](AGENTS.md)** — the
cross-tool convention, so every agent reads the same rules from one file.

**Read [AGENTS.md](AGENTS.md) before changing code in this repository.** It is short,
and it covers the two things most likely to cost you time here:

- This is a monorepo with **two UI surfaces** — the VS Code extension (webview panels)
  and the Praxis desktop app (React + Electron). They share `packages/core` but share
  no UI code, and their rules are mutually inapplicable.
- Several invariants fail *silently* rather than loudly — the renderer CSP's
  `img-src data:`, the hand-maintained `settingsDefaults.ts` mirror, and the
  `copy-renderer` step the e2e suite depends on.

This file is deliberately a pointer: keeping the guidance in one place is what stops
the two copies drifting apart and giving agents contradictory instructions.
