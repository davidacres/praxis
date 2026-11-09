//! JavaScript string length and slicing (UTF-16 code units), so bounded text matches the TS cut
//! points exactly. A cut through a surrogate pair becomes U+FFFD (JS would keep a lone surrogate,
//! which `JSON.stringify` escapes); every other cut is identical.

pub(crate) fn js_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text.slice(start, end)` with non-negative indices clamped to the length.
pub(crate) fn js_slice(text: &str, start: usize, end: usize) -> String {
    if text.is_ascii() {
        let end = end.min(text.len());
        return text.get(start.min(end)..end).unwrap_or_default().to_owned();
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    let end = end.min(units.len());
    String::from_utf16_lossy(&units[start.min(end)..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_and_slices_utf16_units() {
        assert_eq!(js_len("a😀"), 3);
        assert_eq!(js_slice("hello", 1, 3), "el");
        assert_eq!(js_slice("hello", 3, 99), "lo");
        assert_eq!(js_slice("é😀x", 0, 3), "é😀");
    }
}
