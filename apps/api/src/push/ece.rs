//! Message encryption for Web Push (RFC 8291 / RFC 8188, `aes128gcm`).
//!
//! Implemented directly on RustCrypto primitives so the binary stays free of
//! OpenSSL and libcurl and can be linked statically.

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes128Gcm, KeyInit, Nonce};
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use hkdf::Hkdf;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use sha2::Sha256;

use crate::error::{AppError, AppResult};

/// Single-record payload; 4096 is the record size every push service accepts.
const RECORD_SIZE: u32 = 4096;
/// A body must stay below this so push services do not reject it.
pub const MAX_PAYLOAD_BYTES: usize = 3800;

fn decode_base64(value: &str) -> AppResult<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(value.trim())
        .or_else(|_| STANDARD.decode(value.trim()))
        .map_err(|_| AppError::bad_request("Ungültiger base64-Schlüssel im Push-Abo"))
}

fn random_secret() -> SecretKey {
    loop {
        let bytes = crate::auth::password::random_bytes(32);
        if let Ok(secret) = SecretKey::from_slice(&bytes) {
            return secret;
        }
    }
}

/// Encrypts `plaintext` for one subscription and returns the request body.
pub fn encrypt(p256dh: &str, auth: &str, plaintext: &[u8]) -> AppResult<Vec<u8>> {
    if plaintext.len() > MAX_PAYLOAD_BYTES {
        return Err(AppError::bad_request("Push-Nachricht ist zu groß"));
    }

    let ua_public_bytes = decode_base64(p256dh)?;
    let auth_secret = decode_base64(auth)?;
    let ua_public = PublicKey::from_sec1_bytes(&ua_public_bytes)
        .map_err(|_| AppError::bad_request("Ungültiger p256dh-Schlüssel"))?;

    let as_secret = random_secret();
    let as_public_point = as_secret.public_key().to_encoded_point(false);
    let as_public_bytes = as_public_point.as_bytes().to_vec();

    let shared = p256::ecdh::diffie_hellman(as_secret.to_nonzero_scalar(), ua_public.as_affine());

    // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info\0" || ua_public || as_public)
    let mut key_info = Vec::with_capacity(14 + 65 + 65);
    key_info.extend_from_slice(b"WebPush: info\0");
    key_info.extend_from_slice(&ua_public_bytes);
    key_info.extend_from_slice(&as_public_bytes);

    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(&auth_secret), shared.raw_secret_bytes())
        .expand(&key_info, &mut ikm)
        .map_err(|_| AppError::internal("HKDF für Push fehlgeschlagen"))?;

    let salt = crate::auth::password::random_bytes(16);
    let hkdf = Hkdf::<Sha256>::new(Some(&salt), &ikm);

    let mut cek = [0u8; 16];
    hkdf.expand(b"Content-Encoding: aes128gcm\0", &mut cek)
        .map_err(|_| AppError::internal("HKDF (CEK) fehlgeschlagen"))?;
    let mut nonce = [0u8; 12];
    hkdf.expand(b"Content-Encoding: nonce\0", &mut nonce)
        .map_err(|_| AppError::internal("HKDF (Nonce) fehlgeschlagen"))?;

    // Single record: payload followed by the 0x02 padding delimiter.
    let mut record = plaintext.to_vec();
    record.push(0x02);

    let cipher = Aes128Gcm::new_from_slice(&cek)
        .map_err(|_| AppError::internal("AES-Schlüssel ungültig"))?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &record,
                aad: b"",
            },
        )
        .map_err(|_| AppError::internal("Verschlüsselung der Push-Nachricht fehlgeschlagen"))?;

    // Header: salt(16) | rs(4) | idlen(1) | keyid(as_public) | ciphertext
    let mut body = Vec::with_capacity(21 + as_public_bytes.len() + ciphertext.len());
    body.extend_from_slice(&salt);
    body.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    body.push(as_public_bytes.len() as u8);
    body.extend_from_slice(&as_public_bytes);
    body.extend_from_slice(&ciphertext);

    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use p256::elliptic_curve::sec1::ToEncodedPoint;

    /// Round-trip: encrypt for a freshly generated subscription and decrypt it
    /// again with the receiver's private key, exactly like a browser would.
    #[test]
    fn encrypts_so_the_receiver_can_decrypt() {
        let ua_secret = random_secret();
        let ua_public = ua_secret.public_key().to_encoded_point(false);
        let auth_secret = crate::auth::password::random_bytes(16);

        let p256dh = URL_SAFE_NO_PAD.encode(ua_public.as_bytes());
        let auth = URL_SAFE_NO_PAD.encode(&auth_secret);
        let plaintext = br#"{"title":"Initiative","body":"Neue Nachricht"}"#;

        let body = encrypt(&p256dh, &auth, plaintext).expect("encrypts");

        // Parse the aes128gcm header back out.
        let salt = &body[0..16];
        let id_len = body[20] as usize;
        let as_public_bytes = &body[21..21 + id_len];
        let ciphertext = &body[21 + id_len..];

        let as_public = PublicKey::from_sec1_bytes(as_public_bytes).unwrap();
        let shared =
            p256::ecdh::diffie_hellman(ua_secret.to_nonzero_scalar(), as_public.as_affine());

        let mut key_info = Vec::new();
        key_info.extend_from_slice(b"WebPush: info\0");
        key_info.extend_from_slice(ua_public.as_bytes());
        key_info.extend_from_slice(as_public_bytes);

        let mut ikm = [0u8; 32];
        Hkdf::<Sha256>::new(Some(&auth_secret), shared.raw_secret_bytes())
            .expand(&key_info, &mut ikm)
            .unwrap();

        let hkdf = Hkdf::<Sha256>::new(Some(salt), &ikm);
        let mut cek = [0u8; 16];
        hkdf.expand(b"Content-Encoding: aes128gcm\0", &mut cek)
            .unwrap();
        let mut nonce = [0u8; 12];
        hkdf.expand(b"Content-Encoding: nonce\0", &mut nonce)
            .unwrap();

        let cipher = Aes128Gcm::new_from_slice(&cek).unwrap();
        let mut decrypted = cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: ciphertext,
                    aad: b"",
                },
            )
            .expect("decrypts");

        assert_eq!(decrypted.pop(), Some(0x02), "padding delimiter");
        assert_eq!(decrypted, plaintext.to_vec());
    }

    #[test]
    fn rejects_oversized_payloads() {
        let secret = random_secret();
        let public = secret.public_key().to_encoded_point(false);
        let result = encrypt(
            &URL_SAFE_NO_PAD.encode(public.as_bytes()),
            &URL_SAFE_NO_PAD.encode(crate::auth::password::random_bytes(16)),
            &vec![b'x'; MAX_PAYLOAD_BYTES + 1],
        );
        assert!(result.is_err());
    }
}
