//! A Noise `IK` channel with length-prefixed framing (`packages/mobile-protocol/src/secureChannel.ts` port).
//!
//! The initiator is the phone; it pins the responder's (desktop's) static public key from
//! pairing. After a one-round-trip handshake, [`SecureChannel::encrypt`] / [`SecureChannel::decrypt`]
//! carry application frames.
//!
//! Framing: every record is a 4-byte big-endian length followed by that many bytes, at most
//! 1 MiB. Handshake messages and transport ciphertexts are framed the same way; the AEAD
//! associated data of a transport record is empty.

use crate::noise::{
    CipherState, DHLEN, Handshake, HandshakeInit, KeyPair, NoiseError, NoisePattern,
};

/// 1 MiB — a mobile control message is tiny; anything larger is a fault.
pub const MAX_RECORD: usize = 1 << 20;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ChannelError {
    #[error("Record of {0} bytes exceeds the {MAX_RECORD} limit.")]
    RecordTooLarge(usize),
    #[error("Framed record claims {0} bytes, over the {MAX_RECORD} limit.")]
    FramedRecordTooLarge(usize),
    #[error("The initiator must pin the responder static key.")]
    InitiatorMustPin,
    #[error("The handshake is already complete.")]
    AlreadyComplete,
    #[error("The channel is not open.")]
    NotOpen,
    #[error("The handshake did not complete.")]
    HandshakeIncomplete,
    #[error(transparent)]
    Noise(#[from] NoiseError),
}

/// Prefixes `payload` with its 4-byte big-endian length.
pub fn frame(payload: &[u8]) -> Result<Vec<u8>, ChannelError> {
    if payload.len() > MAX_RECORD {
        return Err(ChannelError::RecordTooLarge(payload.len()));
    }
    let length =
        u32::try_from(payload.len()).map_err(|_| ChannelError::RecordTooLarge(payload.len()))?;
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}

/// Buffers stream bytes and emits whole records as they complete.
#[derive(Debug, Default)]
pub struct RecordAssembler {
    header: [u8; 4],
    header_bytes: usize,
    record: Option<Vec<u8>>,
    record_length: usize,
}

impl RecordAssembler {
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends `chunk`; returns every record it completed. A header over the limit is an error.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Vec<u8>>, ChannelError> {
        let mut records = Vec::new();
        let mut rest = chunk;
        while !rest.is_empty() {
            let record = match self.record.as_mut() {
                Some(record) => record,
                None => {
                    let count = (4 - self.header_bytes).min(rest.len());
                    self.header[self.header_bytes..self.header_bytes + count]
                        .copy_from_slice(&rest[..count]);
                    self.header_bytes += count;
                    rest = &rest[count..];
                    if self.header_bytes < 4 {
                        break;
                    }
                    self.header_bytes = 0;
                    let length = u32::from_be_bytes(self.header) as usize;
                    if length > MAX_RECORD {
                        return Err(ChannelError::FramedRecordTooLarge(length));
                    }
                    if length == 0 {
                        records.push(Vec::new());
                        continue;
                    }
                    self.record_length = length;
                    self.record.insert(Vec::with_capacity(length))
                }
            };
            let count = (self.record_length - record.len()).min(rest.len());
            record.extend_from_slice(&rest[..count]);
            rest = &rest[count..];
            if record.len() == self.record_length {
                records.extend(self.record.take());
            }
        }
        Ok(records)
    }
}

pub struct SecureChannelOptions {
    /// This endpoint's long-term identity keypair.
    pub static_key_pair: KeyPair,
    /// Initiator only: the responder's static public key, pinned at pairing.
    pub remote_static_public_key: Option<[u8; DHLEN]>,
    /// Bound into the handshake so a channel is only usable for its pairing context.
    pub prologue: Option<Vec<u8>>,
    /// Test-only: force the ephemeral keypair.
    pub ephemeral_key_pair: Option<KeyPair>,
}

impl SecureChannelOptions {
    pub fn new(static_key_pair: KeyPair) -> Self {
        Self {
            static_key_pair,
            remote_static_public_key: None,
            prologue: None,
            ephemeral_key_pair: None,
        }
    }
}

/// One end of a Noise IK channel. Drive the handshake with [`SecureChannel::next_handshake_message`] /
/// [`SecureChannel::read_handshake_message`] until [`SecureChannel::is_open`], then encrypt / decrypt.
pub struct SecureChannel {
    handshake: Handshake,
    send: Option<CipherState>,
    receive: Option<CipherState>,
    remote_static: Option<[u8; DHLEN]>,
}

impl SecureChannel {
    fn new(initiator: bool, options: SecureChannelOptions) -> Result<Self, ChannelError> {
        let mut init = HandshakeInit::new(NoisePattern::IK, initiator);
        init.prologue = options.prologue.unwrap_or_default();
        init.static_key_pair = Some(options.static_key_pair);
        init.remote_static_public_key = options.remote_static_public_key;
        init.ephemeral_key_pair = options.ephemeral_key_pair;
        Ok(Self {
            handshake: Handshake::new(init)?,
            send: None,
            receive: None,
            remote_static: None,
        })
    }

    pub fn initiator(options: SecureChannelOptions) -> Result<Self, ChannelError> {
        if options.remote_static_public_key.is_none() {
            return Err(ChannelError::InitiatorMustPin);
        }
        Self::new(true, options)
    }

    pub fn responder(options: SecureChannelOptions) -> Result<Self, ChannelError> {
        Self::new(false, options)
    }

    pub fn is_open(&self) -> bool {
        self.send.is_some() && self.receive.is_some()
    }

    /// The peer's authenticated static public key, once the handshake completes.
    pub fn peer_static_public_key(&self) -> Option<[u8; DHLEN]> {
        self.remote_static
    }

    /// The next handshake record to send, framed.
    pub fn next_handshake_message(&mut self, payload: &[u8]) -> Result<Vec<u8>, ChannelError> {
        if self.is_open() {
            return Err(ChannelError::AlreadyComplete);
        }
        let record = frame(&self.handshake.write_message(payload)?)?;
        self.capture_result();
        Ok(record)
    }

    /// Consumes an unframed handshake record from the peer (as [`RecordAssembler`] yields it).
    pub fn read_handshake_message(&mut self, record: &[u8]) -> Result<Vec<u8>, ChannelError> {
        if self.is_open() {
            return Err(ChannelError::AlreadyComplete);
        }
        let payload = self.handshake.read_message(record)?;
        self.capture_result();
        Ok(payload)
    }

    fn capture_result(&mut self) {
        if let Some(result) = self.handshake.take_result() {
            self.send = Some(result.send);
            self.receive = Some(result.receive);
            self.remote_static = result.remote_static_public_key;
        }
    }

    /// Encrypts one application frame and returns it framed for the wire.
    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, ChannelError> {
        let send = self.send.as_mut().ok_or(ChannelError::NotOpen)?;
        frame(&send.encrypt_with_ad(&[], plaintext)?)
    }

    /// Decrypts one unframed transport record.
    pub fn decrypt(&mut self, record: &[u8]) -> Result<Vec<u8>, ChannelError> {
        let receive = self.receive.as_mut().ok_or(ChannelError::NotOpen)?;
        Ok(receive.decrypt_with_ad(&[], record)?)
    }

    /// Splits an open channel into its (send, receive) ciphers so each direction can live on its own task.
    pub fn into_ciphers(self) -> Result<(CipherState, CipherState), ChannelError> {
        match (self.send, self.receive) {
            (Some(send), Some(receive)) => Ok((send, receive)),
            _ => Err(ChannelError::NotOpen),
        }
    }
}

/// Runs the IK handshake to completion over two in-process channels (the loopback fixture and tests).
pub fn complete_handshake(
    initiator: &mut SecureChannel,
    responder: &mut SecureChannel,
) -> Result<(), ChannelError> {
    // IK is two messages: -> e,es,s,ss  then  <- e,ee,se
    for record in RecordAssembler::new().push(&initiator.next_handshake_message(&[])?)? {
        responder.read_handshake_message(&record)?;
    }
    for record in RecordAssembler::new().push(&responder.next_handshake_message(&[])?)? {
        initiator.read_handshake_message(&record)?;
    }
    if !initiator.is_open() || !responder.is_open() {
        return Err(ChannelError::HandshakeIncomplete);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(records: Vec<Vec<u8>>) -> Vec<String> {
        records
            .into_iter()
            .map(|r| String::from_utf8(r).expect("utf8"))
            .collect()
    }

    fn pair(
        phone: &KeyPair,
        desktop: &KeyPair,
        phone_prologue: &[u8],
        desktop_prologue: &[u8],
    ) -> (SecureChannel, SecureChannel) {
        let mut initiator = SecureChannelOptions::new(phone.clone());
        initiator.remote_static_public_key = Some(desktop.public_key());
        initiator.prologue = Some(phone_prologue.to_vec());
        let mut responder = SecureChannelOptions::new(desktop.clone());
        responder.prologue = Some(desktop_prologue.to_vec());
        (
            SecureChannel::initiator(initiator).expect("initiator"),
            SecureChannel::responder(responder).expect("responder"),
        )
    }

    #[test]
    fn record_assembler_reassembles_records_split_across_chunks() {
        let mut asm = RecordAssembler::new();
        let wire = frame(b"alpha").expect("frame");
        assert!(asm.push(&wire[..3]).expect("push").is_empty());
        assert_eq!(text(asm.push(&wire[3..]).expect("push")), ["alpha"]);
    }

    #[test]
    fn record_assembler_splits_several_records_from_one_chunk() {
        let mut asm = RecordAssembler::new();
        let mut chunk = frame(b"a").expect("frame");
        chunk.extend(frame(b"").expect("frame"));
        chunk.extend(frame(b"bb").expect("frame"));
        chunk.extend(frame(b"ccc").expect("frame"));
        assert_eq!(
            text(asm.push(&chunk).expect("push")),
            ["a", "", "bb", "ccc"]
        );
    }

    #[test]
    fn ik_channel_handshake_then_a_two_way_encrypted_conversation() {
        let desktop = KeyPair::generate();
        let phone = KeyPair::generate();
        let (mut initiator, mut responder) = pair(
            &phone,
            &desktop,
            b"praxis-pairing:token-1",
            b"praxis-pairing:token-1",
        );

        complete_handshake(&mut initiator, &mut responder).expect("handshake");
        assert!(initiator.is_open() && responder.is_open());
        assert_eq!(
            responder.peer_static_public_key(),
            Some(phone.public_key()),
            "desktop authenticated the phone"
        );
        assert_eq!(
            initiator.peer_static_public_key(),
            Some(desktop.public_key()),
            "phone authenticated the desktop"
        );

        let wire = RecordAssembler::new()
            .push(
                &initiator
                    .encrypt(br#"{"op":"workflowGates.approve"}"#)
                    .expect("encrypt"),
            )
            .expect("push");
        assert_eq!(
            responder.decrypt(&wire[0]).expect("decrypt"),
            br#"{"op":"workflowGates.approve"}"#
        );

        let reply = RecordAssembler::new()
            .push(
                &responder
                    .encrypt(br#"{"event":"gate.approved"}"#)
                    .expect("encrypt"),
            )
            .expect("push");
        assert_eq!(
            initiator.decrypt(&reply[0]).expect("decrypt"),
            br#"{"event":"gate.approved"}"#
        );
    }

    #[test]
    fn a_channel_bound_to_a_different_pairing_prologue_cannot_complete() {
        let desktop = KeyPair::generate();
        let phone = KeyPair::generate();
        let (mut initiator, mut responder) = pair(&phone, &desktop, b"token-A", b"token-B");
        assert!(complete_handshake(&mut initiator, &mut responder).is_err());
    }

    #[test]
    fn the_initiator_must_pin_a_responder_key() {
        let result = SecureChannel::initiator(SecureChannelOptions::new(KeyPair::generate()));
        assert_eq!(result.err(), Some(ChannelError::InitiatorMustPin));
    }

    #[test]
    fn encrypt_or_decrypt_before_the_handshake_completes_is_refused() {
        let mut responder =
            SecureChannel::responder(SecureChannelOptions::new(KeyPair::generate()))
                .expect("responder");
        assert_eq!(responder.encrypt(b"x").err(), Some(ChannelError::NotOpen));
        assert_eq!(responder.decrypt(b"x").err(), Some(ChannelError::NotOpen));
    }

    #[test]
    fn an_oversize_frame_is_rejected_by_the_assembler_and_by_frame() {
        let mut asm = RecordAssembler::new();
        let header = ((MAX_RECORD + 1) as u32).to_be_bytes();
        assert_eq!(
            asm.push(&header).err(),
            Some(ChannelError::FramedRecordTooLarge(MAX_RECORD + 1))
        );
        assert_eq!(
            frame(&vec![0u8; MAX_RECORD + 1]).err(),
            Some(ChannelError::RecordTooLarge(MAX_RECORD + 1))
        );
    }

    #[test]
    fn a_maximally_fragmented_1_mib_record_uses_bounded_linear_assembly() {
        let mut assembler = RecordAssembler::new();
        let payload = vec![7u8; MAX_RECORD];
        let bytes = frame(&payload).expect("frame");
        let started = std::time::Instant::now();
        let mut completed = Vec::new();
        for byte in bytes.chunks(1) {
            let result = assembler.push(byte).expect("push");
            if !result.is_empty() {
                completed = result;
            }
        }
        assert_eq!(completed, vec![payload]);
        assert!(
            started.elapsed().as_secs() < 5,
            "assembly must not recopy the pending record on each byte"
        );
    }

    #[test]
    fn the_handshake_cannot_be_driven_after_it_completes() {
        let desktop = KeyPair::generate();
        let phone = KeyPair::generate();
        let (mut initiator, mut responder) = pair(&phone, &desktop, b"", b"");
        complete_handshake(&mut initiator, &mut responder).expect("handshake");
        assert_eq!(
            initiator.next_handshake_message(&[]).err(),
            Some(ChannelError::AlreadyComplete)
        );
        assert_eq!(
            responder.read_handshake_message(&[]).err(),
            Some(ChannelError::AlreadyComplete)
        );
    }
}
