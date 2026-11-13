//! The in-app browser the AI can drive and the user can watch (`aiBrowser.ts` port).
//!
//! The Electron host parented a `WebContentsView` to the window. The Rust host has no native view
//! in its headless/e2e shape, so this is a document-level browser: it loads pages over HTTP with
//! the same URL guards, keeps navigation history and the page's title, readable text and
//! interactive elements, and follows links. It does not run page scripts. Every state change is
//! published as `browser:didNavigate`, which is what opens and updates the renderer's browser pane.

use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use praxis_host::HostContext;
use regex::Regex;
use serde_json::{Value, json};
use url::Url;

use super::browser_native::{self, NativeBrowser};
use crate::webviews::blocked_browser_url_reason;

const MAX_TEXT: usize = 12_000;
const MAX_ELEMENTS: usize = 150;

#[derive(Debug, Clone, Default)]
pub struct Element {
    pub reference: String,
    pub role: String,
    pub name: String,
    pub value: String,
    href: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct Page {
    pub url: String,
    pub title: String,
    pub text: String,
    pub elements: Vec<Element>,
}

#[derive(Default)]
struct Browser {
    history: Vec<Page>,
    index: usize,
}

fn browser() -> &'static Mutex<Browser> {
    static BROWSER: OnceLock<Mutex<Browser>> = OnceLock::new();
    BROWSER.get_or_init(Default::default)
}

/// Unit tests point the browser at a local server without touching the process environment.
#[cfg(test)]
pub static ALLOW_PRIVATE_IN_TESTS: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn allow_private_hosts() -> bool {
    #[cfg(test)]
    if ALLOW_PRIVATE_IN_TESTS.load(std::sync::atomic::Ordering::SeqCst) {
        return true;
    }
    std::env::var("PRAXIS_BROWSER_ALLOW_LOOPBACK").as_deref() == Ok("1")
}

fn decode_entities(text: &str) -> String {
    text.replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&")
}

