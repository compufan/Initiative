//! Pressen: Wer sieht wessen Ergebnis? Bis die Runde entschieden ist, nur das
//! eigene – auf JEDEM Weg, auf dem der Server eine Partie ausliefert:
//! Abfrage, Liste, Nachrichtenliste (die Karte im Chat), Antwort auf den
//! eigenen Zug, Echtzeitereignisse (`game.updated`, `message.new/updated`).
//!
//! Dazu: das Strichmännchen eines Kontos (gespeichert in den Einstellungen,
//! geprüft mit Grenzen, für die Mitspielenden in der Partie sichtbar).
//!
//! Eigenes Postgres-Schema je Test, wie in `tests/vorab.rs`.

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
    let schema = format!("sichtprobe_{name}");
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
            format!("./.data/bierjunge-{}", Uuid::now_v7().simple()),
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

/// Ein Lauf mit Zahlen, die sich im Text leicht wiederfinden lassen.
fn lauf(runde: i64) -> Value {
    json!({
        "typ": "ergebnis", "runde": runde, "dauerMs": 13579, "verschuettetDezi": 246,
        "reaktionMs": 321, "vorzeitig": false, "verzoegerungMs": 0
    })
}

const SPUR: [&str; 3] = ["13579", "\"verschuettetDezi\":246", "\"reaktionMs\":321"];

fn enthaelt_spur(wert: &Value) -> bool {
    let text = wert.to_string();
    SPUR.iter().any(|s| text.contains(s))
}

/// Alle Wege, auf denen `wer` die Partie zu sehen bekommt: Abfrage, Liste, Karte im Chat.
async fn sichten(
    probe: &Probe,
    wer: &Konto,
    chat: &str,
    partie: &str,
) -> Vec<(&'static str, Value)> {
    let (_, einzeln) = probe
        .call(
            "GET",
            &format!("/api/v1/games/sessions/{partie}"),
            Some(&wer.token),
            None,
        )
        .await;
    let (_, liste) = probe
        .call(
            "GET",
            &format!("/api/v1/games/sessions?conversationId={chat}"),
            Some(&wer.token),
            None,
        )
        .await;
    let (_, nachrichten) = probe
        .call(
            "GET",
            &format!("/api/v1/conversations/{chat}/messages"),
            Some(&wer.token),
            None,
        )
        .await;
    let karte = nachrichten["items"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|m| m["type"] == "game")
        .cloned()
        .unwrap_or(Value::Null);
    vec![
        ("Abfrage", einzeln),
        ("Liste", liste),
        ("Chat-Karte", karte["game"].clone()),
    ]
}

/// Liest alles, was beim Hörer bisher angekommen ist.
fn gehoert(empfang: &mut tokio::sync::mpsc::Receiver<String>) -> Vec<Value> {
    let mut frames = Vec::new();
    while let Ok(frame) = empfang.try_recv() {
        frames.push(serde_json::from_str(&frame).unwrap_or(Value::Null));
    }
    frames
}

