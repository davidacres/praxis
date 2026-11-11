use praxis_core::network_address::is_non_public_network_address;
use std::time::Duration;
use tokio::net::lookup_host;
use url::Url;

/// Checks whether `host` is a loopback or private network host.
#[must_use]
pub fn is_private_or_loopback_host(host: &str) -> bool {
    let normalized = host
        .to_ascii_lowercase()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .trim_end_matches('.')
        .to_string();

    if normalized == "localhost" || normalized.ends_with(".localhost") {
        return true;
    }

    is_non_public_network_address(&normalized)
}

/// Synchronous syntax and host literal check.
#[must_use]
pub fn blocked_browser_url_reason(raw_url: &str, allow_private: bool) -> Option<String> {
    let url = match Url::parse(raw_url) {
        Ok(u) => u,
        Err(_) => return Some("Not a valid absolute URL.".into()),
    };

    let scheme = url.scheme();
    if scheme != "http" && scheme != "https" {
        return Some(format!(
            "Unsupported scheme \"{scheme}\" — only http and https are allowed."
        ));
    }

    let host = url.host_str().unwrap_or_default();
    if is_private_or_loopback_host(host) && !allow_private {
        return Some(format!(
            "Refusing to open a loopback / private-network host ({host})."
        ));
    }

    None
}

/// Asynchronous destination safety check with DNS pre-resolution.
/// Fails closed if DNS lookup fails or resolves to private/reserved IP.
pub async fn resolved_browser_url_block_reason(
    raw_url: &str,
    allow_private: bool,
) -> Result<(), String> {
    if let Some(reason) = blocked_browser_url_reason(raw_url, allow_private) {
        return Err(reason);
    }

    if allow_private {
        return Ok(());
    }

    let url = Url::parse(raw_url).map_err(|_| "Not a valid absolute URL.")?;
    let host = url.host_str().unwrap_or_default();
    let port = url.port_or_known_default().unwrap_or(80);

    // If already a literal IP, the literal check has already confirmed public status
    if host.parse::<std::net::IpAddr>().is_ok() {
        return Ok(());
    }

    // Resolve DNS with a 3-second timeout
    let lookup_target = format!("{host}:{port}");
    let lookup_future = lookup_host(&lookup_target);
    let resolved = tokio::time::timeout(Duration::from_secs(3), lookup_future)
        .await
        .map_err(|_| "DNS resolution timed out.".to_string())?
        .map_err(|_| "Could not safely resolve browser destination.".to_string())?;

    let addresses: Vec<std::net::SocketAddr> = resolved.collect();
    if addresses.is_empty() {
        return Err("Could not safely resolve browser destination.".to_string());
    }

    for addr in addresses {
        let ip_str = addr.ip().to_string();
        if is_non_public_network_address(&ip_str) {
            return Err("Refusing a DNS destination on a private or reserved network.".to_string());
        }
    }

    Ok(())
}
