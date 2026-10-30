//! Pressen gegen den Spiegel ist eine Übung OHNE Chat.
//!
//! Sie braucht niemanden zum Spielen, also gehört sie in keinen Chat:
//!
//!   * keine Karte (keine Nachricht) in irgendeinem Chat, keine Vorschau in der
//!     Chatliste, keine Mitteilung;
//!   * nur der Besitzer liest und spielt sie – ein Fremder bekommt 404 und
//!     sieht sie weder in der Liste noch im Echtzeitkanal;
//!   * ein älterer Client, der einen Chat mitschickt, bekommt trotzdem eine
//!     Übung ohne Karte;
//!   * Partien mit Gegner bleiben unverändert im Chat;
//!   * die nächste Übung räumt die vorige ab, das Konto zu löschen nimmt sie mit.
//!
//! Eigenes Postgres-Schema je Test, wie in `tests/pressen_sicht.rs`.

use std::sync::Arc;

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

const PASSWORT: &str = "richtigespasswort";

#[allow(dead_code)]
struct Probe {
    router: Router,
    state: AppState,
}

impl Drop for Probe {
    fn drop(&mut self) {
        let vorrat = self.state.pool.clone();
        tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(vorrat.close()));
    }
}

struct Konto {
    token: String,
    id: String,
}

impl Konto {
    fn uuid(&self) -> Uuid {
        self.id.parse().unwrap()
    }
}

