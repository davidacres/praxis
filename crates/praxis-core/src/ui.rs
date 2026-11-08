//! UI colour helpers (`#rgb` and `#rrggbb` parsing and CSS literal normalization).

use serde_json::Value;

/// Parsed 8-bit RGB colour channels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

/// Parses `#rgb` or `#rrggbb` into RGB components. Returns `None` if invalid.
#[must_use]
pub fn parse_hex_rgb(input: Option<&str>) -> Option<Rgb> {
    let raw = input?.trim();
    let hex = raw.strip_prefix('#')?;
    let expanded = match hex.len() {
        3 => {
            if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            let mut s = String::with_capacity(6);
            for ch in hex.chars() {
                s.push(ch);
                s.push(ch);
            }
            s
        }
        6 => {
            if !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                return None;
            }
            hex.to_string()
        }
        _ => return None,
    };

    let r = u8::from_str_radix(&expanded[0..2], 16).ok()?;
    let g = u8::from_str_radix(&expanded[2..4], 16).ok()?;
    let b = u8::from_str_radix(&expanded[4..6], 16).ok()?;
    Some(Rgb { r, g, b })
}

/// Builds the inline style string for a metadata pill from a hex colour.
#[must_use]
pub fn build_meta_pill_inline_style(hex: Option<&str>) -> Option<String> {
    let Rgb { r, g, b } = parse_hex_rgb(hex)?;
    let hex6 = format!("#{r:02x}{g:02x}{b:02x}");
    Some(format!(
        "color: {hex6}; background: rgba({r}, {g}, {b}, 0.16); border-color: rgba({r}, {g}, {b}, 0.35);"
    ))
}

/// Normalizes an optional hex colour value, returning the trimmed string if valid.
#[must_use]
pub fn normalize_optional_hex_color(raw: &Value) -> Option<String> {
    let s = raw.as_str()?.trim();
    if s.is_empty() {
        return None;
    }
    parse_hex_rgb(Some(s)).map(|_| s.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_short_and_full_hex_colours() {
        assert_eq!(
            parse_hex_rgb(Some("#abc")),
            Some(Rgb {
                r: 0xaa,
                g: 0xbb,
                b: 0xcc
            })
        );
        assert_eq!(
            parse_hex_rgb(Some(" #123456 ")),
            Some(Rgb {
                r: 0x12,
                g: 0x34,
                b: 0x56
            })
        );
        assert_eq!(parse_hex_rgb(Some("123456")), None);
        assert_eq!(parse_hex_rgb(Some("#12345")), None);
        assert_eq!(parse_hex_rgb(Some("#12345678")), None);
        assert_eq!(
            normalize_optional_hex_color(&json!(" #4ec9b0 ")),
            Some("#4ec9b0".to_string())
        );
    }
}
