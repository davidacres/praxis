//! Mobile access policy and the listener's lifecycle (`packages/core/src/host/mobileAccessPolicy.ts`,
//! `mobileHostListener.ts` and `apps/praxis-desktop/main/src/main/mobileAccessLifecycle.ts` port).
//!
//! [`evaluate_mobile_access`] decides whether an authenticated peer may use the host;
//! [`resolve_mobile_listener_change`] turns the persisted settings into a bound/unbound listener
//! and decides whether established peers must be dropped. "Network restrictions are
//! host-enforced on new and established connections", so any narrowing or lateral change to the
//! policy drops current peers.

use praxis_core::config::MobileAccessSettings;
use praxis_core::network_address::{
    address_in_subnet, is_local_network_address, normalize_mobile_subnet,
};
use serde::{Deserialize, Serialize};

pub const DEFAULT_MOBILE_LISTENER_PORT: u16 = 43100;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MobileAccessMode {
    Off,
    LocalOnly,
    Internet,
}

impl MobileAccessMode {
    /// The settings' mode string; anything unrecognised is `off` (fail closed).
    pub fn parse(value: &str) -> Self {
        match value {
            "local-only" => Self::LocalOnly,
            "internet" => Self::Internet,
            _ => Self::Off,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::LocalOnly => "local-only",
            Self::Internet => "internet",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileAccessPolicy {
    pub mode: MobileAccessMode,
    pub allowed_interfaces: Vec<String>,
    pub allowed_subnets: Vec<String>,
}

impl MobileAccessPolicy {
    pub fn off() -> Self {
        Self::with_mode(MobileAccessMode::Off)
    }

    pub fn with_mode(mode: MobileAccessMode) -> Self {
        Self {
            mode,
            allowed_interfaces: Vec::new(),
            allowed_subnets: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MobilePeerContext {
    pub interface_name: String,
    pub remote_address: String,
    pub authenticated: bool,
    pub forwarded_for: Option<String>,
    pub relay_route: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MobileAccessAllowed {
    LocalPeer,
    InternetPeer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MobileAccessRefusal {
    Disabled,
    NotAuthenticated,
    RelayNotEnabled,
    ForwardedHeaderNotTrusted,
    InterfaceNotAllowed,
    AddressNotAllowed,
}

impl MobileAccessRefusal {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::NotAuthenticated => "not-authenticated",
            Self::RelayNotEnabled => "relay-not-enabled",
            Self::ForwardedHeaderNotTrusted => "forwarded-header-not-trusted",
            Self::InterfaceNotAllowed => "interface-not-allowed",
            Self::AddressNotAllowed => "address-not-allowed",
        }
    }
}

/// `isPrivateAddress`: the mobile locality classifier.
pub fn is_private_address(address: &str) -> bool {
    is_local_network_address(address)
}

pub fn evaluate_mobile_access(
    policy: &MobileAccessPolicy,
    peer: &MobilePeerContext,
) -> Result<MobileAccessAllowed, MobileAccessRefusal> {
    use MobileAccessRefusal as Refuse;
    if policy.mode == MobileAccessMode::Off {
        return Err(Refuse::Disabled);
    }
    if !peer.authenticated {
        return Err(Refuse::NotAuthenticated);
    }
    if peer.forwarded_for.as_deref().is_some_and(|f| !f.is_empty()) {
        return Err(Refuse::ForwardedHeaderNotTrusted);
    }
    // A relayed stream has no local interface or address to judge: only `internet` admits it.
    if peer.relay_route {
        return if policy.mode == MobileAccessMode::Internet {
            Ok(MobileAccessAllowed::InternetPeer)
        } else {
            Err(Refuse::RelayNotEnabled)
        };
    }
    // `internet` is "local + internet relay": direct peers keep the local allowlists.
    if !is_private_address(&peer.remote_address) {
        return Err(Refuse::AddressNotAllowed);
    }
    if !policy.allowed_interfaces.is_empty()
        && !policy.allowed_interfaces.contains(&peer.interface_name)
    {
        return Err(Refuse::InterfaceNotAllowed);
    }
    if !policy.allowed_subnets.is_empty()
        && !policy.allowed_subnets.iter().any(|subnet| {
            normalize_mobile_subnet(subnet)
                .is_some_and(|normalized| address_in_subnet(&peer.remote_address, &normalized))
        })
    {
        return Err(Refuse::AddressNotAllowed);
    }
    Ok(MobileAccessAllowed::LocalPeer)
}

/// `createMobileListener`: what should be bound for a policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MobileListener {
    pub bound: bool,
    pub mode: MobileAccessMode,
    pub port: Option<u16>,
}

pub fn create_mobile_listener(policy: &MobileAccessPolicy, port: u16) -> MobileListener {
    let bound = policy.mode != MobileAccessMode::Off;
    MobileListener {
        bound,
        mode: policy.mode,
        port: bound.then_some(port),
    }
}

pub fn mobile_access_policy_from_settings(settings: &MobileAccessSettings) -> MobileAccessPolicy {
    MobileAccessPolicy {
        mode: MobileAccessMode::parse(&settings.mode),
        allowed_interfaces: settings.allowed_interfaces.clone(),
        allowed_subnets: settings.allowed_subnets.clone(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MobileListenerChange {
    pub listener: MobileListener,
    /// Bind/rebind the socket (mode moved off `off`, or the port/policy changed while bound).
    pub bind: bool,
    /// Unbind the socket (mode moved to `off`).
    pub unbind: bool,
    /// Sever every established peer — the policy narrowed or changed laterally.
    pub drop_connections: bool,
    pub reason: String,
}

/// `resolveMobileListenerChange`. `port` defaults to the settings' port, else 43100.
///
/// As in the TS, the previous listener carries only its mode, so "the allowlist changed" compares
/// the new allowlists with empty ones: any non-empty allowlist at an unchanged mode and port
/// counts as a change.
pub fn resolve_mobile_listener_change(
    previous: Option<&MobileListener>,
    settings: &MobileAccessSettings,
    port: Option<u16>,
) -> MobileListenerChange {
    let port = port
        .or((settings.listen_port != 0).then_some(settings.listen_port))
        .unwrap_or(DEFAULT_MOBILE_LISTENER_PORT);
    let policy = mobile_access_policy_from_settings(settings);
    let listener = create_mobile_listener(&policy, port);
    let Some(previous) = previous else {
        return MobileListenerChange {
            listener,
            bind: listener.bound,
            unbind: false,
            drop_connections: false,
            reason: if listener.bound {
                format!("Mobile access started in {} mode.", listener.mode.as_str())
            } else {
                "Mobile access is off.".to_owned()
            },
        };
    };
    if previous.mode == policy.mode
        && previous.port == listener.port
        && previous.bound == listener.bound
    {
        let previous_policy = MobileAccessPolicy::with_mode(previous.mode);
        let narrowed = previous_policy != policy;
        return MobileListenerChange {
            listener,
            bind: false,
            unbind: false,
            drop_connections: narrowed,
            reason: if narrowed {
                "The mobile access allowlist changed; established peers were dropped.".to_owned()
            } else {
                "No change to mobile access.".to_owned()
            },
        };
    }
    if policy.mode == MobileAccessMode::Off {
        return MobileListenerChange {
            listener,
            bind: false,
            unbind: true,
            drop_connections: true,
            reason: "Mobile access was turned off.".to_owned(),
        };
    }
    let widening =
        previous.mode == MobileAccessMode::LocalOnly && policy.mode == MobileAccessMode::Internet;
    MobileListenerChange {
        listener,
        bind: true,
        unbind: false,
        drop_connections: !widening,
        reason: if widening {
            "Mobile access widened to internet; local peers kept.".to_owned()
        } else {
            format!(
                "Mobile access changed to {}; established peers were dropped.",
                policy.mode.as_str()
            )
        },
    }
}

/// `assertLanOnlyExecution`: an action that must not run over the relay.
pub fn assert_lan_only_execution(peer: &MobilePeerContext) -> Result<(), &'static str> {
    if peer.relay_route {
        return Err("relay");
    }
    if !peer.authenticated {
        return Err("unauthenticated");
    }
    if peer.forwarded_for.as_deref().is_some_and(|f| !f.is_empty()) {
        return Err("forwarded");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings(mode: &str) -> MobileAccessSettings {
        MobileAccessSettings {
            mode: mode.to_owned(),
            host_name: "Dave Mac".to_owned(),
            allowed_interfaces: Vec::new(),
            allowed_subnets: Vec::new(),
            listen_port: 43100,
            remote_sign_in_required: false,
        }
    }

    fn peer(address: &str) -> MobilePeerContext {
        MobilePeerContext {
            interface_name: "en0".into(),
            remote_address: address.into(),
            authenticated: true,
            ..MobilePeerContext::default()
        }
    }

    // mobileAccessPolicy.test.ts
    #[test]
    fn policy_admits_local_peers_and_refuses_the_rest() {
        let local = MobileAccessPolicy::with_mode(MobileAccessMode::LocalOnly);
        assert_eq!(
            evaluate_mobile_access(&MobileAccessPolicy::off(), &peer("192.168.1.2")),
            Err(MobileAccessRefusal::Disabled)
        );
        assert_eq!(
            evaluate_mobile_access(&local, &peer("192.168.1.2")),
            Ok(MobileAccessAllowed::LocalPeer)
        );
        assert_eq!(
            evaluate_mobile_access(&local, &peer("8.8.8.8")),
            Err(MobileAccessRefusal::AddressNotAllowed)
        );
        assert_eq!(
            evaluate_mobile_access(&local, &peer("::ffff:c0a8:0102")),
            Ok(MobileAccessAllowed::LocalPeer)
        );
        let unauthenticated = MobilePeerContext {
            authenticated: false,
            ..peer("192.168.1.2")
        };
        assert_eq!(
            evaluate_mobile_access(&local, &unauthenticated),
            Err(MobileAccessRefusal::NotAuthenticated)
        );
        let forwarded = MobilePeerContext {
            forwarded_for: Some("1.2.3.4".into()),
            ..peer("192.168.1.2")
        };
        assert_eq!(
            evaluate_mobile_access(&local, &forwarded),
            Err(MobileAccessRefusal::ForwardedHeaderNotTrusted)
        );
        let relayed = MobilePeerContext {
            relay_route: true,
            ..peer("relay")
        };
        assert_eq!(
            evaluate_mobile_access(&local, &relayed),
            Err(MobileAccessRefusal::RelayNotEnabled)
        );
        assert_eq!(
            evaluate_mobile_access(
                &MobileAccessPolicy::with_mode(MobileAccessMode::Internet),
                &relayed
            ),
            Ok(MobileAccessAllowed::InternetPeer)
        );
        let interfaces = MobileAccessPolicy {
            allowed_interfaces: vec!["en1".into()],
            ..local.clone()
        };
        assert_eq!(
            evaluate_mobile_access(&interfaces, &peer("192.168.1.2")),
            Err(MobileAccessRefusal::InterfaceNotAllowed)
        );
        let subnets = MobileAccessPolicy {
            allowed_subnets: vec!["10.0.0.".into()],
            ..local.clone()
        };
        assert_eq!(
            evaluate_mobile_access(&subnets, &peer("127.0.0.1")),
            Err(MobileAccessRefusal::AddressNotAllowed)
        );
        assert_eq!(
            evaluate_mobile_access(&subnets, &peer("10.0.0.7")),
            Ok(MobileAccessAllowed::LocalPeer)
        );
    }

    #[test]
    fn off_means_no_listener_and_nothing_to_drop() {
        let change = resolve_mobile_listener_change(None, &settings("off"), None);
        assert!(!change.listener.bound);
        assert!(!change.bind);
        assert!(!change.drop_connections);
    }

    #[test]
    fn first_enable_binds_without_dropping() {
        let change = resolve_mobile_listener_change(None, &settings("local-only"), None);
        assert!(change.listener.bound);
        assert_eq!(change.listener.mode, MobileAccessMode::LocalOnly);
        assert!(change.bind);
        assert!(!change.drop_connections);
    }

    #[test]
    fn turning_access_off_unbinds_and_severs_every_peer() {
        let previous = resolve_mobile_listener_change(None, &settings("internet"), None).listener;
        let change = resolve_mobile_listener_change(Some(&previous), &settings("off"), None);
        assert!(change.unbind);
        assert!(!change.listener.bound);
        assert!(change.drop_connections);
    }

    #[test]
    fn narrowing_drops_peers_and_widening_keeps_them() {
        let internet = resolve_mobile_listener_change(None, &settings("internet"), None).listener;
        let narrow = resolve_mobile_listener_change(Some(&internet), &settings("local-only"), None);
        assert!(narrow.drop_connections);
        assert!(narrow.bind);
        let local = resolve_mobile_listener_change(None, &settings("local-only"), None).listener;
        let widen = resolve_mobile_listener_change(Some(&local), &settings("internet"), None);
        assert!(!widen.drop_connections);
    }

    #[test]
    fn a_lateral_allowlist_change_at_the_same_mode_drops_established_peers() {
        let before = resolve_mobile_listener_change(None, &settings("local-only"), None).listener;
        let mut narrowed = settings("local-only");
        narrowed.allowed_interfaces = vec!["en0".into()];
        let change = resolve_mobile_listener_change(Some(&before), &narrowed, None);
        assert!(change.drop_connections);
        assert!(!change.bind);
    }

    #[test]
    fn no_change_is_a_no_op() {
        let before = resolve_mobile_listener_change(None, &settings("local-only"), None).listener;
        let change = resolve_mobile_listener_change(Some(&before), &settings("local-only"), None);
        assert!(!change.bind);
        assert!(!change.unbind);
        assert!(!change.drop_connections);
    }

    #[test]
    fn changing_the_listen_port_rebinds_and_drops_peers() {
        let before = resolve_mobile_listener_change(None, &settings("local-only"), None).listener;
        let mut moved = settings("local-only");
        moved.listen_port = 43101;
        let change = resolve_mobile_listener_change(Some(&before), &moved, None);
        assert!(change.bind);
        assert!(change.drop_connections);
        assert_eq!(change.listener.port, Some(43101));
    }

    #[test]
    fn lan_only_execution_refuses_relay_and_unauthenticated_peers() {
        assert_eq!(assert_lan_only_execution(&peer("192.168.1.2")), Ok(()));
        let relayed = MobilePeerContext {
            relay_route: true,
            ..peer("relay")
        };
        assert_eq!(assert_lan_only_execution(&relayed), Err("relay"));
    }
}
