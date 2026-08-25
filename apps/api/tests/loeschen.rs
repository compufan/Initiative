//! „Nur für mich“ und „für alle“ – zwei Arten zu löschen, zwei Bedeutungen.
//!
//! Der Unterschied ist keine Feinheit: Die eine räumt den eigenen Verlauf, die
//! andere greift in fremde ein. Deshalb prüft dieser Test vor allem, was NICHT
//! passieren darf.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

use initiative_api::config::Config;
use initiative_api::state::AppState;
use initiative_api::{app, MIGRATOR};

struct Probe {
    router: Router,
}

impl Probe {
    async fn call(
        &self,
        method: &str,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        let request = match body {
            Some(body) => builder
                .header("content-type", "application/json")
                .body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
            None => builder.body(Body::empty()).unwrap(),
        };
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn anmelden(&self, suffix: &str, name: &str) -> (String, String) {
        let (status, body) = self
            .call(
                "POST",
                "/api/v1/auth/register",
                None,
                Some(json!({
                    "username": format!("{name}{suffix}"),
                    "displayName": format!("{name} {suffix}"),
                    "password": "passwort123",
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        (
            body["accessToken"].as_str().unwrap().to_string(),
            body["user"]["id"].as_str().unwrap().to_string(),
        )
    }

    /// Wie viele Nachrichten sieht diese Person im Chat?
    async fn sichtbar(&self, token: &str, chat: &str) -> Vec<String> {
        let (_, body) = self
            .call(
                "GET",
                &format!("/api/v1/conversations/{chat}/messages"),
                Some(token),
                None,
            )
            .await;
        body["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["deletedAt"].is_null())
            .map(|m| m["body"].as_str().unwrap_or("").to_string())
            .collect()
    }
}

async fn aufbauen() -> Option<Probe> {
    let url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;
    std::env::set_var("DATABASE_URL", &url);
    std::env::set_var("NODE_ENV", "test");
    std::env::set_var("DATABASE_SSL", "false");
    std::env::set_var("JWT_SECRET", "test-secret-value-at-least-16-characters");
    std::env::set_var("REALTIME_BUS", "memory");
    std::env::set_var("STORAGE_DRIVER", "local");
    std::env::set_var("LOCAL_STORAGE_DIR", "./.data/test-uploads");
    let state = AppState::new(Config::from_env().expect("config"))
        .await
        .expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    Some(Probe {
        router: app::build(state),
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn nur_fuer_mich_und_fuer_alle() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – übersprungen");
        return;
    };
    let simple = Uuid::now_v7().simple().to_string();
    let suffix = simple[simple.len() - 8..].to_string();

    let (ida_token, _ida_id) = probe.anmelden(&suffix, "ida").await;
    let (jan_token, jan_id) = probe.anmelden(&suffix, "jan").await;

    let (_, chat) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&ida_token),
            Some(json!({ "type": "direct", "memberIds": [jan_id] })),
        )
        .await;
    let chat_id = chat["id"].as_str().unwrap().to_string();

    async fn senden(probe: &Probe, chat_id: &str, token: &str, text: &str) -> String {
        let (status, body) = probe
            .call(
                "POST",
                &format!("/api/v1/conversations/{chat_id}/messages"),
                Some(token),
                Some(json!({ "type": "text", "body": text })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        body["id"].as_str().unwrap().to_string()
    }

    let von_ida = senden(&probe, &chat_id, &ida_token, "von Ida").await;
    let von_jan = senden(&probe, &chat_id, &jan_token, "von Jan").await;

    assert_eq!(probe.sichtbar(&ida_token, &chat_id).await.len(), 2);
    assert_eq!(probe.sichtbar(&jan_token, &chat_id).await.len(), 2);

    // --- Nur für mich, und zwar an einer FREMDEN Nachricht ---------------
    // Den eigenen Verlauf darf jeder räumen. Das ist der Fall, den es bisher
    // gar nicht gab.
    let (status, _) = probe
        .call(
            "DELETE",
            &format!("/api/v1/messages/{von_jan}?scope=me"),
            Some(&ida_token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    assert_eq!(
        probe.sichtbar(&ida_token, &chat_id).await,
        vec!["von Ida".to_string()],
        "bei Ida ist Jans Nachricht weg"
    );
    assert_eq!(
        probe.sichtbar(&jan_token, &chat_id).await.len(),
        2,
        "bei Jan steht sie unveraendert"
    );

    // --- Für alle löschen: nur die eigene --------------------------------
    let (status, body) = probe
        .call(
            "DELETE",
            &format!("/api/v1/messages/{von_jan}?scope=all"),
            Some(&ida_token),
            None,
        )
        .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "Ida darf Jans Nachricht nicht bei allen loeschen: {body}"
    );

    let (status, _) = probe
        .call(
            "DELETE",
            &format!("/api/v1/messages/{von_ida}?scope=all"),
            Some(&ida_token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Jetzt ist Idas Nachricht bei BEIDEN fort.
    assert!(probe.sichtbar(&ida_token, &chat_id).await.is_empty());
    assert_eq!(
        probe.sichtbar(&jan_token, &chat_id).await,
        vec!["von Jan".to_string()],
        "bei Jan bleibt nur noch seine eigene"
    );

    // --- Und ohne Angabe bleibt es beim alten Verhalten -----------------
    // Ein Client, der den Parameter nicht kennt, darf nicht plötzlich nur
    // noch bei sich löschen.
    let von_jan_zwei = senden(&probe, &chat_id, &jan_token, "zweite von Jan").await;
    let (status, _) = probe
        .call(
            "DELETE",
            &format!("/api/v1/messages/{von_jan_zwei}"),
            Some(&jan_token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(
        probe.sichtbar(&ida_token, &chat_id).await.is_empty(),
        "ohne Angabe gilt weiterhin: fuer alle"
    );
}
