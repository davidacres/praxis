//! Single-shot TCP and HTTP readiness checks (`host/networkProbe.ts` port).
//!
//! One poll, not a retry loop: the run service manager's readiness loop and the directory
//! target's post-deploy health check each poll on their own schedule.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

pub const DEFAULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(1);

/// Whether a TCP connection to `host:port` succeeds within `timeout`.
pub async fn check_tcp_open(host: &str, port: u16, timeout: Duration) -> bool {
    matches!(
        tokio::time::timeout(timeout, TcpStream::connect((host, port))).await,
        Ok(Ok(_))
    )
}

/// Whether one HTTP GET to `host:port` + `probe_path` returns `expected_status`, or any
/// 2xx when none is given, within `timeout`.
pub async fn check_http_ok(
    host: &str,
    port: u16,
    probe_path: &str,
    expected_status: Option<u16>,
    timeout: Duration,
) -> bool {
    if !probe_path.starts_with('/') {
        return false;
    }
    let attempt = async {
        let mut stream = TcpStream::connect((host, port)).await.ok()?;
        let request = format!(
            "GET {probe_path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n"
        );
        stream.write_all(request.as_bytes()).await.ok()?;
        let mut head = [0u8; 256];
        let read = stream.read(&mut head).await.ok()?;
        let text = String::from_utf8_lossy(&head[..read]);
        let status: u16 = text.split_whitespace().nth(1)?.parse().ok()?;
        Some(match expected_status {
            Some(expected) => status == expected,
            None => (200..300).contains(&status),
        })
    };
    matches!(tokio::time::timeout(timeout, attempt).await, Ok(Some(true)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    async fn serve_once(status_line: &'static str) -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                let mut buffer = [0u8; 512];
                let _ = socket.read(&mut buffer).await;
                let _ = socket
                    .write_all(format!("{status_line}\r\nContent-Length: 0\r\n\r\n").as_bytes())
                    .await;
            }
        });
        port
    }

    /// A port no test can listen on: binding below 1024 needs root, so connections are
    /// refused. Binding port 0 and releasing it races with parallel tests reusing it.
    async fn closed_port() -> u16 {
        1
    }

    #[tokio::test]
    async fn http_check_passes_on_2xx_or_the_expected_status() {
        let port = serve_once("HTTP/1.1 204 No Content").await;
        assert!(check_http_ok("127.0.0.1", port, "/healthz", None, DEFAULT_CONNECT_TIMEOUT).await);
        let port = serve_once("HTTP/1.1 503 Service Unavailable").await;
        assert!(!check_http_ok("127.0.0.1", port, "/healthz", None, DEFAULT_CONNECT_TIMEOUT).await);
        let port = serve_once("HTTP/1.1 503 Service Unavailable").await;
        assert!(
            check_http_ok(
                "127.0.0.1",
                port,
                "/healthz",
                Some(503),
                DEFAULT_CONNECT_TIMEOUT
            )
            .await
        );
    }

    #[tokio::test]
    async fn checks_fail_when_nothing_listens() {
        let port = closed_port().await;
        assert!(!check_tcp_open("127.0.0.1", port, DEFAULT_CONNECT_TIMEOUT).await);
        assert!(!check_http_ok("127.0.0.1", port, "/", None, DEFAULT_CONNECT_TIMEOUT).await);
    }

    #[tokio::test]
    async fn tcp_check_passes_when_something_listens() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        assert!(check_tcp_open("127.0.0.1", port, DEFAULT_CONNECT_TIMEOUT).await);
    }
}