fn strip_tags(html: &str) -> String {
    static TAGS: OnceLock<Regex> = OnceLock::new();
    let tags = TAGS.get_or_init(|| Regex::new(r"(?s)<[^>]*>").expect("tag pattern"));
    decode_entities(&tags.replace_all(html, " "))
}

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn attribute(tag: &str, name: &str) -> Option<String> {
    let pattern = format!(r#"(?is)\b{name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#);
    let found = Regex::new(&pattern).ok()?.captures(tag)?;
    found
        .get(1)
        .or_else(|| found.get(2))
        .or_else(|| found.get(3))
        .map(|m| decode_entities(m.as_str()))
}

fn parse_page(url: &str, html: &str) -> Page {
    static TITLE: OnceLock<Regex> = OnceLock::new();
    static HIDDEN: OnceLock<Regex> = OnceLock::new();
    static MAIN: OnceLock<Regex> = OnceLock::new();
    static ELEMENT: OnceLock<Regex> = OnceLock::new();
    let title_pattern =
        TITLE.get_or_init(|| Regex::new(r"(?is)<title[^>]*>(.*?)</title>").expect("title pattern"));
    let hidden = HIDDEN.get_or_init(|| Regex::new(r"(?is)<(script|style|noscript|template)\b.*?</(script|style|noscript|template)>|<!--.*?-->").expect("hidden pattern"));
    let main = MAIN.get_or_init(|| {
        Regex::new(r"(?is)<(main|article)\b[^>]*>(.*?)</(main|article)>").expect("main pattern")
    });
    let element = ELEMENT.get_or_init(|| {
        Regex::new(r"(?is)<a\b[^>]*>.*?</a>|<button\b[^>]*>.*?</button>|<textarea\b[^>]*>.*?</textarea>|<select\b[^>]*>.*?</select>|<input\b[^>]*>").expect("element pattern")
    });

    let title = title_pattern
        .captures(html)
        .map(|c| collapse(&strip_tags(&c[1])))
        .unwrap_or_default();
    let visible = hidden.replace_all(html, " ").to_string();
    let body = visible
        .split_once("</head>")
        .map_or(visible.as_str(), |(_, rest)| rest)
        .to_string();
    let region = main
        .captures(&body)
        .map_or(body.clone(), |c| c[2].to_string());
    let block =
        Regex::new(r"(?i)</?(p|div|h[1-6]|li|ul|ol|tr|br|section|header|footer|nav|table)\b[^>]*>")
            .expect("block pattern");
    let broken = block.replace_all(&region, "\n").to_string();
    let lines: Vec<String> = strip_tags(&broken)
        .lines()
        .map(collapse)
        .filter(|line| !line.is_empty())
        .collect();
    let mut text = lines.join("\n");
    if text.chars().count() > MAX_TEXT {
        text = format!(
            "{}\n\n…[truncated at {MAX_TEXT} chars]",
            text.chars().take(MAX_TEXT).collect::<String>()
        );
    }

    let mut elements = Vec::new();
    for found in element.find_iter(&body) {
        let markup = found.as_str();
        let lower = markup.to_lowercase();
        let tag = lower
            .trim_start_matches('<')
            .split(|c: char| !c.is_ascii_alphanumeric())
            .next()
            .unwrap_or_default()
            .to_owned();
        if tag == "input"
            && attribute(markup, "type").is_some_and(|t| t.eq_ignore_ascii_case("hidden"))
        {
            continue;
        }
        let value = if matches!(tag.as_str(), "input" | "textarea" | "select") {
            attribute(markup, "value").unwrap_or_default()
        } else {
            String::new()
        };
        let name = attribute(markup, "aria-label")
            .or_else(|| Some(collapse(&strip_tags(markup))).filter(|t| !t.is_empty()))
            .or_else(|| (!value.is_empty()).then(|| value.clone()))
            .or_else(|| attribute(markup, "placeholder"))
            .or_else(|| attribute(markup, "title"))
            .or_else(|| attribute(markup, "alt"))
            .unwrap_or_default();
        let role = attribute(markup, "role")
            .unwrap_or_else(|| if tag == "a" { "a".into() } else { tag.clone() });
        let href = (tag == "a").then(|| attribute(markup, "href")).flatten();
        elements.push(Element {
            reference: format!("e{}", elements.len() + 1),
            role,
            name: name.chars().take(160).collect(),
            value: value.chars().take(120).collect(),
            href,
        });
        if elements.len() >= MAX_ELEMENTS {
            break;
        }
    }
    Page {
        url: url.to_owned(),
        title,
        text,
        elements,
    }
}

/// The most of a page the fetcher reads; past this the rest is dropped (only text is kept anyway).
const MAX_BODY_BYTES: usize = 5 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;

/// Follows a redirect only to a destination the browser could have been sent to directly. The
/// final URL alone is not enough: every hop is a request, so a public page redirecting to a
/// loopback or private address would have that request made before the end was checked.
fn redirect_policy(allow_private: bool) -> reqwest::redirect::Policy {
    reqwest::redirect::Policy::custom(move |attempt| {
        if attempt.previous().len() >= MAX_REDIRECTS {
            attempt.error("too many redirects")
        } else if let Some(reason) =
            blocked_browser_url_reason(attempt.url().as_str(), allow_private)
        {
            attempt.error(reason)
        } else {
            attempt.follow()
        }
    })
}

/// The body as text, reading no more than [`MAX_BODY_BYTES`].
async fn bounded_text(mut response: reqwest::Response) -> Result<String, String> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        let room = MAX_BODY_BYTES - body.len();
        body.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if body.len() >= MAX_BODY_BYTES {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&body).into_owned())
}

async fn load(url: &str) -> Result<Page, String> {
    let allow_private = allow_private_hosts();
    // Resolves the host too, so a public name that points at a private address is refused.
    crate::webviews::resolved_browser_url_block_reason(url, allow_private).await?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(redirect_policy(allow_private))
        .user_agent("Praxis-Browser")
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Could not load {url}: {e}"))?;
    let final_url = response.url().to_string();
    if let Some(reason) = blocked_browser_url_reason(&final_url, allow_private) {
        return Err(reason);
    }
    let body = bounded_text(response).await?;
    Ok(parse_page(&final_url, &body))
}

/// The page a native webview currently shows, read through the page script.
async fn native_page(shell: &dyn NativeBrowser) -> Result<Page, String> {
    let read = shell.eval("window.__praxisBrowser.read()").await?;
    let snapshot = shell.eval("window.__praxisBrowser.snapshot()").await?;
    let text = |v: &Value, key: &str| v[key].as_str().unwrap_or_default().to_owned();
    let elements = snapshot
        .as_array()
        .into_iter()
        .flatten()
        .map(|e| Element {
            reference: text(e, "ref"),
            role: text(e, "role"),
            name: text(e, "name"),
            value: text(e, "value"),
            href: None,
        })
        .collect();
    Ok(Page {
        url: text(&read, "url"),
        title: text(&read, "title"),
        text: text(&read, "text"),
        elements,
    })
}

