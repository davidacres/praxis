#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod alibaba_window;
mod application;
mod e2e_server;
mod state;
pub mod webviews;

use praxis_contracts::{RustRpcError, RustRpcRequest};
use serde_json::{Value, json};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use state::DesktopState;

/// Raises task notifications with the platform's notification centre.
///
/// The desktop notification plugin reports no click on desktop platforms, so a click cannot be
/// routed back here; `open` is what a click handler calls once one exists, and is exercised
/// through the e2e server's recording shell.
struct NativeNoticeShell {
    app: tauri::AppHandle,
}

impl application::task_notifications::NoticeShell for NativeNoticeShell {
    fn focused_windows(&self) -> Vec<String> {
        self.app
            .webview_windows()
            .into_iter()
            .filter(|(_, window)| {
                window.is_focused().unwrap_or(false)
                    && window.is_visible().unwrap_or(false)
                    && !window.is_minimized().unwrap_or(false)
            })
            .map(|(label, _)| label)
            .collect()
    }

    fn show(&self, notice: &application::task_notifications::Notice, silent: bool) {
        use tauri_plugin_notification::NotificationExt;
        let mut builder = self.app.notification().builder().title(&notice.title).body(&notice.body);
        if !silent {
            builder = builder.sound("default");
        }
        if let Err(error) = builder.show() {
            eprintln!("Task notification could not be displayed: {error}");
        }
    }

    fn open(&self, notice: &application::task_notifications::Notice, _detached: Option<&str>) {
        // Chats are not popped out into native windows of their own yet, so the main window opens it.
        if let Some(window) = self.app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.emit(
                "praxis:event",
                json!({"channel": "window:notificationOpen", "payload": notice.target}),
            );
            let _ = window.set_focus();
        }
    }
}

fn error(code: &str, message: impl ToString) -> RustRpcError {
    RustRpcError {
        code: code.into(),
        message: message.to_string(),
    }
}

