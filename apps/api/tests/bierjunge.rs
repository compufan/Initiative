//! „Bierjunge“ / „hängt“ im Chat startet ein Pressen-Spiel (`services::bierjunge`).
//!
//! Geprüft werden die Regeln aus dem Kopf von `services/bierjunge.rs`:
//!
//!   * **a** Einzelchat: A „Bierjunge“, B „hängt“ → Partie A↔B im selben Chat.
//!   * **b** Gruppe mit Namen: nur das „hängt“ des Genannten zählt.
//!   * **c** Gruppe ohne Namen: das erste „hängt“ eines anderen Mitglieds.
//!   * **d** „Generalbierjunge“: jedes andere Mitglied einmal; der Aufruf bleibt offen.
//!   * **e** Zehn Minuten ab der Nachricht; ein normaler Aufruf verbraucht sich.
//!   * Eigenes „hängt“, Nichtmitglieder, gelöschter Aufruf, Doppelantwort und
//!     zwei „hängt“ im selben Augenblick (ein Spiel).
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
use initiative_api::services::messages::{create_message, NewMessage};
use initiative_api::state::AppState;
use initiative_api::{app, MIGRATOR};

const PASSWORT: &str = "richtigespasswort";

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
    let schema = format!("bierprobe_{name}");
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
    d: Konto,
}

