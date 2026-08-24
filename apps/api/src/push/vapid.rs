//! VAPID (RFC 8292): an ES256 JWT that identifies this server to the push service.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use p256::ecdsa::signature::Signer;
use p256::ecdsa::{Signature, SigningKey};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::SecretKey;
use serde_json::json;

use crate::error::{AppError, AppResult};

pub struct VapidKeys {
    pub public_key: String,
    pub private_key: String,
}

/// Generates a fresh VAPID key pair (`initiative-api --generate-vapid-keys`).
pub fn generate_keys() -> VapidKeys {
    loop {
        let bytes = crate::auth::password::random_bytes(32);
        if let Ok(secret) = SecretKey::from_slice(&bytes) {
            let public = secret.public_key().to_encoded_point(false);
            return VapidKeys {
                public_key: URL_SAFE_NO_PAD.encode(public.as_bytes()),
                private_key: URL_SAFE_NO_PAD.encode(secret.to_bytes()),
            };
        }
    }
}

fn decode_secret(private_key: &str) -> AppResult<SecretKey> {
    let bytes = URL_SAFE_NO_PAD
        .decode(private_key.trim())
        .or_else(|_| base64::engine::general_purpose::STANDARD.decode(private_key.trim()))
        .map_err(|_| AppError::config("VAPID_PRIVATE_KEY ist kein gültiges base64url"))?;
    SecretKey::from_slice(&bytes)
        .map_err(|_| AppError::config("VAPID_PRIVATE_KEY ist kein gültiger P-256-Schlüssel"))
}

/// `aud` must be the origin of the push endpoint, nothing else.
pub fn audience_of(endpoint: &str) -> AppResult<String> {
    let url = url::Url::parse(endpoint)
        .map_err(|_| AppError::bad_request("Push-Endpunkt ist keine gültige URL"))?;
    let host = url
        .host_str()
        .ok_or_else(|| AppError::bad_request("Push-Endpunkt ohne Host"))?;
    match url.port() {
        Some(port) => Ok(format!("{}://{}:{}", url.scheme(), host, port)),
        None => Ok(format!("{}://{}", url.scheme(), host)),
    }
}

/// Builds the `Authorization: vapid t=<jwt>, k=<public key>` header value.
pub fn authorization_header(
    endpoint: &str,
    subject: &str,
    public_key: &str,
    private_key: &str,
) -> AppResult<String> {
    let secret = decode_secret(private_key)?;
    let signing_key = SigningKey::from(&secret);

    let header = URL_SAFE_NO_PAD.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let claims = json!({
        "aud": audience_of(endpoint)?,
        "exp": (chrono::Utc::now() + chrono::Duration::hours(12)).timestamp(),
        "sub": subject,
    });
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap_or_default());
    let signing_input = format!("{header}.{payload}");

    let signature: Signature = signing_key.sign(signing_input.as_bytes());
    let token = format!(
        "{signing_input}.{}",
        URL_SAFE_NO_PAD.encode(signature.to_bytes())
    );

    Ok(format!("vapid t={token}, k={}", public_key.trim()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_the_audience_from_the_endpoint() {
        assert_eq!(
            audience_of("https://fcm.googleapis.com/fcm/send/abc123").unwrap(),
            "https://fcm.googleapis.com"
        );
    }

    #[test]
    fn signs_a_verifiable_token() {
        let keys = generate_keys();
        let header = authorization_header(
            "https://push.example.com/x",
            "mailto:admin@example.com",
            &keys.public_key,
            &keys.private_key,
        )
        .unwrap();
        assert!(header.starts_with("vapid t="));

        let token = header
            .trim_start_matches("vapid t=")
            .split(',')
            .next()
            .unwrap()
            .to_string();
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);

        // Verify the signature with the advertised public key.
        use p256::ecdsa::signature::Verifier;
        let public_bytes = URL_SAFE_NO_PAD.decode(&keys.public_key).unwrap();
        let verifying = p256::ecdsa::VerifyingKey::from_sec1_bytes(&public_bytes).unwrap();
        let signature =
            p256::ecdsa::Signature::from_slice(&URL_SAFE_NO_PAD.decode(parts[2]).unwrap()).unwrap();
        verifying
            .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &signature)
            .expect("signature verifies");
    }
}
