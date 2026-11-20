//! Atomarität der Speichervorgänge – mit Fehlerinjektion.
//!
//! Jeder Test legt einen Auslöser an, der den ZWEITEN (oder letzten) Schritt
//! eines Vorgangs scheitern lässt – nur für die Zeilen dieses Tests, damit
//! parallel laufende Tests nichts davon merken. Danach darf vom ersten
//! Schritt nichts übrig sein, und niemand darf über Echtzeit von etwas
//! erfahren haben, das nie festgeschrieben wurde.
//!
//! Und zwei Wettläufe: dieselbe Nachricht (gleicher `clientId`) zweimal
//! zugleich, dieselbe Umfrage zweimal zugleich in denselben Chat.

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

/// Ein Auslöser, der jede passende Zeile mit einem Fehler abweist.
///
/// `bedingung` ist SQL über `new`; der Name ist je Test eindeutig, und
/// [`Stolperdraht::weg`] räumt ihn wieder ab.
struct Stolperdraht {
    pool: sqlx::PgPool,
    tabelle: &'static str,
    name: String,
}

impl Stolperdraht {
    async fn legen(
        pool: &sqlx::PgPool,
        tabelle: &'static str,
        wann: &str,
        bedingung: &str,
    ) -> Self {
        let name = format!("stolpern_{}", Uuid::now_v7().simple());
        sqlx::query(&format!(
            "create function {name}() returns trigger language plpgsql as $$
             begin
               if {bedingung} then
                 raise exception 'Fehlerinjektion: {name}';
               end if;
               return new;
             end $$"
        ))
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(&format!(
            "create trigger {name} {wann} on {tabelle}
               for each row execute function {name}()"
        ))
        .execute(pool)
        .await
        .unwrap();
        Self {
            pool: pool.clone(),
            tabelle,
            name,
        }
    }

    async fn weg(self) {
        sqlx::query(&format!(
            "drop trigger if exists {} on {}",
            self.name, self.tabelle
        ))
        .execute(&self.pool)
        .await
        .unwrap();
        sqlx::query(&format!("drop function if exists {}()", self.name))
            .execute(&self.pool)
            .await
            .unwrap();
    }
}

fn eingang(empfang: &mut tokio::sync::mpsc::Receiver<String>) -> Vec<Value> {
    let mut alles = Vec::new();
    while let Ok(rahmen) = empfang.try_recv() {
        if let Ok(wert) = serde_json::from_str::<Value>(&rahmen) {
            alles.push(wert);
        }
    }
    alles
}

fn anzahl_vom_typ(rahmen: &[Value], typ: &str) -> usize {
    rahmen.iter().filter(|r| r["type"] == typ).count()
}

async fn anhang_anlegen(pool: &sqlx::PgPool, besitzer: &str, status: &str) -> Uuid {
    let id = Uuid::now_v7();
    sqlx::query(
        "insert into attachments (id, uploader_id, kind, mime, size, storage_key, status)
         values ($1, $2, 'image', 'image/png', 10, $3, $4)",
    )
    .bind(id)
    .bind(Uuid::parse_str(besitzer).unwrap())
    .bind(format!("probe/atomar/{id}.png"))
    .bind(status)
    .execute(pool)
    .await
    .unwrap();
    id
}

macro_rules! probe {
    ($name:expr) => {
        match aufbauen_mit($name).await {
            Some(probe) => probe,
            None => {
                eprintln!("TEST_DATABASE_URL nicht gesetzt – übersprungen");
                return;
            }
        }
    };
}

