//! Headless e2e server: the real desktop backend without a webview.
//!
//! WKWebView (macOS) exposes no automation protocol Playwright can attach to, so
//! the e2e suite loads the real renderer in Chromium and forwards its
//! `praxis_rpc` calls here. The composition is the one the GUI builds
//! (`HostContext` + `HostServices` + `Application`), the channel allow-list is
//! the same generated desktop contract, and events are the same
//! `HostEventBus` stream. Nothing here is a second implementation of a channel.
//!
//! Safety: refuses to start unless `PRAXIS_E2E=1` and `PRAXIS_E2E_TOKEN` are
//! set, binds loopback only, and requires the token on every request.

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};

use praxis_contracts::RustRpcRequest;
use praxis_host::{HostConfig, HostContext, HostServices};
use serde_json::{Value, json};

use crate::application::task_notifications::{self, Notice, NoticeShell};
use crate::state::{contract_audit, contract_channels};

/// Stands in for the OS notification surface: records what the person would have been shown and
/// where a click would have taken them. Only ever installed by the e2e server.
#[derive(Default)]
struct RecordingShell {
    focused: AtomicBool,
    shown: Mutex<Vec<(Notice, bool)>>,
    opened: Mutex<Vec<Value>>,
    host: Mutex<Option<praxis_host::HostContext>>,
}

impl NoticeShell for RecordingShell {
    fn focused_windows(&self) -> Vec<String> {
        if self.focused.load(Ordering::SeqCst) {
            vec!["main".into()]
        } else {
            Vec::new()
        }
    }

    fn show(&self, notice: &Notice, silent: bool) {
        if let Ok(mut shown) = self.shown.lock() {
            shown.push((notice.clone(), silent));
        }
    }

    fn open(&self, notice: &Notice, detached: Option<&str>) {
        let window = detached.map_or_else(|| "main".to_owned(), |key| format!("detached:{key}"));
        if let Ok(mut opened) = self.opened.lock() {
            opened.push(json!({ "window": window, "target": notice.target }));
        }
        // The main window is told to open the target, as the native shell does.
        if detached.is_none()
            && let Ok(host) = self.host.lock()
            && let Some(host) = host.as_ref()
        {
            host.events()
                .emit("window:notificationOpen", Some(notice.target.clone()));
        }
    }
}

impl RecordingShell {
    fn snapshot(&self) -> Value {
        let shown: Vec<Value> = self.shown.lock().map(|shown| {
            shown.iter().map(|(n, silent)| json!({ "title": n.title, "body": n.body, "silent": silent, "target": n.target })).collect()
        }).unwrap_or_default();
        json!({ "shown": shown, "opened": self.opened.lock().map(|o| o.clone()).unwrap_or_default() })
    }
}

type Subscribers = Arc<Mutex<Vec<Sender<String>>>>;

pub fn run() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::var("PRAXIS_E2E").as_deref() != Ok("1") {
        return Err("--e2e-server requires PRAXIS_E2E=1".into());
    }
    let token = std::env::var("PRAXIS_E2E_TOKEN").unwrap_or_default();
    if token.len() < 16 {
        return Err("--e2e-server requires PRAXIS_E2E_TOKEN (16+ chars)".into());
    }

    let env: BTreeMap<String, String> = std::env::vars().collect();
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let host = HostContext::new(HostConfig::from_args_and_env(&args, &env)?);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let calls = crate::application::in_process_calls(&host);
    let services = HostServices::register(&host, runtime.handle(), calls);
    crate::state::attach_secret_persistence(&host, false);
    crate::application::Application::register(&host, env!("CARGO_PKG_VERSION"));

    let (methods, events) = contract_channels()?;
    let subscribers: Subscribers = Arc::new(Mutex::new(Vec::new()));
    let fanout = Arc::clone(&subscribers);
    host.events().on_event(move |envelope| {
        if !events.contains(&envelope.channel) {
            return;
        }
        let Ok(line) = serde_json::to_string(envelope) else {
            return;
        };
        if let Ok(mut guard) = fanout.lock() {
            guard.retain(|tx| tx.send(line.clone()).is_ok());
        }
    });

    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    println!("{}", json!({ "e2eServer": { "port": port } }));
    std::io::stdout().flush()?;

    let zoom = host.settings().read().appearance.zoom_factor;
    let shell = Arc::new(RecordingShell::default());
    *shell.host.lock().expect("shell host") = Some(host.clone());
    let center = task_notifications::install(&host, Arc::clone(&shell) as Arc<dyn NoticeShell>);
    let shared = Arc::new(Shared {
        host,
        methods,
        token,
        subscribers,
        zoom: Mutex::new(zoom),
        shell,
        center,
        veto_shutdown: AtomicBool::new(false),
    });
    let accept_shared = Arc::clone(&shared);
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let shared = Arc::clone(&accept_shared);
            std::thread::spawn(move || {
                let _ = handle(stream, &shared);
            });
        }
    });

    // The launcher owns our lifetime: exit when stdin closes.
    let mut sink = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut sink);
    // Test seam: a vetoed shutdown (the app refusing to quit) keeps running until it is killed.
    while shared.veto_shutdown.load(Ordering::SeqCst) {
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    crate::application::dispose();
    services.shutdown();
    runtime.shutdown_background();
    Ok(())
}

