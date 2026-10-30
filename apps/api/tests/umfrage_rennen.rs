//! Zwei Stimmen derselben Person im selben Augenblick.
//!
//! `set_votes` ersetzt die Stimmen einer Person mit „löschen, dann
//! einfügen“. Unter `read committed` sieht keine der beiden Transaktionen,
//! was die andere gerade einfügt: Beide löschen nichts, beide fügen ein. Bei
//! einer Einfachauswahl standen danach zwei Stimmen (Doppeltipp, zwei Geräte),
//! bei derselben Option scheiterte die zweite mit einem Serverfehler am
//! Primärschlüssel. Jetzt reiht eine Sperre je (Umfrage, Person) sie auf.

// Das Gerüst teilen sich mehrere Testdateien; nicht jede braucht jeden Griff.
#![allow(dead_code)]

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

#[derive(Clone)]
struct Probe {
    router: Router,
    state: AppState,
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

    async fn konto(&self, name: &str) -> (String, String) {
        let (status, body) = self
            .call(
                "POST",
                "/api/v1/auth/register",
                None,
                Some(json!({
                    "username": name,
                    "displayName": name,
                    "password": "richtigespasswort",
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        (
            body["accessToken"].as_str().unwrap().to_string(),
            body["user"]["id"].as_str().unwrap().to_string(),
        )
    }

    async fn senden(&self, token: &str, chat: &str, text: &str) -> String {
        let (status, nachricht) = self
            .call(
                "POST",
                &format!("/api/v1/conversations/{chat}/messages"),
                Some(token),
                Some(json!({ "type": "text", "body": text })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{nachricht}");
        nachricht["id"].as_str().unwrap().to_string()
    }

    async fn gruppe(&self, token: &str, mitglieder: &[&str]) -> String {
        let (status, chat) = self
            .call(
                "POST",
                "/api/v1/conversations",
                Some(token),
                Some(json!({ "type": "group", "title": "Runde", "memberIds": mitglieder })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{chat}");
        chat["id"].as_str().unwrap().to_string()
    }
}

fn umgebung(name: &str) -> Option<()> {
    let url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;
    std::env::set_var("DATABASE_URL", &url);
    std::env::set_var("NODE_ENV", "test");
    std::env::set_var("JWT_SECRET", "test-secret-value-at-least-16-characters");
    std::env::set_var("REALTIME_BUS", "memory");
    std::env::set_var("STORAGE_DRIVER", "local");
    std::env::set_var(
        "LOCAL_STORAGE_DIR",
        format!("./.data/{name}-{}", Uuid::now_v7().simple()),
    );
    std::env::set_var("PUBLIC_API_URL", "http://localhost:8080");
    std::env::set_var("PUBLIC_APP_URL", "http://localhost:5173");
    Some(())
}

async fn aufbauen_mit(name: &str) -> Option<Probe> {
    umgebung(name)?;
    let state = AppState::new(Config::from_env().expect("config"))
        .await
        .expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    Some(Probe {
        router: app::build(state.clone()),
        state,
    })
}

fn kurz() -> String {
    let voll = Uuid::now_v7().simple().to_string();
    voll[voll.len() - 10..].to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn eine_einfachauswahl_behaelt_genau_eine_stimme() {
    let Some(probe) = aufbauen_mit("umfrage").await else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – übersprungen");
        return;
    };
    let n = kurz();
    let (anna, _) = probe.konto(&format!("anna{n}")).await;
    let (bodo, bodo_id) = probe.konto(&format!("bodo{n}")).await;
    let chat = probe.gruppe(&anna, &[&bodo_id]).await;

    let (status, umfrage) = probe
        .call(
            "POST",
            "/api/v1/polls",
            Some(&anna),
            Some(json!({
                "conversationId": chat,
                "question": "Pizza oder Pasta?",
                "options": [{ "label": "Pizza" }, { "label": "Pasta" }],
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{umfrage}");
    let umfrage_id = umfrage["id"].as_str().unwrap().to_string();
    let optionen: Vec<String> = umfrage["options"]
        .as_array()
        .unwrap()
        .iter()
        .map(|option| option["id"].as_str().unwrap().to_string())
        .collect();

    for runde in 0..15 {
        let mut laeufe = Vec::new();
        for option in optionen.iter().chain(optionen.iter()) {
            let probe = probe.clone();
            let bodo = bodo.clone();
            let umfrage_id = umfrage_id.clone();
            let option = option.clone();
            laeufe.push(tokio::spawn(async move {
                probe
                    .call(
                        "POST",
                        &format!("/api/v1/polls/{umfrage_id}/vote"),
                        Some(&bodo),
                        Some(json!({ "votes": [{ "optionId": option }] })),
                    )
                    .await
            }));
        }
        for lauf in laeufe {
            let (status, antwort) = lauf.await.unwrap();
            assert_eq!(status, StatusCode::OK, "Runde {runde}: {antwort}");
        }
        let stimmen: i64 = sqlx::query_scalar(
            "select count(*) from poll_votes where poll_id = $1::uuid and user_id = $2::uuid",
        )
        .bind(&umfrage_id)
        .bind(&bodo_id)
        .fetch_one(&probe.state.pool)
        .await
        .unwrap();
        assert_eq!(
            stimmen, 1,
            "Runde {runde}: Einfachauswahl mit {stimmen} Stimmen"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn dieselbe_option_zweimal_ist_kein_serverfehler() {
    let Some(probe) = aufbauen_mit("umfrage-doppelt").await else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – übersprungen");
        return;
    };
    let n = kurz();
    let (anna, _) = probe.konto(&format!("anna{n}")).await;
    let (_, bodo_id) = probe.konto(&format!("bodo{n}")).await;
    let chat = probe.gruppe(&anna, &[&bodo_id]).await;
    let (status, umfrage) = probe
        .call(
            "POST",
            "/api/v1/polls",
            Some(&anna),
            Some(json!({
                "conversationId": chat,
                "question": "Wann?",
                "multiple": true,
                "options": [{ "label": "Mo" }, { "label": "Di" }],
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{umfrage}");
    let id = umfrage["id"].as_str().unwrap();
    let mo = umfrage["options"][0]["id"].as_str().unwrap();
    let (status, antwort) = probe
        .call(
            "POST",
            &format!("/api/v1/polls/{id}/vote"),
            Some(&anna),
            Some(json!({ "votes": [{ "optionId": mo }, { "optionId": mo }] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
}