#[tokio::test(flavor = "multi_thread")]
async fn fremde_ergebnisse_stehen_vor_rundenende_in_keinem_ausgelieferten_stand() {
    let probe = probe_oder_uebersprungen!("sicht");
    let w = welt(&probe).await;
    let chat = probe.chat(&w.a, &[&w.b, &w.c], false).await;

    // Duell Anna gegen Bodo; Cleo schaut als Chat-Mitglied zu.
    let (status, partie) = probe
        .call(
            "POST",
            "/api/v1/games/sessions",
            Some(&w.a.token),
            Some(json!({ "conversationId": chat, "gameKey": "pressen", "opponentIds": [w.b.uuid()] })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{partie}");
    let id = partie["id"].as_str().unwrap().to_string();

    let (_, mut anna_hoert, _) = {
        let h = probe.state.hub.register(w.a.uuid());
        (h.0, h.1.empfang, h.2)
    };
    let (_, mut bodo_hoert, _) = {
        let h = probe.state.hub.register(w.b.uuid());
        (h.0, h.1.empfang, h.2)
    };
    let (_, mut cleo_hoert, _) = {
        let h = probe.state.hub.register(w.c.uuid());
        (h.0, h.1.empfang, h.2)
    };

    // Anna meldet ihren Lauf. Die Antwort auf IHREN Zug enthält ihn …
    let (status, antwort) = probe
        .call(
            "POST",
            &format!("/api/v1/games/sessions/{id}/moves"),
            Some(&w.a.token),
            Some(json!({ "move": lauf(1) })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    assert_eq!(antwort["state"]["ergebnisse"][0]["dauerMs"], 13579);
    assert_eq!(antwort["state"]["ergebnisse"][0]["verschuettetDezi"], 246);

    // … Anna sieht ihn auf allen Wegen, Bodo und Cleo auf keinem.
    for (weg, ansicht) in sichten(&probe, &w.a, &chat, &id).await {
        let sitz0 = if weg == "Liste" {
            ansicht["items"][0]["state"]["ergebnisse"][0].clone()
        } else {
            ansicht["state"]["ergebnisse"][0].clone()
        };
        assert_eq!(sitz0["dauerMs"], 13579, "Anna sieht ihren Lauf: {weg}");
    }
    for wer in [&w.b, &w.c] {
        for (weg, ansicht) in sichten(&probe, wer, &chat, &id).await {
            assert!(!enthaelt_spur(&ansicht), "{weg}: {ansicht}");
            let sitz0 = if weg == "Liste" {
                ansicht["items"][0]["state"]["ergebnisse"][0].clone()
            } else {
                ansicht["state"]["ergebnisse"][0].clone()
            };
            assert_eq!(sitz0, json!({ "verborgen": true }), "{weg}");
        }
    }

    // Echtzeitereignisse: an Bodo und Cleo geht nichts Verräterisches hinaus.
    let anna_frames = gehoert(&mut anna_hoert);
    assert!(
        anna_frames.iter().any(enthaelt_spur),
        "Anna bekommt ihren eigenen Stand"
    );
    for (name, hoerer) in [("Bodo", &mut bodo_hoert), ("Cleo", &mut cleo_hoert)] {
        let frames = gehoert(hoerer);
        assert!(
            frames.iter().any(|f| f["type"] == "game.updated"),
            "{name} bekommt das Ereignis"
        );
        for frame in frames {
            assert!(!enthaelt_spur(&frame), "{name}: {frame}");
        }
    }

    // Bodo meldet: Die Runde ist entschieden (Unterschied über der Toleranz) – jetzt ist alles offen.
    let (status, ende) = probe
        .call(
            "POST",
            &format!("/api/v1/games/sessions/{id}/moves"),
            Some(&w.b.token),
            Some(json!({ "move": {
                "typ": "ergebnis", "runde": 1, "dauerMs": 31000, "verschuettetDezi": 5,
                "reaktionMs": 400, "vorzeitig": false, "verzoegerungMs": 0
            }})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{ende}");
    assert_eq!(ende["state"]["fertig"], true);
    for wer in [&w.b, &w.c] {
        for (weg, ansicht) in sichten(&probe, wer, &chat, &id).await {
            // Die Liste zeigt nur laufende Partien; die beendete steht nicht mehr darin.
            if weg == "Liste" {
                continue;
            }
            assert!(enthaelt_spur(&ansicht), "{weg} offen nach Rundenende");
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn nach_atempo_ist_die_vorrunde_offen_die_neue_runde_wieder_verdeckt() {
    let probe = probe_oder_uebersprungen!("atempo");
    let w = welt(&probe).await;
    let chat = probe.chat(&w.a, &[&w.b], true).await;
    let (_, partie) = probe
        .call(
            "POST",
            "/api/v1/games/sessions",
            Some(&w.a.token),
            Some(json!({ "conversationId": chat, "gameKey": "pressen", "opponentIds": [w.b.uuid()] })),
        )
        .await;
    let id = partie["id"].as_str().unwrap().to_string();
    let zug = |dauer: i64| {
        json!({ "move": {
            "typ": "ergebnis", "runde": 1, "dauerMs": dauer, "verschuettetDezi": 0,
            "reaktionMs": 300, "vorzeitig": false, "verzoegerungMs": 0
        }})
    };
    probe
        .call(
            "POST",
            &format!("/api/v1/games/sessions/{id}/moves"),
            Some(&w.a.token),
            Some(zug(12000)),
        )
        .await;
    let (status, nach) = probe
        .call(
            "POST",
            &format!("/api/v1/games/sessions/{id}/moves"),
            Some(&w.b.token),
            Some(zug(12100)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{nach}");
    assert_eq!(nach["state"]["runde"], 2);
    // Die abgeschlossene Runde steht offen in der Vorrunde, die neue ist leer.
    assert_eq!(nach["state"]["vorrunde"][0]["dauerMs"], 12000);
    assert!(nach["state"]["ergebnisse"][0].is_null());
    // Annas Lauf in Runde 2 ist für Bodo wieder nur „fertig“.
    let (_, _) = probe
        .call(
            "POST",
            &format!("/api/v1/games/sessions/{id}/moves"),
            Some(&w.a.token),
            Some(json!({ "move": {
                "typ": "ergebnis", "runde": 2, "dauerMs": 12345, "verschuettetDezi": 11,
                "reaktionMs": 300, "vorzeitig": false, "verzoegerungMs": 40
            }})),
        )
        .await;
    let (_, fuer_bodo) = probe
        .call(
            "GET",
            &format!("/api/v1/games/sessions/{id}"),
            Some(&w.b.token),
            None,
        )
        .await;
    assert_eq!(
        fuer_bodo["state"]["ergebnisse"][0],
        json!({ "verborgen": true })
    );
    assert!(!fuer_bodo["state"]["ergebnisse"]
        .to_string()
        .contains("12345"));
    assert_eq!(fuer_bodo["state"]["vorrunde"][1]["dauerMs"], 12100);
}

#[tokio::test(flavor = "multi_thread")]
async fn das_strichmaennchen_wird_geprueft_gespeichert_und_den_mitspielenden_gezeigt() {
    let probe = probe_oder_uebersprungen!("figur");
    let w = welt(&probe).await;
    let gut = json!({ "frisur": 3, "haarfarbe": 8, "haut": 2, "shirt": 11, "bart": 3, "brille": 3, "hut": 4 });

    // Ungültiges lehnt der Server ab: Grenze, Typ, fremdes Merkmal, fehlendes Merkmal.
    for kaputt in [
        json!({ "frisur": 99, "haarfarbe": 8, "haut": 2, "shirt": 11, "bart": 3, "brille": 3, "hut": 4 }),
        json!({ "frisur": "x", "haarfarbe": 8, "haut": 2, "shirt": 11, "bart": 3, "brille": 3, "hut": 4 }),
        json!({ "frisur": 1, "haarfarbe": 8, "haut": 2, "shirt": 11, "bart": 3, "brille": 3, "hut": 4, "skript": 1 }),
        json!({ "frisur": 1 }),
    ] {
        let (status, antwort) = probe
            .call(
                "PATCH",
                "/api/v1/users/me",
                Some(&w.a.token),
                Some(json!({ "settings": { "modules": { "pressenFigur": kaputt } } })),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{antwort}");
    }
    let (status, antwort) = probe
        .call(
            "PATCH",
            "/api/v1/users/me",
            Some(&w.a.token),
            Some(json!({ "settings": { "modules": { "pressenFigur": gut } } })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    assert_eq!(antwort["settings"]["modules"]["pressenFigur"], gut);

    // Über Geräte hinweg: ein frisches Einloggen sieht dieselbe Figur.
    let (_, ich) = probe
        .call("GET", "/api/v1/auth/me", Some(&w.a.token), None)
        .await;
    assert_eq!(ich["settings"]["modules"]["pressenFigur"], gut);

    // In der Partie sehen es alle Beteiligten – auch Zuschauer im Chat.
    let chat = probe.chat(&w.a, &[&w.b, &w.c], false).await;
    let (_, partie) = probe
        .call(
            "POST",
            "/api/v1/games/sessions",
            Some(&w.a.token),
            Some(json!({ "conversationId": chat, "gameKey": "pressen", "opponentIds": [w.b.uuid()] })),
        )
        .await;
    let id = partie["id"].as_str().unwrap().to_string();
    for wer in [&w.a, &w.b, &w.c] {
        let (_, sicht) = probe
            .call(
                "GET",
                &format!("/api/v1/games/sessions/{id}"),
                Some(&wer.token),
                None,
            )
            .await;
        assert_eq!(sicht["figuren"][w.a.id.as_str()], gut);
        // Wer nichts eingestellt hat, hat keinen Eintrag (der Client nimmt seine Standardfigur).
        assert!(sicht["figuren"][w.b.id.as_str()].is_null());
        assert!(sicht["serverTime"].is_string());
    }
    // Die Einstellungen der anderen bleiben privat: Annas Profil für Bodo trägt sie nicht.
    let (_, fremd) = probe
        .call(
            "GET",
            &format!("/api/v1/users/{}", w.a.id),
            Some(&w.b.token),
            None,
        )
        .await;
    assert!(fremd.get("settings").is_none(), "{fremd}");
}