/// Nachricht mit Anhang: Scheitert der letzte Schritt (Chat-Zeitstempel),
/// steht weder die Nachricht noch die Bindung des Anhangs – und der
/// Empfänger hat nichts gehört. Der Neuversuch mit demselben `clientId`
/// liefert dann genau EINE vollständige Nachricht, ein dritter dieselbe.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn nachricht_mit_anhang_ganz_oder_gar_nicht() {
    let probe = probe!("atomar-nachricht");
    let n = kurz();
    let (anna, anna_id) = probe.konto(&format!("anna{n}")).await;
    let (_, bert_id) = probe.konto(&format!("bert{n}")).await;
    let chat = probe.gruppe(&anna, &[&bert_id]).await;
    let anhang = anhang_anlegen(&probe.state.pool, &anna_id, "ready").await;
    let (_, ausgang, _) = probe.state.hub.register(Uuid::parse_str(&bert_id).unwrap());
    let mut bert_hoert = ausgang.empfang;
    let _ = eingang(&mut bert_hoert);

    let draht = Stolperdraht::legen(
        &probe.state.pool,
        "conversations",
        "before update",
        &format!("new.id = '{chat}'::uuid"),
    )
    .await;
    let client_id = format!("atomar-{n}");
    let sende_pfad = format!("/api/v1/conversations/{chat}/messages");
    let senden = || {
        probe.call(
            "POST",
            &sende_pfad,
            Some(&anna),
            Some(json!({
                "type": "image",
                "body": "Foto",
                "attachmentIds": [anhang],
                "clientId": client_id,
            })),
        )
    };
    let (status, _) = senden().await;
    assert!(
        status.is_server_error(),
        "die Injektion muss greifen: {status}"
    );

    let (nachrichten,): (i64,) = sqlx::query_as(
        "select count(*) from messages where conversation_id = $1 and client_id = $2",
    )
    .bind(Uuid::parse_str(&chat).unwrap())
    .bind(&client_id)
    .fetch_one(&probe.state.pool)
    .await
    .unwrap();
    assert_eq!(nachrichten, 0, "keine halbe Nachricht");
    let (gebunden,): (Option<Uuid>,) =
        sqlx::query_as("select message_id from attachments where id = $1")
            .bind(anhang)
            .fetch_one(&probe.state.pool)
            .await
            .unwrap();
    assert_eq!(gebunden, None, "der Anhang bleibt frei");
    assert_eq!(
        anzahl_vom_typ(&eingang(&mut bert_hoert), "message.new"),
        0,
        "nichts melden, was nie festgeschrieben wurde"
    );

    draht.weg().await;
    let (status, erste) = senden().await;
    assert_eq!(status, StatusCode::CREATED, "{erste}");
    assert_eq!(erste["attachments"].as_array().unwrap().len(), 1, "{erste}");
    let (status, zweite) = senden().await;
    assert_eq!(status, StatusCode::CREATED, "{zweite}");
    assert_eq!(zweite["id"], erste["id"], "dieselbe Nachricht zurück");
    assert_eq!(zweite["attachments"].as_array().unwrap().len(), 1);
    assert_eq!(
        anzahl_vom_typ(&eingang(&mut bert_hoert), "message.new"),
        1,
        "genau einmal gemeldet"
    );
}

/// Ein Anhang, der noch hochlädt, macht keine Nachricht – und wird nicht
/// fälschlich auf `ready` gesetzt.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unfertiger_anhang_scheitert_ganz() {
    let probe = probe!("atomar-unfertig");
    let n = kurz();
    let (anna, anna_id) = probe.konto(&format!("anna{n}")).await;
    let (_, bert_id) = probe.konto(&format!("bert{n}")).await;
    let chat = probe.gruppe(&anna, &[&bert_id]).await;
    let fertig = anhang_anlegen(&probe.state.pool, &anna_id, "ready").await;
    let unfertig = anhang_anlegen(&probe.state.pool, &anna_id, "pending").await;

    let (status, body) = probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat}/messages"),
            Some(&anna),
            Some(json!({
                "type": "image",
                "attachmentIds": [fertig, unfertig],
                "clientId": format!("unfertig-{n}"),
            })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let zeilen: Vec<(String, Option<Uuid>)> =
        sqlx::query_as("select status, message_id from attachments where id = any($1) order by id")
            .bind(vec![fertig, unfertig])
            .fetch_all(&probe.state.pool)
            .await
            .unwrap();
    assert_eq!(
        zeilen,
        vec![("ready".to_string(), None), ("pending".to_string(), None)],
        "auch der fertige Anhang bleibt frei"
    );
}

/// Dieselbe Nachricht zweimal im selben Augenblick (zwei Tabs, Neuversuch):
/// eine Zeile, beide Antworten nennen sie.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gleicher_schluessel_gleichzeitig_gibt_eine_nachricht() {
    let probe = probe!("atomar-gleichzeitig");
    let n = kurz();
    let (anna, anna_id) = probe.konto(&format!("anna{n}")).await;
    let (_, bert_id) = probe.konto(&format!("bert{n}")).await;
    let chat = probe.gruppe(&anna, &[&bert_id]).await;
    let anhang = anhang_anlegen(&probe.state.pool, &anna_id, "ready").await;
    let koerper = json!({
        "type": "image",
        "attachmentIds": [anhang],
        "clientId": format!("zwilling-{n}"),
    });
    let pfad = format!("/api/v1/conversations/{chat}/messages");
    let (a, b) = tokio::join!(
        probe.call("POST", &pfad, Some(&anna), Some(koerper.clone())),
        probe.call("POST", &pfad, Some(&anna), Some(koerper.clone())),
    );
    assert_eq!(a.0, StatusCode::CREATED, "{}", a.1);
    assert_eq!(b.0, StatusCode::CREATED, "{}", b.1);
    assert_eq!(a.1["id"], b.1["id"]);
    assert_eq!(b.1["attachments"].as_array().unwrap().len(), 1, "{}", b.1);
    let (zeilen,): (i64,) = sqlx::query_as(
        "select count(*) from messages where conversation_id = $1 and type = 'image'",
    )
    .bind(Uuid::parse_str(&chat).unwrap())
    .fetch_one(&probe.state.pool)
    .await
    .unwrap();
    assert_eq!(zeilen, 1);
}

