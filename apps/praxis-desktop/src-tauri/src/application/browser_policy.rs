//! Where the in-app browser may go, decided once for every engine and every cause.
//!
//! Two independent checks guard every top-level navigation:
//!
//! 1. **The destination must be public.** A URL whose host is loopback, link-local, private,
//!    unspecified or otherwise non-public — written as a literal, as a `localhost` name, or as a
//!    DNS name that *resolves* there (rebinding) — is refused. Every resolved address is checked,
//!    not just the first, and the fetched-page backend then connects to the address it vetted so a
//!    second lookup cannot answer differently. There is no user-facing escape hatch: the only
//!    allowance is [`enable_e2e_allowance_from_env`], which only the headless e2e server calls.
//! 2. **An agent may only reach hosts the user approved.** When an agent is driving — its own
//!    `browser_navigate`, a link it clicked, a form it submitted, a redirect, or a page script
//!    navigating on its own — a host that is not on Settings' allow-list (nor approved by the person
//!    this run) is refused and raised on the driving session's permission card. Staying on the same
//!    host (ignoring a leading `www.`) is free. A person driving the browser themselves is not asked:
//!    what they type, and what they click, is their own approval.

use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use praxis_core::network_address::is_non_public_network_address;
use praxis_host::HostContext;
use serde_json::json;
use url::Url;

// ── the allow-list decision (pure) ───────────────────────────────────────

/// What the allow-list says about one navigation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    /// Same host as where it came from, on the allow-list, or approved this run.
    Allow,
    /// An unapproved host: ask the user before going there.
    Approve(String),
    /// Not a navigable http(s) URL at all.
    Refuse(String),
}

/// A host with a leading `www.` removed, so `example.com` and `www.example.com` count as one site.
fn site(host: &str) -> &str {
    host.strip_prefix("www.").unwrap_or(host)
}

/// The lower-cased host of an http(s) URL.
#[must_use]
pub fn host_of(url: &str) -> Option<String> {
    Url::parse(url)
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https"))
        .and_then(|u| u.host_str().map(|h| h.trim_end_matches('.').to_lowercase()))
        .filter(|h| !h.is_empty())
}

/// Whether `host` matches an allow-list entry: exactly, or under a `*.suffix` entry.
#[must_use]
pub fn host_listed(host: &str, entries: &[String]) -> bool {
    let host = host.to_lowercase();
    entries.iter().any(|entry| {
        let entry = entry.trim().to_lowercase();
        match entry.strip_prefix("*.") {
            Some(suffix) => host == suffix || host.ends_with(&format!(".{suffix}")),
            None => entry == host,
        }
    })
}

/// The allow-list decision for an agent-driven navigation from `from` (the page it starts on, or
/// the previous redirect hop) to `to`.
#[must_use]
pub fn decide(
    from: Option<&str>,
    to: &str,
    allowed: &[String],
    approved: &BTreeSet<String>,
) -> Verdict {
    let Some(target) = host_of(to) else {
        return Verdict::Refuse(format!(
            "Not an http(s) address the in-app browser can open: {to}"
        ));
    };
    let same_site = from
        .and_then(host_of)
        .is_some_and(|origin| site(&origin) == site(&target));
    if same_site || host_listed(&target, allowed) || approved.contains(&target) {
        Verdict::Allow
    } else {
        Verdict::Approve(target)
    }
}

// ── destination addresses (pure) ─────────────────────────────────────────

/// Loopback destinations the headless e2e server may reach, so its specs can serve pages from a
/// local mock server. Never set in a normal launch.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Allowance {
    #[default]
    None,
    /// Any loopback or private destination.
    Any,
    /// Loopback destinations on these ports only.
    LoopbackPorts(Vec<u16>),
}

impl Allowance {
    /// Parses the e2e env value: `1` for any, or a comma-separated list of ports.
    #[must_use]
    pub fn parse(raw: &str) -> Self {
        let raw = raw.trim();
        if raw == "1" {
            return Self::Any;
        }
        let ports: Vec<u16> = raw
            .split(',')
            .filter_map(|p| p.trim().parse().ok())
            .collect();
        if ports.is_empty() {
            Self::None
        } else {
            Self::LoopbackPorts(ports)
        }
    }

    fn permits(&self, ip: IpAddr, port: u16) -> bool {
        match self {
            Self::None => false,
            Self::Any => true,
            Self::LoopbackPorts(ports) => ip.to_canonical().is_loopback() && ports.contains(&port),
        }
    }
}

