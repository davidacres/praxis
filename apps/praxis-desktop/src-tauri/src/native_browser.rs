//! The desktop shell's half of the in-app browser: a Tauri child webview laid over the renderer's
//! browser pane, and the page snapshots (browser screenshots and artifact thumbnails) taken from
//! webviews.
//!
//! The child webview is labelled `browser`, which the `child-browsers` capability gives no
//! permissions, so a page it loads cannot call the desktop contract.

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::{Value, json};
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl};
use tokio::sync::watch;

use crate::application::browser_native::{NativeBrowser, PAGE_SCRIPT};
use crate::state::DesktopState;
use crate::webviews::blocked_browser_url_reason;

const LABEL: &str = "browser";
const LOAD_TIMEOUT: Duration = Duration::from_secs(15);
const EVAL_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Default)]
struct Nav {
    history: Vec<String>,
    index: usize,
    title: String,
    loading: bool,
    /// Set when the host itself started the navigation, so it is not recorded a second time as a
    /// link the person followed.
    programmatic: bool,
}

pub struct TauriBrowser {
    app: AppHandle,
    nav: Arc<Mutex<Nav>>,
    loaded: watch::Sender<u64>,
}

impl TauriBrowser {
    pub fn new(app: AppHandle) -> Arc<Self> {
        Arc::new(Self {
            app,
            nav: Arc::default(),
            loaded: watch::channel(0).0,
        })
    }

    fn webview(&self) -> Result<tauri::Webview, String> {
        self.app
            .get_webview(LABEL)
            .ok_or_else(|| "The in-app browser has not been opened yet.".to_owned())
    }

