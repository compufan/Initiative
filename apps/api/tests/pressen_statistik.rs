//! Pressen: Statistik über alle gewerteten Läufe (Tabelle `pressen_laeufe`).
//!
//! Geprüft wird, was der Auftrag verlangt:
//!
//!   * Läufe entstehen erst, wenn eine Runde abgeschlossen ist (Sichtbarkeit),
//!     je gewerteter Person eine Zeile, und ein Wiederholen doppelt nichts;
//!   * jeder sieht nur die eigenen Läufe, fremde Läufe sind 404;
//!   * Aggregate stimmen an bekannten Läufen, Liste mit Cursor, Sortierung, Filter;
//!   * die Läufe überleben die aufgeräumte Übung und gehen mit dem Konto;
//!   * der Nachtrag aus vorhandenen Sitzungen ist wiederholbar.
//!
//! Eigenes Postgres-Schema je Test, wie in `tests/uebung_ohne_chat.rs`.

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
    let schema = format!("statprobe_{name}");
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
            format!("./.data/stat-{}", Uuid::now_v7().simple()),
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
const STATISTIK: &str = "/api/v1/games/pressen/statistik";
const LAEUFE: &str = "/api/v1/games/pressen/laeufe";

fn lauf(runde: i64, dauer: i64, verschuettet: i64) -> Value {
    json!({ "move": {
        "typ": "ergebnis", "runde": runde, "dauerMs": dauer, "verschuettetDezi": verschuettet,
        "reaktionMs": 300, "vorzeitig": false, "verzoegerungMs": 0
    }})
}

