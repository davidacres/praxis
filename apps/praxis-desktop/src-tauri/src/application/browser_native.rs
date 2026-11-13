//! The seam between the in-app browser's tools and a real web engine.
//!
//! `ai_browser` has two backends behind one interface. With no native webview (the headless e2e
//! server, or a platform that has not installed one) it fetches and parses pages. When the desktop
//! shell installs a [`NativeBrowser`] — a Tauri child webview laid over the browser pane — every
//! operation goes to a real engine instead: it runs page scripts, and the shell can capture
//! console output, failed requests, screenshots and a person's own input.
//!
//! The shell owns the webview; this module owns what the host does with it: the page-side script
//! (`browser_page.js`), a pump that drains it, and the diagnostics the pump fills.

use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use async_trait::async_trait;
use serde_json::Value;

use crate::webviews::{BrowserDiagnosticsBundleKey, BrowserDiagnosticsRecorder};

/// Installed into every page the browser opens, before the page's own scripts run.
pub const PAGE_SCRIPT: &str = include_str!("browser_page.js");

/// How often the page's buffers are drained while a webview exists.
const PUMP_INTERVAL: Duration = Duration::from_millis(400);

/// A webview the shell can drive. Methods that touch the page are async because the page answers
/// on the webview's own thread.
#[async_trait]
pub trait NativeBrowser: Send + Sync {
    /// Whether the webview has been created (it is created on first use).
    fn exists(&self) -> bool;
    /// Moves the webview over the browser pane. `(x, y, width, height)` in the renderer's CSS
    /// pixels, which the shell converts to window coordinates.
    fn set_bounds(&self, x: f64, y: f64, width: f64, height: f64) -> Result<(), String>;
    fn set_visible(&self, visible: bool) -> Result<(), String>;
    /// Creates the webview if it does not exist yet.
    fn ensure(&self) -> Result<(), String>;
    /// Starts a navigation and waits for it to finish (or time out). The URL has been vetted.
    async fn navigate(&self, url: &str) -> Result<(), String>;
    async fn back(&self) -> Result<(), String>;
    async fn forward(&self) -> Result<(), String>;
    async fn reload(&self) -> Result<(), String>;
    /// Evaluates a script in the page and returns its JSON result.
    async fn eval(&self, script: &str) -> Result<Value, String>;
    /// A PNG of what the page currently shows. Errors where the platform cannot capture one.
    async fn screenshot_png(&self) -> Result<Vec<u8>, String>;
    /// Waits (bounded) for any navigation in flight to finish.
    async fn wait_idle(&self);
    /// `{ url, title, canGoBack, canGoForward, loading }`.
    fn state(&self) -> Value;
}

static SHELL: OnceLock<Arc<dyn NativeBrowser>> = OnceLock::new();

/// Installed once by the desktop shell. The e2e server never calls this.
pub fn install(shell: Arc<dyn NativeBrowser>) {
    if SHELL.set(shell).is_ok() {
        super::runtime::runtime().spawn(pump());
    }
}

/// The native browser, when the shell has installed one.
pub fn shell() -> Option<Arc<dyn NativeBrowser>> {
    SHELL.get().cloned()
}

/// Console and network evidence for the AI browser, scoped to its own sentinel key like the
/// Electron host did (it is one shared browser with no project or run of its own).
pub const DIAGNOSTICS_KEY: (&str, &str, &str) = ("ai-browser", "session", "default");

fn recorder() -> &'static Mutex<Arc<BrowserDiagnosticsRecorder>> {
    static RECORDER: OnceLock<Mutex<Arc<BrowserDiagnosticsRecorder>>> = OnceLock::new();
    RECORDER.get_or_init(|| Mutex::new(Arc::new(new_recorder())))
}

fn new_recorder() -> BrowserDiagnosticsRecorder {
    BrowserDiagnosticsRecorder::new(BrowserDiagnosticsBundleKey {
        project_id: DIAGNOSTICS_KEY.0.into(),
        run_id: DIAGNOSTICS_KEY.1.into(),
        service_id: DIAGNOSTICS_KEY.2.into(),
    })
}

/// A cross-document navigation starts a fresh capture: what accumulated belongs to the page that
/// just left. An in-page (SPA route) change keeps accumulating.
pub fn reset_diagnostics() {
    *recorder().lock().unwrap_or_else(PoisonError::into_inner) = Arc::new(new_recorder());
}

/// The captured evidence, drained from the page first so it is current.
pub async fn diagnostics(shell: &dyn NativeBrowser) -> Value {
    drain(shell).await;
    let bundle = recorder()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .snapshot();
    serde_json::json!({
        "console": bundle["console"],
        "network": bundle["network"],
        "truncated": bundle["truncated"],
    })
}

/// Pulls the page's buffers into the recorder and reports a person's input.
async fn drain(shell: &dyn NativeBrowser) {
    if !shell.exists() {
        return;
    }
    let Ok(batch) = shell
        .eval("window.__praxisBrowser && window.__praxisBrowser.drain()")
        .await
    else {
        return;
    };
    ingest(&batch);
    if batch["input"].as_u64().unwrap_or(0) > 0 {
        super::browser_policy::note_person_input();
        super::coordination::person_used_browser().await;
    }
}

fn ingest(batch: &Value) {
    let recorder = recorder()
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone();
    for entry in batch["console"].as_array().into_iter().flatten() {
        recorder.record_console(
            entry["level"].as_str().unwrap_or("log"),
            entry["message"].as_str().unwrap_or_default(),
        );
    }
    for entry in batch["network"].as_array().into_iter().flatten() {
        recorder.record_network_failure(
            entry["url"].as_str().unwrap_or_default(),
            entry["method"].as_str().unwrap_or("GET"),
            entry["status"].as_u64().and_then(|s| u16::try_from(s).ok()),
            entry["error"].as_str().map(str::to_owned),
        );
    }
}

async fn pump() {
    loop {
        tokio::time::sleep(PUMP_INTERVAL).await;
        if let Some(shell) = shell() {
            drain(shell.as_ref()).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ingest_feeds_the_recorder_and_a_navigation_starts_a_fresh_one() {
        reset_diagnostics();
        ingest(&json!({
            "console": [{ "level": "error", "message": "boom" }],
            "network": [
                { "url": "https://x.test/a.js", "method": "GET", "status": 404 },
                { "url": "https://x.test/b", "method": "POST", "error": "request failed" }
            ]
        }));
        let bundle = recorder().lock().expect("recorder").snapshot();
        assert_eq!(bundle["console"][0]["message"], "boom");
        assert_eq!(bundle["network"][0]["status"], 404);
        assert_eq!(bundle["network"][1]["error"], "request failed");
        reset_diagnostics();
        assert_eq!(
            recorder().lock().expect("recorder").snapshot()["console"],
            json!([])
        );
    }

    #[test]
    fn the_page_script_defines_every_entry_point_the_host_calls() {
        for name in [
            "drain()",
            "read()",
            "snapshot()",
            "click(ref)",
            "type(ref, value, submit)",
        ] {
            assert!(PAGE_SCRIPT.contains(name), "page script lacks {name}");
        }
    }
}
