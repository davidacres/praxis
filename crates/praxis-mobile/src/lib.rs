//! The Praxis mobile companion protocol (`packages/mobile-protocol` port).
//!
//! A phone and the desktop talk over a Noise `IK` channel (`Noise_IK_25519_ChaChaPoly_SHA256`)
//! carried as 4-byte big-endian length-prefixed records; inside it, every record is one JSON
//! frame. Wire-compatible with the TypeScript package and the Flutter app — see each module.

pub mod client;
pub mod noise;
pub mod secure_channel;
pub mod session_mirror;
pub mod wire;

pub use client::{
    MobileClientNotice, MobileRequestError, MobileRequestFailure, MobileSecureClient,
    MobileSecureClientOptions,
};
pub use noise::{
    CipherState, Handshake, HandshakeInit, HandshakeResult, KeyPair, NoiseError, NoisePattern,
};
pub use secure_channel::{
    ChannelError, MAX_RECORD, RecordAssembler, SecureChannel, SecureChannelOptions,
    complete_handshake, frame,
};
pub use session_mirror::{MobileEventCursor, SequencedSnapshot, merge_sequenced_snapshot};
pub use wire::*;