/// The current page from whichever engine is installed.
async fn current_page() -> Result<Page, String> {
    match browser_native::shell() {
        Some(shell) if shell.exists() => native_page(shell.as_ref()).await,
        _ => read(),
    }
}

fn js_string(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| "\"\"".into())
}

fn state_value(browser: &Browser, loading: bool) -> Value {
    let page = browser.history.get(browser.index);
    json!({
        "url": page.map_or("", |p| p.url.as_str()),
        "title": page.map_or("", |p| p.title.as_str()),
        "canGoBack": browser.index > 0,
        "canGoForward": browser.index + 1 < browser.history.len(),
        "loading": loading
    })
}

fn publish(host: &HostContext) {
    if let Some(shell) = browser_native::shell() {
        host.events()
            .emit("browser:didNavigate", Some(shell.state()));
        return;
    }
    let payload = state_value(
        &browser()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
        false,
    );
    host.events().emit("browser:didNavigate", Some(payload));
}

fn current() -> Option<Page> {
    let guard = browser()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    guard.history.get(guard.index).cloned()
}

/// The state `browser.getState()` reports.
pub fn get_state() -> Value {
    if let Some(shell) = browser_native::shell() {
        return shell.state();
    }
    state_value(
        &browser()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
        false,
    )
}

pub async fn navigate(host: &HostContext, url: &str) -> Result<Page, String> {
    if let Some(shell) = browser_native::shell() {
        if let Some(reason) = blocked_browser_url_reason(url, allow_private_hosts()) {
            return Err(reason);
        }
        browser_native::reset_diagnostics();
        shell.ensure()?;
        shell.navigate(url).await?;
        publish(host);
        return native_page(shell.as_ref()).await;
    }
    let page = load(url).await?;
    {
        let mut guard = browser()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let keep = if guard.history.is_empty() {
            0
        } else {
            guard.index + 1
        };
        guard.history.truncate(keep);
        guard.history.push(page.clone());
        guard.index = guard.history.len() - 1;
    }
    publish(host);
    Ok(page)
}

pub async fn go_back(host: &HostContext) {
    if let Some(shell) = browser_native::shell() {
        if shell.exists() {
            browser_native::reset_diagnostics();
            let _ = shell.back().await;
        }
        publish(host);
        return;
    }
    {
        let mut guard = browser()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if guard.index > 0 {
            guard.index -= 1;
        }
    }
    publish(host);
}

pub async fn go_forward(host: &HostContext) {
    if let Some(shell) = browser_native::shell() {
        if shell.exists() {
            browser_native::reset_diagnostics();
            let _ = shell.forward().await;
        }
        publish(host);
        return;
    }
    {
        let mut guard = browser()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if guard.index + 1 < guard.history.len() {
            guard.index += 1;
        }
    }
    publish(host);
}

pub async fn reload(host: &HostContext) -> Result<(), String> {
    if let Some(shell) = browser_native::shell() {
        if shell.exists() {
            browser_native::reset_diagnostics();
            shell.reload().await?;
        }
        publish(host);
        return Ok(());
    }
    let Some(page) = current() else { return Ok(()) };
    let fresh = load(&page.url).await?;
    {
        let mut guard = browser()
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let index = guard.index;
        guard.history[index] = fresh;
    }
    publish(host);
    Ok(())
}

pub fn read() -> Result<Page, String> {
    current().ok_or_else(|| {
        "The in-app browser has no page open. Call browser_navigate first.".to_owned()
    })
}

pub async fn click(host: &HostContext, reference: &str) -> Result<Page, String> {
    let page = read()?;
    let element = page
        .elements
        .iter()
        .find(|e| e.reference == reference)
        .ok_or_else(|| {
            format!("No element with ref \"{reference}\" — call browser_snapshot again.")
        })?;
    if let Some(href) = &element.href {
        let target = Url::parse(&page.url)
            .and_then(|base| base.join(href))
            .map_err(|e| e.to_string())?;
        if target.scheme() == "javascript" {
            return Ok(page);
        }
        return navigate(host, target.as_str()).await;
    }
    Ok(page)
}

pub fn type_text(reference: &str, text: &str) -> Result<Page, String> {
    let mut guard = browser()
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let index = guard.index;
    let page = guard
        .history
        .get_mut(index)
        .ok_or("The in-app browser has no page open.")?;
    let element = page
        .elements
        .iter_mut()
        .find(|e| e.reference == reference)
        .ok_or_else(|| {
            format!("No element with ref \"{reference}\" — call browser_snapshot again.")
        })?;
    element.value = text.to_owned();
    Ok(page.clone())
}

