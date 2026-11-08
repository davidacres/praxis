//! Reads `package/package.json`'s `praxis` field straight out of a published
//! `.tgz`, in memory (`tarballManifest.ts` port).
//!
//! GitHub Packages' packument API drops custom top-level `package.json` fields
//! such as `praxis`, so the tarball itself is the only reliable source for an
//! add-on manifest hosted there. This is a minimal USTAR walker with an inflate
//! cap, so a gzip bomb cannot exhaust memory.

use std::io::Read;

use flate2::read::MultiGzDecoder;
use serde_json::Value;

/// An add-on is a manifest and a few files; anything that inflates past this is not one.
pub const MAX_UNPACKED_TARBALL_BYTES: u64 = 64 * 1024 * 1024;

const BLOCK: usize = 512;
const MANIFEST_ENTRY: &[u8] = b"package/package.json";

/// Inflates `tarball` (refusing anything larger than `max_unpacked_bytes`) and returns the
/// `praxis` value from `package/package.json`.
///
/// `Ok(None)` means the archive has no `package/package.json`, it is not valid JSON, or it has
/// no `praxis` field. `Err` means the gzip stream was corrupt or exceeded the cap.
pub fn read_praxis_manifest_from_tarball(
    tarball: &[u8],
    max_unpacked_bytes: u64,
) -> Result<Option<Value>, String> {
    let tar = inflate_capped(tarball, max_unpacked_bytes)?;

    let mut offset = 0usize;
    while offset + BLOCK <= tar.len() {
        let header = &tar[offset..offset + BLOCK];
        // Zeroed blocks mark end-of-archive.
        if header.iter().all(|&byte| byte == 0) {
            break;
        }

        let name = c_string(&header[0..100]);
        let Some(size) = parse_octal(c_string(&header[124..136])) else {
            // An unreadable size means we cannot find the next header; stop like the TS reader.
            break;
        };
        let content_start = offset + BLOCK;

        if name == MANIFEST_ENTRY {
            let end = content_start.saturating_add(size).min(tar.len());
            let content = String::from_utf8_lossy(&tar[content_start.min(end)..end]);
            return Ok(serde_json::from_str::<Value>(&content)
                .ok()
                .and_then(|mut parsed| parsed.get_mut("praxis").map(Value::take)));
        }

        // Advance past this entry's content, padded up to the next 512-byte block.
        let Some(next) = size
            .div_ceil(BLOCK)
            .checked_mul(BLOCK)
            .and_then(|padded| content_start.checked_add(padded))
        else {
            break;
        };
        offset = next;
    }
    Ok(None)
}

fn inflate_capped(tarball: &[u8], max_unpacked_bytes: u64) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    MultiGzDecoder::new(tarball)
        .take(max_unpacked_bytes.saturating_add(1))
        .read_to_end(&mut out)
        .map_err(|err| format!("Could not decompress the add-on tarball: {err}"))?;
    if out.len() as u64 > max_unpacked_bytes {
        // Mirrors `Math.round(maxUnpackedBytes / 1024 / 1024)` in the TS message.
        let megabytes = (max_unpacked_bytes + 512 * 1024) / (1024 * 1024);
        return Err(format!(
            "The add-on tarball unpacks to more than {megabytes} MB; it is not a valid add-on."
        ));
    }
    Ok(out)
}

fn c_string(field: &[u8]) -> &[u8] {
    field
        .iter()
        .position(|&byte| byte == 0)
        .map_or(field, |nul| &field[..nul])
}