struct Shared {
    host: HostContext,
    methods: std::collections::BTreeSet<String>,
    token: String,
    subscribers: Subscribers,
    zoom: Mutex<f64>,
    shell: Arc<RecordingShell>,
    center: Arc<task_notifications::Center>,
    veto_shutdown: AtomicBool,
}

struct Request {
    method: String,
    path: String,
    query: BTreeMap<String, String>,
    body: Vec<u8>,
}

fn read_request(stream: &TcpStream) -> std::io::Result<Request> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut first = String::new();
    reader.read_line(&mut first)?;
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("").to_owned();
    let target = parts.next().unwrap_or("/");
    let (path, raw_query) = target.split_once('?').unwrap_or((target, ""));
    let query = raw_query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
        .collect();
    let mut length = 0usize;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            length = value.trim().parse().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;
    Ok(Request {
        method,
        path: path.to_owned(),
        query,
        body,
    })
}

const CORS: &str = "Access-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: content-type\r\nAccess-Control-Allow-Methods: GET, POST, OPTIONS\r\n";

fn respond(stream: &mut TcpStream, status: &str, body: &str) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\n{CORS}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn handle(mut stream: TcpStream, shared: &Shared) -> std::io::Result<()> {
    let request = read_request(&stream)?;
    if request.method == "OPTIONS" {
        return respond(&mut stream, "204 No Content", "");
    }
    if request.query.get("token") != Some(&shared.token) {
        return respond(&mut stream, "403 Forbidden", r#"{"error":"bad token"}"#);
    }
    match (request.method.as_str(), request.path.as_str()) {
        ("POST", "/rpc") => {
            let parsed: Result<(String, Vec<Value>), _> =
                serde_json::from_slice::<Value>(&request.body).map(|v| {
                    (
                        v["channel"].as_str().unwrap_or("").to_owned(),
                        v["args"].as_array().cloned().unwrap_or_default(),
                    )
                });
            let Ok((channel, args)) = parsed else {
                return respond(&mut stream, "400 Bad Request", r#"{"error":"bad json"}"#);
            };
            respond(
                &mut stream,
                "200 OK",
                &rpc(shared, channel, args).to_string(),
            )
        }
        // Test-only: dispatch a host channel that is outside the renderer contract
        // (e.g. `workspaces:writeFile`, which the native shell calls after a file dialog).
        // This is how a test stands in for that dialog: it answers the shell channel
        // itself, then performs the step the shell would have taken. Gated by the same
        // PRAXIS_E2E=1 + token as every other route here.
        ("POST", "/host") => {
            let parsed = serde_json::from_slice::<Value>(&request.body)
                .ok()
                .and_then(|v| {
                    Some((
                        v["channel"].as_str()?.to_owned(),
                        v["args"].as_array().cloned().unwrap_or_default(),
                    ))
                });
            let Some((channel, args)) = parsed else {
                return respond(&mut stream, "400 Bad Request", r#"{"error":"bad json"}"#);
            };
            let response = shared.host.dispatch_rpc(RustRpcRequest {
                id: "e2e-host".into(),
                channel,
                args,
            });
            let body = if response.ok {
                json!({ "ok": true, "result": response.result.unwrap_or(Value::Null) })
            } else {
                json!({ "ok": false, "error": response.error })
            };
            respond(&mut stream, "200 OK", &body.to_string())
        }
        // Test seams, reachable only in this e2e-gated server (PRAXIS_E2E=1 + token).
        ("GET", "/e2e/notifications") => {
            respond(&mut stream, "200 OK", &shared.shell.snapshot().to_string())
        }
        ("POST", "/e2e/notifications/click") => {
            let index = serde_json::from_slice::<Value>(&request.body)
                .ok()
                .and_then(|v| v["index"].as_u64());
            let notice = index.and_then(|i| {
                shared
                    .shell
                    .shown
                    .lock()
                    .ok()
                    .and_then(|shown| shown.get(i as usize).map(|(n, _)| n.clone()))
            });
            let Some(notice) = notice else {
                return respond(
                    &mut stream,
                    "400 Bad Request",
                    r#"{"error":"no such notification"}"#,
                );
            };
            shared.center.click(&notice);
            respond(&mut stream, "200 OK", "{}")
        }
        ("POST", "/e2e/window") => {
            if let Some(focused) = serde_json::from_slice::<Value>(&request.body)
                .ok()
                .and_then(|v| v["focused"].as_bool())
            {
                shared.shell.focused.store(focused, Ordering::SeqCst);
            }
            respond(&mut stream, "200 OK", "{}")
        }
        ("POST", "/e2e/sessions") => {
            let record = serde_json::from_slice::<Value>(&request.body).unwrap_or(Value::Null);
            match crate::application::e2e_apply_session(&shared.host, record) {
                Ok(()) => respond(&mut stream, "200 OK", "{}"),
                Err(error) => respond(
                    &mut stream,
                    "400 Bad Request",
                    &json!({ "error": error.message }).to_string(),
                ),
            }
        }
        ("POST", "/e2e/provider-usage") => {
            let raw = serde_json::from_slice::<Value>(&request.body)
                .ok()
                .and_then(|v| v["usage"].as_str().map(str::to_owned));
            crate::application::set_provider_usage_override(raw);
            respond(&mut stream, "200 OK", "{}")
        }
        ("POST", "/e2e/browser/person-input") => {
            crate::application::e2e_person_used_browser();
            respond(&mut stream, "200 OK", "{}")
        }
        ("POST", "/e2e/veto-shutdown") => {
            shared.veto_shutdown.store(true, Ordering::SeqCst);
            respond(&mut stream, "200 OK", "{}")
        }
        ("GET", "/events") => {
            write!(
                stream,
                "HTTP/1.1 200 OK\r\n{CORS}Content-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n\r\n: open\n\n"
            )?;
            stream.flush()?;
            let (tx, rx) = mpsc::channel::<String>();
            shared
                .subscribers
                .lock()
                .map_err(|_| std::io::ErrorKind::Other)?
                .push(tx);
            for line in rx {
                write!(stream, "data: {line}\n\n")?;
                stream.flush()?;
            }
            Ok(())
        }
        _ => respond(&mut stream, "404 Not Found", r#"{"error":"not found"}"#),
    }
}

/// Mirrors `praxis_rpc` in `main.rs`: same allow-list, then the host. Channels
/// that need a native window or dialog have no webview here and answer inertly.
fn rpc(shared: &Shared, channel: String, args: Vec<Value>) -> Value {
    // Diagnostic: `PRAXIS_E2E_LOG_RPC=1` prints one line per call, so a render loop that hammers
    // a channel is visible without guessing.
    // `=2` also prints the first 400 characters of the arguments (never use with real secrets).
    if let Ok(level) = std::env::var("PRAXIS_E2E_LOG_RPC") {
        if level == "2" {
            let shown = serde_json::to_string(&args).unwrap_or_default();
            eprintln!(
                "[rpc] {channel} {}",
                shown.chars().take(400).collect::<String>()
            );
        } else {
            eprintln!("[rpc] {channel}");
        }
    }
    let fail = |code: &str, message: String| json!({ "ok": false, "error": { "code": code, "message": message } });
    if channel == "desktop:capabilities" {
        return json!({ "ok": true, "result": contract_audit(&shared.host) });
    }
    if !shared.methods.contains(&channel) {
        return fail(
            "FORBIDDEN",
            format!("Channel '{channel}' is not in the desktop contract."),
        );
    }
    let ok = |value: Value| json!({ "ok": true, "result": value });
    match channel.as_str() {
        "app:getVersion" => ok(json!(env!("CARGO_PKG_VERSION"))),
        "window:isMaximized" | "window:supportsVibrancy" => ok(json!(false)),
        "window:getZoomFactor" => ok(json!(*shared.zoom.lock().expect("zoom"))),
        "window:setZoomFactor" => match args
            .first()
            .and_then(Value::as_f64)
            .filter(|f| (0.5..=3.0).contains(f))
        {
            Some(factor) => {
                let factor = (factor * 100.0).round() / 100.0;
                *shared.zoom.lock().expect("zoom") = factor;
                let _ = shared
                    .host
                    .settings()
                    .write(&json!({ "appearance": { "zoomFactor": factor } }));
                ok(json!(factor))
            }
            None => fail(
                "INVALID_ARGUMENT",
                "Zoom factor must be between 0.5 and 3.".into(),
            ),
        },
        // Closing with sessions still running asks first, as the native window does.
        "window:close" => {
            let running =
                crate::application::running_session_count(&shared.host.config().user_data_dir);
            if running > 0 {
                shared.host.events().emit(
                    "window:closeRequested",
                    Some(json!({ "runningSessionCount": running })),
                );
            }
            ok(Value::Null)
        }
        "window:reload"
        | "window:minimize"
        | "window:toggleMaximize"
        | "window:confirmClose"
        | "window:cancelClose"
        | "window:setSurfaceVibrancy"
        | "shell:openExternal" => ok(Value::Null),
        // The webview reports what it is showing, so a notice for it can be held back.
        "window:setNotificationView" => {
            task_notifications::set_view("main", args.first().unwrap_or(&Value::Null));
            ok(Value::Null)
        }
        "dialog:pickFolder" | "workspaces:saveToFile" | "workspaces:openFromFile" => {
            ok(Value::Null)
        }
        _ => {
            let response = shared.host.dispatch_rpc(RustRpcRequest {
                id: "e2e".into(),
                channel,
                args,
            });
            if response.ok {
                ok(response.result.unwrap_or(Value::Null))
            } else {
                json!({ "ok": false, "error": response.error })
            }
        }
    }
}
