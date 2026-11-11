//! Add-on marketplace verification (`packages/core/src/marketplace` port): catalogue types,
//! semver ordering, `praxis` manifest validation, tarball integrity checks, and in-memory
//! manifest extraction from published `.tgz` archives.
//!
//! Also holds the pure registry-client rules and the on-disk add-on storage; the HTTP transport
//! and install orchestration live in the desktop host.

pub mod addon_manifest;
pub mod catalog_types;
pub mod integrity;
pub mod registry;
pub mod semver;
pub mod storage;
pub mod tarball_manifest;
