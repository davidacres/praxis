//! The in-app browser the AI can drive and the user can watch (`aiBrowser.ts` port).
//!
//! The Electron host parented a `WebContentsView` to the window. The Rust host has no native view
//! in its headless/e2e shape, so this is a document-level browser: it loads pages over HTTP with
//! the same URL guards, keeps navigation history and the page's title, readable text and
//! interactive elements, and follows links. It does not run page scripts. Every state change is
//! published as `browser:didNavigate`, which is what opens and updates the renderer's browser pane.

use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use praxis_host::HostContext;
use regex::Regex;
use serde_json::{Value, json};
use url::Url;

use super::browser_native::{self, NativeBrowser};
use super::browser_policy::{self, Allowance, Approver, Driver};

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

/// Fetches `url` for the fetched-page backend, following redirects one hop at a time. Every hop
/// is a request, so every hop is checked before it is made: its destination must be public (it is
/// resolved here and the connection is pinned to the vetted address, so the HTTP client cannot
/// look the name up again and land somewhere else), and when an agent is driving, its host must be
/// approved — the same host as the hop before it, on the allow-list, or approved now.
async fn load(
    host: Option<&HostContext>,
    url: &str,
    from: Option<&str>,
    driver: &Driver,
    allowance: &Allowance,
) -> Result<Page, String> {
    let mut target = url.to_owned();
    let mut previous = from.map(str::to_owned);
    for _ in 0..=MAX_REDIRECTS {
        let pinned = browser_policy::vet_destination(&target, allowance).await?;
        if let Driver::Agent(approver) = driver {
            browser_policy::check_agent_navigation(host, approver, previous.as_deref(), &target)
                .await?;
        }
        let mut builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            // A proxy would resolve the name itself, undoing the pin.
            .no_proxy()
            .user_agent("Praxis-Browser");
        if let Some((name, address)) = &pinned {
            builder = builder.resolve(name, *address);
        }
        let client = builder.build().map_err(|e| e.to_string())?;
        let response = client
            .get(&target)
            .send()
            .await
            .map_err(|e| format!("Could not load {target}: {e}"))?;
        if response.status().is_redirection()
            && let Some(location) = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
        {
            let next = Url::parse(&target)
                .and_then(|base| base.join(location))
                .map_err(|e| format!("A redirect from {target} went nowhere: {e}"))?;
            previous = Some(std::mem::replace(&mut target, next.to_string()));
            continue;
        }
        let body = bounded_text(response).await?;
        return Ok(parse_page(&target, &body));
    }
    Err(format!("Too many redirects loading {url}."))
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

/// The URL the browser is on now, whichever engine shows it.
fn current_url() -> Option<String> {
    match browser_native::shell() {
        Some(shell) if shell.exists() => shell.state()["url"]
            .as_str()
            .filter(|u| !u.is_empty())
            .map(str::to_owned),
        _ => current().map(|p| p.url),
    }
}

/// Opens `url`. A person's navigation is their own approval (for this run); an agent's goes
/// through the allow-list, and so does every redirect and link it leads to (see `browser_policy`).
pub async fn navigate(host: &HostContext, url: &str, driver: &Driver) -> Result<Page, String> {
    let from = current_url();
    if let Some(shell) = browser_native::shell() {
        // The native engine never gets the e2e allowance: it only exists in real launches.
        browser_policy::vet_destination(url, &Allowance::None).await?;
        match driver {
            Driver::Agent(approver) => {
                browser_policy::check_agent_navigation(Some(host), approver, from.as_deref(), url)
                    .await?;
            }
            Driver::Person => {
                browser_policy::note_person_opened(url);
                // Redirects of the person's own navigation are theirs too.
                browser_policy::note_person_input();
            }
        }
        browser_native::reset_diagnostics();
        shell.ensure()?;
        shell.navigate(url).await?;
        if let Driver::Agent(approver) = driver {
            browser_policy::resolve_blocked_after_action(host, approver, shell.as_ref()).await?;
        }
        publish(host);
        return native_page(shell.as_ref()).await;
    }
    if matches!(driver, Driver::Person) {
        browser_policy::note_person_opened(url);
    }
    let page = load(
        Some(host),
        url,
        from.as_deref(),
        driver,
        &browser_policy::allowance(),
    )
    .await?;
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
    // The person pressed reload; the page's own host is already where they are.
    let fresh = load(
        Some(host),
        &page.url,
        Some(&page.url),
        &Driver::Person,
        &browser_policy::allowance(),
    )
    .await?;
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

pub async fn click(host: &HostContext, reference: &str, driver: &Driver) -> Result<Page, String> {
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
        return navigate(host, target.as_str(), driver).await;
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
            "Open a URL in the in-app browser. Returns the resolved URL, page title, and only a short excerpt of the text — call browser_read afterwards if you need the full page body. Every navigation is checked, not just this one: leaving the current host for one that is not on the user's allow-list — here, through a link you click, a form you submit, a redirect, or the page's own scripts — pauses and asks the user to allow that host first; a refusal comes back as \"Permission denied to open <host>\" and the browser stays where it was. Staying on the same host never asks. Loopback, link-local and private-network addresses (including names that resolve to them) are always refused.",
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
            "Click the element with the given ref (from browser_snapshot), then return the updated title, URL, and a short excerpt. If the click leads to a host that is not approved, the user is asked first (see browser_navigate).",
            json!({ "type": "object", "properties": { "ref": { "type": "string" } }, "required": ["ref"] }),
        ),
        (
            "browser_type",
            "Type text into the input/textarea with the given ref. Set submit=true to press Enter afterwards (e.g. to run a search). Returns the updated title, URL, and a short excerpt. A submit that leads to a host that is not approved asks the user first (see browser_navigate).",
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

/// After an agent's click or submit on the native webview: anything the navigation hook refused
/// for want of approval is asked about now, then the pane is told where the browser ended up.
async fn after_native_action(
    host: &HostContext,
    approver: &Approver,
    shell: &dyn NativeBrowser,
) -> Result<Page, String> {
    let followed = browser_policy::resolve_blocked_after_action(host, approver, shell).await;
    publish(host);
    followed?;
    native_page(shell).await
}

/// Runs one tool and returns `(ok, text)`. Any navigation it causes — `browser_navigate`, a link
/// it clicks, a form it submits, the redirects that follow, a page script — that leaves the
/// current host for one that is not approved is put to `approver` first.
pub async fn run_tool(
    host: &HostContext,
    name: &str,
    args: &Value,
    approver: &Approver,
) -> (bool, String) {
    let _turn = browser_policy::begin_agent_turn(approver);
    let driver = Driver::Agent(Arc::clone(approver));
    let result: Result<String, String> = async {
        match name {
            "browser_navigate" => {
                let url = args["url"].as_str().unwrap_or_default().trim();
                if url.is_empty() {
                    return Err("url is required.".into());
                }
                Ok(excerpt(&navigate(host, url, &driver).await?))
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
                    return Ok(excerpt(
                        &after_native_action(host, approver, shell.as_ref()).await?,
                    ));
                }
                Ok(excerpt(&click(host, reference, &driver).await?))
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
                        return Ok(excerpt(
                            &after_native_action(host, approver, shell.as_ref()).await?,
                        ));
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

    /// A listener that records whether anything connected to it.
    fn tripwire() -> (std::net::SocketAddr, Arc<AtomicBool>) {
        let reached = Arc::new(AtomicBool::new(false));
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("address");
        let flag = Arc::clone(&reached);
        std::thread::spawn(move || {
            if listener.accept().is_ok() {
                flag.store(true, Ordering::SeqCst);
            }
        });
        (address, reached)
    }

    fn redirect_to(location: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        )
        .into_bytes()
    }

    #[tokio::test]
    async fn a_redirect_to_a_private_address_is_never_requested() {
        let (inner, reached) = tripwire();
        let outer = serve_once(redirect_to(&format!("http://{inner}/admin")));
        // Only the first hop's port is let through, standing in for a public page.
        let allowance = Allowance::LoopbackPorts(vec![outer.port()]);
        let result = load(
            None,
            &format!("http://{outer}/"),
            None,
            &Driver::Person,
            &allowance,
        )
        .await;
        let error = result.expect_err("the redirect was followed");
        assert!(error.contains("loopback / private"), "{error}");
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !reached.load(Ordering::SeqCst),
            "the private host was requested"
        );
    }

    #[tokio::test]
    async fn an_agents_redirect_to_an_unapproved_host_asks_and_a_refusal_stops_it() {
        let (inner, reached) = tripwire();
        // `localhost` is a different host from `127.0.0.1`, so leaving for it needs approval.
        let outer = serve_once(redirect_to(&format!("http://localhost:{}/", inner.port())));
        let allowance = Allowance::LoopbackPorts(vec![outer.port(), inner.port()]);
        let asked = Arc::new(Mutex::new(Vec::<String>::new()));
        let record = Arc::clone(&asked);
        let approver: Approver = Arc::new(move |host, _url| {
            record.lock().expect("asked").push(host.clone());
            Box::pin(async move { host == "127.0.0.1" })
        });
        let result = load(
            None,
            &format!("http://{outer}/"),
            None,
            &Driver::Agent(approver),
            &allowance,
        )
        .await;
        assert_eq!(
            result.err().as_deref(),
            Some("Permission denied to open localhost.")
        );
        // (`127.0.0.1` is asked about too unless another test has already opened it this run.)
        assert_eq!(
            asked.lock().expect("asked").last().map(String::as_str),
            Some("localhost")
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(
            !reached.load(Ordering::SeqCst),
            "the unapproved host was requested"
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
