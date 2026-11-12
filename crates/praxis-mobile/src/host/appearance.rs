//! The desktop theme a paired phone follows (`normalizeMobileAppearance` in
//! `packages/core/src/host/mobileProtocol.ts`).
//!
//! The renderer resolves a theme to colours; this accepts only a well-formed result, so a
//! malformed one is dropped rather than painted on the phone.

use serde_json::{Map, Value, json};

const COLOR_KEYS: [&str; 14] = [
    "bg",
    "bgElevated",
    "bgSunken",
    "bgInput",
    "border",
    "borderStrong",
    "text",
    "textSecondary",
    "textTertiary",
    "accent",
    "accentContrast",
    "success",
    "warning",
    "danger",
];
const MOTIF_ANCHORS: [&str; 5] = [
    "top-left",
    "top-right",
    "bottom-left",
    "bottom-right",
    "center",
];
const MAX_MOTIF_SVG: usize = 200_000;
const MAX_NAME_CHARS: usize = 120;

fn is_hex_color(text: &str) -> bool {
    text.len() == 7
        && text.starts_with('#')
        && text[1..]
            .chars()
            .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
}

fn clipped(text: &str) -> String {
    text.trim().chars().take(MAX_NAME_CHARS).collect()
}

fn size_in(value: &Value, min: f64, max: f64) -> Option<f64> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && *n >= min && *n <= max)
}

fn normalize_motif(value: &Value) -> Option<Value> {
    let opacity = value["opacity"].as_f64().filter(|o| *o > 0.0)?;
    let layers = value["layers"].as_array()?;
    let mut kept = Vec::new();
    for layer in layers.iter().take(4) {
        let svg = layer["svg"].as_str()?;
        if !svg.starts_with("<svg") || svg.chars().count() > MAX_MOTIF_SVG {
            return None;
        }
        let anchor = layer["anchor"]
            .as_str()
            .filter(|a| MOTIF_ANCHORS.contains(a))?;
        size_in(&layer["width"], 1.0, 4000.0)?;
        size_in(&layer["height"], 1.0, 4000.0)?;
        kept.push(json!({
            "svg": svg, "width": layer["width"], "height": layer["height"], "anchor": anchor,
            "repeat": layer["repeat"] == true
        }));
    }
    if kept.is_empty() {
        return None;
    }
    let viewport = &value["viewport"];
    let mut motif = json!({ "opacity": opacity.min(1.0), "layers": kept });
    if size_in(&viewport["width"], 100.0, 10_000.0).is_some()
        && size_in(&viewport["height"], 100.0, 10_000.0).is_some()
    {
        motif["viewport"] = json!({ "width": viewport["width"], "height": viewport["height"] });
    }
    Some(motif)
}

/// A well-formed appearance with lower-cased colours, or `None`.
#[must_use]
pub fn normalize_mobile_appearance(value: &Value) -> Option<Value> {
    let theme_id = value["themeId"].as_str().filter(|t| !t.trim().is_empty())?;
    let mode = value["mode"]
        .as_str()
        .filter(|m| matches!(*m, "light" | "dark"))?;
    let colors = value["colors"].as_object()?;
    let mut normalized = Map::new();
    for key in COLOR_KEYS {
        let color = colors.get(key)?.as_str()?.to_lowercase();
        if !is_hex_color(&color) {
            return None;
        }
        normalized.insert(key.into(), Value::String(color));
    }
    let theme_id = clipped(theme_id);
    let theme_name = value["themeName"]
        .as_str()
        .map(clipped)
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| theme_id.clone());
    let mut appearance = json!({
        "themeId": theme_id, "themeName": theme_name, "mode": mode, "colors": normalized
    });
    if let Some(motif) = normalize_motif(&value["motif"]) {
        appearance["motif"] = motif;
    }
    Some(appearance)
}

#[cfg(test)]
#[allow(clippy::expect_used)]
mod tests {
    use super::*;

    fn colors() -> Value {
        let mut map = Map::new();
        for key in COLOR_KEYS {
            map.insert(key.into(), json!("#2C2620"));
        }
        Value::Object(map)
    }

    #[test]
    fn colours_are_lower_cased_and_the_name_falls_back_to_the_id() {
        let appearance = normalize_mobile_appearance(
            &json!({ "themeId": " praxis-dark ", "mode": "dark", "colors": colors() }),
        )
        .expect("appearance");
        assert_eq!(appearance["colors"]["bgElevated"], "#2c2620");
        assert_eq!(appearance["themeName"], "praxis-dark");
    }

    #[test]
    fn a_malformed_appearance_is_dropped() {
        let mut bad = colors();
        bad["bg"] = json!("red");
        for value in [
            json!(null),
            json!({ "themeId": "", "mode": "dark", "colors": colors() }),
            json!({ "themeId": "x", "mode": "sepia", "colors": colors() }),
            json!({ "themeId": "x", "mode": "dark", "colors": bad }),
            json!({ "themeId": "x", "mode": "dark" }),
        ] {
            assert!(normalize_mobile_appearance(&value).is_none(), "{value}");
        }
    }

    #[test]
    fn a_motif_keeps_valid_layers_and_a_fitting_viewport_only() {
        let motif = json!({
            "opacity": 3, "viewport": { "width": 50, "height": 800 },
            "layers": [{ "svg": "<svg/>", "width": 10, "height": 10, "anchor": "center", "repeat": true }]
        });
        let appearance = normalize_mobile_appearance(
            &json!({ "themeId": "x", "mode": "light", "colors": colors(), "motif": motif }),
        )
        .expect("appearance");
        assert_eq!(appearance["motif"]["opacity"], 1.0);
        assert!(appearance["motif"].get("viewport").is_none());
        let bad_layer = json!({
            "opacity": 0.5, "layers": [{ "svg": "<div/>", "width": 10, "height": 10, "anchor": "center" }]
        });
        let dropped = normalize_mobile_appearance(
            &json!({ "themeId": "x", "mode": "light", "colors": colors(), "motif": bad_layer }),
        )
        .expect("appearance");
        assert!(dropped.get("motif").is_none());
    }
}