/// Whether `ip` is loopback, link-local, private, unspecified or otherwise not on the public
/// internet — including IPv4-mapped / -compatible IPv6 spellings of those.
#[must_use]
pub fn is_non_public(ip: IpAddr) -> bool {
    is_non_public_network_address(&ip.to_string())
        || is_non_public_network_address(&ip.to_canonical().to_string())
}

/// Checks every address a host resolved to and returns the one to connect to. One non-public
/// address refuses the lot: a name that answers with both a public and a private address is
/// exactly what a rebinding attack looks like.
pub fn vet_addresses(
    host: &str,
    port: u16,
    addresses: &[IpAddr],
    allowance: &Allowance,
) -> Result<IpAddr, String> {
    let Some(first) = addresses.first() else {
        return Err(format!("Could not resolve {host}."));
    };
    if let Some(bad) = addresses
        .iter()
        .find(|ip| is_non_public(**ip) && !allowance.permits(**ip, port))
    {
        let literal = host.trim_matches(['[', ']']).parse::<IpAddr>().ok() == Some(*bad);
        return Err(if literal {
            format!("Refusing to open a loopback / private-network host ({host}).")
        } else {
            format!(
                "Refusing to open a loopback / private-network host ({host}, which resolves to {bad})."
            )
        });
    }
    Ok(*first)
}

/// What resolving a URL's host involves, before any lookup.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Destination {
    /// The host is an IP literal; it has been vetted.
    Literal(IpAddr),
    /// A DNS name that must be resolved and vetted.
    Name { host: String, port: u16 },
}

/// The syntactic half of the destination check: scheme, IP literals and `localhost` names.
pub fn classify_destination(url: &str, allowance: &Allowance) -> Result<Destination, String> {
    let parsed = Url::parse(url).map_err(|_| format!("Not a valid absolute URL: {url}"))?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(format!(
            "Unsupported scheme \"{scheme}\" — only http and https are allowed."
        ));
    }
    let port = parsed.port_or_known_default().unwrap_or(80);
    match parsed.host() {
        Some(url::Host::Ipv4(ip)) => {
            vet_addresses(&ip.to_string(), port, &[IpAddr::V4(ip)], allowance)
                .map(Destination::Literal)
        }
        Some(url::Host::Ipv6(ip)) => {
            vet_addresses(&ip.to_string(), port, &[IpAddr::V6(ip)], allowance)
                .map(Destination::Literal)
        }
        Some(url::Host::Domain(name)) => {
            let host = name.trim_end_matches('.').to_lowercase();
            if host.is_empty() {
                return Err(format!("Not a valid absolute URL: {url}"));
            }
            if host == "localhost" || host.ends_with(".localhost") {
                let loopback = IpAddr::from([127, 0, 0, 1]);
                vet_addresses(&host, port, &[loopback], allowance)?;
            }
            Ok(Destination::Name { host, port })
        }
        None => Err(format!("Not a valid absolute URL: {url}")),
    }
}

const LOOKUP_TIMEOUT: Duration = Duration::from_secs(3);

/// Resolves and vets `url`'s destination. Returns the address to pin the connection to, or `None`
/// when the host is an IP literal (there is nothing to pin).
pub async fn vet_destination(
    url: &str,
    allowance: &Allowance,
) -> Result<Option<(String, SocketAddr)>, String> {
    match classify_destination(url, allowance)? {
        Destination::Literal(_) => Ok(None),
        Destination::Name { host, port } => {
            let addresses: Vec<IpAddr> = tokio::time::timeout(
                LOOKUP_TIMEOUT,
                tokio::net::lookup_host((host.as_str(), port)),
            )
            .await
            .map_err(|_| format!("Looking up {host} timed out."))?
            .map_err(|_| format!("Could not resolve {host}."))?
            .map(|a| a.ip())
            .collect();
            let ip = vet_addresses(&host, port, &addresses, allowance)?;
            lock(resolved_cache()).insert(host.clone(), Instant::now());
            Ok(Some((host, SocketAddr::new(ip, port))))
        }
    }
}

// ── process state ────────────────────────────────────────────────────────

static E2E_ALLOWANCE: OnceLock<Allowance> = OnceLock::new();