    fn zoom(&self) -> f64 {
        self.app
            .try_state::<DesktopState>()
            .and_then(|s| s.zoom.lock().ok().map(|z| *z))
            .unwrap_or(1.0)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Nav> {
        self.nav.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn announce(app: &AppHandle, nav: &Mutex<Nav>) {
        let payload = state_of(&nav.lock().unwrap_or_else(PoisonError::into_inner));
        let _ = app.emit_to(
            "main",
            "praxis:event",
            json!({ "channel": "browser:didNavigate", "payload": payload }),
        );
    }

    /// Starts `url` loading and waits for it to finish. `record` adds it to the history.
    async fn go(&self, url: &str, record: bool) -> Result<(), String> {
        let parsed: tauri::Url = url.parse().map_err(|e| format!("Not a valid URL: {e}"))?;
        let webview = self.webview()?;
        {
            let mut nav = self.lock();
            nav.programmatic = true;
            nav.loading = true;
            if record {
                let keep = if nav.history.is_empty() { 0 } else { nav.index + 1 };
                nav.history.truncate(keep);
                nav.history.push(url.to_owned());
                nav.index = nav.history.len() - 1;
            }
        }
        let mut done = self.loaded.subscribe();
        done.borrow_and_update();
        webview.navigate(parsed).map_err(|e| e.to_string())?;
        // A page that never finishes is reported by what it did load, not as a failure.
        let _ = tokio::time::timeout(LOAD_TIMEOUT, done.changed()).await;
        self.lock().loading = false;
        Ok(())
    }
}

fn state_of(nav: &Nav) -> Value {
    json!({
        "url": nav.history.get(nav.index).map_or("", String::as_str),
        "title": nav.title,
        "canGoBack": nav.index > 0,
        "canGoForward": nav.index + 1 < nav.history.len(),
        "loading": nav.loading,
    })
}

fn allow_loopback() -> bool {
    std::env::var("PRAXIS_BROWSER_ALLOW_LOOPBACK").as_deref() == Ok("1")
}

#[async_trait]
impl NativeBrowser for TauriBrowser {
    fn exists(&self) -> bool {
        self.app.get_webview(LABEL).is_some()
    }

    fn ensure(&self) -> Result<(), String> {
        if self.exists() {
            return Ok(());
        }
        let window = self
            .app
            .get_window("main")
            .ok_or("The main window is not available.")?;
        let nav = Arc::clone(&self.nav);
        let nav_for_load = Arc::clone(&self.nav);
        let loaded = self.loaded.clone();
        let app = self.app.clone();
        let builder = WebviewBuilder::new(
            LABEL,
            WebviewUrl::External("about:blank".parse().map_err(|e| format!("{e}"))?),
        )
        .initialization_script(PAGE_SCRIPT)
        .on_navigation(move |url| {
            if url.as_str() == "about:blank" {
                return true;
            }
            if blocked_browser_url_reason(url.as_str(), allow_loopback()).is_some() {
                return false;
            }
            let mut nav = nav.lock().unwrap_or_else(PoisonError::into_inner);
            if nav.programmatic {
                nav.programmatic = false;
            } else {
                // A link the person (or a page script) followed.
                let keep = if nav.history.is_empty() { 0 } else { nav.index + 1 };
                nav.history.truncate(keep);
                nav.history.push(url.to_string());
                nav.index = nav.history.len() - 1;
                nav.loading = true;
            }
            true
        })
        .on_page_load(move |webview, payload| {
            let url = payload.url().to_string();
            match payload.event() {
                PageLoadEvent::Started => {
                    nav_for_load
                        .lock()
                        .unwrap_or_else(PoisonError::into_inner)
                        .loading = true;
                }
                PageLoadEvent::Finished => {
                    if url != "about:blank" {
                        let mut nav = nav_for_load.lock().unwrap_or_else(PoisonError::into_inner);
                        nav.loading = false;
                        let index = nav.index;
                        match nav.history.get_mut(index) {
                            Some(slot) => *slot = url,
                            None => {
                                nav.history.push(url);
                                nav.index = nav.history.len() - 1;
                            }
                        }
                    }
                    let (nav_title, app_title, announcer) =
                        (Arc::clone(&nav_for_load), app.clone(), loaded.clone());
                    let _ = webview.eval_with_callback("document.title", move |title| {
                        let title: String = serde_json::from_str(&title).unwrap_or_default();
                        nav_title
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner)
                            .title = title;
                        TauriBrowser::announce(&app_title, &nav_title);
                        announcer.send_modify(|n| *n += 1);
                    });
                }
            }
        });
        // Created hidden and out of the way; the pane's bounds place and show it.
        window
            .add_child(builder, LogicalPosition::new(0.0, 0.0), LogicalSize::new(1.0, 1.0))
            .map_err(|e| e.to_string())?;
        if let Ok(webview) = self.webview() {
            let _ = webview.hide();
        }
        Ok(())
    }

    fn set_bounds(&self, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
        self.ensure()?;
        let zoom = self.zoom();
        let webview = self.webview()?;
        webview
            .set_position(LogicalPosition::new(x * zoom, y * zoom))
            .map_err(|e| e.to_string())?;
        webview
            .set_size(LogicalSize::new((width * zoom).max(1.0), (height * zoom).max(1.0)))
            .map_err(|e| e.to_string())
    }

    fn set_visible(&self, visible: bool) -> Result<(), String> {
        let Ok(webview) = self.webview() else {
            return Ok(());
        };
        if visible { webview.show() } else { webview.hide() }.map_err(|e| e.to_string())
    }

    async fn navigate(&self, url: &str) -> Result<(), String> {
        self.go(url, true).await
    }

    async fn back(&self) -> Result<(), String> {
        let target = {
            let mut nav = self.lock();
            if nav.index == 0 {
                return Ok(());
            }
            nav.index -= 1;
            nav.history[nav.index].clone()
        };
        self.go(&target, false).await
    }

    async fn forward(&self) -> Result<(), String> {
        let target = {
            let mut nav = self.lock();
            if nav.index + 1 >= nav.history.len() {
                return Ok(());
            }
            nav.index += 1;
            nav.history[nav.index].clone()
        };
        self.go(&target, false).await
    }

    async fn reload(&self) -> Result<(), String> {
        let target = {
            let nav = self.lock();
            nav.history.get(nav.index).cloned()
        };
        match target {
            Some(url) => self.go(&url, false).await,
            None => Ok(()),
        }
    }

    async fn eval(&self, script: &str) -> Result<Value, String> {
        let webview = self.webview()?;
        let (sender, receiver) = tokio::sync::oneshot::channel::<String>();
        let sender = Mutex::new(Some(sender));
        webview
            .eval_with_callback(
                format!("(function(){{try{{return ({script});}}catch(e){{return null;}}}})()"),
                move |json| {
                    if let Some(sender) = sender.lock().ok().and_then(|mut s| s.take()) {
                        let _ = sender.send(json);
                    }
                },
            )
            .map_err(|e| e.to_string())?;
        let raw = tokio::time::timeout(EVAL_TIMEOUT, receiver)
            .await
            .map_err(|_| "The page did not respond.".to_owned())?
            .map_err(|_| "The page did not respond.".to_owned())?;
        Ok(serde_json::from_str(&raw).unwrap_or(Value::Null))
    }

    async fn screenshot_png(&self) -> Result<Vec<u8>, String> {
        #[cfg(target_os = "macos")]
        {
            let webview = self.webview()?;
            crate::macos_snapshot::snapshot(
                &webview,
                crate::macos_snapshot::Capture::default(),
                crate::macos_snapshot::Format::Png,
            )
            .await
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err("Screenshots are not available on this platform yet.".into())
        }
    }

    async fn wait_idle(&self) {
        for _ in 0..30 {
            if !self.lock().loading {
                return;
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    }

    fn state(&self) -> Value {
        state_of(&self.lock())
    }
}

/// Draws `html` (already under the restricted preview policy) in a throwaway window and returns a
/// JPEG data URL, or `None` where the platform cannot snapshot a page.
#[cfg(target_os = "macos")]
pub async fn thumbnail(app: &AppHandle, html: &str) -> Option<String> {
    use base64::Engine;
    use std::sync::atomic::{AtomicU32, Ordering};
    static SEQ: AtomicU32 = AtomicU32::new(1);
    // One at a time: each draw is a whole web content process.
    static GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _turn = GATE.lock().await;

    let url: tauri::Url = format!(
        "data:text/html;charset=utf-8;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(html)
    )
    .parse()
    .ok()?;
    let (sender, receiver) = tokio::sync::oneshot::channel::<()>();
    let sender = Mutex::new(Some(sender));
    let window = tauri::WebviewWindowBuilder::new(
        app,
        format!("preview-thumbnail-{}", SEQ.fetch_add(1, Ordering::Relaxed)),
        WebviewUrl::External(url),
    )
    .inner_size(960.0, 600.0)
    .visible(false)
    .focused(false)
    .skip_taskbar(true)
    .on_page_load(move |_, payload| {
        if matches!(payload.event(), PageLoadEvent::Finished)
            && let Some(sender) = sender.lock().ok().and_then(|mut s| s.take())
        {
            let _ = sender.send(());
        }
    })
    .build()
    .ok()?;
    let _ = tokio::time::timeout(Duration::from_secs(8), receiver).await;
    // Let fonts and first paint settle.
    tokio::time::sleep(Duration::from_millis(400)).await;
    let jpeg = crate::macos_snapshot::snapshot(
        window.as_ref(),
        crate::macos_snapshot::Capture {
            rect: None,
            width: Some(480.0),
        },
        crate::macos_snapshot::Format::Jpeg(0.7),
    )
    .await;
    let _ = window.destroy();
    jpeg.ok().map(|bytes| {
        format!(
            "data:image/jpeg;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    })
}

#[cfg(not(target_os = "macos"))]
pub async fn thumbnail(_app: &AppHandle, _html: &str) -> Option<String> {
    None
}