fn excerpt(page: &Page) -> String {
    let text: String = page.text.chars().take(600).collect();
    format!("URL: {}\nTitle: {}\n\n{}", page.url, page.title, text)
}

/// Tool definitions a full-tools session is granted (`BROWSER_TOOL_DEFINITIONS`).
pub fn tool_definitions() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "browser_navigate",
            "Open a URL in the in-app browser. Returns the resolved URL, page title, and only a short excerpt of the text — call browser_read afterwards if you need the full page body. Navigating to a host that is not pre-approved asks the user to allow it first.",
            json!({ "type": "object", "properties": { "url": { "type": "string", "description": "Absolute http(s) URL." } }, "required": ["url"] }),
        ),
        (
            "browser_read",
            "Return the CURRENT page as plain text (main content; scripts, nav and chrome stripped). This is the only tool that returns the full body, so only call it when you actually need to read the page contents — not routinely after every navigation.",
            json!({ "type": "object", "properties": {} }),
        ),
        (
            "browser_snapshot",
            "List the interactive elements on the current page — links, buttons, inputs, selects — each with a stable `ref`, its role, its visible label, and its current value. Pass a `ref` to browser_click / browser_type.",
            json!({ "type": "object", "properties": { "filter": { "type": "string", "description": "Optional case-insensitive substring; only elements whose label/value contains it are returned." } } }),
        ),
        (
            "browser_click",
            "Click the element with the given ref (from browser_snapshot), then return the updated title, URL, and a short excerpt.",
            json!({ "type": "object", "properties": { "ref": { "type": "string" } }, "required": ["ref"] }),
        ),
        (
            "browser_type",
            "Type text into the input/textarea with the given ref. Set submit=true to press Enter afterwards (e.g. to run a search). Returns the updated title, URL, and a short excerpt.",
            json!({ "type": "object", "properties": { "ref": { "type": "string" }, "text": { "type": "string" }, "submit": { "type": "boolean" } }, "required": ["ref", "text"] }),
        ),
        (
            "browser_diagnostics",
            "Return console errors/warnings and failed network requests captured since the last browser_navigate. Reports \"not supported\" rather than an empty result on a host that cannot capture diagnostics.",
            json!({ "type": "object", "properties": {} }),
        ),
        (
            "browser_screenshot",
            "Capture a screenshot of the current page for the USER to review — the image is never returned to you, only a confirmation that it was captured (or why it could not be).",
            json!({ "type": "object", "properties": {} }),
        ),
    ]
}

/// The host part of a URL, as the allow-list is keyed.
pub fn host_of(url: &str) -> Option<String> {
    Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_lowercase))
}

fn native_shell() -> Option<std::sync::Arc<dyn NativeBrowser>> {
    browser_native::shell().filter(|shell| shell.exists())
}

fn require_element(result: &Value, reference: &str) -> Result<(), String> {
    if result == &Value::Bool(true) {
        Ok(())
    } else {
        Err(format!(
            "No element with ref \"{reference}\" — call browser_snapshot again."
        ))
    }
}

/// Gives an action that may have started a navigation time to land, then tells the pane.
async fn settle(host: &HostContext, shell: &dyn NativeBrowser) {
    tokio::time::sleep(Duration::from_millis(600)).await;
    shell.wait_idle().await;
    publish(host);
}