/// The e2e server's loopback allowance, read from `PRAXIS_E2E_BROWSER_ALLOW_LOOPBACK` (`1`, or a
/// comma-separated list of ports). Only `e2e_server::run` calls this, after its own
/// `PRAXIS_E2E=1` + token check; a normal launch never reads the variable.
pub fn enable_e2e_allowance_from_env() {
    if let Ok(raw) = std::env::var("PRAXIS_E2E_BROWSER_ALLOW_LOOPBACK") {
        let _ = E2E_ALLOWANCE.set(Allowance::parse(&raw));
    }
}

/// Unit tests point the fetched-page browser at a local server without touching the environment.
#[cfg(test)]
pub static ALLOW_PRIVATE_IN_TESTS: AtomicBool = AtomicBool::new(false);

/// The allowance in force for the fetched-page backend.
pub fn allowance() -> Allowance {
    #[cfg(test)]
    if ALLOW_PRIVATE_IN_TESTS.load(Ordering::SeqCst) {
        return Allowance::Any;
    }
    E2E_ALLOWANCE.get().cloned().unwrap_or_default()
}

static HOST: OnceLock<HostContext> = OnceLock::new();

/// Gives the policy the host whose settings hold the allow-list (the native webview's navigation
/// hook has no other way to reach them).
pub fn install_host(host: &HostContext) {
    let _ = HOST.set(host.clone());
}

fn allowed_hosts(host: Option<&HostContext>) -> Vec<String> {
    host.or_else(|| HOST.get())
        .map(|h| h.settings().read().ai.browser_tools.allowed_hosts.clone())
        .unwrap_or_default()
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Hosts the person opened themselves this run (typed in the toolbar, or a chat link they
/// clicked). They are the person's approval, but only for this run: nothing is written to Settings.
fn person_approved() -> &'static Mutex<BTreeSet<String>> {
    static SET: OnceLock<Mutex<BTreeSet<String>>> = OnceLock::new();
    SET.get_or_init(Default::default)
}

pub fn note_person_opened(url: &str) {
    if let Some(host) = host_of(url) {
        lock(person_approved()).insert(host);
    }
}

/// The allow-list verdict for an agent navigating from `from` to `to`.
pub fn verdict(host: Option<&HostContext>, from: Option<&str>, to: &str) -> Verdict {
    decide(from, to, &allowed_hosts(host), &lock(person_approved()))
}

/// Remembers an approval in Settings' allow-list, as the approval prompt always has.
pub fn remember_approval(host: &HostContext, approved: &str) {
    let mut hosts = host
        .settings()
        .read()
        .ai
        .browser_tools
        .allowed_hosts
        .clone();
    if host_listed(approved, &hosts) {
        return;
    }
    hosts.push(approved.to_owned());
    let _ = super::ai_providers::write_settings(
        host,
        &json!({ "ai": { "browserTools": { "allowedHosts": hosts } } }),
    );
}

// ── who is driving ───────────────────────────────────────────────────────

/// Asks the person driving an agent session whether the browser may open `host` (to reach `url`).
/// Raised on that session's permission card.
pub type Approver =
    Arc<dyn Fn(String, String) -> Pin<Box<dyn Future<Output = bool> + Send>> + Send + Sync>;

/// Who started a navigation.
#[derive(Clone)]
pub enum Driver {
    /// The person (the toolbar, a chat link). Their own action is the approval.
    Person,
    /// An agent's tool call; unapproved hosts go through the approver.
    Agent(Approver),
}

/// Asks before an agent reaches `to` from `from`; `Ok` means go ahead. An approval is remembered.
pub async fn check_agent_navigation(
    host: Option<&HostContext>,
    approver: &Approver,
    from: Option<&str>,
    to: &str,
) -> Result<(), String> {
    match verdict(host, from, to) {
        Verdict::Allow => Ok(()),
        Verdict::Refuse(reason) => Err(reason),
        Verdict::Approve(name) => {
            if approver(name.clone(), to.to_owned()).await {
                if let Some(host) = host {
                    remember_approval(host, &name);
                }
                Ok(())
            } else {
                Err(format!("Permission denied to open {name}."))
            }
        }
    }
}

/// The approver of the agent session that last drove the browser. A navigation the page starts on
/// its own (a script, a meta refresh) while an agent drives it is raised on that session's card.
fn active_agent() -> &'static Mutex<Option<Approver>> {
    static AGENT: OnceLock<Mutex<Option<Approver>>> = OnceLock::new();
    AGENT.get_or_init(Default::default)
}

static TOOL_IN_FLIGHT: AtomicBool = AtomicBool::new(false);

/// Marks an agent tool call as driving the browser until the guard drops.
pub struct AgentTurn(());

