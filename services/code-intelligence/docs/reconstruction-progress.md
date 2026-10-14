# Reconstruction progress

Updated 14 October 2026.

## Current verified checkpoint

Branch: codex/code-intelligence-recovery. No PR or main merge.
Original baseline: f8ef840269ec871aa87ae4d2a50c26950e14b875.
The previous implementation is not recovered. See recovery-record.md for historical inventory.

Reconstructed:
- .NET10.0.402 solution, strict compiler settings and pinned dependency locks.
- Executable migration001 extracted from the reviewed specification.
- SQLite WAL/foreign-key connections, atomic migration/checksum record, idempotent initialization, newer-schema and checksum rejection.
- Integrity checks and verified backup preserving committed WAL data, refusing overwrite.
- Raw-byte source hashes, strict UTF8/UTF16 BOM decoding, byte limits, path component rejection, canonical selected-root aliases, source symlink/reparse-point exclusion.
- Minimal init/doctor CLI; indexing and query commands are not yet available.

## Verification performed on reconstructed files

SDK10.0.402 downloaded from official builds.dotnet.microsoft.com and verified against upstream SHA512.
C# test run:13passed,0failed,0skipped. This replaces no historical release claim.
Tests cover migration idempotence, FK enforcement, newer schema rejection without downgrade, migration checksum mismatch, backup content/refusal, raw-byte hashes and UTF16 decoding, six traversal/ambiguous path forms, oversized/invalid encoding, and Unix root/source symlink policy.
Source alias test bypasses Windows because link privileges need a platform fixture.
SQLite Python smoke: migration executes, quick_check=ok, no foreign-key violations,28tables includingFTS internals.
Locked-mode restore succeeds. git diff --check succeeds.
No UI/platform/MCP/model/performance/quality tests exist on the reconstructed branch yet.

## Preservation evidence

Recovery record and reviewed specification committed directly through connected GitHub API.
Specification saved149539bytes, matching Library version2 size.
Storage/config/test files and source policy/dependency locks committed through GitHub API and read back with exact text comparison.
Command-line git push failed because its HTTPS credentials were unavailable; connector commits succeeded. Local checkpoint8c9b6a28 is not the remote SHA because connector saved files as individual commits. Do not mistake local commits for preservation.
Remote checkpoint before this progress document: d0e2989fb1cc1e6a68e40160cbb547864466d032.

## Next work and limitations

Reconstruct Roslyn declarations/canonical identities and passive manifests, then registration/index publication/query contracts, owner/MCP, local model and desktop.
Source path checks are not yet a race-proof filesystem sandbox: adversarial concurrent directory replacement requires handle-relative platform validation and dedicated tests. Do not expose source reads through MCP until that boundary is completed.
Current schema initialization does not perform corruption recovery/maintenance scheduling. No repository admission, grants, epochs, watcher, jobs, embeddings, graph, providers or desktop functionality is wired yet.
Continue against specification release gates A01–A40. Historical40test run in recovery record applies only to deleted checkout.
Every turn must end with meaningful source/tests/docs remotely preserved and verified, including incomplete checkpoints.