/// Parses a USTAR octal size field like JS `parseInt(field.trim(), 8)`: an empty field is
/// zero, otherwise the leading octal digits are read and anything after them ignored.
fn parse_octal(field: &[u8]) -> Option<usize> {
    let text = std::str::from_utf8(field).ok()?.trim();
    if text.is_empty() {
        return Some(0);
    }
    let digits: &str = &text[..text
        .find(|c: char| !('0'..='7').contains(&c))
        .unwrap_or(text.len())];
    usize::from_str_radix(digits, 8).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use serde_json::json;
    use std::io::Write;

    fn gzip(bytes: &[u8]) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(bytes).expect("gzip write");
        encoder.finish().expect("gzip finish")
    }

    fn write_field(header: &mut [u8], at: usize, text: &str) {
        header[at..at + text.len()].copy_from_slice(text.as_bytes());
    }

    /// Builds a minimal gzipped USTAR tarball, the same shape `npm pack` produces.
    fn build_tarball(entries: &[(&str, &str)]) -> Vec<u8> {
        let mut tar = Vec::new();
        for (name, content) in entries {
            let mut header = [0u8; BLOCK];
            write_field(&mut header, 0, name);
            write_field(&mut header, 100, "0000644\0");
            write_field(&mut header, 108, "0000000\0");
            write_field(&mut header, 116, "0000000\0");
            write_field(&mut header, 124, &format!("{:011o}\0", content.len()));
            write_field(&mut header, 136, "00000000000\0");
            write_field(&mut header, 148, "        ");
            write_field(&mut header, 156, "0");
            write_field(&mut header, 257, "ustar\0");
            write_field(&mut header, 263, "00");
            let checksum: u32 = header.iter().map(|&b| u32::from(b)).sum();
            write_field(&mut header, 148, &format!("{checksum:06o}\0 "));

            tar.extend_from_slice(&header);
            let mut body = content.as_bytes().to_vec();
            body.resize(content.len().div_ceil(BLOCK) * BLOCK, 0);
            tar.extend_from_slice(&body);
        }
        tar.extend_from_slice(&[0u8; 2 * BLOCK]);
        gzip(&tar)
    }

    #[test]
    fn recovers_the_manifest_from_package_json() {
        let package = json!({
            "name": "@acme/praxis-addon-nord",
            "version": "1.0.0",
            "praxis": { "schemaVersion": 1, "kind": "theme", "id": "nord", "name": "Nord" }
        })
        .to_string();
        let tarball = build_tarball(&[
            ("package/README.md", "# Nord"),
            ("package/package.json", &package),
        ]);
        let manifest = read_praxis_manifest_from_tarball(&tarball, MAX_UNPACKED_TARBALL_BYTES)
            .expect("read tarball");
        assert_eq!(
            manifest,
            Some(json!({ "schemaVersion": 1, "kind": "theme", "id": "nord", "name": "Nord" }))
        );
    }

    #[test]
    fn returns_none_when_package_json_has_no_praxis_field() {
        let tarball = build_tarball(&[(
            "package/package.json",
            r#"{"name":"@acme/some-lib","version":"1.0.0"}"#,
        )]);
        assert_eq!(
            read_praxis_manifest_from_tarball(&tarball, MAX_UNPACKED_TARBALL_BYTES),
            Ok(None)
        );
    }

    #[test]
    fn returns_none_when_package_json_is_absent_or_invalid() {
        let absent = build_tarball(&[("package/README.md", "# nothing here")]);
        assert_eq!(
            read_praxis_manifest_from_tarball(&absent, MAX_UNPACKED_TARBALL_BYTES),
            Ok(None)
        );
        let invalid = build_tarball(&[("package/package.json", "{not json")]);
        assert_eq!(
            read_praxis_manifest_from_tarball(&invalid, MAX_UNPACKED_TARBALL_BYTES),
            Ok(None)
        );
    }

    #[test]
    fn refuses_a_tarball_that_inflates_past_the_cap() {
        let bomb = gzip(&vec![0u8; 2 * 1024 * 1024]);
        let err = read_praxis_manifest_from_tarball(&bomb, 1024 * 1024).expect_err("bomb");
        assert!(err.contains("unpacks to more than 1 MB"), "{err}");
    }

    #[test]
    fn corrupt_gzip_is_an_error() {
        assert!(
            read_praxis_manifest_from_tarball(b"not gzip", MAX_UNPACKED_TARBALL_BYTES).is_err()
        );
    }
}