impl Drop for AgentTurn {
    fn drop(&mut self) {
        TOOL_IN_FLIGHT.store(false, Ordering::SeqCst);
    }
}

pub fn begin_agent_turn(approver: &Approver) -> AgentTurn {
    *lock(active_agent()) = Some(Arc::clone(approver));
    lock(blocked()).clear();
    TOOL_IN_FLIGHT.store(true, Ordering::SeqCst);
    AgentTurn(())
}

fn person_input_at() -> &'static Mutex<Option<Instant>> {
    static AT: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    AT.get_or_init(Default::default)
}

/// The page reported a person's own (trusted) input.
pub fn note_person_input() {
    *lock(person_input_at()) = Some(Instant::now());
}

fn person_input_within(window: Duration) -> bool {
    lock(person_input_at()).is_some_and(|at| at.elapsed() <= window)
}

/// Navigations the native webview refused for want of approval, oldest first.
fn blocked() -> &'static Mutex<Vec<(String, String)>> {
    static BLOCKED: OnceLock<Mutex<Vec<(String, String)>>> = OnceLock::new();
    BLOCKED.get_or_init(Default::default)
}

/// Takes the navigations refused since the last call, as `(host, url)`.
pub fn take_blocked() -> Vec<(String, String)> {
    std::mem::take(&mut *lock(blocked()))
}

// ── the native webview's navigation hook ─────────────────────────────────

/// Resolved, vetted names, so the hook (which runs on the UI thread) looks a host up once.
fn resolved_cache() -> &'static Mutex<BTreeMap<String, Instant>> {
    static CACHE: OnceLock<Mutex<BTreeMap<String, Instant>>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

const CACHE_TTL: Duration = Duration::from_secs(60);

/// Resolves `host` off the UI thread, waiting a bounded time; a slow or failed lookup refuses.
fn blocking_lookup(host: &str, port: u16) -> Result<Vec<IpAddr>, String> {
    use std::net::ToSocketAddrs;
    let (sender, receiver) = std::sync::mpsc::channel();
    let target = (host.to_owned(), port);
    std::thread::spawn(move || {
        let _ = sender.send(
            target
                .to_socket_addrs()
                .map(|addrs| addrs.map(|a| a.ip()).collect::<Vec<_>>()),
        );
    });
    match receiver.recv_timeout(Duration::from_secs(2)) {
        Ok(Ok(addresses)) => Ok(addresses),
        Ok(Err(_)) => Err(format!("Could not resolve {host}.")),
        Err(_) => Err(format!("Looking up {host} timed out.")),
    }
}

/// The destination check for the native webview, synchronous because the hook is. The webview
/// resolves the name again itself, so unlike the fetched-page backend this cannot pin the address;
/// it narrows the rebinding window to the cache lifetime rather than closing it.
pub fn native_destination_ok(url: &str) -> bool {
    match classify_destination(url, &Allowance::None) {
        Err(_) => false,
        Ok(Destination::Literal(_)) => true,
        Ok(Destination::Name { host, port }) => {
            if lock(resolved_cache())
                .get(&host)
                .is_some_and(|at| at.elapsed() < CACHE_TTL)
            {
                return true;
            }
            let ok = blocking_lookup(&host, port)
                .and_then(|addresses| vet_addresses(&host, port, &addresses, &Allowance::None))
                .is_ok();
            if ok {
                lock(resolved_cache()).insert(host, Instant::now());
            }
            ok
        }
    }
}

/// How the native webview's navigation hook decides. `current` is the page it is leaving and
/// `programmatic` says the host itself started this navigation (already checked by the caller).
pub fn native_navigation_allowed(current: Option<&str>, target: &str, programmatic: bool) -> bool {
    if target == "about:blank" {
        return true;
    }
    if !native_destination_ok(target) {
        return false;
    }
    if programmatic {
        return true;
    }
    // No agent has driven the browser: it is the person's own, and they are not asked.
    if lock(active_agent()).is_none() || person_input_within(Duration::from_secs(2)) {
        return true;
    }
    match verdict(None, current, target) {
        Verdict::Allow => true,
        Verdict::Refuse(_) => false,
        Verdict::Approve(host) => {
            lock(blocked()).push((host, target.to_owned()));
            if !TOOL_IN_FLIGHT.load(Ordering::SeqCst) {
                super::runtime::runtime().spawn(resolve_unprompted_block());
            }
            false
        }
    }
}