/// Umfrage und Karte: Scheitert die Karte, gibt es auch die Umfrage nicht.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn umfrage_ohne_karte_gibt_es_nicht() {
    let probe = probe!("atomar-umfrage");
    let n = kurz();
    let (anna, _) = probe.konto(&format!("anna{n}")).await;
    let (_, bert_id) = probe.konto(&format!("bert{n}")).await;
    let chat = probe.gruppe(&anna, &[&bert_id]).await;
    let draht = Stolperdraht::legen(
        &probe.state.pool,
        "messages",
        "before insert",
        &format!("new.conversation_id = '{chat}'::uuid and new.type = 'poll'"),
    )
    .await;
    let (status, _) = probe
        .call(
            "POST",
            "/api/v1/polls",
            Some(&anna),
            Some(json!({
                "conversationId": chat,
                "question": "Pizza?",
                "options": [{ "label": "Ja" }, { "label": "Nein" }],
            })),
        )
        .await;
    draht.weg().await;
    assert!(status.is_server_error(), "{status}");
    let (umfragen,): (i64,) =
        sqlx::query_as("select count(*) from polls where conversation_id = $1")
            .bind(Uuid::parse_str(&chat).unwrap())
            .fetch_one(&probe.state.pool)
            .await
            .unwrap();
    assert_eq!(umfragen, 0, "keine Umfrage ohne Karte");
}

/// Eine Gruppe ohne ihre Systemzeile gibt es nicht – und Mitglieder ohne
/// „… wurde hinzugefügt“ auch nicht.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gruppe_und_mitglieder_nur_mit_systemzeile() {
    let probe = probe!("atomar-gruppe");
    let n = kurz();
    let (anna, anna_id) = probe.konto(&format!("anna{n}")).await;
    let (_, bert_id) = probe.konto(&format!("bert{n}")).await;
    let (_, cleo_id) = probe.konto(&format!("cleo{n}")).await;

    let draht = Stolperdraht::legen(
        &probe.state.pool,
        "messages",
        "before insert",
        &format!("new.type = 'system' and new.sender_id = '{anna_id}'::uuid"),
    )
    .await;
    let (status, _) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&anna),
            Some(json!({ "type": "group", "title": "Runde", "memberIds": [bert_id] })),
        )
        .await;
    assert!(status.is_server_error(), "{status}");
    let (gruppen,): (i64,) =
        sqlx::query_as("select count(*) from conversations where created_by = $1")
            .bind(Uuid::parse_str(&anna_id).unwrap())
            .fetch_one(&probe.state.pool)
            .await
            .unwrap();
    assert_eq!(gruppen, 0, "keine Gruppe ohne Gründungszeile");
    draht.weg().await;

    let chat = probe.gruppe(&anna, &[&bert_id]).await;
    let draht = Stolperdraht::legen(
        &probe.state.pool,
        "messages",
        "before insert",
        &format!("new.conversation_id = '{chat}'::uuid and new.type = 'system'"),
    )
    .await;
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat}/members"),
            Some(&anna),
            Some(json!({ "memberIds": [cleo_id] })),
        )
        .await;
    draht.weg().await;
    assert!(status.is_server_error(), "{status}");
    let (drin,): (bool,) = sqlx::query_as(
        "select exists (select 1 from conversation_members
                         where conversation_id = $1 and user_id = $2)",
    )
    .bind(Uuid::parse_str(&chat).unwrap())
    .bind(Uuid::parse_str(&cleo_id).unwrap())
    .fetch_one(&probe.state.pool)
    .await
    .unwrap();
    assert!(!drin, "kein Mitglied ohne Systemzeile");
}

/// Eine Partie im Chat gibt es nur mit ihrer Karte.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn partie_ohne_karte_gibt_es_nicht() {
    let probe = probe!("atomar-partie");
    let n = kurz();
    let (anna, _) = probe.konto(&format!("anna{n}")).await;
    let (_, bert_id) = probe.konto(&format!("bert{n}")).await;
    let chat = probe.gruppe(&anna, &[&bert_id]).await;
    let draht = Stolperdraht::legen(
        &probe.state.pool,
        "messages",
        "before insert",
        &format!("new.conversation_id = '{chat}'::uuid and new.type = 'game'"),
    )
    .await;
    let (status, body) = probe
        .call(
            "POST",
            "/api/v1/games/sessions",
            Some(&anna),
            Some(json!({ "conversationId": chat, "gameKey": "pressen", "opponentIds": [bert_id] })),
        )
        .await;
    draht.weg().await;
    assert!(status.is_server_error(), "{status} {body}");
    let (partien,): (i64,) =
        sqlx::query_as("select count(*) from game_sessions where conversation_id = $1")
            .bind(Uuid::parse_str(&chat).unwrap())
            .fetch_one(&probe.state.pool)
            .await
            .unwrap();
    assert_eq!(partien, 0, "keine Partie ohne Karte");
}

