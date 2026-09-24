# CLAUDE.md

All project guidance for AI coding agents lives in **[AGENTS.md](AGENTS.md)** — the
cross-tool convention, so every agent reads the same rules from one file.

The thing most likely to cost you time here: several invariants fail *silently*
rather than loudly — the renderer CSP's `img-src data:`, the hand-maintained
`settingsDefaults.ts` mirror, and the `copy-renderer` step the e2e suite depends on.

This file is deliberately a pointer so the guidance lives in exactly one place.
Claude Code loads it through the import below.

@AGENTS.md