/// Whether a refused URL was an embedded frame's rather than the page's own. The hook cannot tell
/// frames apart, so frames from unapproved hosts are refused too; they are not worth a prompt.
async fn is_frame(shell: &dyn super::browser_native::NativeBrowser, url: &str) -> bool {
    let script = format!(
        "Array.from(document.querySelectorAll('iframe,frame')).some(function(f){{return f.src==={}}})",
        serde_json::to_string(url).unwrap_or_else(|_| "\"\"".into())
    );
    shell.eval(&script).await.ok() == Some(serde_json::Value::Bool(true))
}

/// After an agent action on the native webview: asks about the navigations it was refused, and
/// follows the first one that is approved. `Ok(true)` when it navigated.
pub async fn resolve_blocked_after_action(
    host: &HostContext,
    approver: &Approver,
    shell: &dyn super::browser_native::NativeBrowser,
) -> Result<bool, String> {
    let mut navigated = false;
    for _ in 0..5 {
        let mut pending = None;
        for (name, url) in take_blocked() {
            if !is_frame(shell, &url).await {
                pending = Some((name, url));
                break;
            }
        }
        let Some((name, url)) = pending else {
            return Ok(navigated);
        };
        if !approver(name.clone(), url.clone()).await {
            return Err(format!(
                "Permission denied to open {name}: the page tried to go to {url} and was stopped."
            ));
        }
        remember_approval(host, &name);
        shell.navigate(&url).await?;
        shell.wait_idle().await;
        navigated = true;
    }
    Ok(navigated)
}

