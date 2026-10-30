//! Erinnerung vor dem Termin (`services::vorab`): `reminder_minutes` liefert der
//! Server selbst aus – als Push an jeden Empfänger und als stille Karte im
//! Einzelchat.
//!
//! Geprüft werden die Regeln aus dem Kopf von `services/vorab.rs`:
//!
//!   * **Fenster**: nicht vor der Fälligkeit, nicht später als 60 Minuten danach,
//!     nie ab dem Beginn; ganztägig mit dem Bezug „Beginn − 12 h“.
//!   * **Einmal**: ein zweiter Durchgang und gleichzeitige Instanzen senden nichts
//!     doppelt; ein verschobener Termin erinnert erneut.
//!   * **Wer**: Ersteller und Teilnehmer ausser `no`.
//!   * **Nicht rückwirkend**: ein nach der Fälligkeit angelegter Termin erinnert nicht.
//!   * **Karte nur im vorhandenen Einzelchat**: sonst nur Push; es entsteht kein
//!     Chat, und im Gruppenchat steht nichts.
//!   * **Aufräumen** beim Löschen, Absagen und Ausladen.
//!
//! Eigenes Postgres-Schema je Test und frei gewählte Uhr, wie in `tests/erinnern.rs`
//! (dort steht die Begründung).

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use chrono::{DateTime, Duration, TimeZone, Utc};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

use initiative_api::config::Config;
use initiative_api::push::Mitschnitt;
use initiative_api::services::vorab::{self, Bilanz};
use initiative_api::state::AppState;
use initiative_api::{app, MIGRATOR};

const PASSWORT: &str = "richtigespasswort";

/// Der Beginn der Termine in den meisten Tests.
fn beginn() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2030, 3, 1, 18, 0, 0).unwrap()
}

fn min(minuten: i64) -> Duration {
    Duration::minutes(minuten)
}

struct Probe {
    router: Router,
    state: AppState,
    push: Mitschnitt,
    config: Arc<Config>,
    url: String,
    schema: String,
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