async fn welt(probe: &Probe) -> Welt {
    // Das erste Konto eines leeren Schemas ist Verwalter – es soll mit den Tests
    // nichts zu tun haben.
    probe.konto("wurzel").await;
    Welt {
        a: probe.konto("anna").await,
        b: probe.konto("bodo").await,
        c: probe.konto("cleo").await,
        d: probe.konto("dora").await,
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

// ---------------------------------------------------------------------------
// a – Einzelchat
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn a_einzelchat_bierjunge_und_haengt_starten_eine_partie() {
    let probe = probe_oder_uebersprungen!("a");
    let w = welt(&probe).await;
    let chat = probe.chat(&w.a, &[&w.b], true).await;

    probe.schreibe(&w.a, &chat, "Na, Bierjunge?").await;
    assert_eq!(probe.partien(&chat).await, 0, "vor dem „hängt“ nichts");
    // Groß-/Kleinschreibung egal, Satzzeichen egal.
    probe.schreibe(&w.b, &chat, "HÄNGT!").await;

    assert_eq!(probe.partien(&chat).await, 1);
    // Ausrufer auf Sitz 0, Antwortender auf Sitz 1 – im selben Chat.
    assert_eq!(probe.spielende(&chat).await, vec![w.a.uuid(), w.b.uuid()]);
    // Die Spielkarte ist eine ganz normale Nachricht im Chat; die Auslöser auch.
    assert_eq!(
        probe
            .zahl(&format!(
                "select count(*) from messages where conversation_id = '{chat}' and type = 'game'"
            ))
            .await,
        1
    );
    assert_eq!(
        probe
            .zahl(&format!(
                "select count(*) from messages where conversation_id = '{chat}' and type = 'text' and deleted_at is null"
            ))
            .await,
        2
    );
    let status: String = sqlx::query_scalar(&format!(
        "select status from game_sessions where conversation_id = '{chat}'"
    ))
    .fetch_one(&probe.state.pool)
    .await
    .unwrap();
    assert_eq!(status, "active");

    // Normales „Bierjunge“ ist verbraucht: ein weiteres „hängt“ tut nichts.
    probe.schreibe(&w.b, &chat, "hängt").await;
    assert_eq!(probe.partien(&chat).await, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn eigenes_haengt_und_andere_woerter_starten_nichts() {
    let probe = probe_oder_uebersprungen!("eigen");
    let w = welt(&probe).await;
    let chat = probe.chat(&w.a, &[&w.b], true).await;

    probe.schreibe(&w.a, &chat, "Bierjunge").await;
    probe.schreibe(&w.a, &chat, "hängt").await; // der Ausrufer selbst zählt nicht
    probe
        .schreibe(&w.b, &chat, "aufgehängt, hängte, verhängt")
        .await;
    probe.schreibe(&w.b, &chat, "Bierjungenstreich").await;
    assert_eq!(probe.partien(&chat).await, 0);
    assert_eq!(
        probe.zahl("select count(*) from bierjunge_aufrufe").await,
        1,
        "nur der echte Aufruf ist gemerkt"
    );
    // „hängt“ ohne Aufruf in einem anderen Chat bleibt wirkungslos.
    let anderer = probe.chat(&w.a, &[&w.c], true).await;
    probe.schreibe(&w.c, &anderer, "hängt").await;
    assert_eq!(probe.partien(&anderer).await, 0);
    // Und das „hängt“ aus dem anderen Chat verbraucht den Aufruf hier nicht.
    probe.schreibe(&w.b, &chat, "hängt").await;
    assert_eq!(probe.partien(&chat).await, 1);
}

// ---------------------------------------------------------------------------
// b, c – Gruppe
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn b_gruppe_mit_namen_zaehlt_nur_das_haengt_des_angesprochenen() {
    let probe = probe_oder_uebersprungen!("b");
    let w = welt(&probe).await;
    let chat = probe.chat(&w.a, &[&w.b, &w.c, &w.d], false).await;

    // Benutzername mit @, andere Schreibweise.
    probe
        .schreibe(&w.a, &chat, "Bierjunge @BoDo wer sonst")
        .await;
    probe.schreibe(&w.c, &chat, "hängt").await;
    probe.schreibe(&w.d, &chat, "hängt").await;
    assert_eq!(
        probe.partien(&chat).await,
        0,
        "Unbeteiligte lösen nichts aus"
    );

    probe.schreibe(&w.b, &chat, "hängt").await;
    assert_eq!(probe.partien(&chat).await, 1);
    assert_eq!(probe.spielende(&chat).await, vec![w.a.uuid(), w.b.uuid()]);

    // Auch die Spitze des Anzeigenamens genügt (hier gleich dem Benutzernamen).
    probe.schreibe(&w.a, &chat, "bierjunge Cleo").await;
    probe.schreibe(&w.d, &chat, "hängt").await;
    assert_eq!(probe.partien(&chat).await, 1);
    probe.schreibe(&w.c, &chat, "Hängt").await;
    assert_eq!(probe.partien(&chat).await, 2);
    assert_eq!(probe.spielende(&chat).await, vec![w.a.uuid(), w.c.uuid()]);
}

#[tokio::test(flavor = "multi_thread")]
async fn c_gruppe_ohne_namen_das_erste_haengt_gewinnt() {
    let probe = probe_oder_uebersprungen!("c");
    let w = welt(&probe).await;
    let chat = probe.chat(&w.a, &[&w.b, &w.c, &w.d], false).await;

    probe.schreibe(&w.a, &chat, "Bierjunge").await;
    probe.schreibe(&w.c, &chat, "hängt").await;
    assert_eq!(probe.partien(&chat).await, 1);
    assert_eq!(probe.spielende(&chat).await, vec![w.a.uuid(), w.c.uuid()]);
    // Verbraucht: weitere „hängt“ bleiben ohne Wirkung.
    probe.schreibe(&w.b, &chat, "hängt").await;
    probe.schreibe(&w.d, &chat, "hängt").await;
    assert_eq!(probe.partien(&chat).await, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn ein_genannter_nichtmitglied_name_macht_den_aufruf_namenlos() {
    let probe = probe_oder_uebersprungen!("fremdname");
    let w = welt(&probe).await;
    let chat = probe.chat(&w.a, &[&w.b, &w.c], false).await;
    // Dora ist nicht im Chat: Der Name zählt nicht, das erste „hängt“ gewinnt.
    probe.schreibe(&w.a, &chat, "Bierjunge dora").await;
    probe.schreibe(&w.c, &chat, "hängt").await;
    assert_eq!(probe.partien(&chat).await, 1);
    assert_eq!(probe.spielende(&chat).await, vec![w.a.uuid(), w.c.uuid()]);
}

// ---------------------------------------------------------------------------
// d – Generalbierjunge
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn d_generalbierjunge_jeder_einmal_und_bleibt_offen() {
    let probe = probe_oder_uebersprungen!("d");
    let w = welt(&probe).await;
    let chat = probe.chat(&w.a, &[&w.b, &w.c, &w.d], false).await;

    // Ein Name im Text ändert beim Generalaufruf nichts.
    probe.schreibe(&w.a, &chat, "GENERALBIERJUNGE Bodo").await;
    probe.schreibe(&w.c, &chat, "hängt").await;
    assert_eq!(probe.partien(&chat).await, 1);
    probe.schreibe(&w.b, &chat, "hängt").await;
    assert_eq!(probe.partien(&chat).await, 2);
    // Doppelantwort: Cleo hat schon geantwortet.
    probe.schreibe(&w.c, &chat, "hängt nochmal").await;
    assert_eq!(probe.partien(&chat).await, 2);
    // Der Ausrufer zählt nie.
    probe.schreibe(&w.a, &chat, "hängt").await;
    assert_eq!(probe.partien(&chat).await, 2);
    // Dora kommt noch dazu – der Aufruf ist weiter offen.
    probe.schreibe(&w.d, &chat, "hängt!").await;
    assert_eq!(probe.partien(&chat).await, 3);
    assert_eq!(probe.spielende(&chat).await, vec![w.a.uuid(), w.d.uuid()]);
    // Und alle drei Antworten sind je Person genau einmal verbucht.
    assert_eq!(
        probe
            .zahl("select count(*) from bierjunge_antworten where spiel_id is not null")
            .await,
        3
    );
}

// ---------------------------------------------------------------------------
// e – Frist
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn e_nach_zehn_minuten_tut_ein_haengt_nichts() {
    let probe = probe_oder_uebersprungen!("e");
    let w = welt(&probe).await;
    let chat = probe.chat(&w.a, &[&w.b], true).await;

    let alt = probe.schreibe(&w.a, &chat, "Bierjunge").await;
    probe.altern(&alt, 11).await;
    probe.schreibe(&w.b, &chat, "hängt").await;
    assert_eq!(probe.partien(&chat).await, 0, "elf Minuten sind zu spät");

    // Neun Minuten reichen noch.
    let frisch = probe.schreibe(&w.a, &chat, "Bierjunge").await;
    probe.altern(&frisch, 9).await;
    probe.schreibe(&w.b, &chat, "hängt").await;
    assert_eq!(probe.partien(&chat).await, 1);

    // Auch ein Generalaufruf läuft ab.
    let gruppe = probe.chat(&w.a, &[&w.b, &w.c], false).await;
    let general = probe.schreibe(&w.a, &gruppe, "Generalbierjunge").await;
    probe.schreibe(&w.b, &gruppe, "hängt").await;
    assert_eq!(probe.partien(&gruppe).await, 1);
    probe.altern(&general, 12).await;
    probe.schreibe(&w.c, &gruppe, "hängt").await;
    assert_eq!(
        probe.partien(&gruppe).await,
        1,
        "nach Ablauf kein zweites Spiel"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn alte_aufrufe_werden_beim_naechsten_aufruf_aufgeraeumt() {
    let probe = probe_oder_uebersprungen!("raeumen");
    let w = welt(&probe).await;
    let chat = probe.chat(&w.a, &[&w.b], true).await;
    let alt = probe.schreibe(&w.a, &chat, "Bierjunge").await;
    probe.altern(&alt, 60 * 30).await;
    probe.schreibe(&w.a, &chat, "Bierjunge nochmal").await;
    assert_eq!(
        probe.zahl("select count(*) from bierjunge_aufrufe").await,
        1
    );
}

// ---------------------------------------------------------------------------
// Fremde, gelöscht, Rennen
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn nichtmitglieder_loesen_nie_etwas_aus() {
    let probe = probe_oder_uebersprungen!("fremde");
    let w = welt(&probe).await;
    let chat = probe.chat(&w.a, &[&w.b], true).await;
    probe.schreibe(&w.a, &chat, "Bierjunge").await;

    // Dora ist nicht im Chat. Über die Schnittstelle kommt sie nicht durch …
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat}/messages"),
            Some(&w.d.token),
            Some(json!({ "type": "text", "body": "hängt" })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // … und selbst eine Nachricht, die der Server von ihr anlegt, startet nichts.
    create_message(
        &probe.state,
        NewMessage::text(chat.parse().unwrap(), w.d.uuid(), "hängt"),
    )
    .await
    .unwrap();
    assert_eq!(probe.partien(&chat).await, 0);
    // Ein Nichtmitglied kann auch keinen Aufruf anlegen.
    create_message(
        &probe.state,
        NewMessage::text(chat.parse().unwrap(), w.d.uuid(), "Generalbierjunge"),
    )
    .await
    .unwrap();
    assert_eq!(
        probe.zahl("select count(*) from bierjunge_aufrufe").await,
        1
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn ein_geloeschter_aufruf_zaehlt_nicht_mehr() {
    let probe = probe_oder_uebersprungen!("geloescht");
    let w = welt(&probe).await;
    let chat = probe.chat(&w.a, &[&w.b, &w.c], false).await;
    let aufruf = probe.schreibe(&w.a, &chat, "Bierjunge").await;
    let general = probe.schreibe(&w.a, &chat, "Generalbierjunge").await;

    for id in [&aufruf, &general] {
        let (status, _) = probe
            .call(
                "DELETE",
                &format!("/api/v1/messages/{id}"),
                Some(&w.a.token),
                None,
            )
            .await;
        assert!(status.is_success(), "{status}");
    }
    probe.schreibe(&w.b, &chat, "hängt").await;
    probe.schreibe(&w.c, &chat, "hängt").await;
    assert_eq!(probe.partien(&chat).await, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn zwei_haengt_gleichzeitig_starten_nur_ein_spiel() {
    let probe = probe_oder_uebersprungen!("rennen");
    let w = welt(&probe).await;
    for runde in 0..4 {
        let chat = probe.chat(&w.a, &[&w.b, &w.c, &w.d], false).await;
        probe
            .schreibe(&w.a, &chat, &format!("Bierjunge {runde}"))
            .await;
        let (b, c, d) = tokio::join!(
            probe.schreibe(&w.b, &chat, "hängt"),
            probe.schreibe(&w.c, &chat, "hängt"),
            probe.schreibe(&w.d, &chat, "hängt"),
        );
        let _ = (b, c, d);
        assert_eq!(probe.partien(&chat).await, 1, "Runde {runde}");
        let verbraucht = probe
            .zahl(&format!(
                "select count(*) from bierjunge_antworten r join bierjunge_aufrufe a on a.id = r.aufruf_id
                  where a.conversation_id = '{chat}' and r.spiel_id is not null"
            ))
            .await;
        assert_eq!(verbraucht, 1);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn ein_haengt_beantwortet_den_aeltesten_offenen_aufruf() {
    let probe = probe_oder_uebersprungen!("zwei");
    let w = welt(&probe).await;
    let chat = probe.chat(&w.a, &[&w.b, &w.c], false).await;
    probe.schreibe(&w.a, &chat, "Bierjunge").await;
    probe.schreibe(&w.c, &chat, "Bierjunge").await;
    // Bodo antwortet einmal: auf den älteren Aufruf (Annas).
    probe.schreibe(&w.b, &chat, "hängt").await;
    assert_eq!(probe.partien(&chat).await, 1);
    assert_eq!(probe.spielende(&chat).await, vec![w.a.uuid(), w.b.uuid()]);
    // Annas Aufruf ist verbraucht; Cleos Aufruf wartet auf ein weiteres „hängt“.
    probe.schreibe(&w.a, &chat, "hängt").await;
    assert_eq!(probe.partien(&chat).await, 2);
    assert_eq!(probe.spielende(&chat).await, vec![w.c.uuid(), w.a.uuid()]);
}