#[allow(dead_code)]
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

    async fn konto(&self, name: &str) -> Konto {
        let (status, body) = self
            .call(
                "POST",
                "/api/v1/auth/register",
                None,
                Some(json!({ "username": name, "displayName": name, "password": PASSWORT })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        Konto {
            token: body["accessToken"].as_str().unwrap().to_string(),
            id: body["user"]["id"].as_str().unwrap().to_string(),
        }
    }

    /// Ein Chat: `einzel` = Einzelchat mit dem ersten der anderen, sonst Gruppe.
    async fn chat(&self, von: &Konto, andere: &[&Konto], einzel: bool) -> String {
        let ids: Vec<Uuid> = andere.iter().map(|k| k.uuid()).collect();
        let body = if einzel {
            json!({ "type": "direct", "memberIds": ids })
        } else {
            json!({ "type": "group", "title": "Runde", "memberIds": ids })
        };
        let (status, chat) = self
            .call(
                "POST",
                "/api/v1/conversations",
                Some(&von.token),
                Some(body),
            )
            .await;
        assert!(status.is_success(), "{chat}");
        chat["id"].as_str().unwrap().to_string()
    }

    /// Schreibt eine Textnachricht über die Schnittstelle; gibt ihre Kennung zurück.
    async fn schreibe(&self, wer: &Konto, chat: &str, text: &str) -> String {
        let (status, nachricht) = self
            .call(
                "POST",
                &format!("/api/v1/conversations/{chat}/messages"),
                Some(&wer.token),
                Some(json!({ "type": "text", "body": text })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{nachricht}");
        nachricht["id"].as_str().unwrap().to_string()
    }

    async fn sql(&self, anweisung: &str) {
        sqlx::query(anweisung)
            .execute(&self.state.pool)
            .await
            .unwrap_or_else(|fehler| panic!("{anweisung}: {fehler}"));
    }

    async fn zahl(&self, abfrage: &str) -> i64 {
        sqlx::query_scalar(abfrage)
            .fetch_one(&self.state.pool)
            .await
            .unwrap()
    }

    /// Wie viele Pressen-Partien es in diesem Chat gibt.
    async fn partien(&self, chat: &str) -> i64 {
        self.zahl(&format!(
            "select count(*) from game_sessions where conversation_id = '{chat}' and game_key = 'pressen'"
        ))
        .await
    }

    /// Die Spielenden der (einzigen oder jüngsten) Partie in Sitzreihenfolge.
    async fn spielende(&self, chat: &str) -> Vec<Uuid> {
        let zeile: Value = sqlx::query_scalar(&format!(
            "select players from game_sessions where conversation_id = '{chat}' order by created_at desc limit 1"
        ))
        .fetch_one(&self.state.pool)
        .await
        .unwrap();
        let mut sitze: Vec<(i64, Uuid)> = zeile
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                (
                    p["seat"].as_i64().unwrap(),
                    p["userId"].as_str().unwrap().parse().unwrap(),
                )
            })
            .collect();
        sitze.sort();
        sitze.into_iter().map(|(_, id)| id).collect()
    }

    /// Lässt den Aufruf `minuten` Minuten alt aussehen (Nachricht und Aufruf).
    async fn altern(&self, nachricht: &str, minuten: i64) {
        self.sql(&format!(
            "update messages set created_at = now() - interval '{minuten} minutes' where id = '{nachricht}'"
        ))
        .await;
        self.sql(&format!(
            "update bierjunge_aufrufe set erstellt_am = now() - interval '{minuten} minutes' where message_id = '{nachricht}'"
        ))
        .await;
    }
}

static AUFBAU: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn pool_fuer(url: &str, schema: &str) -> sqlx::PgPool {
    let fuer_pfad = schema.to_string();
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(5)
        .after_connect(move |verbindung, _| {
            let schema = fuer_pfad.clone();
            Box::pin(async move {
                sqlx::query(&format!("set search_path to {schema}"))
                    .execute(verbindung)
                    .await?;
                Ok(())
            })
        })
        .connect(url)
        .await
        .expect("Pool")
}

async fn aufbauen(name: &str) -> Option<Probe> {
    let url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;
    let schema = format!("uebungprobe_{name}");
    let config = {
        let _schloss = AUFBAU.lock().await;
        std::env::set_var("DATABASE_URL", &url);
        std::env::set_var("NODE_ENV", "test");
        std::env::set_var("JWT_SECRET", "test-secret-value-at-least-16-characters");
        std::env::set_var("REALTIME_BUS", "memory");
        std::env::set_var("RATE_LIMIT", "false");
        std::env::set_var("STORAGE_DRIVER", "local");
        std::env::set_var(
            "LOCAL_STORAGE_DIR",
            format!("./.data/uebung-{}", Uuid::now_v7().simple()),
        );
        std::env::set_var("PUBLIC_API_URL", "http://localhost:8080");
        std::env::set_var("PUBLIC_APP_URL", "http://localhost:5173");
        Arc::new(Config::from_env().expect("config"))
    };
    let vorbereiten = sqlx::PgPool::connect(&url).await.expect("Datenbank");
    sqlx::query(&format!("drop schema if exists {schema} cascade"))
        .execute(&vorbereiten)
        .await
        .expect("Schema verwerfen");
    sqlx::query(&format!("create schema {schema}"))
        .execute(&vorbereiten)
        .await
        .expect("Schema anlegen");
    vorbereiten.close().await;

    let pool = pool_fuer(&url, &schema).await;
    let state = AppState::from_pool(pool, config.clone())
        .await
        .expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    Some(Probe {
        router: app::build(state.clone()),
        state,
    })
}

struct Welt {
    a: Konto,
    b: Konto,
    c: Konto,
}

async fn welt(probe: &Probe) -> Welt {
    probe.konto("wurzel").await;
    Welt {
        a: probe.konto("anna").await,
        b: probe.konto("bodo").await,
        c: probe.konto("cleo").await,
    }
}

macro_rules! probe_oder_uebersprungen {
    ($name:expr) => {
        match aufbauen($name).await {
            Some(probe) => probe,
            None => {
                eprintln!("TEST_DATABASE_URL nicht gesetzt – übersprungen");
                return;
            }
        }
    };
}

const SESSIONS: &str = "/api/v1/games/sessions";

/// Anzahl der Karten (Nachrichten vom Typ `game`) im Chat.
async fn karten(probe: &Probe, chat: &str) -> i64 {
    probe
        .zahl(&format!(
            "select count(*) from messages where conversation_id = '{chat}' and type = 'game'"
        ))
        .await
}

fn lauf(runde: i64) -> Value {
    json!({
        "typ": "ergebnis", "runde": runde, "dauerMs": 13579, "verschuettetDezi": 246,
        "reaktionMs": 321, "vorzeitig": false, "verzoegerungMs": 0
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn eine_uebung_ohne_chat_hat_keine_karte_und_keinen_chat() {
    let probe = probe_oder_uebersprungen!("karte");
    let w = welt(&probe).await;
    let chat = probe.chat(&w.a, &[&w.b], true).await;
    let vorher = karten(&probe, &chat).await;

    let (status, uebung) = probe
        .call(
            "POST",
            SESSIONS,
            Some(&w.a.token),
            Some(json!({ "gameKey": "pressen", "opponentIds": [] })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{uebung}");
    assert!(uebung["conversationId"].is_null(), "{uebung}");
    assert!(uebung["messageId"].is_null(), "{uebung}");
    assert_eq!(uebung["status"], "active");
    assert_eq!(uebung["state"]["modus"], "spiegel");
    assert_eq!(uebung["players"].as_array().unwrap().len(), 1);

    // Keine Nachricht irgendwo, nichts in der Chatliste.
    assert_eq!(karten(&probe, &chat).await, vorher, "keine Karte im Chat");
    assert_eq!(
        probe
            .zahl("select count(*) from messages where type = 'game'")
            .await,
        0
    );
    let (_, chats) = probe
        .call("GET", "/api/v1/conversations", Some(&w.a.token), None)
        .await;
    assert!(
        !chats.to_string().contains(uebung["id"].as_str().unwrap()),
        "die Chatliste weiß nichts von der Übung: {chats}"
    );

    // Der Besitzer sieht sie in seiner Liste und kann sie spielen.
    let id = uebung["id"].as_str().unwrap();
    let (status, liste) = probe.call("GET", SESSIONS, Some(&w.a.token), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(liste["items"].as_array().unwrap().len(), 1, "{liste}");
    let (status, nach) = probe
        .call(
            "POST",
            &format!("{SESSIONS}/{id}/moves"),
            Some(&w.a.token),
            Some(json!({ "move": { "typ": "start", "art": "asynchron" }, "version": uebung["version"] })),
        )
        .await;
    // Ob der Start-Zug im Spiegel überhaupt gilt, entscheidet die Regel – hier
    // zählt nur, dass der Besitzer ankommt und nicht am Zugriff scheitert.
    assert_ne!(status, StatusCode::FORBIDDEN, "{nach}");
    assert_ne!(status, StatusCode::NOT_FOUND, "{nach}");

    // Mit einem Chat-Filter taucht sie nicht auf.
    let (_, gefiltert) = probe
        .call(
            "GET",
            &format!("{SESSIONS}?conversationId={chat}"),
            Some(&w.a.token),
            None,
        )
        .await;
    assert!(
        gefiltert["items"].as_array().unwrap().is_empty(),
        "{gefiltert}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn nur_der_besitzer_liest_und_spielt_die_uebung() {
    let probe = probe_oder_uebersprungen!("besitzer");
    let w = welt(&probe).await;
    let chat = probe.chat(&w.a, &[&w.b], true).await;
    let (_, uebung) = probe
        .call(
            "POST",
            SESSIONS,
            Some(&w.a.token),
            Some(json!({ "gameKey": "pressen" })),
        )
        .await;
    let id = uebung["id"].as_str().unwrap();

    let (_, mut bodo_hoert, _) = {
        let h = probe.state.hub.register(w.b.uuid());
        (h.0, h.1, h.2)
    };

    // Bodo teilt einen Einzelchat mit Anna – das öffnet ihm nichts.
    for (methode, pfad, body) in [
        ("GET", format!("{SESSIONS}/{id}"), None),
        ("POST", format!("{SESSIONS}/{id}/join"), None),
        (
            "POST",
            format!("{SESSIONS}/{id}/moves"),
            Some(json!({ "move": lauf(1) })),
        ),
        ("POST", format!("{SESSIONS}/{id}/abort"), None),
        ("POST", format!("{SESSIONS}/{id}/rematch"), None),
    ] {
        let (status, antwort) = probe.call(methode, &pfad, Some(&w.b.token), body).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{methode} {pfad}: {antwort}");
    }
    let (_, liste) = probe.call("GET", SESSIONS, Some(&w.b.token), None).await;
    assert!(liste["items"].as_array().unwrap().is_empty(), "{liste}");
    let (_, chatliste) = probe
        .call(
            "GET",
            &format!("{SESSIONS}?conversationId={chat}"),
            Some(&w.b.token),
            None,
        )
        .await;
    assert!(chatliste["items"].as_array().unwrap().is_empty());

    // Ohne Anmeldung gar nichts.
    let (status, _) = probe
        .call("GET", &format!("{SESSIONS}/{id}"), None, None)
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Anna spielt weiter (Zug, Aufgeben); Bodo hört davon nichts.
    let (status, _) = probe
        .call(
            "POST",
            &format!("{SESSIONS}/{id}/abort"),
            Some(&w.a.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let mut gehoert = Vec::new();
    while let Ok(frame) = bodo_hoert.try_recv() {
        gehoert.push(frame);
    }
    assert!(
        gehoert.iter().all(|f| !f.contains(id)),
        "Bodo erfuhr von fremder Übung: {gehoert:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn ein_alter_client_mit_chat_bekommt_trotzdem_eine_uebung_ohne_karte() {
    let probe = probe_oder_uebersprungen!("alterclient");
    let w = welt(&probe).await;
    let chat = probe.chat(&w.a, &[&w.b, &w.c], false).await;

    // Gruppe, keine Mitspielenden gewählt: früher „Spiegel im Chat“.
    let (status, uebung) = probe
        .call(
            "POST",
            SESSIONS,
            Some(&w.a.token),
            Some(json!({ "conversationId": chat, "gameKey": "pressen", "opponentIds": [] })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{uebung}");
    assert!(uebung["conversationId"].is_null(), "{uebung}");
    assert_eq!(karten(&probe, &chat).await, 0);
    let (status, _) = probe
        .call(
            "GET",
            &format!("{SESSIONS}/{}", uebung["id"].as_str().unwrap()),
            Some(&w.c.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Ein Duell bleibt eine Karte im Chat – mit Chat und Gegner wie bisher.
    let (status, duell) = probe
        .call(
            "POST",
            SESSIONS,
            Some(&w.a.token),
            Some(json!({ "conversationId": chat, "gameKey": "pressen", "opponentIds": [w.b.uuid()] })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{duell}");
    assert_eq!(duell["conversationId"], chat);
    assert_eq!(karten(&probe, &chat).await, 1);

    // Spiele, die zwei brauchen, gibt es nicht ohne Chat; ohne Chat und mit Gegner auch nicht.
    let (status, _) = probe
        .call(
            "POST",
            SESSIONS,
            Some(&w.a.token),
            Some(json!({ "gameKey": "tic-tac-toe" })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = probe
        .call(
            "POST",
            SESSIONS,
            Some(&w.a.token),
            Some(json!({ "gameKey": "pressen", "opponentIds": [w.b.uuid()] })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test(flavor = "multi_thread")]
async fn die_naechste_uebung_raeumt_die_vorige_ab_und_das_konto_nimmt_sie_mit() {
    let probe = probe_oder_uebersprungen!("aufraeumen");
    let w = welt(&probe).await;

    let (_, erste) = probe
        .call(
            "POST",
            SESSIONS,
            Some(&w.a.token),
            Some(json!({ "gameKey": "pressen" })),
        )
        .await;
    let (_, zweite) = probe
        .call(
            "POST",
            SESSIONS,
            Some(&w.a.token),
            Some(json!({ "gameKey": "pressen" })),
        )
        .await;
    assert_ne!(erste["id"], zweite["id"]);
    assert_eq!(
        probe
            .zahl(&format!(
                "select count(*) from game_sessions where besitzer_id = '{}'",
                w.a.id
            ))
            .await,
        1,
        "es bleibt eine Übung"
    );
    let (status, _) = probe
        .call(
            "GET",
            &format!("{SESSIONS}/{}", erste["id"].as_str().unwrap()),
            Some(&w.a.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Revanche einer Übung ist wieder eine Übung ohne Chat.
    let (status, neu) = probe
        .call(
            "POST",
            &format!("{SESSIONS}/{}/rematch", zweite["id"].as_str().unwrap()),
            Some(&w.a.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{neu}");
    assert!(neu["conversationId"].is_null());

    // Konto löschen: die Übung verschwindet mit ihm.
    probe
        .sql(&format!("delete from users where id = '{}'", w.a.id))
        .await;
    assert_eq!(
        probe.zahl("select count(*) from game_sessions").await,
        0,
        "ohne Besitzer bleibt keine Übung liegen"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn eine_partie_braucht_chat_oder_besitzer() {
    let probe = probe_oder_uebersprungen!("pruefung");
    let w = welt(&probe).await;
    let fehler = sqlx::query(
        "insert into game_sessions (id, game_key, status, created_by)
         values ($1, 'pressen', 'active', $2)",
    )
    .bind(Uuid::now_v7())
    .bind(w.a.uuid())
    .execute(&probe.state.pool)
    .await;
    assert!(
        fehler.is_err(),
        "weder Chat noch Besitzer darf es nicht geben"
    );
}
