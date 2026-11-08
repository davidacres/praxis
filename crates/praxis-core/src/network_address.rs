//! IPv4/IPv6 network address and CIDR subnet normalization and locality policy helpers.

use std::net::{Ipv4Addr, Ipv6Addr};

/// Normalized IP address representation (`32` bits for IPv4 or IPv4-mapped IPv6, `128` bits for IPv6).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NetworkAddress {
    pub bits: u32,
    pub value: u128,
}

/// Normalizes IPv6 spellings and IPv4-mapped IPv6 addresses before policy comparison.
#[must_use]
pub fn parse_network_address(raw: &str) -> Option<NetworkAddress> {
    let mut address = raw.trim().to_ascii_lowercase();
    if let Some(stripped) = address.strip_prefix('[') {
        address = stripped.to_string();
    }
    if let Some(stripped) = address.strip_suffix(']') {
        address = stripped.to_string();
    }
    if let Some((before_zone, _)) = address.split_once('%') {
        address = before_zone.to_string();
    }
    if address.is_empty() {
        return None;
    }

    if let Ok(v4) = address.parse::<Ipv4Addr>() {
        return Some(NetworkAddress {
            bits: 32,
            value: u128::from(u32::from(v4)),
        });
    }

    if let Ok(v6) = address.parse::<Ipv6Addr>() {
        let value = u128::from(v6);
        if (value >> 32) == 0xffff {
            return Some(NetworkAddress {
                bits: 32,
                value: value & 0xffff_ffff,
            });
        }
        return Some(NetworkAddress { bits: 128, value });
    }

    None
}

/// Returns `true` when `address` falls inside `subnet` (exact IP or `ip/prefix` CIDR).
#[must_use]
pub fn address_in_subnet(address: &str, subnet: &str) -> bool {
    let parts: Vec<&str> = subnet.split('/').collect();
    if parts.is_empty() || parts.len() > 2 {
        return false;
    }
    let Some(network) = parse_network_address(parts[0]) else {
        return false;
    };
    let Some(peer) = parse_network_address(address) else {
        return false;
    };
    if peer.bits != network.bits {
        return false;
    }

    let prefix = if parts.len() == 1 {
        network.bits
    } else {
        let prefix_str = parts[1];
        if prefix_str.is_empty() || !prefix_str.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
        let Ok(parsed) = prefix_str.parse::<u32>() else {
            return false;
        };
        if parsed > network.bits {
            return false;
        }
        parsed
    };

    let shift = network.bits - prefix;
    if shift == 128 {
        true
    } else {
        (peer.value >> shift) == (network.value >> shift)
    }
}

/// Accepts exact addresses/CIDRs and migrates unambiguous legacy octet prefixes (`192.168.1.`).
#[must_use]
pub fn normalize_mobile_subnet(raw: &str) -> Option<String> {
    let text = raw.trim();
    if is_legacy_octet_prefix(text) {
        let without_dot = text.strip_suffix('.')?;
        let parts: Vec<&str> = without_dot.split('.').collect();
        let mut octets = Vec::with_capacity(4);
        for part in &parts {
            let val = part.parse::<u16>().ok()?;
            if val > 255 {
                return None;
            }
            octets.push(val);
        }
        let prefix_len = octets.len() * 8;
        while octets.len() < 4 {
            octets.push(0);
        }
        return Some(format!(
            "{}.{}.{}.{}/{}",
            octets[0], octets[1], octets[2], octets[3], prefix_len
        ));
    }

    let head = text.split('/').next()?;
    if parse_network_address(head).is_none() || !address_in_subnet(head, text) {
        return None;
    }
    Some(text.to_string())
}

fn is_legacy_octet_prefix(text: &str) -> bool {
    let Some(without_trailing_dot) = text.strip_suffix('.') else {
        return false;
    };
    if without_trailing_dot.is_empty() {
        return false;
    }
    let parts: Vec<&str> = without_trailing_dot.split('.').collect();
    if parts.is_empty() || parts.len() > 3 {
        return false;
    }
    parts
        .iter()
        .all(|p| (1..=3).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
}

/// Returns `true` when `address` is a loopback, RFC1918, link-local, or ULA local network address.
#[must_use]
pub fn is_local_network_address(address: &str) -> bool {
    const LOCAL_SUBNETS: &[&str] = &[
        "127.0.0.0/8",
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "169.254.0.0/16",
        "::1/128",
        "fc00::/7",
        "fe80::/10",
    ];
    LOCAL_SUBNETS
        .iter()
        .any(|subnet| address_in_subnet(address, subnet))
}

/// Returns `true` when `address` is non-public (local, unspecified, CGNAT, multicast, reserved).
#[must_use]
pub fn is_non_public_network_address(address: &str) -> bool {
    if is_local_network_address(address) {
        return true;
    }
    const NON_PUBLIC_SUBNETS: &[&str] = &[
        "0.0.0.0/8",
        "100.64.0.0/10",
        "224.0.0.0/4",
        "240.0.0.0/4",
        "::/128",
        "::/96",
        "ff00::/8",
    ];
    NON_PUBLIC_SUBNETS
        .iter()
        .any(|subnet| address_in_subnet(address, subnet))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_mobile_subnets_and_migrates_legacy_prefixes() {
        assert_eq!(normalize_mobile_subnet("192.168.1"), None);
        assert_eq!(
            normalize_mobile_subnet("192.168.1."),
            Some("192.168.1.0/24".to_string())
        );
        assert_eq!(
            normalize_mobile_subnet("192.168.1.0/24"),
            Some("192.168.1.0/24".to_string())
        );
        assert_eq!(normalize_mobile_subnet("10.0.0.0/33"), None);
        assert_eq!(
            normalize_mobile_subnet("fd00::/8"),
            Some("fd00::/8".to_string())
        );
        assert_eq!(normalize_mobile_subnet("lan"), None);
    }

    #[test]
    fn handles_ipv4_mapped_ipv6_and_locality_checks() {
        assert!(is_local_network_address("127.0.0.1"));
        assert!(is_local_network_address("::ffff:192.168.1.25"));
        assert!(!is_local_network_address("8.8.8.8"));
        assert!(is_non_public_network_address("100.64.1.1"));
        assert!(!is_non_public_network_address("1.1.1.1"));
    }
}
