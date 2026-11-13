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

/// One HTML document served from a loopback port, for as long as this value lives.
///
/// A window loaded from a `data:` URL stays blank in the platform webview (and is capped by URL
/// length), so previews and thumbnails load the document over `http://127.0.0.1` instead. The path
/// carries a random token, only that path is answered, and the server stops when this is dropped.
pub struct ServedDocument {
    pub url: String,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl Drop for ServedDocument {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

/// How long a served document stays up even if nobody drops it.
const SERVE_LIMIT: std::time::Duration = std::time::Duration::from_secs(60 * 60);

pub fn serve_document(html: String) -> std::io::Result<ServedDocument> {
    use std::io::{Read, Write};
    use std::sync::atomic::{AtomicBool, Ordering};
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    listener.set_nonblocking(true)?;
    let port = listener.local_addr()?.port();
    let path = format!("/{}/", uuid::Uuid::new_v4().simple());
    let stop = std::sync::Arc::new(AtomicBool::new(false));
    let flag = std::sync::Arc::clone(&stop);
    let served_path = path.clone();
    std::thread::spawn(move || {
        let deadline = std::time::Instant::now() + SERVE_LIMIT;
        while !flag.load(Ordering::Relaxed) && std::time::Instant::now() < deadline {
            let mut stream = match listener.accept() {
                Ok((stream, _)) => stream,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(std::time::Duration::from_millis(25));
                    continue;
                }
                Err(_) => break,
            };
            let _ = stream.set_nonblocking(false);
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
            let mut head = [0u8; 4096];
            let read = stream.read(&mut head).unwrap_or(0);
            let request = String::from_utf8_lossy(&head[..read]);
            let target = request
                .lines()
                .next()
                .and_then(|line| line.strip_prefix("GET "))
                .and_then(|rest| rest.split_whitespace().next())
                .unwrap_or_default();
            let (status, body) = if target.split('?').next() == Some(served_path.as_str()) {
                ("200 OK", html.as_bytes())
            } else {
                ("404 Not Found", &b""[..])
            };
            let response = format!(
                "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\
                 Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.write_all(body);
        }
    });
    Ok(ServedDocument {
        url: format!("http://127.0.0.1:{port}{path}"),
        stop,
    })
}

/// A navigation filter for a window showing a [`ServedDocument`]: the first navigation must be to
/// that document, and from then on [`preview_may_navigate`] decides.
pub fn served_navigation_guard(url: String) -> impl Fn(&str) -> bool + Send + 'static {
    let opened = std::sync::atomic::AtomicBool::new(false);
    move |target: &str| {
        if !opened.load(std::sync::atomic::Ordering::Relaxed) {
            if target == url {
                opened.store(true, std::sync::atomic::Ordering::Relaxed);
                return true;
            }
            return target == "about:blank";
        }
        preview_may_navigate(&url, target)
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

    fn get(url: &str, path_override: Option<&str>) -> String {
        use std::io::{Read, Write};
        let rest = url.strip_prefix("http://").expect("http url");
        let (host, path) = rest.split_once('/').expect("path");
        let mut stream = std::net::TcpStream::connect(host).expect("connect");
        let path = path_override.map_or_else(|| format!("/{path}"), str::to_owned);
        write!(stream, "GET {path} HTTP/1.1\r\nHost: {host}\r\n\r\n").expect("write");
        let mut out = String::new();
        stream.read_to_string(&mut out).expect("read");
        out
    }

    #[test]
    fn a_served_document_answers_only_its_own_path_and_stops_when_dropped() {
        let served = serve_document("<h1>hello</h1>".into()).expect("serve");
        assert!(served.url.starts_with("http://127.0.0.1:"));
        let ok = get(&served.url, None);
        assert!(ok.starts_with("HTTP/1.1 200 OK"), "{ok}");
        assert!(ok.contains("nosniff") && ok.ends_with("<h1>hello</h1>"));
        let elsewhere = get(&served.url, Some("/"));
        assert!(elsewhere.starts_with("HTTP/1.1 404"), "{elsewhere}");
        let url = served.url.clone();
        drop(served);
        std::thread::sleep(std::time::Duration::from_millis(200));
        let host = url
            .strip_prefix("http://")
            .and_then(|r| r.split('/').next())
            .expect("host");
        assert!(
            std::net::TcpStream::connect(host).is_err(),
            "the server stopped"
        );
    }

    #[test]
    fn the_served_guard_opens_the_document_then_refuses_everything_else() {
        let guard = served_navigation_guard("http://127.0.0.1:9/abc/".into());
        assert!(
            !guard("https://example.com/"),
            "nothing but the document first"
        );
        assert!(guard("http://127.0.0.1:9/abc/"));
        assert!(guard("http://127.0.0.1:9/abc/#section"));
        assert!(!guard("https://example.com/"));
        assert!(!guard("http://127.0.0.1:9/other/"));
    }
}
