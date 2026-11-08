//! A local HTTP stub for the GitHub Actions client tests: records every request and answers
//! each one from a handler closure. A copy of `praxis-trackers`' `test_support.rs`, kept
//! here so no test code is exposed from that crate.

use std::sync::{Arc, Mutex, PoisonError};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, Method, Uri};
use axum::response::Response;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

/// One request the stub received.
#[derive(Debug, Clone)]
pub struct RecordedRequest {
    pub method: String,
    /// Path plus query string, as sent.
    pub uri: String,
    pub headers: HeaderMap,
    pub body: String,
}

impl RecordedRequest {
    pub fn path(&self) -> &str {
        self.uri.split('?').next().unwrap_or_default()
    }

    pub fn query_param(&self, name: &str) -> Option<String> {
        let query = self.uri.split_once('?')?.1;
        query.split('&').find_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            (key == name).then(|| value.to_string())
        })
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|value| value.to_str().ok())
    }

    pub fn json_body(&self) -> serde_json::Value {
        serde_json::from_str(&self.body).expect("the request body is JSON")
    }
}

/// The stub's answer to one request.
#[derive(Debug, Clone)]
pub struct MockResponse {
    pub status: u16,
    pub body: String,
    pub headers: Vec<(String, String)>,
}

impl MockResponse {
    pub fn json(value: &serde_json::Value) -> Self {
        Self::status_json(200, value)
    }

    pub fn status_json(status: u16, value: &serde_json::Value) -> Self {
        Self {
            status,
            body: value.to_string(),
            headers: vec![("content-type".to_string(), "application/json".to_string())],
        }
    }

    pub fn text(status: u16, body: &str) -> Self {
        Self {
            status,
            body: body.to_string(),
            headers: Vec::new(),
        }
    }

    pub fn with_header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }
}

type Handler = dyn Fn(&RecordedRequest) -> MockResponse + Send + Sync;

#[derive(Clone)]
struct ServerState {
    handler: Arc<Handler>,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
}

/// A running stub server; stops when dropped.
pub struct MockServer {
    pub base_url: String,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    task: JoinHandle<()>,
}

impl MockServer {
    pub async fn start<F>(handler: F) -> Self
    where
        F: Fn(&RecordedRequest) -> MockResponse + Send + Sync + 'static,
    {
        let requests = Arc::new(Mutex::new(Vec::new()));
        let state = ServerState {
            handler: Arc::new(handler),
            requests: Arc::clone(&requests),
        };
        let router = Router::new().fallback(handle).with_state(state);
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("the stub binds a local port");
        let address = listener.local_addr().expect("the stub has an address");
        let task = tokio::spawn(async move {
            axum::serve(listener, router)
                .await
                .expect("the stub server runs");
        });
        Self {
            base_url: format!("http://{address}"),
            requests,
            task,
        }
    }

    pub fn requests(&self) -> Vec<RecordedRequest> {
        self.requests
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn handle(
    State(state): State<ServerState>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let request = RecordedRequest {
        method: method.to_string(),
        uri: uri
            .path_and_query()
            .map_or_else(|| uri.path().to_string(), ToString::to_string),
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    };
    let answer = (state.handler)(&request);
    state
        .requests
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .push(request);
    let mut builder = Response::builder().status(answer.status);
    for (name, value) in &answer.headers {
        builder = builder.header(name, value);
    }
    builder
        .body(Body::from(answer.body))
        .expect("the stub response is valid")
}
