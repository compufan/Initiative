//! Mitteilungen zu Nachrichten gehen nur an die, die sie noch nicht gesehen haben.
//!
//! Gemeldet wurde: „Auch in der App GELESENE Nachrichten kommen als Push.“
//! Ursache: `notify_new_message` kannte nur Absender und Stummschaltung. Wer
//! den Chat in diesem Augenblick offen hatte, bekam die Mitteilung trotzdem
//! (der Service Worker zeigte und schloss sie), und wer sie in den ersten
//! Sekunden las, bekam sie, weil der Versand nicht wartete.
//!
//! Geprüft wird am Ausgang (`PushService::mitschneiden`), wem etwas ginge.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

use initiative_api::config::Config;
use initiative_api::push::Mitschnitt;
use initiative_api::services::notify::{chat_offen_melden, chat_zu_melden, noch_ungelesen};
use initiative_api::state::AppState;
use initiative_api::{app, MIGRATOR};

struct Probe {
    router: Router,
    state: AppState,
    push: Mitschnitt,
}

impl Drop for Probe {
    fn drop(&mut self) {
        let vorrat = self.state.pool.clone();
        tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(vorrat.close()));
    }
}

struct Konto {
    token: String,
    id: Uuid,
}

impl Probe {
    async fn call(
        &self,
        method: &str,
        uri: &str,
        token: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let builder = Request::builder()
            .method(method)
            .uri(uri)
            .header("authorization", format!("Bearer {token}"));
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

    async fn konto(&self, name: &str) -> Konto {
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/register")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({
                    "username": name,
                    "displayName": name,
                    "password": "richtigespasswort",
                }))
                .unwrap(),
            ))
            .unwrap();
        let response = self.router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        Konto {
            token: body["accessToken"].as_str().unwrap().to_string(),
            id: body["user"]["id"].as_str().unwrap().parse().unwrap(),
        }
    }

    /// Gruppe aus `a` (Gründer) und den übrigen.
    async fn gruppe(&self, a: &Konto, andere: &[&Konto]) -> String {
        let (status, chat) = self
            .call(
                "POST",
                "/api/v1/conversations",
                &a.token,
                Some(json!({
                    "type": "group",
                    "title": "Runde",
                    "memberIds": andere.iter().map(|k| k.id).collect::<Vec<_>>(),
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{chat}");
        chat["id"].as_str().unwrap().to_string()
    }

    async fn senden(&self, von: &Konto, chat: &str, text: &str) -> String {
        let (status, nachricht) = self
            .call(
                "POST",
                &format!("/api/v1/conversations/{chat}/messages"),
                &von.token,
                Some(json!({ "type": "text", "body": text })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{nachricht}");
        nachricht["id"].as_str().unwrap().to_string()
    }

    fn empfaenger(&self) -> Vec<Uuid> {
        self.push
            .lock()
            .unwrap()
            .iter()
            .map(|(id, _)| *id)
            .collect()
    }

    fn leeren(&self) {
        self.push.lock().unwrap().clear();
    }
}

async fn aufbauen() -> Option<Probe> {
    let url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;
    std::env::set_var("DATABASE_URL", &url);
    std::env::set_var("NODE_ENV", "test");
    std::env::set_var("JWT_SECRET", "test-secret-value-at-least-16-characters");
    std::env::set_var("REALTIME_BUS", "memory");
    std::env::set_var("DATABASE_POOL_MAX", "4");
    std::env::set_var("STORAGE_DRIVER", "local");
    std::env::set_var(
        "LOCAL_STORAGE_DIR",
        format!("./.data/pushnachricht-{}", Uuid::now_v7().simple()),
    );
    std::env::set_var("PUBLIC_API_URL", "http://localhost:8080");
    std::env::set_var("PUBLIC_APP_URL", "http://localhost:5173");

    let state = AppState::new(Config::from_env().expect("config"))
        .await
        .expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    let push = state.push.mitschneiden();
    Some(Probe {
        router: app::build(state.clone()),
        state,
        push,
    })
}

fn kurz() -> String {
    let voll = Uuid::now_v7().simple().to_string();
    voll[voll.len() - 10..].to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn push_geht_nicht_an_den_absender_und_nicht_an_wen_den_chat_offen_hat() {
    let Some(p) = aufbauen().await else { return };
    let (a, b, c) = (
        p.konto(&format!("pa{}", kurz())).await,
        p.konto(&format!("pb{}", kurz())).await,
        p.konto(&format!("pc{}", kurz())).await,
    );
    let chat = p.gruppe(&a, &[&b, &c]).await;
    let chat_id: Uuid = chat.parse().unwrap();

    // Ausgangslage: B und C bekommen, A (Absender) nicht.
    p.senden(&a, &chat, "eins").await;
    let mut ziele = p.empfaenger();
    ziele.sort();
    let mut erwartet = vec![b.id, c.id];
    erwartet.sort();
    assert_eq!(ziele, erwartet, "nur die anderen, nie der Absender");

    // B hat den Chat offen (eine Leitung meldet ihn): keine Mitteilung für B.
    p.leeren();
    let leitung = Uuid::now_v7();
    chat_offen_melden(&p.state.pool, leitung, b.id, chat_id).await;
    p.senden(&a, &chat, "zwei").await;
    assert_eq!(p.empfaenger(), vec![c.id], "B hat den Chat offen");

    // Verlässt B den Chat (Hintergrund / Chatliste), kommt sie wieder.
    p.leeren();
    chat_zu_melden(&p.state.pool, leitung).await;
    p.senden(&a, &chat, "drei").await;
    let mut ziele = p.empfaenger();
    ziele.sort();
    assert_eq!(ziele, erwartet, "B ist weg, B bekommt wieder");

    // Eine abgelaufene Meldung (eingefrorenes Gerät) zählt nicht.
    p.leeren();
    chat_offen_melden(&p.state.pool, leitung, b.id, chat_id).await;
    sqlx::query("update chat_offen set bis = now() - interval '1 second' where verbindung = $1")
        .bind(leitung)
        .execute(&p.state.pool)
        .await
        .unwrap();
    p.senden(&a, &chat, "vier").await;
    assert!(p.empfaenger().contains(&b.id), "abgelaufen zählt nicht");

    // Ein offener Chat ist nur der EINE: ein anderer Chat von B stört nicht.
    p.leeren();
    let anderer = p.gruppe(&a, &[&b]).await;
    chat_offen_melden(&p.state.pool, leitung, b.id, anderer.parse().unwrap()).await;
    sqlx::query("update chat_offen set bis = now() + interval '30 seconds'")
        .execute(&p.state.pool)
        .await
        .unwrap();
    p.senden(&a, &chat, "fuenf").await;
    assert!(p.empfaenger().contains(&b.id), "anderer Chat offen");
}

#[tokio::test(flavor = "multi_thread")]
async fn wer_die_nachricht_in_der_frist_liest_bekommt_keine_mitteilung() {
    let Some(p) = aufbauen().await else { return };
    p.state
        .push
        .verzoegerung_setzen(std::time::Duration::from_millis(600));
    let (a, b, c) = (
        p.konto(&format!("fa{}", kurz())).await,
        p.konto(&format!("fb{}", kurz())).await,
        p.konto(&format!("fc{}", kurz())).await,
    );
    let chat = p.gruppe(&a, &[&b, &c]).await;

    let id = p.senden(&a, &chat, "hallo").await;
    // Nichts geht sofort ab …
    assert!(p.empfaenger().is_empty(), "der Versand wartet die Frist ab");
    // … und B liest in der Frist.
    let (status, _) = p
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat}/read"),
            &b.token,
            Some(json!({ "messageId": id })),
        )
        .await;
    assert!(status.is_success(), "{status}");
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    assert_eq!(p.empfaenger(), vec![c.id], "B hat gelesen, nur C bekommt");
}

#[tokio::test(flavor = "multi_thread")]
async fn noch_ungelesen_kennt_lesestand_und_mitgliedschaft() {
    let Some(p) = aufbauen().await else { return };
    let (a, b) = (
        p.konto(&format!("na{}", kurz())).await,
        p.konto(&format!("nb{}", kurz())).await,
    );
    let chat = p.gruppe(&a, &[&b]).await;
    let chat_id: Uuid = chat.parse().unwrap();
    let eins: Uuid = p.senden(&a, &chat, "eins").await.parse().unwrap();
    let zwei: Uuid = p.senden(&a, &chat, "zwei").await.parse().unwrap();
    let pool = &p.state.pool;
    assert_eq!(
        noch_ungelesen(pool, chat_id, eins, &[b.id]).await,
        vec![b.id]
    );
    p.call(
        "POST",
        &format!("/api/v1/conversations/{chat}/read"),
        &b.token,
        Some(json!({ "messageId": zwei.to_string() })),
    )
    .await;
    assert!(noch_ungelesen(pool, chat_id, eins, &[b.id])
        .await
        .is_empty());
    assert!(noch_ungelesen(pool, chat_id, zwei, &[b.id])
        .await
        .is_empty());
    // Ein Fremder (kein Mitglied) ist nie ein Ziel.
    let c = p.konto(&format!("nc{}", kurz())).await;
    assert!(noch_ungelesen(pool, chat_id, zwei, &[c.id])
        .await
        .is_empty());
}