#[tauri::command]
async fn praxis_rpc(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, DesktopState>,
    channel: String,
    args: Vec<Value>,
) -> Result<Value, RustRpcError> {
    // Capabilities also deny remote origins. Do not grant this to child browsers.
    DesktopState::check_caller(window.label())?;
    if channel == "desktop:capabilities" {
        return Ok(state.capabilities());
    }
    if !state.allows(&channel) {
        return Err(error(
            "FORBIDDEN",
            format!("Channel '{channel}' is not in the desktop contract."),
        ));
    }
    match channel.as_str() {
        "app:getVersion" => Ok(json!(
            window.app_handle().package_info().version.to_string()
        )),
        "window:reload" => {
            window.reload().map_err(shell_error)?;
            Ok(Value::Null)
        }
        "window:minimize" => {
            window.minimize().map_err(shell_error)?;
            Ok(Value::Null)
        }
        "window:toggleMaximize" => {
            if window.is_maximized().map_err(shell_error)? {
                window.unmaximize()
            } else {
                window.maximize()
            }
            .map_err(shell_error)?;
            Ok(Value::Null)
        }
        "window:isMaximized" => Ok(json!(window.is_maximized().map_err(shell_error)?)),
        // Closing with sessions still running asks first; `confirmClose` is the answer.
        "window:close" => {
            let running = application::running_session_count(&state.host.config().user_data_dir);
            if running == 0 {
                window.close().map_err(shell_error)?;
            } else {
                window.emit("praxis:event", json!({"channel": "window:closeRequested", "payload": { "runningSessionCount": running }})).map_err(shell_error)?;
            }
            Ok(Value::Null)
        }
        "window:confirmClose" => {
            window.close().map_err(shell_error)?;
            Ok(Value::Null)
        }
        "window:cancelClose" => Ok(Value::Null),
        "window:supportsVibrancy" => Ok(json!(false)),
        "window:setSurfaceVibrancy" => Ok(Value::Null),
        "window:getZoomFactor" => Ok(json!(*state.zoom.lock().map_err(shell_error)?)),
        "window:setZoomFactor" => {
            let factor = args
                .first()
                .and_then(Value::as_f64)
                .filter(|factor| factor.is_finite() && (0.5..=3.0).contains(factor))
                .ok_or_else(|| {
                    error("INVALID_ARGUMENT", "Zoom factor must be between 0.5 and 3.")
                })?;
            let factor = (factor * 100.0).round() / 100.0;
            window.set_zoom(factor).map_err(shell_error)?;
            let _ = state
                .host
                .settings()
                .write(&json!({ "appearance": { "zoomFactor": factor } }));
            *state.zoom.lock().map_err(shell_error)? = factor;
            window
                .emit(
                    "praxis:event",
                    json!({"channel": "window:zoomChanged", "payload": factor}),
                )
                .map_err(shell_error)?;
            Ok(json!(factor))
        }
        "window:setNotificationView" => {
            application::task_notifications::set_view(
                window.label(),
                args.first().unwrap_or(&Value::Null),
            );
            Ok(Value::Null)
        }
        "dialog:pickFolder" => {
            let dialog = window.dialog().file().set_title(
                args.first()
                    .and_then(Value::as_str)
                    .unwrap_or("Choose folder"),
            );
            let (sender, receiver) = tokio::sync::oneshot::channel();
            dialog.pick_folder(move |path| {
                let _ = sender.send(path);
            });
            let selected = receiver.await.map_err(shell_error)?;
            selected
                .map(|path| {
                    path.into_path()
                        .map(|path| json!(path.to_string_lossy()))
                        .map_err(shell_error)
                })
                .unwrap_or(Ok(Value::Null))
        }
        "shell:openExternal" => {
            let url = args
                .first()
                .and_then(Value::as_str)
                .ok_or_else(|| error("INVALID_ARGUMENT", "URL required"))?;
            let parsed = tauri::Url::parse(url).map_err(shell_error)?;
            if !matches!(parsed.scheme(), "https" | "http" | "mailto") {
                return Err(error(
                    "INVALID_ARGUMENT",
                    "External URL scheme is not allowed.",
                ));
            }
            window
                .opener()
                .open_url(url, None::<&str>)
                .map_err(shell_error)?;
            Ok(Value::Null)
        }
        "aiUsage:alibabaConsoleSignIn" => {
            // The window is the shell's; the backend decides where it goes and keeps what it finds.
            let provider = args.first().and_then(Value::as_str).ok_or_else(|| error("INVALID_ARGUMENT", "Provider required."))?.to_owned();
            let target = invoke_host(state.host.clone(), "aiUsage:alibabaConsoleTarget".into(), vec![json!(provider)]).await?;
            let cookies = alibaba_window::sign_in(window.app_handle(), &target).await?;
            invoke_host(state.host.clone(), "aiUsage:alibabaConsoleStoreSession".into(), vec![json!(provider), json!(cookies)]).await
        }
        "workspaces:saveToFile" | "workspaces:openFromFile" => {
            let save = channel == "workspaces:saveToFile";
            let mut dialog = window
                .dialog()
                .file()
                .add_filter(
                    "Praxis Workspace",
                    &[praxis_core::workspaces::PRAXIS_WORKSPACE_FILE_EXTENSION],
                )
                .add_filter("All Files", &["*"]);
            let id = if save {
                let id = args
                    .first()
                    .and_then(Value::as_str)
                    .ok_or_else(|| error("INVALID_ARGUMENT", "Workspace id is required."))?
                    .to_owned();
                let workspace =
                    invoke_host(state.host.clone(), "workspaces:get".into(), vec![json!(id)])
                        .await?;
                let name = workspace["name"]
                    .as_str()
                    .ok_or_else(|| error("APPLICATION_ERROR", "Workspace was not found."))?;
                dialog = dialog
                    .set_title("Save Praxis Workspace")
                    .set_file_name(praxis_core::workspaces::workspace_file_name(name));
                Some(id)
            } else {
                dialog = dialog.set_title("Open Praxis Workspace");
                None
            };
            let (sender, receiver) = tokio::sync::oneshot::channel();
            if save {
                dialog.save_file(move |path| {
                    let _ = sender.send(path);
                });
            } else {
                dialog.pick_file(move |path| {
                    let _ = sender.send(path);
                });
            }
            let Some(path) = receiver.await.map_err(shell_error)? else {
                return Ok(Value::Null);
            };
            let path = path.into_path().map_err(shell_error)?;
            let (channel, args) = if let Some(id) = id {
                ("workspaces:writeFile", vec![json!(id), json!(path)])
            } else {
                ("workspaces:openFile", vec![json!(path)])
            };
            invoke_host(state.host.clone(), channel.into(), args).await
        }
        "ai:openHtmlArtifactPreview" => {
            // The host validates the file and applies the restricted-preview policy; the shell
            // shows it in its own window. That window has no label in any capability, so it can
            // neither call the desktop contract nor reach the app bridge.
            let prepared = invoke_host(state.host.clone(), channel, args).await?;
            let title = prepared["title"].as_str().unwrap_or("Preview").to_owned();
            let html = prepared["html"].as_str().unwrap_or_default();
            let url = format!("data:text/html;charset=utf-8,{}", percent_encode(html));
            let url = url.parse().map_err(shell_error)?;
            let label = format!("html-preview-{}", PREVIEW_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed));
            tauri::WebviewWindowBuilder::new(window.app_handle(), label, tauri::WebviewUrl::External(url))
                .title(title)
                .inner_size(1000.0, 760.0)
                .min_inner_size(560.0, 360.0)
                .build()
                .map_err(shell_error)?;
            Ok(Value::Null)
        }
        _ => invoke_host(state.host.clone(), channel, args).await,
    }
}