/// Dieselbe Umfrage zweimal zugleich in denselben Chat: ein Auftritt, eine
/// Karte.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn umfrage_zweimal_zugleich_platzieren_gibt_eine_karte() {
    let probe = probe!("atomar-platz");
    let n = kurz();
    let (anna, _) = probe.konto(&format!("anna{n}")).await;
    let (_, bert_id) = probe.konto(&format!("bert{n}")).await;
    let ursprung = probe.gruppe(&anna, &[&bert_id]).await;
    let ziel = probe.gruppe(&anna, &[&bert_id]).await;
    let (status, umfrage) = probe
        .call(
            "POST",
            "/api/v1/polls",
            Some(&anna),
            Some(json!({
                "conversationId": ursprung,
                "question": "Wann?",
                "options": [{ "label": "Mo" }, { "label": "Di" }],
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{umfrage}");
    let id = umfrage["id"].as_str().unwrap();
    let pfad = format!("/api/v1/polls/{id}/placements");
    let koerper = json!({ "conversationId": ziel });
    let (a, b) = tokio::join!(
        probe.call("POST", &pfad, Some(&anna), Some(koerper.clone())),
        probe.call("POST", &pfad, Some(&anna), Some(koerper.clone())),
    );
    assert_eq!(a.0, StatusCode::CREATED, "{}", a.1);
    assert_eq!(b.0, StatusCode::CREATED, "{}", b.1);
    let (karten,): (i64,) = sqlx::query_as(
        "select count(*) from messages where conversation_id = $1 and type = 'poll'",
    )
    .bind(Uuid::parse_str(&ziel).unwrap())
    .fetch_one(&probe.state.pool)
    .await
    .unwrap();
    assert_eq!(karten, 1, "genau eine Karte im Ziel");
    let (auftritte,): (i64,) =
        sqlx::query_as("select count(*) from poll_placements where conversation_id = $1")
            .bind(Uuid::parse_str(&ziel).unwrap())
            .fetch_one(&probe.state.pool)
            .await
            .unwrap();
    assert_eq!(auftritte, 1);
}

/// Bearbeiten nach „für alle löschen“ schreibt den Text nicht zurück, und ein
/// zweites Löschen ist folgenlos.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bearbeiten_und_loeschen_sind_wiederholbar() {
    let probe = probe!("atomar-bearbeiten");
    let n = kurz();
    let (anna, _) = probe.konto(&format!("anna{n}")).await;
    let (_, bert_id) = probe.konto(&format!("bert{n}")).await;
    let chat = probe.gruppe(&anna, &[&bert_id]).await;
    let id = probe.senden(&anna, &chat, "Hallo").await;

    let nachricht_pfad = format!("/api/v1/messages/{id}");
    let bearbeiten = || {
        probe.call(
            "PATCH",
            &nachricht_pfad,
            Some(&anna),
            Some(json!({ "body": "Hallo!" })),
        )
    };
    let (status, erste) = bearbeiten().await;
    assert_eq!(status, StatusCode::OK, "{erste}");
    let (status, zweite) = bearbeiten().await;
    assert_eq!(status, StatusCode::OK, "{zweite}");
    assert_eq!(
        zweite["editedAt"], erste["editedAt"],
        "Neuversuch ändert nichts"
    );

    let loeschen = || probe.call("DELETE", &nachricht_pfad, Some(&anna), None);
    assert_eq!(loeschen().await.0, StatusCode::NO_CONTENT);
    let (geloescht_am,): (Option<chrono::DateTime<chrono::Utc>>,) =
        sqlx::query_as("select deleted_at from messages where id = $1")
            .bind(Uuid::parse_str(&id).unwrap())
            .fetch_one(&probe.state.pool)
            .await
            .unwrap();
    assert_eq!(loeschen().await.0, StatusCode::NO_CONTENT);
    let (danach,): (Option<chrono::DateTime<chrono::Utc>>,) =
        sqlx::query_as("select deleted_at from messages where id = $1")
            .bind(Uuid::parse_str(&id).unwrap())
            .fetch_one(&probe.state.pool)
            .await
            .unwrap();
    assert_eq!(geloescht_am, danach, "zweites Löschen ist folgenlos");

    let (status, _) = bearbeiten().await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (text,): (Option<String>,) = sqlx::query_as("select body from messages where id = $1")
        .bind(Uuid::parse_str(&id).unwrap())
        .fetch_one(&probe.state.pool)
        .await
        .unwrap();
    assert_eq!(text, None);
}
