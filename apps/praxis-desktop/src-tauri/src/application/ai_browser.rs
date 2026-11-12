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

fn allow_private_hosts() -> bool {
    std::env::var("PRAXIS_BROWSER_ALLOW_LOOPBACK").as_deref() == Ok("1")
}

fn decode_entities(text: &str) -> String {
    text.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&amp;", "&")
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
    found.get(1).or_else(|| found.get(2)).or_else(|| found.get(3)).map(|m| decode_entities(m.as_str()))
}

fn parse_page(url: &str, html: &str) -> Page {
    static TITLE: OnceLock<Regex> = OnceLock::new();
    static HIDDEN: OnceLock<Regex> = OnceLock::new();
    static MAIN: OnceLock<Regex> = OnceLock::new();
    static ELEMENT: OnceLock<Regex> = OnceLock::new();
    let title_pattern = TITLE.get_or_init(|| Regex::new(r"(?is)<title[^>]*>(.*?)</title>").expect("title pattern"));
    let hidden = HIDDEN.get_or_init(|| Regex::new(r"(?is)<(script|style|noscript|template)\b.*?</(script|style|noscript|template)>|<!--.*?-->").expect("hidden pattern"));
    let main = MAIN.get_or_init(|| Regex::new(r"(?is)<(main|article)\b[^>]*>(.*?)</(main|article)>").expect("main pattern"));
    let element = ELEMENT.get_or_init(|| {
        Regex::new(r"(?is)<a\b[^>]*>.*?</a>|<button\b[^>]*>.*?</button>|<textarea\b[^>]*>.*?</textarea>|<select\b[^>]*>.*?</select>|<input\b[^>]*>").expect("element pattern")
    });

    let title = title_pattern.captures(html).map(|c| collapse(&strip_tags(&c[1]))).unwrap_or_default();
    let visible = hidden.replace_all(html, " ").to_string();
    let body = visible.split_once("</head>").map_or(visible.as_str(), |(_, rest)| rest).to_string();
    let region = main.captures(&body).map_or(body.clone(), |c| c[2].to_string());
    let block = Regex::new(r"(?i)</?(p|div|h[1-6]|li|ul|ol|tr|br|section|header|footer|nav|table)\b[^>]*>").expect("block pattern");
    let broken = block.replace_all(&region, "\n").to_string();
    let lines: Vec<String> = strip_tags(&broken).lines().map(collapse).filter(|line| !line.is_empty()).collect();
    let mut text = lines.join("\n");
    if text.chars().count() > MAX_TEXT {
        text = format!("{}\n\n…[truncated at {MAX_TEXT} chars]", text.chars().take(MAX_TEXT).collect::<String>());
    }

    let mut elements = Vec::new();
    for found in element.find_iter(&body) {
        let markup = found.as_str();
        let lower = markup.to_lowercase();
        let tag = lower.trim_start_matches('<').split(|c: char| !c.is_ascii_alphanumeric()).next().unwrap_or_default().to_owned();
        if tag == "input" && attribute(markup, "type").is_some_and(|t| t.eq_ignore_ascii_case("hidden")) {
            continue;
        }
        let value = if matches!(tag.as_str(), "input" | "textarea" | "select") { attribute(markup, "value").unwrap_or_default() } else { String::new() };
        let name = attribute(markup, "aria-label")
            .or_else(|| Some(collapse(&strip_tags(markup))).filter(|t| !t.is_empty()))
            .or_else(|| (!value.is_empty()).then(|| value.clone()))
            .or_else(|| attribute(markup, "placeholder"))
            .or_else(|| attribute(markup, "title"))
            .or_else(|| attribute(markup, "alt"))
            .unwrap_or_default();
        let role = attribute(markup, "role").unwrap_or_else(|| if tag == "a" { "a".into() } else { tag.clone() });
        let href = (tag == "a").then(|| attribute(markup, "href")).flatten();
        elements.push(Element { reference: format!("e{}", elements.len() + 1), role, name: name.chars().take(160).collect(), value: value.chars().take(120).collect(), href });
        if elements.len() >= MAX_ELEMENTS {
            break;
        }
    }
    Page { url: url.to_owned(), title, text, elements }
}

async fn load(url: &str) -> Result<Page, String> {
    if let Some(reason) = blocked_browser_url_reason(url, allow_private_hosts()) {
        return Err(reason);
    }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).redirect(reqwest::redirect::Policy::limited(5)).user_agent("Praxis-Browser").build().map_err(|e| e.to_string())?;
    let response = client.get(url).send().await.map_err(|e| format!("Could not load {url}: {e}"))?;
    let final_url = response.url().to_string();
    if let Some(reason) = blocked_browser_url_reason(&final_url, allow_private_hosts()) {
        return Err(reason);
    }
    let body = response.text().await.map_err(|e| e.to_string())?;
    Ok(parse_page(&final_url, &body))
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
    let payload = state_value(&browser().lock().unwrap_or_else(std::sync::PoisonError::into_inner), false);
    host.events().emit("browser:didNavigate", Some(payload));
}

fn current() -> Option<Page> {
    let guard = browser().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    guard.history.get(guard.index).cloned()
}

/// The state `browser.getState()` reports.
pub fn get_state() -> Value {
    state_value(&browser().lock().unwrap_or_else(std::sync::PoisonError::into_inner), false)
}

pub async fn navigate(host: &HostContext, url: &str) -> Result<Page, String> {
    let page = load(url).await?;
    {
        let mut guard = browser().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let keep = if guard.history.is_empty() { 0 } else { guard.index + 1 };
        guard.history.truncate(keep);
        guard.history.push(page.clone());
        guard.index = guard.history.len() - 1;
    }
    publish(host);
    Ok(page)
}

