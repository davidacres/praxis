# Progress — Worker C (M3 Workstream C)

Last visited: 2026-11-08T16:16:55Z

## Status
Cargo dependencies added (`sha2`, `sha1`, `uuid`, `url`). Designing and implementing `mcp` module.

## Plan
1. [x] Initialize DISPATCH.md, BRIEFING.md, progress.md
2. [x] Read `ORIGINAL_REQUEST.md` and `explorer_survey_c/handoff.md`
3. [x] Inspect `crates/praxis-ai` current layout and root `Cargo.toml`
4. [x] Add workspace dependencies to `crates/praxis-ai/Cargo.toml`
5. [ ] Implement `src/mcp` (types, transports, client pool, truncation, built-in servers, registry) + tests
6. [ ] Implement `src/acp` (schemas, supervisor, agent host, permissions, sandboxed fs) + tests
7. [ ] Implement `src/team_chat` (domain types, transitions, hash-chaining, idempotency, epoch crash recovery, file repo) + tests
8. [ ] Implement `src/gadgets` (envelope, kinds, regex redaction, JSON repair, markdown block parser, action validation) + tests
9. [ ] Expose public modules in `crates/praxis-ai/src/lib.rs`
10. [ ] Run `cargo test -p praxis-ai` and `cargo clippy -p praxis-ai --all-targets --all-features -- -D warnings`
11. [ ] Write handoff report and notify orchestrator
