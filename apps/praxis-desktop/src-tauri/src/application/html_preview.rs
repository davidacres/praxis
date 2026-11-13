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
    Regex::new(r#"(?i)<meta\b[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy\b[^>]*>"#)
        .expect("csp regex")
});
/// A leading byte-order mark, whitespace and comments, then a doctype: the only things that may
/// precede the policy. Anything else (a `<script>` before `<head>`, or a `<head>` hidden inside a
/// comment) would run before the policy exists, or bury it where it never applies.
static DOCTYPE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)\A\u{FEFF}?(?:\s|<!--.*?-->)*<!doctype\b[^>]*>").expect("doctype regex")
});

pub fn is_html_path(path: &str) -> bool {
    let bare = path
        .split(['?', '#'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    bare.ends_with(".html") || bare.ends_with(".htm")
}

pub fn window_title(requested: &str) -> String {
    let clean: String = requested
        .chars()
        .map(|c| {
            if matches!(c, '\r' | '\n' | '\0') {
                ' '
            } else {
                c
            }
        })
        .take(120)
        .collect();
    format!(
        "Preview — {}",
        if clean.trim().is_empty() {
            "HTML artifact"
        } else {
            clean.as_str()
        }
    )
}

pub fn apply_policy(source: &str) -> String {
    let stripped = CSP_META.replace_all(source, "");
    let policy = format!(
        "<meta http-equiv=\"Content-Security-Policy\" content=\"{PREVIEW_CSP}\">{BOOTSTRAP}"
    );
    // The policy is the first element the parser meets, so it opens the (implied) `<head>` and is in
    // force before any of the source's own markup. The source's `<html>`/`<head>` tags that follow
    // are merged into the ones already open, as the HTML parser always does.
    let (doctype, rest) = match DOCTYPE.find(&stripped) {
        Some(m) => (&stripped[..m.end()], &stripped[m.end()..]),
        None => ("<!doctype html>", &stripped[..]),
    };
    format!("{doctype}<meta charset=\"utf-8\">{policy}{rest}")
}

/// Whether a preview window may go to `target`. It shows the one document it was opened with
/// (and in-page anchors on it); a script setting `location` to anything else is refused, since a
/// navigation is a way out of the no-network policy (the data rides in the URL).
pub fn preview_may_navigate(initial: &str, target: &str) -> bool {
    let without_fragment = |url: &str| url.split('#').next().unwrap_or_default().to_owned();
    target == "about:blank" || without_fragment(target) == without_fragment(initial)
}

/// A navigation filter for a preview window: the first `data:` document it loads is the preview
/// (taken as the engine reports it, so no re-serialisation can make the preview refuse itself), and
/// from then on [`preview_may_navigate`] decides.
pub fn preview_navigation_guard() -> impl Fn(&str) -> bool + Send + 'static {
    let document = std::sync::Mutex::new(None::<String>);
    move |target: &str| {
        let mut document = document
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        match document.as_deref() {
            Some(initial) => preview_may_navigate(initial, target),
            None if target.starts_with("data:") => {
                *document = Some(target.to_owned());
                true
            }
            None => target == "about:blank",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replaces_a_looser_source_policy() {
        let out = apply_policy(
            r#"<html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head></html>"#,
        );
        assert!(!out.contains("default-src *"));
        assert!(out.contains("default-src 'none'"));
    }

    #[test]
    fn wraps_a_fragment_and_checks_extensions() {
        let out = apply_policy("<h1>x</h1>");
        assert!(out.starts_with("<!doctype html><meta charset=\"utf-8\"><meta http-equiv"));
        assert!(out.ends_with("</script><h1>x</h1>"));
        assert!(is_html_path("a/b.HTML?x") && !is_html_path("a.txt"));
    }

    fn policy_offset(out: &str) -> usize {
        out.find("Content-Security-Policy").expect("policy present")
    }

    #[test]
    fn the_policy_precedes_a_script_placed_before_head() {
        // A script ahead of `<head>` used to run before the policy was parsed, with full network.
        let source = "<!DOCTYPE html><script>fetch('https://evil.test/')</script><html><head></head><body>x</body></html>";
        let out = apply_policy(source);
        assert!(out.starts_with("<!DOCTYPE html><meta"));
        assert!(policy_offset(&out) < out.find("evil.test").expect("script kept"));
    }

    #[test]
    fn a_head_inside_a_comment_cannot_swallow_the_policy() {
        // The policy used to be spliced in after the first `<head`, even one inside a comment,
        // where it is inert text and the page ran with no policy at all.
        let source = "<!-- <head> --><script>new Image().src='https://evil.test/'</script>";
        let out = apply_policy(source);
        assert!(policy_offset(&out) < out.find("<!--").expect("comment kept"));
    }

    #[test]
    fn a_leading_comment_and_doctype_stay_ahead_of_the_policy() {
        let out = apply_policy("\u{FEFF}<!-- hi -->\n<!doctype html><html><head></head></html>");
        assert!(out.starts_with("\u{FEFF}<!-- hi -->\n<!doctype html><meta charset"));
    }

    #[test]
    fn a_preview_only_navigates_within_its_own_document() {
        let initial = "data:text/html;charset=utf-8,%3Ch1%3Ex";
        assert!(preview_may_navigate(initial, initial));
        assert!(preview_may_navigate(initial, &format!("{initial}#section")));
        assert!(preview_may_navigate(initial, "about:blank"));
        assert!(!preview_may_navigate(
            initial,
            "https://evil.test/?d=secret"
        ));
        assert!(!preview_may_navigate(
            initial,
            "data:text/html,<script>fetch('x')</script>"
        ));
    }

    #[test]
    fn the_guard_admits_its_first_document_and_nothing_else() {
        let guard = preview_navigation_guard();
        assert!(guard("about:blank"));
        assert!(!guard("https://evil.test/"), "nothing remote, even first");
        assert!(guard("data:text/html,doc"));
        assert!(guard("data:text/html,doc#a"));
        assert!(!guard("data:text/html,other"));
        assert!(!guard("https://evil.test/?d=1"));
    }
}
