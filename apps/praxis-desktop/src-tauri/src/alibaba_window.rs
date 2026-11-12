//! The Alibaba Cloud console sign-in window (`alibabaConsoleSession.ts`'s `signInToAlibabaConsole`).
//!
//! A Praxis-owned webview on its own persistent cookie store, so nothing is shared with the app's
//! renderer or any other Praxis browser surface, and nothing is copied from the person's own
//! browser. Its label (`alibaba-console`) is in no capability, so it can never call the desktop
//! contract, and `praxis_rpc` refuses any caller but `main`. While it is open the shell reads the
//! cookies the console set and hands them to the backend (`aiUsage:alibabaConsoleStoreSession`),
//! which keeps them with the other credentials and reads quota with them.

use std::time::Duration;

use praxis_contracts::RustRpcError;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};

pub const WINDOW_LABEL: &str = "alibaba-console";

/// HTTPS only; plain HTTP solely for the loopback mock console the e2e suite points at.
pub fn allowed_console_url(url: &Url, origin_override: Option<&str>) -> bool {
    if url.scheme() == "https" {
        return true;
    }
    origin_override
        .map(|o| o.trim().trim_end_matches('/'))
        .filter(|o| !o.is_empty())
        .is_some_and(|origin| url.as_str().starts_with(origin))
}

fn shell_error(message: impl ToString) -> RustRpcError {
    RustRpcError {
        code: "DESKTOP_ERROR".into(),
        message: message.to_string(),
    }
}

/// Opens the console's Coding Plan page and returns the console cookies once the person closes it.
pub async fn sign_in(app: &AppHandle, target: &Value) -> Result<Vec<Value>, RustRpcError> {
    let page = |key: &str| target[key].as_str().and_then(|raw| Url::parse(raw).ok());
    let dashboard = page("dashboard")
        .ok_or_else(|| shell_error("The console sign-in page is not a valid URL."))?;
    if let Some(existing) = app.get_webview_window(WINDOW_LABEL) {
        let _ = existing.set_focus();
    } else {
        let origin = std::env::var("PRAXIS_ALIBABA_CONSOLE_ORIGIN").ok();
        let mut builder = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::External(dashboard.clone()))
            .title("Sign in to Alibaba Cloud — Praxis")
            .inner_size(1100.0, 820.0)
            .min_inner_size(520.0, 480.0)
            // Sign-in may hop between Alibaba's own login hosts and identity providers, so navigation
            // is not pinned to one origin, but it never leaves HTTPS.
            .on_navigation(move |url| allowed_console_url(url, origin.as_deref()));
        #[cfg(target_os = "macos")]
        {
            builder = builder.data_store_identifier(*b"praxis-alibaba-c");
        }
        #[cfg(not(target_os = "macos"))]
        {
            let dir = app
                .path()
                .app_local_data_dir()
                .map_err(shell_error)?
                .join("alibaba-console-webview");
            builder = builder.data_directory(dir);
        }
        builder.build().map_err(shell_error)?;
    }
    let urls: Vec<Url> = ["gateway", "rpcBase", "dashboard"]
        .iter()
        .filter_map(|key| page(key))
        .collect();
    let mut latest: Vec<Value> = Vec::new();
    // The window is the person's to close; read its cookies while it lives, as they vanish with it.
    while let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let mut seen: Vec<Value> = Vec::new();
        for url in &urls {
            for cookie in window.cookies_for_url(url.clone()).unwrap_or_default() {
                if !seen.iter().any(|c| c["name"] == cookie.name()) {
                    seen.push(json!({ "name": cookie.name(), "value": cookie.value() }));
                }
            }
        }
        if !seen.is_empty() {
            latest = seen;
        }
        tokio::time::sleep(Duration::from_millis(750)).await;
    }
    Ok(latest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_sign_in_window_never_leaves_https_except_for_the_test_console() {
        let url = |raw: &str| Url::parse(raw).expect("url");
        assert!(allowed_console_url(
            &url("https://passport.alibabacloud.com/login"),
            None
        ));
        assert!(!allowed_console_url(
            &url("http://passport.alibabacloud.com/login"),
            None
        ));
        assert!(!allowed_console_url(&url("file:///etc/passwd"), None));
        assert!(!allowed_console_url(&url("javascript:alert(1)"), None));
        assert!(allowed_console_url(
            &url("http://127.0.0.1:4000/coding-plan"),
            Some("http://127.0.0.1:4000/")
        ));
        assert!(!allowed_console_url(
            &url("http://127.0.0.1:4001/coding-plan"),
            Some("http://127.0.0.1:4000")
        ));
    }
}
