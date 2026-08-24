//! Password hashing (Argon2id) and random tokens – all pure Rust, no OpenSSL.

use argon2::password_hash::rand_core::OsRng as PasswordOsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

pub fn hash_password(password: &str) -> AppResult<String> {
    let salt = SaltString::generate(&mut PasswordOsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|error| AppError::internal(format!("Passwort konnte nicht gehasht werden: {error}")))
}

pub fn verify_password(password: &str, stored: &str) -> bool {
    match PasswordHash::new(stored) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

/// URL-safe random token (refresh tokens, calendar feed tokens).
pub fn random_token(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    rand::rng().fill_bytes(&mut buffer);
    URL_SAFE_NO_PAD.encode(buffer)
}

pub fn random_bytes(len: usize) -> Vec<u8> {
    let mut buffer = vec![0u8; len];
    rand::rng().fill_bytes(&mut buffer);
    buffer
}

/// Refresh tokens are only ever stored as a hash.
pub fn sha256_hex(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    hex::encode(digest)
}

/// Short, unambiguous invite/join code.
pub fn invite_code(length: usize) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let bytes = random_bytes(length);
    bytes
        .iter()
        .map(|byte| ALPHABET[*byte as usize % ALPHABET.len()] as char)
        .collect()
}