pub async fn go_back(host: &HostContext) {
    {
        let mut guard = browser().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if guard.index > 0 {
            guard.index -= 1;
        }
    }
    publish(host);
}

pub async fn go_forward(host: &HostContext) {
    {
        let mut guard = browser().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if guard.index + 1 < guard.history.len() {
            guard.index += 1;
        }
    }
    publish(host);
}

pub async fn reload(host: &HostContext) -> Result<(), String> {
    let Some(page) = current() else { return Ok(()) };
    let fresh = load(&page.url).await?;
    {
        let mut guard = browser().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let index = guard.index;
        guard.history[index] = fresh;
    }
    publish(host);
    Ok(())
}

pub fn read() -> Result<Page, String> {
    current().ok_or_else(|| "The in-app browser has no page open. Call browser_navigate first.".to_owned())
}

pub async fn click(host: &HostContext, reference: &str) -> Result<Page, String> {
    let page = read()?;
    let element = page.elements.iter().find(|e| e.reference == reference).ok_or_else(|| format!("No element with ref \"{reference}\" — call browser_snapshot again."))?;
    if let Some(href) = &element.href {
        let target = Url::parse(&page.url).and_then(|base| base.join(href)).map_err(|e| e.to_string())?;
        if target.scheme() == "javascript" {
            return Ok(page);
        }
        return navigate(host, target.as_str()).await;
    }
    Ok(page)
}

pub fn type_text(reference: &str, text: &str) -> Result<Page, String> {
    let mut guard = browser().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    let index = guard.index;
    let page = guard.history.get_mut(index).ok_or("The in-app browser has no page open.")?;
    let element = page.elements.iter_mut().find(|e| e.reference == reference).ok_or_else(|| format!("No element with ref \"{reference}\" — call browser_snapshot again."))?;
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
        ("browser_navigate", "Open a URL in the in-app browser. Returns the resolved URL, page title, and only a short excerpt of the text — call browser_read afterwards if you need the full page body. Navigating to a host that is not pre-approved asks the user to allow it first.", json!({ "type": "object", "properties": { "url": { "type": "string", "description": "Absolute http(s) URL." } }, "required": ["url"] })),
        ("browser_read", "Return the CURRENT page as plain text (main content; scripts, nav and chrome stripped). This is the only tool that returns the full body, so only call it when you actually need to read the page contents — not routinely after every navigation.", json!({ "type": "object", "properties": {} })),
        ("browser_snapshot", "List the interactive elements on the current page — links, buttons, inputs, selects — each with a stable `ref`, its role, its visible label, and its current value. Pass a `ref` to browser_click / browser_type.", json!({ "type": "object", "properties": { "filter": { "type": "string", "description": "Optional case-insensitive substring; only elements whose label/value contains it are returned." } } })),
        ("browser_click", "Click the element with the given ref (from browser_snapshot), then return the updated title, URL, and a short excerpt.", json!({ "type": "object", "properties": { "ref": { "type": "string" } }, "required": ["ref"] })),
        ("browser_type", "Type text into the input/textarea with the given ref. Set submit=true to press Enter afterwards (e.g. to run a search). Returns the updated title, URL, and a short excerpt.", json!({ "type": "object", "properties": { "ref": { "type": "string" }, "text": { "type": "string" }, "submit": { "type": "boolean" } }, "required": ["ref", "text"] })),
        ("browser_diagnostics", "Return console errors/warnings and failed network requests captured since the last browser_navigate. Reports \"not supported\" rather than an empty result on a host that cannot capture diagnostics.", json!({ "type": "object", "properties": {} })),
        ("browser_screenshot", "Capture a screenshot of the current page for the USER to review — the image is never returned to you, only a confirmation that it was captured (or why it could not be).", json!({ "type": "object", "properties": {} })),
    ]
}

/// The host part of a URL, as the allow-list is keyed.
pub fn host_of(url: &str) -> Option<String> {
    Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_lowercase))
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
                let page = read()?;
                Ok(format!("URL: {}\nTitle: {}\n\n{}", page.url, page.title, page.text))
            }
            "browser_snapshot" => {
                let page = read()?;
                let needle = args["filter"].as_str().unwrap_or_default().to_lowercase();
                let rows: Vec<String> = page
                    .elements
                    .iter()
                    .filter(|e| needle.is_empty() || format!("{} {}", e.name, e.value).to_lowercase().contains(&needle))
                    .map(|e| format!("[{}] {} \"{}\"{}", e.reference, e.role, e.name, if e.value.is_empty() { String::new() } else { format!(" value=\"{}\"", e.value) }))
                    .collect();
                Ok(format!("URL: {}\nTitle: {}\n\n{}", page.url, page.title, if rows.is_empty() { "(no interactive elements)".to_owned() } else { rows.join("\n") }))
            }
            "browser_click" => Ok(excerpt(&click(host, args["ref"].as_str().unwrap_or_default()).await?)),
            "browser_type" => Ok(excerpt(&type_text(args["ref"].as_str().unwrap_or_default(), args["text"].as_str().unwrap_or_default())?)),
            "browser_diagnostics" => Ok("Console and network diagnostics are not supported by this browser host.".into()),
            "browser_screenshot" => Ok("A screenshot could not be captured: this browser host renders no pixels.".into()),
            other => Err(format!("Unknown browser tool: {other}")),
        }
    }
    .await;
    match result {
        Ok(text) => (true, text),
        Err(message) => (false, message),
    }
}