impl Probe {
    async fn spiel(&self, von: &Konto, gegner: &Konto, chat: &str) -> String {
        let (status, partie) = self
            .call(
                "POST",
                SESSIONS,
                Some(&von.token),
                Some(json!({
                    "conversationId": chat, "gameKey": "pressen",
                    "opponentIds": [gegner.uuid()]
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{partie}");
        partie["id"].as_str().unwrap().to_string()
    }

    async fn uebung(&self, von: &Konto) -> String {
        let (status, partie) = self
            .call(
                "POST",
                SESSIONS,
                Some(&von.token),
                Some(json!({ "gameKey": "pressen", "opponentIds": [] })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{partie}");
        partie["id"].as_str().unwrap().to_string()
    }

    async fn zug(&self, partie: &str, wer: &Konto, zug: Value) -> (StatusCode, Value) {
        self.call(
            "POST",
            &format!("{SESSIONS}/{partie}/moves"),
            Some(&wer.token),
            Some(zug),
        )
        .await
    }

    async fn statistik(&self, wer: &Konto, abfrage: &str) -> Value {
        let (status, antwort) = self
            .call(
                "GET",
                &format!("{STATISTIK}{abfrage}"),
                Some(&wer.token),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{antwort}");
        antwort
    }

    async fn laeufe_von(&self, wer: &Konto) -> i64 {
        self.zahl(&format!(
            "select count(*) from pressen_laeufe where user_id = '{}'",
            wer.id
        ))
        .await
    }
}

/// Ein Duell bis zur Entscheidung: `a` gewinnt klar.
async fn duell_entscheiden(probe: &Probe, a: &Konto, b: &Konto, chat: &str) -> String {
    let partie = probe.spiel(a, b, chat).await;
    let (status, _) = probe.zug(&partie, a, lauf(1, 12000, 0)).await;
    assert_eq!(status, StatusCode::OK);
    let (status, nach) = probe.zug(&partie, b, lauf(1, 20000, 50)).await;
    assert_eq!(status, StatusCode::OK, "{nach}");
    assert_eq!(nach["state"]["fertig"], true);
    partie
}

#[tokio::test(flavor = "multi_thread")]
async fn laeufe_entstehen_erst_am_rundenende_je_person_und_wiederholen_doppelt_nichts() {
    let probe = probe_oder_uebersprungen!("rundenende");
    let w = welt(&probe).await;
    let chat = probe.chat(&w.a, &[&w.b], true).await;
    let partie = probe.spiel(&w.a, &w.b, &chat).await;

    // Annas Lauf allein: Die Runde steht noch nicht fest, also gibt es nichts
    // zu zählen – nicht für Anna, nicht für Bodo.
    probe.zug(&partie, &w.a, lauf(1, 12000, 0)).await;
    assert_eq!(probe.laeufe_von(&w.a).await, 0);
    assert_eq!(probe.statistik(&w.a, "").await["kopf"]["laeufe"], 0);
    assert_eq!(probe.statistik(&w.b, "").await["kopf"]["laeufe"], 0);

    // Bodos Lauf entscheidet: je Person eine Zeile.
    let (status, nach) = probe.zug(&partie, &w.b, lauf(1, 20000, 50)).await;
    assert_eq!(status, StatusCode::OK, "{nach}");
    assert_eq!(probe.laeufe_von(&w.a).await, 1);
    assert_eq!(probe.laeufe_von(&w.b).await, 1);
    assert_eq!(probe.laeufe_von(&w.c).await, 0);

    // Wiederholt Bodo den Zug (Netz hakt), wird er abgelehnt und nichts doppelt sich.
    let (status, _) = probe.zug(&partie, &w.b, lauf(1, 20000, 50)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(probe.laeufe_von(&w.b).await, 1);

    // Das Eintragen selbst ist idempotent: dieselbe Zeile zweimal ändert nichts.
    use initiative_api::services::pressen_statistik::{eintragen, NeuerLauf};
    let eine = NeuerLauf {
        user_id: w.a.uuid(),
        session_id: partie.parse().unwrap(),
        runde: 1,
        sitz: 0,
        modus: "duell".into(),
        start_art: "asynchron",
        gegner_ids: vec![w.b.uuid()],
        team_ids: vec![],
        dauer_ms: 12000,
        verschuettet_dezi: 0,
        wertung_ms: 12000,
        reaktion_ms: Some(300),
        vorzeitig: false,
        getruemmert: true,
        malus_ms: 0,
        versatz_ms: 0,
        ausgang: "sieg",
        team_wertung_ms: Some(12000),
        gegner_wertung_ms: Some(20550),
    };
    for _ in 0..2 {
        let mut tx = probe.state.pool.begin().await.unwrap();
        eintragen(&mut tx, std::slice::from_ref(&eine))
            .await
            .unwrap();
        tx.commit().await.unwrap();
    }
    assert_eq!(probe.laeufe_von(&w.a).await, 1);

    // Inhalt: Sieg für Anna mit Gegner Bodo, Niederlage für Bodo mit Gegner Anna.
    let a = probe.statistik(&w.a, "").await;
    assert_eq!(a["kopf"]["siege"], 1);
    assert_eq!(a["kopf"]["niederlagen"], 0);
    assert_eq!(a["rekorde"]["besteZeit"]["wert"], 12000);
    assert_eq!(a["nachGegner"][0]["name"], "bodo");
    assert_eq!(a["nachGegner"][0]["siege"], 1);
    assert_eq!(a["nachGegner"][0]["durchschnittVorsprungMs"], 8550.0);
    let b = probe.statistik(&w.b, "").await;
    assert_eq!(b["kopf"]["niederlagen"], 1);
    assert_eq!(b["nachGegner"][0]["name"], "anna");
    assert_eq!(b["nachGegner"][0]["niederlagen"], 1);
    assert_eq!(b["nachGegner"][0]["durchschnittVorsprungMs"], -8550.0);
    assert_eq!(b["kopf"]["gesamtVerschuettetDezi"], 50);
}

#[tokio::test(flavor = "multi_thread")]
async fn fremde_laeufe_gibt_es_nicht_404_und_keine_fremden_zeilen_in_der_liste() {
    let probe = probe_oder_uebersprungen!("fremde");
    let w = welt(&probe).await;
    let chat = probe.chat(&w.a, &[&w.b], true).await;
    duell_entscheiden(&probe, &w.a, &w.b, &chat).await;

    let (_, liste) = probe.call("GET", LAEUFE, Some(&w.a.token), None).await;
    let id = liste["items"][0]["id"].as_str().unwrap().to_string();
    assert_eq!(liste["items"].as_array().unwrap().len(), 1);
    assert_eq!(liste["items"][0]["gegner"][0]["name"], "bodo");

    // Annas Lauf: Anna sieht ihn im Einzelnen, Bodo und Cleo nicht (404, kein 403).
    let (status, detail) = probe
        .call("GET", &format!("{LAEUFE}/{id}"), Some(&w.a.token), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{detail}");
    assert_eq!(detail["ausgang"], "sieg");
    assert_eq!(detail["dauerMs"], 12000);
    for fremd in [&w.b, &w.c] {
        let (status, _) = probe
            .call("GET", &format!("{LAEUFE}/{id}"), Some(&fremd.token), None)
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
    // Cleo hat keine Läufe; Bodos Liste enthält nur Bodos Zeile.
    let (_, cleo) = probe.call("GET", LAEUFE, Some(&w.c.token), None).await;
    assert!(cleo["items"].as_array().unwrap().is_empty());
    let (_, bodo) = probe.call("GET", LAEUFE, Some(&w.b.token), None).await;
    assert_eq!(bodo["items"].as_array().unwrap().len(), 1);
    assert_ne!(bodo["items"][0]["id"], id);
    assert_eq!(bodo["items"][0]["ausgang"], "niederlage");
    // Unbekannte Kennung und Anmeldung.
    let (status, _) = probe
        .call(
            "GET",
            &format!("{LAEUFE}/{}", Uuid::now_v7()),
            Some(&w.a.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = probe.call("GET", STATISTIK, None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // Ungültige Filter sind ein Fehler, keine leere Liste.
    for abfrage in ["?modus=quatsch", "?sortierung=quatsch", "?cursor=kaputt"] {
        let (status, _) = probe
            .call("GET", &format!("{LAEUFE}{abfrage}"), Some(&w.a.token), None)
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{abfrage}");
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn spiegel_zaehlt_jede_runde_liste_hat_cursor_sortierung_und_filter() {
    let probe = probe_oder_uebersprungen!("liste");
    let w = welt(&probe).await;
    let uebung = probe.uebung(&w.a).await;
    // Fünf Spiegel-Runden: immer Atempo, jede schließt eine Runde und zählt.
    let werte = [
        (15000, 0),
        (12000, 100),
        (18000, 0),
        (13000, 250),
        (16000, 30),
    ];
    for (nr, (dauer, verschuettet)) in werte.iter().enumerate() {
        let (status, antwort) = probe
            .zug(&uebung, &w.a, lauf(nr as i64 + 1, *dauer, *verschuettet))
            .await;
        assert_eq!(status, StatusCode::OK, "{antwort}");
        assert_eq!(antwort["state"]["runde"], nr as i64 + 2);
    }
    let s = probe.statistik(&w.a, "").await;
    assert_eq!(s["kopf"]["laeufe"], 5);
    assert_eq!(s["kopf"]["atempo"], 5);
    assert_eq!(s["kopf"]["siegquote"], Value::Null);
    assert_eq!(s["nachModus"][0]["modus"], "spiegel");
    assert_eq!(s["kopf"]["durchschnittZeitMs"], 14800.0);
    assert_eq!(s["verlauf"].as_array().unwrap().len(), 5);
    // Im Spiegel wächst der Malus nicht, also bleibt die Malus-Tabelle leer.
    assert!(s["nachMalus"].as_array().unwrap().is_empty());
    assert!(s["nachGegner"].as_array().unwrap().is_empty());

    // Seitenweise, neueste zuerst; der Cursor liefert den Rest ohne Doppel.
    let (_, seite1) = probe
        .call("GET", &format!("{LAEUFE}?limit=2"), Some(&w.a.token), None)
        .await;
    assert_eq!(seite1["items"].as_array().unwrap().len(), 2);
    assert_eq!(seite1["items"][0]["dauerMs"], 16000);
    let cursor = seite1["nextCursor"].as_str().unwrap().to_string();
    let (_, seite2) = probe
        .call(
            "GET",
            &format!("{LAEUFE}?limit=2&cursor={cursor}"),
            Some(&w.a.token),
            None,
        )
        .await;
    assert_eq!(seite2["items"][0]["dauerMs"], 18000);
    assert_eq!(seite2["items"][1]["dauerMs"], 12000);
    let cursor = seite2["nextCursor"].as_str().unwrap().to_string();
    let (_, seite3) = probe
        .call(
            "GET",
            &format!("{LAEUFE}?limit=2&cursor={cursor}"),
            Some(&w.a.token),
            None,
        )
        .await;
    assert_eq!(seite3["items"].as_array().unwrap().len(), 1);
    assert_eq!(seite3["nextCursor"], Value::Null);
    assert_eq!(seite3["items"][0]["dauerMs"], 15000);

    // Sortiert nach Zeit (schnellste zuerst), auch über Seiten.
    let (_, nach_zeit) = probe
        .call(
            "GET",
            &format!("{LAEUFE}?sortierung=zeit&limit=3"),
            Some(&w.a.token),
            None,
        )
        .await;
    let zeiten: Vec<i64> = nach_zeit["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["dauerMs"].as_i64().unwrap())
        .collect();
    assert_eq!(zeiten, vec![12000, 13000, 15000]);
    let cursor = nach_zeit["nextCursor"].as_str().unwrap().to_string();
    let (_, rest) = probe
        .call(
            "GET",
            &format!("{LAEUFE}?sortierung=zeit&limit=3&cursor={cursor}"),
            Some(&w.a.token),
            None,
        )
        .await;
    let rest: Vec<i64> = rest["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["dauerMs"].as_i64().unwrap())
        .collect();
    assert_eq!(rest, vec![16000, 18000]);

    // Filter: ein Modus ohne Läufe ist leer, ein Ausgang filtert.
    let (_, duell) = probe
        .call(
            "GET",
            &format!("{LAEUFE}?modus=duell"),
            Some(&w.a.token),
            None,
        )
        .await;
    assert!(duell["items"].as_array().unwrap().is_empty());
    assert_eq!(
        probe.statistik(&w.a, "?modus=duell").await["kopf"]["laeufe"],
        0
    );
    let (_, atempo) = probe
        .call(
            "GET",
            &format!("{LAEUFE}?ausgang=atempo&sortierung=verschuettet"),
            Some(&w.a.token),
            None,
        )
        .await;
    assert_eq!(atempo["items"][0]["verschuettetDezi"], 0);
    assert_eq!(atempo["items"][4]["verschuettetDezi"], 250);
    // Zeitraum: nichts vor 2000, alles bis morgen.
    assert_eq!(
        probe.statistik(&w.a, "?bis=2000-01-01T00:00:00Z").await["kopf"]["laeufe"],
        0
    );
    assert_eq!(
        probe.statistik(&w.a, "?von=2000-01-01T00:00:00Z").await["kopf"]["laeufe"],
        5
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn laeufe_ueberleben_die_aufgeraeumte_uebung_und_gehen_mit_dem_konto() {
    let probe = probe_oder_uebersprungen!("loeschen");
    let w = welt(&probe).await;
    let chat = probe.chat(&w.a, &[&w.b], true).await;
    duell_entscheiden(&probe, &w.a, &w.b, &chat).await;
    let uebung = probe.uebung(&w.a).await;
    probe.zug(&uebung, &w.a, lauf(1, 14000, 0)).await;
    assert_eq!(probe.laeufe_von(&w.a).await, 2);

    // Die nächste Übung räumt die vorige ab – der Lauf bleibt, ohne Sitzung.
    let zweite = probe.uebung(&w.a).await;
    assert_ne!(zweite, uebung);
    assert_eq!(
        probe
            .zahl(&format!(
                "select count(*) from game_sessions where id = '{uebung}'"
            ))
            .await,
        0
    );
    assert_eq!(probe.laeufe_von(&w.a).await, 2);
    assert_eq!(
        probe
            .zahl(&format!(
                "select count(*) from pressen_laeufe where user_id = '{}' and session_id is null",
                w.a.id
            ))
            .await,
        1
    );
    let s = probe.statistik(&w.a, "").await;
    assert_eq!(s["kopf"]["laeufe"], 2);

    // Löscht Anna ihr Konto, gehen ihre Läufe mit; Bodos bleiben.
    probe
        .sql(&format!("delete from users where id = '{}'", w.a.id))
        .await;
    assert_eq!(probe.laeufe_von(&w.a).await, 0);
    assert_eq!(probe.laeufe_von(&w.b).await, 1);
    // In Bodos Statistik ist Anna nur noch ein Name, den es nicht mehr gibt.
    let b = probe.statistik(&w.b, "").await;
    assert_eq!(b["nachGegner"][0]["name"], Value::Null);
    assert_eq!(b["nachGegner"][0]["niederlagen"], 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn der_nachtrag_aus_vorhandenen_sitzungen_ist_wiederholbar() {
    let probe = probe_oder_uebersprungen!("nachtrag");
    let w = welt(&probe).await;
    let chat = probe.chat(&w.a, &[&w.b], true).await;
    let partie = duell_entscheiden(&probe, &w.a, &w.b, &chat).await;
    let uebung = probe.uebung(&w.c).await;
    probe.zug(&uebung, &w.c, lauf(1, 15000, 20)).await;
    // Eine abgebrochene Übung zählt für den Nachtrag nicht (Zeitpunkt unbekannt).
    let abgebrochen = probe.uebung(&w.b).await;
    probe.zug(&abgebrochen, &w.b, lauf(1, 15000, 0)).await;
    probe
        .call(
            "POST",
            &format!("{SESSIONS}/{abgebrochen}/abort"),
            Some(&w.b.token),
            None,
        )
        .await;
    let vorher = probe.zahl("select count(*) from pressen_laeufe").await;
    assert_eq!(vorher, 4);

    // So sah die Datenbank vor der Statistik aus: Sitzungen da, Tabelle leer.
    probe.sql("delete from pressen_laeufe").await;
    let nachtrag = include_str!("../migrations/0028_pressen_laeufe.sql");
    for durchlauf in 0..2 {
        sqlx::raw_sql(nachtrag)
            .execute(&probe.state.pool)
            .await
            .unwrap();
        // Entschiedene Partie: beide Sitze; laufende Spiegel-Übung: die letzte Runde;
        // abgebrochene Übung: nichts.
        assert_eq!(
            probe.zahl("select count(*) from pressen_laeufe").await,
            3,
            "Durchlauf {durchlauf}"
        );
    }
    let a = probe.statistik(&w.a, "").await;
    assert_eq!(a["kopf"]["siege"], 1);
    assert_eq!(a["rekorde"]["besteZeit"]["wert"], 12000);
    assert_eq!(a["nachGegner"][0]["name"], "bodo");
    assert_eq!(a["nachGegner"][0]["durchschnittVorsprungMs"], 8550.0);
    let b = probe.statistik(&w.b, "").await;
    assert_eq!(b["kopf"]["niederlagen"], 1);
    assert_eq!(b["kopf"]["laeufe"], 1);
    let c = probe.statistik(&w.c, "").await;
    assert_eq!(c["kopf"]["atempo"], 1);
    assert_eq!(c["nachModus"][0]["modus"], "spiegel");
    // Die Zeile gehört weiter zur Sitzung, solange es sie gibt.
    assert_eq!(
        probe
            .zahl(&format!(
                "select count(*) from pressen_laeufe where session_id = '{partie}'"
            ))
            .await,
        2
    );
}
