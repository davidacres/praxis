//! Ed25519 device pairing, LAN WebSocket host server, and cloud relay client/server
//! for the Praxis mobile companion app.

/// Default protocol version for the mobile pairing and command envelope.
pub const MOBILE_PROTOCOL_VERSION: u32 = 1;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mobile_protocol_version_is_nonzero() {
        assert_eq!(MOBILE_PROTOCOL_VERSION, 1);
    }
}