static PREVIEW_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(1);

/// `encodeURIComponent` for a `data:` document: everything but unreserved characters is escaped.
fn percent_encode(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

async fn invoke_host(
    host: praxis_host::HostContext,
    channel: String,
    args: Vec<Value>,
) -> Result<Value, RustRpcError> {
    // Existing bridge handlers can block or enter Tokio. Never run them on the
    // webview/UI thread or on an async runtime worker.
    tauri::async_runtime::spawn_blocking(move || {
        let response = host.dispatch_rpc(RustRpcRequest {
            id: "in-process".into(),
            channel,
            args,
        });
        if response.ok {
            Ok(response.result.unwrap_or(Value::Null))
        } else {
            Err(response
                .error
                .unwrap_or_else(|| error("HOST_ERROR", "Host returned no error")))
        }
    })
    .await
    .map_err(shell_error)?
}

fn shell_error(message: impl ToString) -> RustRpcError {
    error("DESKTOP_ERROR", message)
}

fn resolve_user_data_dir(
    app: &tauri::AppHandle,
) -> Result<std::path::PathBuf, Box<dyn std::error::Error>> {
    if let Ok(dir) = std::env::var("PRAXIS_USER_DATA_DIR")
        && !dir.trim().is_empty()
    {
        return Ok(std::path::PathBuf::from(dir));
    }

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if let Some(val) = arg.strip_prefix("--user-data-dir=") {
            if !val.trim().is_empty() {
                return Ok(std::path::PathBuf::from(val));
            }
        } else if arg == "--user-data-dir"
            && let Some(next) = args.next()
            && !next.trim().is_empty()
        {
            return Ok(std::path::PathBuf::from(next));
        }
    }

    let base_dir = if cfg!(target_os = "macos") || cfg!(target_os = "windows") {
        app.path().data_dir().ok()
    } else {
        app.path()
            .config_dir()
            .ok()
            .or_else(|| app.path().data_dir().ok())
    };

    if let Some(base) = base_dir {
        let praxis_dir = base.join("Praxis");
        let lowercase_dir = base.join("praxis");
        if praxis_dir.exists() {
            return Ok(praxis_dir);
        }
        if lowercase_dir.exists() {
            return Ok(lowercase_dir);
        }
        return Ok(praxis_dir);
    }

    Ok(app.path().app_data_dir()?)
}

fn main() {
    if std::env::args().any(|arg| arg == "--audit-contract") {
        if let Err(error) = state::print_contract_audit() {
            eprintln!("Desktop contract audit failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    if std::env::args().any(|arg| arg == "--e2e-server") {
        if let Err(error) = e2e_server::run() {
            eprintln!("e2e server failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![praxis_rpc])
        .setup(|app| {
            let default_dir = resolve_user_data_dir(app.handle())?;
            eprintln!("[Tauri] RESOLVED USER DATA DIR: {:?}", default_dir);
            let state = DesktopState::new(default_dir, app.handle().clone())?;
            if let Some(window) = app.get_webview_window("main") {
                window.set_zoom(state.host.settings().read().appearance.zoom_factor)?;
            }
            application::task_notifications::install(
                &state.host,
                std::sync::Arc::new(NativeNoticeShell { app: app.handle().clone() }),
            );
            app.manage(state);
            app.set_menu(tauri::menu::Menu::default(app.handle())?)?;
            if let Ok(dev_url) = std::env::var("PRAXIS_DEV_SERVER_URL")
                && let Some(main_window) = app.get_webview_window("main")
            {
                let target = if dev_url.ends_with(".html") {
                    dev_url.clone()
                } else {
                    format!("{}/tauri.html", dev_url.trim_end_matches('/'))
                };
                if let Ok(url) = target.parse::<tauri::Url>() {
                    let _ = main_window.navigate(url);
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Resized(_) = event {
                let _ = window.emit("praxis:event", json!({
                    "channel": "window:maximizeChanged", "payload": window.is_maximized().unwrap_or(false)
                }));
            }
        })
        .build(tauri::generate_context!())
        .expect("build Praxis Tauri preview");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::Exit)
            && let Some(state) = handle.try_state::<DesktopState>()
        {
            state.shutdown();
        }
    });
}