/// A navigation the page started on its own, outside any tool call. If it followed a person's
/// input it was theirs and is let through; otherwise the agent's session is asked.
async fn resolve_unprompted_block() {
    tokio::time::sleep(Duration::from_millis(700)).await;
    if TOOL_IN_FLIGHT.load(Ordering::SeqCst) {
        return;
    }
    let Some(shell) = super::browser_native::shell() else {
        return;
    };
    let Some(host) = HOST.get() else { return };
    if person_input_within(Duration::from_secs(3)) {
        let first = take_blocked().into_iter().next();
        if let Some((_, url)) = first {
            note_person_opened(&url);
            let _ = shell.navigate(&url).await;
        }
        return;
    }
    let Some(approver) = lock(active_agent()).clone() else {
        take_blocked();
        return;
    };
    let _ = resolve_blocked_after_action(host, &approver, shell.as_ref()).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(hosts: &[&str]) -> BTreeSet<String> {
        hosts.iter().map(|h| (*h).to_owned()).collect()
    }

    fn list(hosts: &[&str]) -> Vec<String> {
        hosts.iter().map(|h| (*h).to_owned()).collect()
    }

    #[test]
    fn an_unlisted_host_needs_approval_and_a_listed_one_does_not() {
        let allowed = list(&["docs.example.com", "*.mozilla.org"]);
        assert_eq!(
            decide(None, "https://docs.example.com/a", &allowed, &set(&[])),
            Verdict::Allow
        );
        assert_eq!(
            decide(None, "https://developer.mozilla.org/x", &allowed, &set(&[])),
            Verdict::Allow
        );
        assert_eq!(
            decide(None, "https://evil.test/", &allowed, &set(&[])),
            Verdict::Approve("evil.test".into())
        );
        // A suffix entry does not match a host that merely ends in the same letters.
        assert_eq!(
            decide(None, "https://notmozilla.org/", &allowed, &set(&[])),
            Verdict::Approve("notmozilla.org".into())
        );
    }

    #[test]
    fn a_link_or_redirect_off_the_approved_host_needs_approval() {
        let allowed = list(&["docs.example.com"]);
        // A click or a redirect from an approved page to another host is not free.
        assert_eq!(
            decide(
                Some("https://docs.example.com/page"),
                "https://tracker.test/collect?x=1",
                &allowed,
                &set(&[])
            ),
            Verdict::Approve("tracker.test".into())
        );
        // Staying on the site is, including its www. twin, even if the site was never listed.
        assert_eq!(
            decide(
                Some("https://news.test/a"),
                "https://news.test/b",
                &[],
                &set(&[])
            ),
            Verdict::Allow
        );
        assert_eq!(
            decide(
                Some("https://news.test/"),
                "https://www.news.test/",
                &[],
                &set(&[])
            ),
            Verdict::Allow
        );
        // A subdomain is a different host.
        assert_eq!(
            decide(
                Some("https://news.test/"),
                "https://admin.news.test/",
                &[],
                &set(&[])
            ),
            Verdict::Approve("admin.news.test".into())
        );
    }

    #[test]
    fn a_host_the_person_opened_this_run_is_approved() {
        assert_eq!(
            decide(None, "https://Mine.Test/x", &[], &set(&["mine.test"])),
            Verdict::Allow
        );
    }

    #[test]
    fn non_http_targets_are_refused_outright() {
        for target in ["file:///etc/passwd", "javascript:alert(1)", "not a url"] {
            assert!(
                matches!(decide(None, target, &[], &set(&[])), Verdict::Refuse(_)),
                "{target}"
            );
        }
    }

    fn ip(text: &str) -> IpAddr {
        text.parse().expect("ip")
    }

    #[test]
    fn loopback_private_link_local_and_mapped_addresses_are_non_public() {
        for address in [
            "127.0.0.1",
            "127.255.0.9",
            "::1",
            "10.1.2.3",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.1.1",
            "169.254.169.254",
            "fe80::1",
            "fc00::1",
            "fd12:3456::1",
            "0.0.0.0",
            "::",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::ffff:169.254.169.254",
            "::ffff:192.168.0.1",
        ] {
            assert!(is_non_public(ip(address)), "{address}");
        }
        for address in [
            "8.8.8.8",
            "1.1.1.1",
            "172.32.0.1",
            "2001:4860:4860::8888",
            "::ffff:8.8.8.8",
        ] {
            assert!(!is_non_public(ip(address)), "{address}");
        }
    }

    #[test]
    fn every_resolved_address_is_checked_not_just_the_first() {
        let rebinding = [ip("93.184.216.34"), ip("127.0.0.1")];
        assert!(vet_addresses("evil.test", 80, &rebinding, &Allowance::None).is_err());
        let public = [ip("93.184.216.34"), ip("2606:2800:220:1::1")];
        assert_eq!(
            vet_addresses("example.com", 80, &public, &Allowance::None),
            Ok(ip("93.184.216.34"))
        );
        assert!(vet_addresses("nothing.test", 80, &[], &Allowance::None).is_err());
    }

    #[test]
    fn the_e2e_allowance_is_narrow() {
        let ports = Allowance::parse("4100, 4200");
        assert_eq!(ports, Allowance::LoopbackPorts(vec![4100, 4200]));
        assert!(vet_addresses("127.0.0.1", 4100, &[ip("127.0.0.1")], &ports).is_ok());
        // Another loopback port, or a private (non-loopback) address, stays refused.
        assert!(vet_addresses("127.0.0.1", 4300, &[ip("127.0.0.1")], &ports).is_err());
        assert!(vet_addresses("10.0.0.1", 4100, &[ip("10.0.0.1")], &ports).is_err());
        assert!(vet_addresses("x", 4100, &[ip("10.0.0.1")], &Allowance::Any).is_ok());
        assert_eq!(Allowance::parse(""), Allowance::None);
        assert_eq!(Allowance::parse("yes"), Allowance::None);
    }

    #[test]
    fn literals_and_localhost_names_are_classified_before_any_lookup() {
        let none = Allowance::None;
        for url in [
            "http://127.0.0.1:3000/",
            "http://[::1]/",
            "http://[::ffff:127.0.0.1]/",
            "http://169.254.169.254/latest/meta-data",
            "http://localhost:8080/",
            "http://app.localhost/",
            "http://LOCALHOST./",
            "http://0x7f.1/",
            "http://2130706433/",
            "ftp://example.com/",
        ] {
            assert!(classify_destination(url, &none).is_err(), "{url}");
        }
        assert_eq!(
            classify_destination("https://example.com/x", &none),
            Ok(Destination::Name {
                host: "example.com".into(),
                port: 443
            })
        );
        assert_eq!(
            classify_destination("http://8.8.8.8/", &none),
            Ok(Destination::Literal(ip("8.8.8.8")))
        );
    }

    #[tokio::test]
    async fn a_name_that_resolves_to_loopback_is_refused_after_lookup() {
        // `localhost` is caught by name above; `vet_destination` must also catch it by what it
        // resolves to, which is the path a rebinding name takes.
        let addresses: Vec<IpAddr> = tokio::net::lookup_host(("localhost", 80))
            .await
            .expect("lookup")
            .map(|a| a.ip())
            .collect();
        assert!(vet_addresses("localhost", 80, &addresses, &Allowance::None).is_err());
        assert!(
            vet_destination("http://localhost/", &Allowance::None)
                .await
                .is_err()
        );
    }
}