    /// Ein Termin mit Erinnerungen vor dem Termin; Beginn und Anlagezeit liegen
    /// danach fest: angelegt eine Woche vor dem Beginn.
    async fn termin(
        &self,
        von: &Konto,
        personen: &[Uuid],
        erinnerungen: &[i32],
        einzelchats: bool,
        beginn: DateTime<Utc>,
        ganztaegig: bool,
    ) -> String {
        let (status, termin) = self
            .call(
                "POST",
                "/api/v1/calendar/events",
                Some(&von.token),
                Some(json!({
                    "title": "Grillen",
                    "startsAt": Utc::now() + Duration::days(3),
                    "endsAt": Utc::now() + Duration::days(3) + Duration::hours(2),
                    "attendeeIds": personen,
                    "reminderMinutes": erinnerungen,
                    "zustellung": { "senden": true, "einzelchats": einzelchats, "gruppenChatIds": [] },
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{termin}");
        let id = termin["id"].as_str().unwrap().to_string();
        self.sql(&format!(
            "update calendar_events
                set starts_at = '{b}', ends_at = '{b}'::timestamptz + interval '1 hour',
                    all_day = {ganztaegig}, created_at = '{b}'::timestamptz - interval '7 days'
              where id = '{id}'",
            b = beginn.to_rfc3339()
        ))
        .await;
        // Die Einladung hat selbst Mitteilungen ausgelöst; hier zählen nur die
        // der Erinnerung.
        self.push.lock().unwrap().clear();
        id
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

    async fn durchgang(&self, jetzt: DateTime<Utc>) -> Bilanz {
        vorab::durchgang(&self.state, jetzt).await
    }

    async fn rsvp(&self, wer: &Konto, termin: &str, status: &str) {
        let (code, antwort) = self
            .call(
                "POST",
                &format!("/api/v1/calendar/events/{termin}/rsvp"),
                Some(&wer.token),
                Some(json!({ "status": status })),
            )
            .await;
        assert_eq!(code, StatusCode::OK, "{antwort}");
    }

    /// Der Einzelchat, in dem die Einzelkarte dieser Person steht.
    async fn einzelchat(&self, termin: &str, person: &Konto) -> String {
        sqlx::query_scalar::<_, Uuid>(
            "select conversation_id from event_placements
              where event_id = $1 and art = 'einzel' and user_id = $2",
        )
        .bind(termin.parse::<Uuid>().unwrap())
        .bind(person.uuid())
        .fetch_one(&self.state.pool)
        .await
        .expect("Einzelkarte")
        .to_string()
    }

    /// Die nicht gelöschten Vorab-Karten zu einem Termin in einem Chat.
    async fn karten(&self, wer: &Konto, chat: &str, termin: &str) -> Vec<Value> {
        let (status, liste) = self
            .call(
                "GET",
                &format!("/api/v1/conversations/{chat}/messages"),
                Some(&wer.token),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{liste}");
        liste["items"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|nachricht| {
                nachricht["type"] == "event"
                    && nachricht["deletedAt"].is_null()
                    && nachricht["metadata"]["eventId"] == termin
                    && nachricht["metadata"]["erinnerung"]["art"] == "vorab"
            })
            .collect()
    }

    async fn karten_zahl(&self) -> i64 {
        self.zahl(
            "select count(*) from messages
              where type = 'event' and deleted_at is null
                and metadata -> 'erinnerung' ->> 'art' = 'vorab'",
        )
        .await
    }

    fn push_an(&self, wer: &Konto) -> Vec<Value> {
        self.push
            .lock()
            .unwrap()
            .iter()
            .filter(|(person, _)| *person == wer.uuid())
            .map(|(_, payload)| serde_json::to_value(payload).unwrap())
            .collect()
    }

    fn push_anzahl(&self) -> usize {
        self.push.lock().unwrap().len()
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
    let schema = format!("vorabprobe_{name}");
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
            format!("./.data/vorab-{}", Uuid::now_v7().simple()),
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
    let push = state.push.mitschneiden();
    Some(Probe {
        router: app::build(state.clone()),
        state,
        push,
        config,
        url,
        schema,
    })
}

/// Ein Ersteller (anna) und drei Eingeladene (bodo, cleo, dora).
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

fn ids(personen: &[&Konto]) -> Vec<Uuid> {
    personen.iter().map(|konto| konto.uuid()).collect()
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
// Fenster
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn faellig_genau_im_fenster_und_nur_einmal() {
    let probe = probe_oder_uebersprungen!("v1");
    let w = welt(&probe).await;
    let id = probe
        .termin(&w.a, &ids(&[&w.b]), &[60], true, beginn(), false)
        .await;
    let ab = probe.einzelchat(&id, &w.b).await;

    // Eine Sekunde vor der Fälligkeit: nichts.
    let zu_frueh = probe
        .durchgang(beginn() - min(60) - Duration::seconds(1))
        .await;
    assert_eq!(zu_frueh, Bilanz::default());

    // Auf die Sekunde: Ersteller nur Push, Bodo Push und Karte im Einzelchat.
    let bilanz = probe.durchgang(beginn() - min(60)).await;
    assert_eq!(bilanz.beansprucht, 2, "{bilanz:?}");
    assert_eq!(bilanz.karten, 1, "{bilanz:?}");
    assert_eq!(bilanz.ohne_karte, 1, "{bilanz:?}");
    assert_eq!(bilanz.gescheitert, 0, "{bilanz:?}");

    let karten = probe.karten(&w.b, &ab, &id).await;
    assert_eq!(karten.len(), 1, "{karten:?}");
    assert_eq!(
        karten[0]["senderId"],
        w.a.id.as_str(),
        "Absender: Ersteller"
    );
    assert_eq!(karten[0]["metadata"]["erinnerung"]["minuten"], 60);
    assert_eq!(
        karten[0]["body"],
        "Erinnerung: „Grillen“ beginnt in 1 Stunde."
    );
    assert_eq!(karten[0]["event"]["title"], "Grillen");

    assert_eq!(probe.push_anzahl(), 2);
    let an_b = probe.push_an(&w.b);
    assert_eq!(an_b[0]["body"], "Grillen beginnt in 1 Stunde");
    assert_eq!(an_b[0]["url"], format!("/chats/{ab}"));
    let an_a = probe.push_an(&w.a);
    assert_eq!(an_a.len(), 1, "der Ersteller bekommt Push");
    assert_eq!(an_a[0]["url"], format!("/kalender/termin/{id}"));

    // Ein zweiter Durchgang im selben Fenster und später: nichts mehr.
    assert_eq!(probe.durchgang(beginn() - min(30)).await, Bilanz::default());
    assert_eq!(probe.karten_zahl().await, 1);
    assert_eq!(probe.push_anzahl(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn nach_einer_stunde_ist_die_erinnerung_veraltet() {
    let probe = probe_oder_uebersprungen!("v2");
    let w = welt(&probe).await;
    // 180 Minuten vorher fällig; eine Minute zu spät für das Fenster.
    probe
        .termin(&w.a, &ids(&[&w.b]), &[180], true, beginn(), false)
        .await;
    let zu_spaet = probe.durchgang(beginn() - min(180) + min(61)).await;
    assert_eq!(zu_spaet, Bilanz::default());
    assert_eq!(probe.push_anzahl(), 0);
    // Genau 60 Minuten nach der Fälligkeit gilt noch.
    let gerade = probe.durchgang(beginn() - min(180) + min(60)).await;
    assert_eq!(gerade.beansprucht, 2, "{gerade:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn ab_dem_beginn_und_ohne_minuten_nie() {
    let probe = probe_oder_uebersprungen!("v3");
    let w = welt(&probe).await;
    probe
        .termin(&w.a, &ids(&[&w.b]), &[0, 10], true, beginn(), false)
        .await;
    // Null Minuten ist ein Fenster der Länge null; die 10 sind am Beginn vorbei.
    assert_eq!(probe.durchgang(beginn()).await, Bilanz::default());
    assert_eq!(probe.durchgang(beginn() + min(5)).await, Bilanz::default());
}

#[tokio::test(flavor = "multi_thread")]
async fn mehrere_erinnerungen_kommen_nacheinander() {
    let probe = probe_oder_uebersprungen!("v4");
    let w = welt(&probe).await;
    let id = probe
        .termin(&w.a, &ids(&[&w.b]), &[1440, 60], true, beginn(), false)
        .await;
    let ab = probe.einzelchat(&id, &w.b).await;
    probe.durchgang(beginn() - min(1440)).await;
    probe.durchgang(beginn() - min(60)).await;
    let karten = probe.karten(&w.b, &ab, &id).await;
    let mut minuten: Vec<i64> = karten
        .iter()
        .map(|karte| karte["metadata"]["erinnerung"]["minuten"].as_i64().unwrap())
        .collect();
    minuten.sort();
    assert_eq!(minuten, vec![60, 1440]);
}

#[tokio::test(flavor = "multi_thread")]
async fn ganztaegig_bezieht_sich_auf_beginn_minus_zwoelf_stunden() {
    let probe = probe_oder_uebersprungen!("v5");
    let w = welt(&probe).await;
    // „12:00“ des Tages; der Tag beginnt zwölf Stunden früher, 60 Minuten davor
    // ist die Erinnerung fällig.
    probe
        .termin(&w.a, &ids(&[&w.b]), &[60], true, beginn(), true)
        .await;
    let faellig = beginn() - Duration::hours(12) - min(60);
    assert_eq!(
        probe.durchgang(faellig - Duration::seconds(1)).await,
        Bilanz::default()
    );
    assert_eq!(probe.durchgang(faellig).await.beansprucht, 2);
}

// ---------------------------------------------------------------------------
// Einmal, verschoben, nicht rückwirkend
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn ein_verschobener_termin_erinnert_erneut() {
    let probe = probe_oder_uebersprungen!("v6");
    let w = welt(&probe).await;
    let id = probe
        .termin(&w.a, &ids(&[&w.b]), &[60], true, beginn(), false)
        .await;
    assert_eq!(probe.durchgang(beginn() - min(60)).await.beansprucht, 2);

    let neu = beginn() + Duration::days(1);
    probe
        .sql(&format!(
            "update calendar_events set starts_at = '{}' where id = '{id}'",
            neu.to_rfc3339()
        ))
        .await;
    // Der alte Beginn erinnert nicht noch einmal …
    assert_eq!(probe.durchgang(beginn() - min(30)).await, Bilanz::default());
    // … der neue schon.
    let bilanz = probe.durchgang(neu - min(60)).await;
    assert_eq!(bilanz.beansprucht, 2, "{bilanz:?}");
    assert_eq!(
        probe
            .zahl("select count(*) from event_vorab_erinnerungen")
            .await,
        4
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn ein_spaet_angelegter_termin_erinnert_nicht_rueckwirkend() {
    let probe = probe_oder_uebersprungen!("v7");
    let w = welt(&probe).await;
    let id = probe
        .termin(&w.a, &ids(&[&w.b]), &[60, 10], true, beginn(), false)
        .await;
    // Angelegt 30 Minuten vor dem Beginn: die 60er war schon vorbei, die 10er nicht.
    probe
        .sql(&format!(
            "update calendar_events set created_at = '{}' where id = '{id}'",
            (beginn() - min(30)).to_rfc3339()
        ))
        .await;
    assert_eq!(probe.durchgang(beginn() - min(30)).await, Bilanz::default());
    let bilanz = probe.durchgang(beginn() - min(10)).await;
    assert_eq!(bilanz.beansprucht, 2, "{bilanz:?}");
    let minuten: Vec<i32> =
        sqlx::query_scalar("select distinct minuten from event_vorab_erinnerungen")
            .fetch_all(&probe.state.pool)
            .await
            .unwrap();
    assert_eq!(minuten, vec![10]);
}

#[tokio::test(flavor = "multi_thread")]
async fn gleichzeitige_instanzen_senden_nur_einmal() {
    let probe = probe_oder_uebersprungen!("v8");
    let w = welt(&probe).await;
    let id = probe
        .termin(&w.a, &ids(&[&w.b, &w.c]), &[60], true, beginn(), false)
        .await;
    let zweite = AppState::from_pool(
        pool_fuer(&probe.url, &probe.schema).await,
        probe.config.clone(),
    )
    .await
    .expect("zweiter Zustand");
    let jetzt = beginn() - min(60);
    let (eins, zwei) = tokio::join!(
        vorab::durchgang(&probe.state, jetzt),
        vorab::durchgang(&zweite, jetzt)
    );
    assert_eq!(eins.beansprucht + zwei.beansprucht, 3, "{eins:?} {zwei:?}");
    assert_eq!(probe.karten_zahl().await, 2);
    let _ = id;
}

// ---------------------------------------------------------------------------
// Wer
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn nicht_an_wer_abgesagt_hat() {
    let probe = probe_oder_uebersprungen!("v9");
    let w = welt(&probe).await;
    let id = probe
        .termin(
            &w.a,
            &ids(&[&w.b, &w.c, &w.d]),
            &[60],
            true,
            beginn(),
            false,
        )
        .await;
    probe.rsvp(&w.b, &id, "yes").await;
    probe.rsvp(&w.c, &id, "no").await;
    probe.rsvp(&w.d, &id, "maybe").await;
    let bilanz = probe.durchgang(beginn() - min(60)).await;
    assert_eq!(bilanz.beansprucht, 3, "Ersteller, Bodo, Dora: {bilanz:?}");
    assert!(probe.push_an(&w.c).is_empty());
    assert_eq!(probe.push_an(&w.b).len(), 1);
    assert_eq!(probe.push_an(&w.d).len(), 1);
    let ac = probe.einzelchat(&id, &w.c).await;
    assert!(probe.karten(&w.c, &ac, &id).await.is_empty());
}

// ---------------------------------------------------------------------------
// Karte nur im vorhandenen Einzelchat
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn ohne_einzelchat_nur_push_und_kein_neuer_chat() {
    let probe = probe_oder_uebersprungen!("v10");
    let w = welt(&probe).await;
    // Gruppenchat der vier; der Termin geht ohne Einzelchats hinaus.
    let (status, gruppe) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&w.a.token),
            Some(json!({
                "type": "group", "title": "Skat",
                "memberIds": [w.b.id, w.c.id, w.d.id],
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{gruppe}");
    let id = probe
        .termin(&w.a, &ids(&[&w.b, &w.c]), &[60], false, beginn(), false)
        .await;
    let chats_vorher = probe.zahl("select count(*) from conversations").await;
    let nachrichten_vorher = probe.zahl("select count(*) from messages").await;

    let bilanz = probe.durchgang(beginn() - min(60)).await;
    assert_eq!(bilanz.beansprucht, 3, "{bilanz:?}");
    assert_eq!(bilanz.karten, 0, "{bilanz:?}");
    assert_eq!(bilanz.ohne_karte, 3, "{bilanz:?}");
    assert_eq!(probe.push_anzahl(), 3, "alle drei bekommen Push");
    assert_eq!(
        probe.zahl("select count(*) from conversations").await,
        chats_vorher,
        "es entsteht kein Chat"
    );
    assert_eq!(
        probe.zahl("select count(*) from messages").await,
        nachrichten_vorher,
        "nirgends wird gepostet"
    );
    let gruppe_id = gruppe["id"].as_str().unwrap();
    assert!(probe.karten(&w.b, gruppe_id, &id).await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn ein_stummer_chat_und_push_aus_unterdruecken_nur_die_mitteilung() {
    let probe = probe_oder_uebersprungen!("v11");
    let w = welt(&probe).await;
    let id = probe
        .termin(&w.a, &ids(&[&w.b, &w.c]), &[60], true, beginn(), false)
        .await;
    let ab = probe.einzelchat(&id, &w.b).await;
    probe
        .sql(&format!(
            "update conversation_members set muted_until = now() + interval '10 years'
              where conversation_id = '{ab}' and user_id = '{}'",
            w.b.id
        ))
        .await;
    probe
        .sql(&format!(
            "update users set settings = settings ||
               '{{\"notifications\":{{\"previews\":false}}}}'::jsonb where id = '{}'",
            w.c.id
        ))
        .await;
    probe.durchgang(beginn() - min(60)).await;
    assert!(probe.push_an(&w.b).is_empty(), "Chat stummgeschaltet");
    assert_eq!(
        probe.karten(&w.b, &ab, &id).await.len(),
        1,
        "Karte trotzdem"
    );
    let an_c = probe.push_an(&w.c);
    assert_eq!(an_c[0]["body"], "Erinnerung an einen Termin");
}

// ---------------------------------------------------------------------------
// Aufräumen
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn loeschen_absagen_und_ausladen_raeumen_die_karten_auf() {
    let probe = probe_oder_uebersprungen!("v12");
    let w = welt(&probe).await;
    let id = probe
        .termin(
            &w.a,
            &ids(&[&w.b, &w.c, &w.d]),
            &[60],
            true,
            beginn(),
            false,
        )
        .await;
    probe.durchgang(beginn() - min(60)).await;
    assert_eq!(probe.karten_zahl().await, 3);

    // Ausladen: nur Cleos Karte und Zeile gehen.
    let (status, antwort) = probe
        .call(
            "DELETE",
            &format!("/api/v1/calendar/events/{id}/attendees/{}", w.c.id),
            Some(&w.a.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    assert_eq!(probe.karten_zahl().await, 2);
    assert_eq!(
        probe
            .zahl(&format!(
                "select count(*) from event_vorab_erinnerungen where user_id = '{}'",
                w.c.id
            ))
            .await,
        0
    );

    // Absagen: alle übrigen Karten weg.
    let (status, antwort) = probe
        .call(
            "PATCH",
            &format!("/api/v1/calendar/events/{id}"),
            Some(&w.a.token),
            Some(json!({ "status": "cancelled" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    assert_eq!(probe.karten_zahl().await, 0);
    assert_eq!(
        probe
            .zahl("select count(*) from event_vorab_erinnerungen")
            .await,
        0
    );
    // Ein abgesagter Termin erinnert nicht.
    assert_eq!(probe.durchgang(beginn() - min(59)).await, Bilanz::default());

    // Löschen: ein zweiter Termin, dessen Karten mit ihm verschwinden.
    let zwei = probe
        .termin(&w.a, &ids(&[&w.b]), &[120], true, beginn(), false)
        .await;
    probe.durchgang(beginn() - min(120)).await;
    assert_eq!(probe.karten_zahl().await, 1);
    let (status, antwort) = probe
        .call(
            "DELETE",
            &format!("/api/v1/calendar/events/{zwei}"),
            Some(&w.a.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{antwort}");
    assert_eq!(probe.karten_zahl().await, 0);
}
