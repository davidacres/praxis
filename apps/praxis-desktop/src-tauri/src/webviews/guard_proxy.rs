use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

use super::guard_policy::{is_private_or_loopback_host, resolved_browser_url_block_reason};
use super::preview_access::PreviewAccessRegistry;

#[derive(Debug)]
pub struct LoopbackGuardProxy {
    port: u16,
    shutdown: Option<oneshot::Sender<()>>,
}

impl LoopbackGuardProxy {
    pub async fn start(
        preview_access: Arc<PreviewAccessRegistry>,
        allow_private_hosts: bool,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let (shutdown_tx, mut shutdown_rx) = oneshot::channel();

        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => {
                        break;
                    }
                    Ok((stream, _)) = listener.accept() => {
                        let access = Arc::clone(&preview_access);
                        tokio::spawn(async move {
                            if let Err(err) = handle_proxy_connection(stream, access, allow_private_hosts).await {
                                eprintln!("[guard_proxy] connection error: {err}");
                            }
                        });
                    }
                }
            }
        });

        Ok(Self {
            port,
            shutdown: Some(shutdown_tx),
        })
    }

    #[must_use]
    pub fn port(&self) -> u16 {
        self.port
    }

    #[must_use]
    pub fn proxy_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

impl Drop for LoopbackGuardProxy {
    fn drop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

async fn handle_proxy_connection(
    mut client_stream: TcpStream,
    preview_access: Arc<PreviewAccessRegistry>,
    allow_private_hosts: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut buffer = [0u8; 4096];
    let bytes_read = client_stream.read(&mut buffer).await?;
    if bytes_read == 0 {
        return Ok(());
    }

    let request_str = String::from_utf8_lossy(&buffer[..bytes_read]);
    let mut lines = request_str.lines();
    let Some(first_line) = lines.next() else {
        return Ok(());
    };

    let parts: Vec<&str> = first_line.split_whitespace().collect();
    if parts.len() < 2 {
        return Ok(());
    }

    let method = parts[0];
    let target = parts[1];

    if method.eq_ignore_ascii_case("CONNECT") {
        handle_connect(client_stream, target, preview_access, allow_private_hosts).await?;
    } else {
        handle_http(
            client_stream,
            &buffer[..bytes_read],
            target,
            preview_access,
            allow_private_hosts,
        )
        .await?;
    }

    Ok(())
}

async fn handle_connect(
    mut client_stream: TcpStream,
    target: &str,
    preview_access: Arc<PreviewAccessRegistry>,
    allow_private_hosts: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let host_port: Vec<&str> = target.split(':').collect();
    let host = host_port[0];
    let port: u16 = host_port.get(1).and_then(|p| p.parse().ok()).unwrap_or(443);

    let synthetic_url = format!("https://{host}:{port}");
    let is_preview_granted = preview_access.is_origin_granted(&synthetic_url);

    if !allow_private_hosts && !is_preview_granted {
        if is_private_or_loopback_host(host) {
            let reject = format!(
                "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nRefusing to open a loopback / private-network host ({host}).\r\n"
            );
            client_stream.write_all(reject.as_bytes()).await?;
            return Ok(());
        }

        if let Err(reason) = resolved_browser_url_block_reason(&synthetic_url, false).await {
            let reject = format!(
                "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n{reason}\r\n"
            );
            client_stream.write_all(reject.as_bytes()).await?;
            return Ok(());
        }
    }

    // Connect to destination target
    let target_addr = format!("{host}:{port}");
    match TcpStream::connect(&target_addr).await {
        Ok(mut target_stream) => {
            client_stream
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                .await?;
            let _ = tokio::io::copy_bidirectional(&mut client_stream, &mut target_stream).await;
        }
        Err(err) => {
            let err_msg = format!(
                "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nFailed to connect: {err}\r\n"
            );
            client_stream.write_all(err_msg.as_bytes()).await?;
        }
    }

    Ok(())
}

#[allow(clippy::collapsible_if)]
async fn handle_http(
    mut client_stream: TcpStream,
    initial_bytes: &[u8],
    target: &str,
    preview_access: Arc<PreviewAccessRegistry>,
    allow_private_hosts: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let raw_url = if target.starts_with("http://") || target.starts_with("https://") {
        target.to_string()
    } else {
        format!("http://{target}")
    };

    let is_preview_granted = preview_access.is_origin_granted(&raw_url);
    if !allow_private_hosts && !is_preview_granted {
        if let Err(reason) = resolved_browser_url_block_reason(&raw_url, false).await {
            let reject = format!(
                "HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n{reason}\r\n"
            );
            client_stream.write_all(reject.as_bytes()).await?;
            return Ok(());
        }
    }

    let Ok(parsed) = url::Url::parse(&raw_url) else {
        client_stream
            .write_all(b"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n")
            .await?;
        return Ok(());
    };

    let host = parsed.host_str().unwrap_or("127.0.0.1");
    let port = parsed.port_or_known_default().unwrap_or(80);
    let target_addr = format!("{host}:{port}");

    match TcpStream::connect(&target_addr).await {
        Ok(mut target_stream) => {
            target_stream.write_all(initial_bytes).await?;
            let _ = tokio::io::copy_bidirectional(&mut client_stream, &mut target_stream).await;
        }
        Err(err) => {
            let err_msg = format!(
                "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nFailed to connect: {err}\r\n"
            );
            client_stream.write_all(err_msg.as_bytes()).await?;
        }
    }

    Ok(())
}
