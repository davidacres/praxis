//! The restricted document policy for an HTML artifact shown in a preview window or thumbnail.
//!
//! The page gets no network, no downloads, no navigation and only inline `data:`/`blob:` assets;
//! a source document's own CSP is stripped so it cannot loosen this one.

use regex::Regex;
use std::sync::LazyLock;

const PREVIEW_CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; \
img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; object-src 'none'; \
base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; navigate-to 'none'";

const BOOTSTRAP: &str = "<script>\
document.addEventListener('click', event => {\
  const target = event.target;\
  const link = target instanceof Element ? target.closest('a') : null;\
  if (link && !link.getAttribute('href')?.startsWith('#')) event.preventDefault();\
}, true);\
document.addEventListener('submit', event => event.preventDefault(), true);\
</script>";

static CSP_META: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)<meta\b[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy\b[^>]*>"#).expect("csp regex")
});
static HEAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)<head\b[^>]*>").expect("head regex"));

pub fn is_html_path(path: &str) -> bool {
    let bare = path.split(['?', '#']).next().unwrap_or_default().to_ascii_lowercase();
    bare.ends_with(".html") || bare.ends_with(".htm")
}

pub fn window_title(requested: &str) -> String {
    let clean: String = requested.chars().map(|c| if matches!(c, '\r' | '\n' | '\0') { ' ' } else { c }).take(120).collect();
    format!("Preview — {}", if clean.trim().is_empty() { "HTML artifact" } else { clean.as_str() })
}

pub fn apply_policy(source: &str) -> String {
    let stripped = CSP_META.replace_all(source, "");
    let policy = format!("<meta http-equiv=\"Content-Security-Policy\" content=\"{PREVIEW_CSP}\">{BOOTSTRAP}");
    match HEAD.find(&stripped) {
        Some(m) => format!("{}{}{}", &stripped[..m.end()], policy, &stripped[m.end()..]),
        None => format!("<!doctype html><html><head><meta charset=\"utf-8\">{policy}</head><body>{stripped}</body></html>"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_a_looser_source_policy() {
        let out = apply_policy(r#"<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head></html>"#);
        assert!(!out.contains("default-src *"));
        assert!(out.contains("default-src 'none'"));
    }

    #[test]
    fn wraps_a_fragment_and_checks_extensions() {
        assert!(apply_policy("<h1>x</h1>").contains("<body><h1>x</h1></body>"));
        assert!(is_html_path("a/b.HTML?x") && !is_html_path("a.txt"));
    }
}
