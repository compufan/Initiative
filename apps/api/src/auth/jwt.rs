//! Minimal HS256 JWT – no dependency on ring/OpenSSL and no algorithm confusion:
//! the header is fixed, and anything that is not exactly `HS256` is rejected.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub typ: String,
    pub iat: i64,
    pub exp: i64,
}

fn sign(data: &str, secret: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key size");
    mac.update(data.as_bytes());
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

pub fn encode(subject: &str, token_type: &str, secret: &str, ttl_seconds: i64) -> String {
    let issued_at = chrono::Utc::now().timestamp();
    let claims = Claims {
        sub: subject.to_string(),
        typ: token_type.to_string(),
        iat: issued_at,
        exp: issued_at + ttl_seconds,
    };
    let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).expect("claims serialise"));
    let data = format!("{header}.{payload}");
    let signature = sign(&data, secret);
    format!("{data}.{signature}")
}

/// Returns the claims when the signature matches, the algorithm is HS256 and
/// the token has not expired.
pub fn decode(token: &str, secret: &str) -> Option<Claims> {
    let mut parts = token.split('.');
    let header = parts.next()?;
    let payload = parts.next()?;
    let signature = parts.next()?;
    if parts.next().is_some() {
        return None;
    }

    let header_json: serde_json::Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header).ok()?).ok()?;
    if header_json.get("alg").and_then(|alg| alg.as_str()) != Some("HS256") {
        return None;
    }

    let expected = sign(&format!("{header}.{payload}"), secret);
    // Constant-time comparison via HMAC verification semantics.
    if !constant_time_eq(signature.as_bytes(), expected.as_bytes()) {
        return None;
    }

    let claims: Claims = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(payload).ok()?).ok()?;
    if claims.exp <= chrono::Utc::now().timestamp() {
        return None;
    }
    Some(claims)
}

/// Vergleicht ohne frühen Abbruch, damit sich ein Geheimnis nicht über die
/// Antwortzeit zeichenweise erraten lässt.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (left, right) in a.iter().zip(b.iter()) {
        diff |= left ^ right;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrips_a_token() {
        let token = encode("user-1", "access", "supersecretsupersecret", 60);
        let claims = decode(&token, "supersecretsupersecret").expect("valid token");
        assert_eq!(claims.sub, "user-1");
        assert_eq!(claims.typ, "access");
    }

    #[test]
    fn rejects_a_wrong_secret() {
        let token = encode("user-1", "access", "supersecretsupersecret", 60);
        assert!(decode(&token, "anderes-geheimnis-1234").is_none());
    }

    #[test]
    fn rejects_expired_tokens() {
        let token = encode("user-1", "access", "supersecretsupersecret", -10);
        assert!(decode(&token, "supersecretsupersecret").is_none());
    }

    #[test]
    fn rejects_the_none_algorithm() {
        // A forged token claiming alg=none must never be accepted.
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"none","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(
            serde_json::to_vec(&Claims {
                sub: "attacker".into(),
                typ: "access".into(),
                iat: 0,
                exp: chrono::Utc::now().timestamp() + 600,
            })
            .unwrap(),
        );
        let forged = format!("{header}.{payload}.");
        assert!(decode(&forged, "supersecretsupersecret").is_none());
    }
}
