//! Die Chatliste rechnet richtig – und schnell.
//!
//! Drei Abfragen der Chatliste (letzte Nachricht, Ungelesene, verdeckter
//! Verlauf) lasen bei jedem Laden den GANZEN Verlauf aller Chats: bei 300
//! Chats mit je 2000 Nachrichten zusammen 3,3 s. Umgeschrieben auf
//! Indexsuchen (und Migration 0029) sind es gut 10 ms. Dieser Test hält fest,
//! dass dabei nichts anderes herauskommt: gelöschte Nachrichten, eigene
//! Nachrichten, fehlendes Lesezeichen und die Verlaufsgrenze.

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

impl Probe {
    async fn eintrag(&self, token: &str, chat: &str) -> Value {
        let (status, liste) = self
            .call("GET", "/api/v1/conversations", Some(token), None)
            .await;
        assert_eq!(status, StatusCode::OK, "{liste}");
        let eintraege = liste
            .as_array()
            .cloned()
            .or_else(|| liste["items"].as_array().cloned())
            .expect("Liste");
        eintraege
            .into_iter()
            .find(|eintrag| eintrag["id"] == chat)
            .expect("Chat in der Liste")
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn letzte_nachricht_ungelesene_und_grenze_stimmen() {
    let Some(probe) = aufbauen_mit("chatliste").await else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – übersprungen");
        return;
    };
    let n = kurz();
    let (anna, anna_id) = probe.konto(&format!("anna{n}")).await;
    let (bodo, bodo_id) = probe.konto(&format!("bodo{n}")).await;
    let (cleo, cleo_id) = probe.konto(&format!("cleo{n}")).await;
    let chat = probe.gruppe(&anna, &[&bodo_id]).await;

    // Ohne Lesezeichen zählt alles Fremde, das Eigene nie.
    probe.senden(&anna, &chat, "von anna").await;
    let b1 = probe.senden(&bodo, &chat, "eins").await;
    let _b2 = probe.senden(&bodo, &chat, "zwei").await;
    let b3 = probe.senden(&bodo, &chat, "drei").await;
    let sicht = probe.eintrag(&anna, &chat).await;
    assert_eq!(sicht["unreadCount"], 3, "{sicht}");
    assert_eq!(sicht["lastMessage"]["id"], b3.as_str(), "{sicht}");
    // Für Bodo: Annas Nachricht und die Systemzeile „Gruppe angelegt“.
    assert_eq!(probe.eintrag(&bodo, &chat).await["unreadCount"], 2);

    // Mit Lesezeichen zählt nur, was danach kam.
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat}/read"),
            Some(&anna),
            Some(json!({ "messageId": b1 })),
        )
        .await;
    assert!(status.is_success(), "{status}");
    assert_eq!(probe.eintrag(&anna, &chat).await["unreadCount"], 2);

    // Gelöschtes zählt nicht und ist nicht die letzte Nachricht.
    let (status, _) = probe
        .call(
            "DELETE",
            &format!("/api/v1/messages/{b3}"),
            Some(&bodo),
            None,
        )
        .await;
    assert!(status.is_success(), "{status}");
    let sicht = probe.eintrag(&anna, &chat).await;
    assert_eq!(sicht["unreadCount"], 1, "{sicht}");
    assert_eq!(sicht["lastMessage"]["body"], "zwei", "{sicht}");
    assert_eq!(sicht["verdeckterVerlauf"], false, "die Gründerin: {sicht}");

    // Wer später kommt, sieht von vorher weder Vorschau noch Ungelesenes –
    // nur die Systemzeile seines eigenen Beitritts – wohl aber, dass etwas
    // verdeckt ist.
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat}/members"),
            Some(&anna),
            Some(json!({ "memberIds": [cleo_id] })),
        )
        .await;
    assert!(status.is_success(), "{status}");
    let sicht = probe.eintrag(&cleo, &chat).await;
    assert_eq!(sicht["unreadCount"], 1, "{sicht}");
    assert_eq!(sicht["lastMessage"]["type"], "system", "{sicht}");
    assert_eq!(sicht["verdeckterVerlauf"], true, "{sicht}");

    let neu = probe.senden(&bodo, &chat, "willkommen").await;
    let sicht = probe.eintrag(&cleo, &chat).await;
    assert_eq!(sicht["unreadCount"], 2, "{sicht}");
    assert_eq!(sicht["lastMessage"]["id"], neu.as_str(), "{sicht}");
    let _ = (anna_id, probe.state.pool.size());
}

/// Die Abfragen der Chatliste und des Verlaufsantrags finden ihren Index.
///
/// Auf einer Testdatenbank mit wenig Zeilen wählt der Planer gern die
/// Tabellendurchsicht; `enable_seqscan = off` zwingt ihn, zu zeigen, ob ein
/// passender Index da ist. Ohne Migration 0029 bleibt nur der Filter auf
/// `created_at` – ohne Indexgrenze.
#[tokio::test(flavor = "multi_thread")]
async fn die_grenzfrage_hat_einen_index() {
    let Some(probe) = aufbauen_mit("chatliste-index").await else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – übersprungen");
        return;
    };
    let mut verbindung = probe.state.pool.acquire().await.expect("Verbindung");
    sqlx::query("set enable_seqscan = off")
        .execute(&mut *verbindung)
        .await
        .unwrap();
    sqlx::query("set enable_bitmapscan = off")
        .execute(&mut *verbindung)
        .await
        .unwrap();
    let plan: Vec<String> = sqlx::query_scalar(
        "explain select exists (
           select 1 from messages
            where conversation_id = $1 and deleted_at is null and created_at < $2)",
    )
    .bind(Uuid::now_v7())
    .bind(chrono::Utc::now())
    .fetch_all(&mut *verbindung)
    .await
    .unwrap();
    sqlx::query("reset all")
        .execute(&mut *verbindung)
        .await
        .unwrap();
    let plan = plan.join("\n");
    assert!(
        plan.contains("messages_conversation_created_idx") && plan.contains("created_at <"),
        "kein Index für (conversation_id, created_at):\n{plan}"
    );
}
