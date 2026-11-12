use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

use praxis_host::HostContext;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::webviews::{
    BrowserDiagnosticsBundleKey, BrowserDiagnosticsRecorder, PreviewAccessRegistry,
    blocked_browser_url_reason, preview_access_blocked_reason,
};

use super::{Result, failure, text};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RectBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug)]
pub struct WebviewManager {
    browser_bounds: Mutex<Option<RectBounds>>,
    browser_visible: Mutex<bool>,
    browser_url: Mutex<String>,
    browser_title: Mutex<String>,
    preview_bounds: Mutex<Option<RectBounds>>,
    preview_visible: Mutex<bool>,
    preview_url: Mutex<String>,
    detached_chats: Mutex<BTreeSet<String>>,
    preview_access: Arc<PreviewAccessRegistry>,
    diagnostics: Mutex<BTreeMap<String, Arc<BrowserDiagnosticsRecorder>>>,
}

impl Default for WebviewManager {
    fn default() -> Self {
        Self {
            browser_bounds: Mutex::new(None),
            browser_visible: Mutex::new(false),
            browser_url: Mutex::new(String::new()),
            browser_title: Mutex::new(String::new()),
            preview_bounds: Mutex::new(None),
            preview_visible: Mutex::new(false),
            preview_url: Mutex::new(String::new()),
            detached_chats: Mutex::new(BTreeSet::new()),
            preview_access: Arc::new(PreviewAccessRegistry::new()),
            diagnostics: Mutex::new(BTreeMap::new()),
        }
    }
}

impl WebviewManager {
    pub fn new() -> Self {
        Self::default()
    }

    #[allow(dead_code)]
    #[must_use]
    pub fn preview_access(&self) -> Arc<PreviewAccessRegistry> {
        Arc::clone(&self.preview_access)
    }

    pub fn dispatch(&self, host: &HostContext, channel: &str, args: &[Value]) -> Result<Value> {
        match channel {
            "browser:attach" => Ok(Value::Null),
            "browser:setBounds" => {
                let bounds: RectBounds = args
                    .first()
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
                    .unwrap_or(RectBounds {
                        x: 0.0,
                        y: 0.0,
                        width: 800.0,
                        height: 600.0,
                    });
                *self.browser_bounds.lock().map_err(failure)? = Some(bounds);
                Ok(Value::Null)
            }
            "browser:setVisible" => {
                let visible = args.first().and_then(Value::as_bool).unwrap_or(false);
                *self.browser_visible.lock().map_err(failure)? = visible;
                Ok(Value::Null)
            }
            "browser:navigate" => {
                let url = text(args, 0)?;
                let page = super::runtime::block_on(super::ai_browser::navigate(host, url)).map_err(failure)?;
                *self.browser_url.lock().map_err(failure)? = page.url.clone();
                *self.browser_title.lock().map_err(failure)? = page.title.clone();
                Ok(json!({ "ok": true, "url": page.url, "title": page.title }))
            }
            "browser:back" => {
                super::runtime::block_on(super::ai_browser::go_back(host));
                Ok(Value::Null)
            }
            "browser:forward" => {
                super::runtime::block_on(super::ai_browser::go_forward(host));
                Ok(Value::Null)
            }
            "browser:reload" => {
                super::runtime::block_on(super::ai_browser::reload(host)).map_err(failure)?;
                Ok(Value::Null)
            }
            "browser:personInput" => {
                super::runtime::block_on(super::coordination::person_used_browser());
                Ok(Value::Null)
            }
            "browser:getState" => Ok(super::ai_browser::get_state()),
            "preview:attach" => Ok(Value::Null),
            "preview:setBounds" => {
                let bounds: RectBounds = args
                    .first()
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
                    .unwrap_or(RectBounds {
                        x: 0.0,
                        y: 0.0,
                        width: 800.0,
                        height: 600.0,
                    });
                *self.preview_bounds.lock().map_err(failure)? = Some(bounds);
                Ok(Value::Null)
            }
            "preview:setVisible" => {
                let visible = args.first().and_then(Value::as_bool).unwrap_or(false);
                *self.preview_visible.lock().map_err(failure)? = visible;
                Ok(Value::Null)
            }
            "preview:open" => {
                let url = text(args, 0)?;
                if let Some(reason) = preview_access_blocked_reason(url, &self.preview_access) {
                    return Err(failure(reason));
                }

                *self.preview_url.lock().map_err(failure)? = url.to_string();

                let grant = self.preview_access.grant_for(url);
                let key = if let Some(g) = grant {
                    BrowserDiagnosticsBundleKey {
                        project_id: g.project_id,
                        run_id: g.run_id,
                        service_id: g.service_id,
                    }
                } else {
                    BrowserDiagnosticsBundleKey {
                        project_id: "preview".to_string(),
                        run_id: "default".to_string(),
                        service_id: "default".to_string(),
                    }
                };

                let recorder = Arc::new(BrowserDiagnosticsRecorder::new(key));
                self.diagnostics
                    .lock()
                    .map_err(failure)?
                    .insert(url.to_string(), recorder);

                Ok(Value::Null)
            }
            "preview:captureDiagnostics" => {
                let url = self.preview_url.lock().map_err(failure)?.clone();
                let recorder = self.diagnostics.lock().map_err(failure)?.get(&url).cloned();

                if let Some(r) = recorder {
                    Ok(r.snapshot())
                } else {
                    Ok(Value::Null)
                }
            }
            "detachedChat:open" => {
                let issue_key = text(args, 0)?;
                let mut chats = self.detached_chats.lock().map_err(failure)?;
                chats.insert(issue_key.to_string());
                let keys: Vec<String> = chats.iter().cloned().collect();
                drop(chats);
                host.events()
                    .emit("detachedChat:changed", Some(json!(keys)));
                Ok(Value::Null)
            }
            "detachedChat:close" => {
                let issue_key = text(args, 0)?;
                let mut chats = self.detached_chats.lock().map_err(failure)?;
                chats.remove(issue_key);
                let keys: Vec<String> = chats.iter().cloned().collect();
                drop(chats);
                host.events()
                    .emit("detachedChat:changed", Some(json!(keys)));
                Ok(Value::Null)
            }
            "detachedChat:list" => {
                let chats = self.detached_chats.lock().map_err(failure)?;
                let keys: Vec<String> = chats.iter().cloned().collect();
                Ok(json!(keys))
            }
            _ => Err(failure(format!("Unknown webview channel: {channel}"))),
        }
    }
}
