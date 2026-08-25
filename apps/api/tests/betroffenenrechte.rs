//! Auskunft, Mitnahme, Löschung – die drei Rechte mit einem Knopf.
//!
//! Art. 15, 20 und 17 DSGVO geben jedem das Recht, zu sehen was gespeichert
//! ist, es mitzunehmen und es löschen zu lassen. Wer dafür jemanden bitten
//! muss, hat diese Rechte praktisch nicht – deshalb sind sie hier Endpunkte
//! und keine Zusage.

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
async fn auskunft_mitnahme_und_loeschung() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – übersprungen");
        return;
    };
    let simple = Uuid::now_v7().simple().to_string();
    let suffix = simple[simple.len() - 8..].to_string();

    let (eva_token, eva_id) = probe.anmelden(&suffix, "eva").await;
    let (finn_token, finn_id) = probe.anmelden(&suffix, "finn").await;

    let (_, chat) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&eva_token),
            Some(json!({ "type": "direct", "memberIds": [finn_id] })),
        )
        .await;
    let chat_id = chat["id"].as_str().unwrap().to_string();

    probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat_id}/messages"),
            Some(&eva_token),
            Some(json!({ "type": "text", "body": "Hallo Finn" })),
        )
        .await;

    // --- Auskunft und Mitnahme ------------------------------------------
    let (status, daten) = probe
        .call("GET", "/api/v1/users/me/export", Some(&eva_token), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{daten}");
    assert_eq!(daten["konto"]["id"], json!(eva_id));
    assert!(
        daten["meineNachrichten"]
            .as_array()
            .unwrap()
            .iter()
            .any(|n| n["body"] == json!("Hallo Finn")),
        "die eigene Nachricht muss drin sein: {daten}"
    );
    assert_eq!(
        daten["chats"].as_array().unwrap().len(),
        1,
        "der Chat wird genannt: {daten}"
    );
    // Der Pruefwert des Passworts hat in einem Export nichts verloren.
    assert!(
        !serde_json::to_string(&daten).unwrap().contains("$argon2"),
        "kein Passwort-Pruefwert im Export"
    );

    // --- Löschung braucht das Passwort ----------------------------------
    let (status, _) = probe
        .call(
            "DELETE",
            "/api/v1/users/me",
            Some(&eva_token),
            Some(json!({ "password": "falsch" })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "ein offenes Geraet allein darf nicht genuegen"
    );

    let (status, _) = probe
        .call(
            "DELETE",
            "/api/v1/users/me",
            Some(&eva_token),
            Some(json!({ "password": "passwort123" })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Danach ist das Konto fort …
    let (status, _) = probe
        .call("GET", "/api/v1/auth/me", Some(&eva_token), None)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "das Konto ist geloescht");

    // … und Finns Gespraech hat kein Loch: Die Nachricht steht noch, nur
    // ohne Absender. Alles andere risse fremden Leuten ihre Chats auseinander.
    let (_, verlauf) = probe
        .call(
            "GET",
            &format!("/api/v1/conversations/{chat_id}/messages"),
            Some(&finn_token),
            None,
        )
        .await;
    let nachricht = verlauf["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["body"] == json!("Hallo Finn"));
    assert!(nachricht.is_some(), "die Nachricht steht noch: {verlauf}");
    assert!(
        nachricht.unwrap()["senderId"].is_null(),
        "aber ohne Absender: {nachricht:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn die_datenschutzseite_ist_ohne_anmeldung_erreichbar() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let (status, _) = probe.call("GET", "/datenschutz", None, None).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "wer wissen will, was mit seinen Daten geschieht, soll dafuer kein Konto brauchen"
    );
}
