//! Noise Protocol Framework — the `*_25519_ChaChaPoly_SHA256` suite, patterns IK / NK / XX
//! (`packages/mobile-protocol/src/noise.ts` port).
//!
//! The product uses `IK`: the phone (initiator) already holds the desktop's static public key
//! from pairing, so one round trip reaches a mutually authenticated, forward-secret channel.
//!
//! Byte-compatible with the TypeScript (and so with the Flutter port): X25519 (RFC 7748, private
//! keys stored unclamped and clamped on use), IETF ChaCha20-Poly1305 with a 12-byte nonce of four
//! zero bytes then the 64-bit little-endian counter, SHA-256, and Noise's HKDF (HMAC-SHA256 chain).
//! A protocol name of at most 32 bytes is zero-padded rather than hashed, per the spec.
//! Guarded by the canonical `snow` vectors and by vectors produced with the TypeScript itself.

use std::collections::VecDeque;

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};
use zeroize::Zeroizing;

pub const DHLEN: usize = 32;
pub const HASHLEN: usize = 32;
pub const TAGLEN: usize = 16;

/// Noise reserves nonce 2^64-1 for [`CipherState::rekey`].
const MAX_NONCE: u64 = u64::MAX;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NoiseError {
    #[error("Noise nonce exhausted; rekey required.")]
    NonceExhausted,
    #[error("Noise encryption failed.")]
    EncryptFailed,
    #[error("Cannot rekey a CipherState with no key.")]
    NoKeyToRekey,
    #[error("Noise decryption failed: the message was tampered with or keyed differently.")]
    DecryptFailed,
    #[error("Missing key for pre-message token \"{0}\".")]
    MissingPreMessageKey(&'static str),
    #[error("The handshake has no more messages to write.")]
    NoMoreMessagesToWrite,
    #[error("The handshake has no more messages to read.")]
    NoMoreMessagesToRead,
    #[error("This handshake has no static key to send.")]
    NoStaticKey,
    #[error("Key missing for DH token \"{0}\".")]
    MissingDhKey(&'static str),
    #[error("The handshake message is too short for token \"{0}\".")]
    MessageTooShort(&'static str),
    /// X25519 produced the all-zero output (a low-order point); `@noble/curves` refuses it too.
    #[error("invalid private or public key received")]
    NonContributoryKey,
}

/// An X25519 keypair. The private half zeroizes on drop and never appears in `Debug`.
#[derive(Clone)]
pub struct KeyPair {
    private_key: StaticSecret,
    public_key: [u8; DHLEN],
}

impl KeyPair {
    /// A fresh random keypair from the operating system's CSPRNG.
    pub fn generate() -> Self {
        Self::from_private_key(StaticSecret::random().to_bytes())
    }

    /// The keypair whose private key is exactly `private_key` (`generateKeyPair(seed)` in the TS).
    pub fn from_private_key(private_key: [u8; DHLEN]) -> Self {
        let private_key = StaticSecret::from(private_key);
        let public_key = PublicKey::from(&private_key).to_bytes();
        Self {
            private_key,
            public_key,
        }
    }

    pub fn public_key(&self) -> [u8; DHLEN] {
        self.public_key
    }

    /// The raw private key, as the TS stores it (unclamped).
    pub fn private_key(&self) -> Zeroizing<[u8; DHLEN]> {
        Zeroizing::new(self.private_key.to_bytes())
    }

    fn dh(&self, public_key: &[u8; DHLEN]) -> Result<Zeroizing<[u8; DHLEN]>, NoiseError> {
        let shared = self
            .private_key
            .diffie_hellman(&PublicKey::from(*public_key));
        if !shared.was_contributory() {
            return Err(NoiseError::NonContributoryKey);
        }
        Ok(Zeroizing::new(shared.to_bytes()))
    }
}

impl std::fmt::Debug for KeyPair {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeyPair")
            .field("public_key", &self.public_key)
            .finish_non_exhaustive()
    }
}

fn hmac_sha256(key: &[u8], parts: &[&[u8]]) -> Zeroizing<[u8; HASHLEN]> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC accepts any key length");
    for part in parts {
        mac.update(part);
    }
    Zeroizing::new(mac.finalize().into_bytes().into())
}

/// Noise HKDF: an HMAC-SHA256 chain producing two outputs (the third is never used by IK/NK/XX).
fn hkdf2(
    chaining_key: &[u8],
    input_key_material: &[u8],
) -> (Zeroizing<[u8; HASHLEN]>, Zeroizing<[u8; HASHLEN]>) {
    let temp_key = hmac_sha256(chaining_key, &[input_key_material]);
    let o1 = hmac_sha256(temp_key.as_slice(), &[&[1]]);
    let o2 = hmac_sha256(temp_key.as_slice(), &[o1.as_slice(), &[2]]);
    (o1, o2)
}

fn nonce_bytes(n: u64) -> Nonce {
    let mut out = [0u8; 12]; // 32 zero bits || 64-bit little-endian counter
    out[4..].copy_from_slice(&n.to_le_bytes());
    Nonce::from(out)
}

fn sha256(parts: &[&[u8]]) -> [u8; HASHLEN] {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    hasher.finalize().into()
}

/// Noise CipherState — an AEAD key plus a monotonic 64-bit nonce.
#[derive(Default)]
pub struct CipherState {
    key: Option<Zeroizing<[u8; HASHLEN]>>,
    nonce: u64,
}

impl CipherState {
    pub fn new(key: [u8; HASHLEN]) -> Self {
        Self {
            key: Some(Zeroizing::new(key)),
            nonce: 0,
        }
    }

    fn keyed(key: &[u8; HASHLEN]) -> Self {
        Self {
            key: Some(Zeroizing::new(*key)),
            nonce: 0,
        }
    }

    pub fn has_key(&self) -> bool {
        self.key.is_some()
    }

    pub fn nonce_value(&self) -> u64 {
        self.nonce
    }

    fn aead(key: &[u8; HASHLEN]) -> ChaCha20Poly1305 {
        ChaCha20Poly1305::new(Key::from_slice(key))
    }

    pub fn encrypt_with_ad(&mut self, ad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let Some(key) = &self.key else {
            return Ok(plaintext.to_vec());
        };
        if self.nonce == MAX_NONCE {
            return Err(NoiseError::NonceExhausted);
        }
        let out = Self::aead(key)
            .encrypt(
                &nonce_bytes(self.nonce),
                Payload {
                    msg: plaintext,
                    aad: ad,
                },
            )
            .map_err(|_| NoiseError::EncryptFailed)?;
        self.nonce += 1;
        Ok(out)
    }

    /// Authenticates in constant time; the nonce advances only on success.
    pub fn decrypt_with_ad(&mut self, ad: &[u8], ciphertext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let Some(key) = &self.key else {
            return Ok(ciphertext.to_vec());
        };
        if self.nonce == MAX_NONCE {
            return Err(NoiseError::NonceExhausted);
        }
        let out = Self::aead(key)
            .decrypt(
                &nonce_bytes(self.nonce),
                Payload {
                    msg: ciphertext,
                    aad: ad,
                },
            )
            .map_err(|_| NoiseError::DecryptFailed)?;
        self.nonce += 1;
        Ok(out)
    }

    /// Replaces the key with `ENCRYPT(k, 2^64-1, [], zeros)` — forward-secret ratchet, nonce untouched.
    pub fn rekey(&mut self) -> Result<(), NoiseError> {
        let Some(key) = &self.key else {
            return Err(NoiseError::NoKeyToRekey);
        };
        let material = Zeroizing::new(
            Self::aead(key)
                .encrypt(&nonce_bytes(MAX_NONCE), &[0u8; HASHLEN][..])
                .map_err(|_| NoiseError::EncryptFailed)?,
        );
        let mut next = [0u8; HASHLEN];
        next.copy_from_slice(&material[..HASHLEN]);
        self.key = Some(Zeroizing::new(next));
        Ok(())
    }
}

struct SymmetricState {
    ck: Zeroizing<[u8; HASHLEN]>,
    h: [u8; HASHLEN],
    cipher: CipherState,
}

impl SymmetricState {
    fn new(protocol_name: &str) -> Self {
        let name = protocol_name.as_bytes();
        let h = if name.len() <= HASHLEN {
            let mut padded = [0u8; HASHLEN];
            padded[..name.len()].copy_from_slice(name);
            padded
        } else {
            sha256(&[name])
        };
        Self {
            ck: Zeroizing::new(h),
            h,
            cipher: CipherState::default(),
        }
    }

    fn mix_key(&mut self, input: &[u8]) {
        let (ck, temp_k) = hkdf2(self.ck.as_slice(), input);
        self.ck = ck;
        self.cipher = CipherState::keyed(&temp_k);
    }

    fn mix_hash(&mut self, data: &[u8]) {
        self.h = sha256(&[&self.h, data]);
    }

    fn encrypt_and_hash(&mut self, plaintext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let ciphertext = self.cipher.encrypt_with_ad(&self.h, plaintext)?;
        self.mix_hash(&ciphertext);
        Ok(ciphertext)
    }

    fn decrypt_and_hash(&mut self, ciphertext: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let plaintext = self.cipher.decrypt_with_ad(&self.h, ciphertext)?;
        self.mix_hash(ciphertext);
        Ok(plaintext)
    }

    fn split(&self) -> (CipherState, CipherState) {
        let (k1, k2) = hkdf2(self.ck.as_slice(), &[]);
        (CipherState::keyed(&k1), CipherState::keyed(&k2))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Token {
    E,
    S,
    Ee,
    Es,
    Se,
    Ss,
}

impl Token {
    fn name(self) -> &'static str {
        match self {
            Token::E => "e",
            Token::S => "s",
            Token::Ee => "ee",
            Token::Es => "es",
            Token::Se => "se",
            Token::Ss => "ss",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NoisePattern {
    IK,
    NK,
    XX,
}

impl NoisePattern {
    pub fn as_str(self) -> &'static str {
        match self {
            NoisePattern::IK => "IK",
            NoisePattern::NK => "NK",
            NoisePattern::XX => "XX",
        }
    }

    /// Whether the responder's static key is a pre-message (`<- s` before `...`).
    fn responder_static_premessage(self) -> bool {
        matches!(self, NoisePattern::IK | NoisePattern::NK)
    }

    fn messages(self) -> &'static [&'static [Token]] {
        use Token::*;
        match self {
            NoisePattern::IK => &[&[E, Es, S, Ss], &[E, Ee, Se]],
            NoisePattern::NK => &[&[E, Es], &[E, Ee]],
            NoisePattern::XX => &[&[E], &[E, Ee, S, Es], &[S, Se]],
        }
    }
}

pub struct HandshakeInit {
    pub pattern: NoisePattern,
    pub initiator: bool,
    pub prologue: Vec<u8>,
    pub static_key_pair: Option<KeyPair>,
    pub remote_static_public_key: Option<[u8; DHLEN]>,
    /// Test-only: force the ephemeral keypair instead of generating it.
    pub ephemeral_key_pair: Option<KeyPair>,
}

impl HandshakeInit {
    pub fn new(pattern: NoisePattern, initiator: bool) -> Self {
        Self {
            pattern,
            initiator,
            prologue: Vec::new(),
            static_key_pair: None,
            remote_static_public_key: None,
            ephemeral_key_pair: None,
        }
    }
}

pub struct HandshakeResult {
    pub send: CipherState,
    pub receive: CipherState,
    pub handshake_hash: [u8; HASHLEN],
    pub remote_static_public_key: Option<[u8; DHLEN]>,
}

/// A Noise handshake in progress. Alternate [`Handshake::write_message`] /
/// [`Handshake::read_message`] per the pattern; any error leaves it unusable.
pub struct Handshake {
    sym: SymmetricState,
    initiator: bool,
    s: Option<KeyPair>,
    e: Option<KeyPair>,
    rs: Option<[u8; DHLEN]>,
    re: Option<[u8; DHLEN]>,
    queue: VecDeque<&'static [Token]>,
    forced_ephemeral: Option<KeyPair>,
    result: Option<HandshakeResult>,
}

impl Handshake {
    pub fn new(init: HandshakeInit) -> Result<Self, NoiseError> {
        let mut sym = SymmetricState::new(&format!(
            "Noise_{}_25519_ChaChaPoly_SHA256",
            init.pattern.as_str()
        ));
        sym.mix_hash(&init.prologue);
        let mut handshake = Self {
            sym,
            initiator: init.initiator,
            s: init.static_key_pair,
            e: None,
            rs: init.remote_static_public_key,
            re: None,
            queue: init.pattern.messages().iter().copied().collect(),
            forced_ephemeral: init.ephemeral_key_pair,
            result: None,
        };
        if init.pattern.responder_static_premessage() {
            let key = if handshake.initiator {
                handshake.rs
            } else {
                handshake.s.as_ref().map(KeyPair::public_key)
            };
            let key = key.ok_or(NoiseError::MissingPreMessageKey("s"))?;
            handshake.sym.mix_hash(&key);
        }
        Ok(handshake)
    }

    pub fn is_done(&self) -> bool {
        self.queue.is_empty()
    }

    pub fn finished(&self) -> Option<&HandshakeResult> {
        self.result.as_ref()
    }

    /// Moves the completed result out (the transport ciphers are not cloneable).
    pub fn take_result(&mut self) -> Option<HandshakeResult> {
        self.result.take()
    }

    pub fn write_message(&mut self, payload: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let tokens = self
            .queue
            .pop_front()
            .ok_or(NoiseError::NoMoreMessagesToWrite)?;
        let mut message = Vec::new();
        for &token in tokens {
            match token {
                Token::E => {
                    let e = self
                        .forced_ephemeral
                        .take()
                        .unwrap_or_else(KeyPair::generate);
                    let public_key = e.public_key();
                    message.extend_from_slice(&public_key);
                    self.sym.mix_hash(&public_key);
                    self.e = Some(e);
                }
                Token::S => {
                    let public_key = self.s.as_ref().ok_or(NoiseError::NoStaticKey)?.public_key();
                    message.extend(self.sym.encrypt_and_hash(&public_key)?);
                }
                dh => self.mix_dh(dh)?,
            }
        }
        message.extend(self.sym.encrypt_and_hash(payload)?);
        if self.is_done() {
            self.finish();
        }
        Ok(message)
    }

    pub fn read_message(&mut self, message: &[u8]) -> Result<Vec<u8>, NoiseError> {
        let tokens = self
            .queue
            .pop_front()
            .ok_or(NoiseError::NoMoreMessagesToRead)?;
        let mut rest = message;
        for &token in tokens {
            match token {
                Token::E => {
                    let (key, tail) = take_key(rest, DHLEN, token)?;
                    self.sym.mix_hash(&key);
                    self.re = Some(key);
                    rest = tail;
                }
                Token::S => {
                    let length = if self.sym.cipher.has_key() {
                        DHLEN + TAGLEN
                    } else {
                        DHLEN
                    };
                    if rest.len() < length {
                        return Err(NoiseError::MessageTooShort(token.name()));
                    }
                    let (sealed, tail) = rest.split_at(length);
                    let plain = self.sym.decrypt_and_hash(sealed)?;
                    let key: [u8; DHLEN] = plain
                        .as_slice()
                        .try_into()
                        .map_err(|_| NoiseError::MessageTooShort(token.name()))?;
                    self.rs = Some(key);
                    rest = tail;
                }
                dh => self.mix_dh(dh)?,
            }
        }
        let payload = self.sym.decrypt_and_hash(rest)?;
        if self.is_done() {
            self.finish();
        }
        Ok(payload)
    }

    fn mix_dh(&mut self, token: Token) -> Result<(), NoiseError> {
        let missing = || NoiseError::MissingDhKey(token.name());
        let (local, remote) = match (token, self.initiator) {
            (Token::Ee, _) => (self.e.as_ref(), self.re.as_ref()),
            (Token::Es, true) | (Token::Se, false) => (self.e.as_ref(), self.rs.as_ref()),
            (Token::Es, false) | (Token::Se, true) => (self.s.as_ref(), self.re.as_ref()),
            (Token::Ss, _) => (self.s.as_ref(), self.rs.as_ref()),
            (Token::E | Token::S, _) => return Err(missing()),
        };
        let secret = local.ok_or_else(missing)?.dh(remote.ok_or_else(missing)?)?;
        self.sym.mix_key(secret.as_slice());
        Ok(())
    }

    fn finish(&mut self) {
        let (c1, c2) = self.sym.split();
        let (send, receive) = if self.initiator { (c1, c2) } else { (c2, c1) };
        self.result = Some(HandshakeResult {
            send,
            receive,
            handshake_hash: self.sym.h,
            remote_static_public_key: self.rs,
        });
    }
}

fn take_key(bytes: &[u8], length: usize, token: Token) -> Result<([u8; DHLEN], &[u8]), NoiseError> {
    if bytes.len() < length {
        return Err(NoiseError::MessageTooShort(token.name()));
    }
    let (key, tail) = bytes.split_at(length);
    let key = key
        .try_into()
        .map_err(|_| NoiseError::MessageTooShort(token.name()))?;
    Ok((key, tail))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ik_pair(phone: &KeyPair, desktop: &KeyPair, pinned: [u8; DHLEN]) -> (Handshake, Handshake) {
        let mut phone_init = HandshakeInit::new(NoisePattern::IK, true);
        phone_init.static_key_pair = Some(phone.clone());
        phone_init.remote_static_public_key = Some(pinned);
        let mut desktop_init = HandshakeInit::new(NoisePattern::IK, false);
        desktop_init.static_key_pair = Some(desktop.clone());
        (
            Handshake::new(phone_init).expect("phone handshake"),
            Handshake::new(desktop_init).expect("desktop handshake"),
        )
    }

    #[test]
    fn ik_live_handshake_with_random_keys_yields_a_working_two_way_channel() {
        let desktop = KeyPair::generate();
        let phone = KeyPair::generate();
        let (mut phone_side, mut desktop_side) = ik_pair(&phone, &desktop, desktop.public_key());

        let first = phone_side
            .write_message(b"hello from the phone")
            .expect("write 1");
        assert_eq!(
            desktop_side.read_message(&first).expect("read 1"),
            b"hello from the phone"
        );
        let second = desktop_side.write_message(&[]).expect("write 2");
        assert!(phone_side.read_message(&second).expect("read 2").is_empty());

        let mut p = phone_side.take_result().expect("phone finished");
        let mut d = desktop_side.take_result().expect("desktop finished");
        assert_eq!(
            d.remote_static_public_key,
            Some(phone.public_key()),
            "desktop authenticated the phone"
        );
        assert_eq!(p.handshake_hash, d.handshake_hash);

        let ct = p
            .send
            .encrypt_with_ad(&[], b"approve run-1")
            .expect("encrypt");
        assert_eq!(
            d.receive.decrypt_with_ad(&[], &ct).expect("decrypt"),
            b"approve run-1"
        );
        let reply = d
            .send
            .encrypt_with_ad(&[], b"gate.approved")
            .expect("encrypt reply");
        assert_eq!(
            p.receive
                .decrypt_with_ad(&[], &reply)
                .expect("decrypt reply"),
            b"gate.approved"
        );
    }

    #[test]
    fn a_tampered_transport_frame_is_rejected() {
        let desktop = KeyPair::generate();
        let phone = KeyPair::generate();
        let (mut phone_side, mut desktop_side) = ik_pair(&phone, &desktop, desktop.public_key());
        desktop_side
            .read_message(&phone_side.write_message(&[]).expect("write 1"))
            .expect("read 1");
        phone_side
            .read_message(&desktop_side.write_message(&[]).expect("write 2"))
            .expect("read 2");

        let mut p = phone_side.take_result().expect("phone finished");
        let mut d = desktop_side.take_result().expect("desktop finished");
        let mut ct = p.send.encrypt_with_ad(&[], b"approve").expect("encrypt");
        let last = ct.len() - 1;
        ct[last] ^= 0x01;
        assert_eq!(
            d.receive.decrypt_with_ad(&[], &ct),
            Err(NoiseError::DecryptFailed)
        );
        assert_eq!(
            d.receive.nonce_value(),
            0,
            "a failed decrypt does not advance the nonce"
        );
    }

    #[test]
    fn the_wrong_pinned_desktop_key_fails_the_handshake() {
        let desktop = KeyPair::generate();
        let attacker = KeyPair::generate();
        let phone = KeyPair::generate();
        let (mut phone_side, mut desktop_side) = ik_pair(&phone, &desktop, attacker.public_key());
        let first = phone_side.write_message(&[]).expect("write 1");
        assert_eq!(
            desktop_side.read_message(&first),
            Err(NoiseError::DecryptFailed)
        );
    }

    #[test]
    fn a_truncated_handshake_message_is_an_error_not_a_panic() {
        let desktop = KeyPair::generate();
        let phone = KeyPair::generate();
        let (mut phone_side, mut desktop_side) = ik_pair(&phone, &desktop, desktop.public_key());
        let first = phone_side.write_message(&[]).expect("write 1");
        assert_eq!(
            desktop_side.read_message(&first[..20]),
            Err(NoiseError::MessageTooShort("e"))
        );
    }

    #[test]
    fn a_low_order_ephemeral_key_is_refused() {
        let desktop = KeyPair::generate();
        let mut desktop_init = HandshakeInit::new(NoisePattern::IK, false);
        desktop_init.static_key_pair = Some(desktop);
        let mut desktop_side = Handshake::new(desktop_init).expect("desktop handshake");
        // The all-zero point has small order: X25519 with it is the all-zero secret.
        let message = [0u8; DHLEN + DHLEN + TAGLEN + TAGLEN];
        assert_eq!(
            desktop_side.read_message(&message),
            Err(NoiseError::NonContributoryKey)
        );
    }

    #[test]
    fn the_initiator_of_ik_needs_the_responder_key_up_front() {
        let mut init = HandshakeInit::new(NoisePattern::IK, true);
        init.static_key_pair = Some(KeyPair::generate());
        assert_eq!(
            Handshake::new(init).err(),
            Some(NoiseError::MissingPreMessageKey("s"))
        );
    }

    #[test]
    fn writing_past_the_pattern_is_refused() {
        let desktop = KeyPair::generate();
        let phone = KeyPair::generate();
        let (mut phone_side, mut desktop_side) = ik_pair(&phone, &desktop, desktop.public_key());
        desktop_side
            .read_message(&phone_side.write_message(&[]).expect("write 1"))
            .expect("read 1");
        phone_side
            .read_message(&desktop_side.write_message(&[]).expect("write 2"))
            .expect("read 2");
        assert_eq!(
            phone_side.write_message(&[]),
            Err(NoiseError::NoMoreMessagesToWrite)
        );
        assert_eq!(
            desktop_side.read_message(&[]),
            Err(NoiseError::NoMoreMessagesToRead)
        );
    }

    #[test]
    fn an_unkeyed_cipher_state_passes_bytes_through_and_cannot_rekey() {
        let mut cipher = CipherState::default();
        assert_eq!(
            cipher
                .encrypt_with_ad(b"ad", b"plain")
                .expect("passthrough"),
            b"plain"
        );
        assert_eq!(cipher.rekey(), Err(NoiseError::NoKeyToRekey));
    }

    #[test]
    fn the_reserved_nonce_is_never_used_for_a_message() {
        let mut cipher = CipherState::new([7u8; HASHLEN]);
        cipher.nonce = MAX_NONCE;
        assert_eq!(
            cipher.encrypt_with_ad(&[], b"x"),
            Err(NoiseError::NonceExhausted)
        );
        assert_eq!(
            cipher.decrypt_with_ad(&[], b"x"),
            Err(NoiseError::NonceExhausted)
        );
    }

    #[test]
    fn debug_output_never_shows_the_private_key() {
        let pair = KeyPair::from_private_key([0xab; DHLEN]);
        let shown = format!("{pair:?}");
        assert!(!shown.contains("private"), "{shown}");
    }
}
