//! Add-on marketplace verification (`packages/core/src/marketplace` port): catalogue types,
//! semver ordering, `praxis` manifest validation, tarball integrity checks, and in-memory
//! manifest extraction from published `.tgz` archives.
//!
//! The registry client and install service (HTTP + on-disk storage) are not ported yet.

pub mod addon_manifest;
pub mod catalog_types;
pub mod integrity;
pub mod semver;
pub mod tarball_manifest;