/// Runs one tool (after the caller has dealt with host approval) and returns `(ok, text)`.
pub async fn run_tool(host: &HostContext, name: &str, args: &Value) -> (bool, String) {
    let result: Result<String, String> = async {
        match name {
            "browser_navigate" => {
                let url = args["url"].as_str().unwrap_or_default().trim();
                if url.is_empty() {
                    return Err("url is required.".into());
                }
                Ok(excerpt(&navigate(host, url).await?))
            }
            "browser_read" => {
                let page = current_page().await?;
                Ok(format!(
                    "URL: {}\nTitle: {}\n\n{}",
                    page.url, page.title, page.text
                ))
            }
            "browser_snapshot" => {
                let page = current_page().await?;
                let needle = args["filter"].as_str().unwrap_or_default().to_lowercase();
                let rows: Vec<String> = page
                    .elements
                    .iter()
                    .filter(|e| {
                        needle.is_empty()
                            || format!("{} {}", e.name, e.value)
                                .to_lowercase()
                                .contains(&needle)
                    })
                    .map(|e| {
                        format!(
                            "[{}] {} \"{}\"{}",
                            e.reference,
                            e.role,
                            e.name,
                            if e.value.is_empty() {
                                String::new()
                            } else {
                                format!(" value=\"{}\"", e.value)
                            }
                        )
                    })
                    .collect();
                Ok(format!(
                    "URL: {}\nTitle: {}\n\n{}",
                    page.url,
                    page.title,
                    if rows.is_empty() {
                        "(no interactive elements)".to_owned()
                    } else {
                        rows.join("\n")
                    }
                ))
            }
            "browser_click" => {
                let reference = args["ref"].as_str().unwrap_or_default();
                if let Some(shell) = native_shell() {
                    let clicked = shell
                        .eval(&format!(
                            "window.__praxisBrowser.click({})",
                            js_string(reference)
                        ))
                        .await?;
                    require_element(&clicked, reference)?;
                    settle(host, shell.as_ref()).await;
                    return Ok(excerpt(&native_page(shell.as_ref()).await?));
                }
                Ok(excerpt(&click(host, reference).await?))
            }
            "browser_type" => {
                let reference = args["ref"].as_str().unwrap_or_default();
                let text = args["text"].as_str().unwrap_or_default();
                if let Some(shell) = native_shell() {
                    let submit = args["submit"].as_bool().unwrap_or(false);
                    let typed = shell
                        .eval(&format!(
                            "window.__praxisBrowser.type({}, {}, {submit})",
                            js_string(reference),
                            js_string(text)
                        ))
                        .await?;
                    require_element(&typed, reference)?;
                    if submit {
                        settle(host, shell.as_ref()).await;
                    }
                    return Ok(excerpt(&native_page(shell.as_ref()).await?));
                }
                Ok(excerpt(&type_text(reference, text)?))
            }
            "browser_diagnostics" => match native_shell() {
                Some(shell) => Ok(serde_json::to_string_pretty(
                    &browser_native::diagnostics(shell.as_ref()).await,
                )
                .unwrap_or_default()),
                None => Ok(
                    "Console and network diagnostics are not supported by this browser host."
                        .into(),
                ),
            },
            "browser_screenshot" => match native_shell() {
                Some(shell) => {
                    let png = shell.screenshot_png().await?;
                    let dir = host.config().user_data_dir.join("browser-screenshots");
                    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                    let stamp = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_or(0, |d| d.as_millis());
                    let file = dir.join(format!("browser-{stamp}.png"));
                    std::fs::write(&file, &png).map_err(|e| e.to_string())?;
                    Ok(format!(
                        "Screenshot captured for the user ({} KB) and saved to {}.",
                        png.len() / 1024,
                        file.display()
                    ))
                }
                None => Ok(
                    "A screenshot could not be captured: this browser host renders no pixels."
                        .into(),
                ),
            },
            other => Err(format!("Unknown browser tool: {other}")),
        }
    }
    .await;
    match result {
        Ok(text) => (true, text),
        Err(message) => (false, message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};

    /// Serves one canned response on loopback and returns its address.
    fn serve_once(response: Vec<u8>) -> std::net::SocketAddr {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("address");
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut request = [0u8; 2048];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(&response);
            }
        });
        address
    }

    #[tokio::test]
    async fn a_redirect_to_a_private_address_is_never_requested() {
        // The private destination records whether anything reached it.
        let reached = Arc::new(AtomicBool::new(false));
        let inner = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let inner_address = inner.local_addr().expect("address");
        let flag = Arc::clone(&reached);
        std::thread::spawn(move || {
            inner.set_nonblocking(false).ok();
            if inner.accept().is_ok() {
                flag.store(true, Ordering::SeqCst);
            }
        });
        let outer = serve_once(
            format!(
                "HTTP/1.1 302 Found\r\nLocation: http://{inner_address}/admin\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .into_bytes(),
        );
        // The first hop stands in for a public page (it is fetched directly, past `load`'s own
        // check); the redirect policy alone must stop the second.
        let client = reqwest::Client::builder()
            .redirect(redirect_policy(false))
            .build()
            .expect("client");
        let result = client.get(format!("http://{outer}/")).send().await;
        assert!(result.is_err(), "the redirect was followed");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !reached.load(Ordering::SeqCst),
            "the private host was requested"
        );
    }

    #[tokio::test]
    async fn a_huge_page_is_read_only_up_to_the_cap() {
        let size = MAX_BODY_BYTES + 512 * 1024;
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n"
        )
        .into_bytes();
        response.extend(std::iter::repeat_n(b'a', size));
        let address = serve_once(response);
        let response = reqwest::get(format!("http://{address}/"))
            .await
            .expect("response");
        let text = bounded_text(response).await.expect("text");
        assert_eq!(text.len(), MAX_BODY_BYTES);
    }
}
