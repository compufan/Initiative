//! Erinnern: wer auf eine Einladung nicht antwortet, wird in seinem Einzelchat
//! mit dem Ersteller erinnert – wenn der Ersteller es für diesen Termin will.
//!
//! Die Regeln, die hier geprüft werden:
//!
//!   * **Wann**: nach dem Abstand, nicht vorher; im gleichen Abstand; höchstens
//!     so oft, wie eingestellt (und nie mehr als zehnmal); nie in den letzten zwei
//!     Stunden vor dem Beginn.
//!   * **Wer**: nur Ausstehende, nur im Einzelchat, nur dort, wo die Einzelkarte
//!     ankam – nie der Gruppenchat, nie der Ersteller.
//!   * **Wann nicht mehr**: bei jeder Antwort, beim Ausladen, Löschen, Absagen.
//!   * **Genau einmal**: mehrere gleichzeitige Durchgänge (mehrere Instanzen des
//!     Servers) senden jede Erinnerung nur einmal.
//!   * **Eine kaputte Zeile hält die anderen nicht auf**; Offenes wird nachgeholt.
//!   * **Eine Mitteilung je Erinnerung**, nach den Einstellungen der Person.
//!   * **Rückwärtsverträglich**: Termine ohne Einstellung bleiben stumm.
//!
//! # Warum jeder Test sein eigenes Schema bekommt
//!
//! Der Dienst fragt die Datenbank nach ALLEN fälligen Terminen, nicht nach denen
//! eines Nutzers. In der geteilten Entwicklungsdatenbank stünden darin die
//! Termine aller anderen Testläufe – und der Dienst sendete ihnen Erinnerungen.
//! Ein eigenes Postgres-Schema je Test (`set search_path`, Migrationen hinein)
//! macht „alle“ zu „die dieses Tests“ (derselbe Weg wie `tests/auslagern.rs`).
//!
//! # Warum die Zeit ein Parameter ist
//!
//! Die Erinnerungen werden nach Stunden fällig. Die Tests rufen `durchgang` mit
//! einer frei gewählten Uhr auf und legen Einladezeitpunkt und Beginn vorher per
//! SQL auf feste Werte – so sind Grenzen sekundengenau prüfbar. Die Mitteilungen
//! werden nicht gesendet, sondern am Ausgang mitgeschrieben
//! (`PushService::mitschneiden`).

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use chrono::{DateTime, Duration, TimeZone, Utc};
use http_body_util::BodyExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;
use tower::ServiceExt;
use uuid::Uuid;

use initiative_api::config::Config;
use initiative_api::push::Mitschnitt;
use initiative_api::services::erinnern::{self, Bilanz};
use initiative_api::state::AppState;
use initiative_api::{app, MIGRATOR};

const PASSWORT: &str = "richtigespasswort";

/// Der feste Bezugspunkt: Hier wurde eingeladen.
fn t0() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2030, 3, 1, 10, 0, 0).unwrap()
}

fn std(stunden: i64) -> Duration {
    Duration::hours(stunden)
}

struct Probe {
    router: Router,
    state: AppState,
    push: Mitschnitt,
    config: Arc<Config>,
    url: String,
    schema: String,
}

/// Schliesst den Verbindungsvorrat, wenn der Test zu Ende ist – sonst behält
/// jeder Test seine Verbindungen bis zum Ende des ganzen Laufs.
impl Drop for Probe {
    fn drop(&mut self) {
        let vorrat = self.state.pool.clone();
        tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(vorrat.close()));
    }
}

struct Konto {
    token: String,
    id: String,
    name: String,
}

impl Konto {
    fn uuid(&self) -> Uuid {
        self.id.parse().unwrap()
    }
}

struct Hoerer {
    empfaenger: UnboundedReceiver<String>,
}

impl Hoerer {
    /// Alles, was seit dem letzten Mal angekommen ist.
    fn alles(&mut self) -> Vec<Value> {
        let mut gesammelt = Vec::new();
        while let Ok(rahmen) = self.empfaenger.try_recv() {
            gesammelt.push(serde_json::from_str(&rahmen).unwrap());
        }
        gesammelt
    }
}

fn vom_typ(rahmen: &[Value], art: &str) -> Vec<Value> {
    rahmen
        .iter()
        .filter(|rahmen| rahmen["type"] == art)
        .cloned()
        .collect()
}

/// Eine Zeile aus `event_erinnerungen`.
#[derive(Debug, Clone, sqlx::FromRow)]
struct Zeile {
    person: Uuid,
    nummer: i16,
    nachricht: Option<Uuid>,
    beansprucht: DateTime<Utc>,
    versuche: i16,
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
                Some(json!({
                    "username": name,
                    "displayName": name,
                    "password": PASSWORT,
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        Konto {
            token: body["accessToken"].as_str().unwrap().to_string(),
            id: body["user"]["id"].as_str().unwrap().to_string(),
            name: name.to_string(),
        }
    }

    /// Ein Konto ohne Anmeldung – für die vielen Personen, die nur eingeladen
    /// werden.
    async fn nutzer(&self, name: &str) -> Uuid {
        let id = Uuid::now_v7();
        sqlx::query(
            "insert into users (id, username, display_name, password_hash, calendar_token)
             values ($1, $2, $2, 'x', $3)",
        )
        .bind(id)
        .bind(name)
        .bind(Uuid::now_v7().to_string())
        .execute(&self.state.pool)
        .await
        .unwrap();
        id
    }

    async fn gruppe(&self, inhaber: &Konto, titel: &str, mitglieder: &[&Konto]) -> String {
        let ids: Vec<&str> = mitglieder.iter().map(|konto| konto.id.as_str()).collect();
        let (status, chat) = self
            .call(
                "POST",
                "/api/v1/conversations",
                Some(&inhaber.token),
                Some(json!({ "type": "group", "title": titel, "memberIds": ids })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{chat}");
        chat["id"].as_str().unwrap().to_string()
    }

    /// Ein Termin mit Einzelkarten für alle Eingeladenen, mit Erinnern; Einladezeit
    /// und Beginn liegen danach fest (`t0` und `beginn`).
    async fn termin(
        &self,
        von: &Konto,
        personen: &[Uuid],
        erinnern: Value,
        beginn: DateTime<Utc>,
    ) -> String {
        let termin = self
            .termin_roh(von, personen, erinnern, true, "Grillen")
            .await;
        let id = termin["id"].as_str().unwrap().to_string();
        self.zeiten(&id, t0(), beginn, false).await;
        id
    }

    async fn termin_roh(
        &self,
        von: &Konto,
        personen: &[Uuid],
        erinnern: Value,
        einzelchats: bool,
        titel: &str,
    ) -> Value {
        let beginn = Utc::now() + Duration::days(3);
        let mut koerper = json!({
            "title": titel,
            "startsAt": beginn,
            "endsAt": beginn + Duration::hours(2),
            "attendeeIds": personen,
            "zustellung": { "senden": true, "einzelchats": einzelchats, "gruppenChatIds": [] },
        });
        if !erinnern.is_null() {
            koerper["erinnern"] = erinnern;
        }
        let (status, termin) = self
            .call(
                "POST",
                "/api/v1/calendar/events",
                Some(&von.token),
                Some(koerper),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{termin}");
        termin
    }

    /// Legt Einladezeitpunkt, Uhr der Einstellung und Beginn auf feste Werte.
    async fn zeiten(
        &self,
        termin: &str,
        ab: DateTime<Utc>,
        beginn: DateTime<Utc>,
        ganztaegig: bool,
    ) {
        let id: Uuid = termin.parse().unwrap();
        sqlx::query("update event_attendees set eingeladen_am = $2 where event_id = $1")
            .bind(id)
            .bind(ab)
            .execute(&self.state.pool)
            .await
            .unwrap();
        sqlx::query(
            "update calendar_events
                set erinnern_seit = case when erinnern_nach_std is null then null else $2 end,
                    starts_at = $3, ends_at = $3 + interval '1 hour', all_day = $4
              where id = $1",
        )
        .bind(id)
        .bind(ab)
        .bind(beginn)
        .bind(ganztaegig)
        .execute(&self.state.pool)
        .await
        .unwrap();
    }

    /// Stellt die Uhr der Einstellung, als hätte die Datenbank in diesem Augenblick
    /// gespeichert: Die Tests rechnen mit einer erfundenen Uhr, `now()` der
    /// Datenbank ist die echte.
    async fn uhr_stellen(&self, termin: &str, zeit: DateTime<Utc>) {
        sqlx::query(
            "update calendar_events set erinnern_seit = $2
              where id = $1 and erinnern_seit is not null",
        )
        .bind(termin.parse::<Uuid>().unwrap())
        .bind(zeit)
        .execute(&self.state.pool)
        .await
        .unwrap();
    }

    async fn durchgang(&self, jetzt: DateTime<Utc>) -> Bilanz {
        erinnern::durchgang(&self.state, jetzt).await
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

    async fn aendern(&self, wer: &Konto, termin: &str, body: Value) -> (StatusCode, Value) {
        self.call(
            "PATCH",
            &format!("/api/v1/calendar/events/{termin}"),
            Some(&wer.token),
            Some(body),
        )
        .await
    }

    async fn holen(&self, wer: &Konto, termin: &str) -> (StatusCode, Value) {
        self.call(
            "GET",
            &format!("/api/v1/calendar/events/{termin}"),
            Some(&wer.token),
            None,
        )
        .await
    }

    async fn stand(&self, wer: &Konto, termin: &str) -> (StatusCode, Value) {
        self.call(
            "GET",
            &format!("/api/v1/calendar/events/{termin}/erinnerungen"),
            Some(&wer.token),
            None,
        )
        .await
    }

    async fn ausladen(&self, wer: &Konto, termin: &str, person: &Konto) {
        let (status, antwort) = self
            .call(
                "DELETE",
                &format!("/api/v1/calendar/events/{termin}/attendees/{}", person.id),
                Some(&wer.token),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{antwort}");
    }

    async fn loeschen(&self, wer: &Konto, termin: &str) {
        let (status, antwort) = self
            .call(
                "DELETE",
                &format!("/api/v1/calendar/events/{termin}"),
                Some(&wer.token),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::NO_CONTENT, "{antwort}");
    }

    async fn nachrichten(&self, wer: &Konto, chat: &str) -> Vec<Value> {
        let (status, liste) = self
            .call(
                "GET",
                &format!("/api/v1/conversations/{chat}/messages"),
                Some(&wer.token),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{liste}");
        liste["items"].as_array().cloned().unwrap_or_default()
    }

    /// Die (nicht gelöschten) Erinnerungskarten zu einem Termin in einem Chat.
    async fn erinnerungskarten(&self, wer: &Konto, chat: &str, termin: &str) -> Vec<Value> {
        self.nachrichten(wer, chat)
            .await
            .into_iter()
            .filter(|nachricht| {
                nachricht["type"] == "event"
                    && nachricht["deletedAt"].is_null()
                    && nachricht["metadata"]["eventId"] == termin
                    && !nachricht["metadata"]["erinnerung"].is_null()
            })
            .collect()
    }

    /// Alle Erinnerungskarten eines Termins laut Nachrichtentabelle – nicht
    /// gelöschte.
    async fn karten_zahl(&self, termin: &str) -> i64 {
        sqlx::query_scalar(
            "select count(*) from messages
              where type = 'event' and deleted_at is null
                and metadata ->> 'eventId' = $1 and metadata ? 'erinnerung'",
        )
        .bind(termin)
        .fetch_one(&self.state.pool)
        .await
        .unwrap()
    }

    /// Der Einzelchat, in dem die Einzelkarte dieser Person steht.
    async fn einzelchat(&self, termin: &str, person: Uuid) -> String {
        sqlx::query_scalar::<_, Uuid>(
            "select conversation_id from event_placements
              where event_id = $1 and art = 'einzel' and user_id = $2",
        )
        .bind(termin.parse::<Uuid>().unwrap())
        .bind(person)
        .fetch_one(&self.state.pool)
        .await
        .expect("Einzelkarte")
        .to_string()
    }

    async fn zeilen(&self, termin: &str) -> Vec<Zeile> {
        sqlx::query_as::<_, Zeile>(
            "select user_id as person, nummer, message_id as nachricht,
                    beansprucht_am as beansprucht, versuche
               from event_erinnerungen where event_id = $1
              order by user_id, nummer",
        )
        .bind(termin.parse::<Uuid>().unwrap())
        .fetch_all(&self.state.pool)
        .await
        .unwrap()
    }

    async fn zeilen_von(&self, termin: &str, person: &Konto) -> Vec<Zeile> {
        self.zeilen(termin)
            .await
            .into_iter()
            .filter(|zeile| zeile.person == person.uuid())
            .collect()
    }

    async fn sql(&self, anweisung: &str) {
        sqlx::query(anweisung)
            .execute(&self.state.pool)
            .await
            .unwrap_or_else(|fehler| panic!("{anweisung}: {fehler}"));
    }

    fn hoeren(&self, wer: &Konto) -> Hoerer {
        let (_, empfaenger, _) = self.state.hub.register(wer.uuid());
        Hoerer { empfaenger }
    }

    fn push_leeren(&self) {
        self.push.lock().unwrap().clear();
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

    /// Eine zweite „Instanz“ des Servers: eigener Zustand, eigener Vorrat,
    /// dieselbe Datenbank.
    async fn zweite_instanz(&self) -> AppState {
        let pool = pool_fuer(&self.url, &self.schema).await;
        AppState::from_pool(pool, self.config.clone())
            .await
            .expect("zweiter Zustand")
    }
}

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

/// Der Aufbau muss nacheinander laufen – die Umgebung gehört dem Prozess.
static AUFBAU: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn aufbauen(name: &str) -> Option<Probe> {
    let url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;
    let schema = format!("erinnerprobe_{name}");

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
            format!("./.data/erinnern-{}", Uuid::now_v7().simple()),
        );
        std::env::set_var("PUBLIC_API_URL", "http://localhost:8080");
        std::env::set_var("PUBLIC_APP_URL", "http://localhost:5173");
        Arc::new(Config::from_env().expect("config"))
    };

    // Verworfen und neu angelegt, nicht am Ende aufgeräumt: Ein Lauf, der
    // mittendrin abbricht, hinterlässt sonst Zeilen, und der nächste soll davon
    // nichts merken.
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

/// Ein Ersteller, drei Eingeladene und ein Gruppenchat.
struct Welt {
    a: Konto,
    b: Konto,
    c: Konto,
    d: Konto,
}

async fn welt(probe: &Probe) -> Welt {
    // Ein erstes Konto, das nichts mit den Tests zu tun hat: Das erste Konto
    // eines leeren Schemas ist Verwalter und liesse sich nicht löschen.
    probe.konto("wurzel").await;
    let a = probe.konto("anna").await;
    let b = probe.konto("bodo").await;
    let c = probe.konto("cleo").await;
    let d = probe.konto("dora").await;
    probe.gruppe(&a, "Skatrunde", &[&b, &c, &d]).await;
    Welt { a, b, c, d }
}

fn ids(personen: &[&Konto]) -> Vec<Uuid> {
    personen.iter().map(|konto| konto.uuid()).collect()
}

fn erinnern(nach_stunden: i64, anzahl: Option<i64>) -> Value {
    json!({ "nachStunden": nach_stunden, "anzahl": anzahl })
}

// ---------------------------------------------------------------------------
// Wann
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn faellig_nach_der_frist_und_nicht_vorher() {
    let Some(probe) = aufbauen("r1").await else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – übersprungen");
        return;
    };
    let w = welt(&probe).await;
    let id = probe
        .termin(
            &w.a,
            &ids(&[&w.b, &w.c]),
            erinnern(24, Some(3)),
            t0() + std(240),
        )
        .await;
    let ab = probe.einzelchat(&id, w.b.uuid()).await;
    let ac = probe.einzelchat(&id, w.c.uuid()).await;

    // Eine Minute vor der Frist: nichts.
    let zu_frueh = probe.durchgang(t0() + std(24) - Duration::minutes(1)).await;
    assert_eq!(zu_frueh, Bilanz::default());
    assert_eq!(probe.karten_zahl(&id).await, 0);

    // Auf die Sekunde: genau eine Karte je offener Person – im Einzelchat.
    let bilanz = probe.durchgang(t0() + std(24)).await;
    assert_eq!(bilanz.beansprucht, 2, "{bilanz:?}");
    assert_eq!(bilanz.zugestellt, 2, "{bilanz:?}");
    assert_eq!(bilanz.gescheitert, 0, "{bilanz:?}");

    let karten = probe.erinnerungskarten(&w.b, &ab, &id).await;
    assert_eq!(karten.len(), 1, "{karten:?}");
    let karte = &karten[0];
    assert_eq!(karte["type"], "event");
    assert_eq!(
        karte["senderId"],
        w.a.id.as_str(),
        "Absender ist der Ersteller"
    );
    assert_eq!(
        karte["body"],
        "Erinnerung: Du hast noch nicht auf „Grillen“ geantwortet."
    );
    assert_eq!(karte["metadata"]["erinnerung"]["nummer"], 1);
    assert_eq!(
        karte["event"]["title"], "Grillen",
        "die Karte trägt den Termin"
    );
    assert_eq!(probe.erinnerungskarten(&w.c, &ac, &id).await.len(), 1);

    // Die Zeilen tragen ihre Nachricht.
    let zeilen = probe.zeilen(&id).await;
    assert_eq!(zeilen.len(), 2);
    assert!(zeilen.iter().all(|zeile| zeile.nachricht.is_some()));
    assert!(zeilen.iter().all(|zeile| zeile.nummer == 1));
    assert!(zeilen
        .iter()
        .all(|zeile| zeile.beansprucht == t0() + std(24)));

    // Ein Termin ohne Einstellung (alt, Bestand) erinnert nie.
    let alt = probe
        .termin_roh(&w.a, &ids(&[&w.b, &w.c]), Value::Null, true, "Alt")
        .await;
    let alt_id = alt["id"].as_str().unwrap();
    assert!(alt["erinnern"].is_null(), "{alt}");
    probe.zeiten(alt_id, t0(), t0() + std(240), false).await;
    // Der erste Termin erinnert weiter (zweimal nachgefasst), der alte nie.
    let spaeter = probe.durchgang(t0() + std(24 * 9)).await;
    assert_eq!(spaeter.beansprucht, 2, "{spaeter:?}");
    assert!(probe.zeilen(alt_id).await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn zaehlt_im_gleichen_abstand_und_hoert_bei_der_anzahl_auf() {
    let Some(probe) = aufbauen("r2").await else {
        return;
    };
    let w = welt(&probe).await;
    let id = probe
        .termin(&w.a, &ids(&[&w.b]), erinnern(24, Some(3)), t0() + std(480))
        .await;

    // Dreimal: bei +24, +48 und +72 Stunden – Nummer 1 bis 3, dann nichts mehr.
    for (nummer, stunden) in [(1, 24), (2, 48), (3, 72)] {
        let bilanz = probe.durchgang(t0() + std(stunden)).await;
        assert_eq!(bilanz.zugestellt, 1, "Nummer {nummer}: {bilanz:?}");
        let zeilen = probe.zeilen_von(&id, &w.b).await;
        assert_eq!(zeilen.len() as i16, nummer);
        assert_eq!(zeilen.last().unwrap().nummer, nummer);
    }
    let danach = probe.durchgang(t0() + std(96)).await;
    assert_eq!(danach, Bilanz::default());
    assert_eq!(probe.karten_zahl(&id).await, 3);

    // Der Abstand rechnet ab der tatsächlichen Beanspruchung, nicht ab der
    // geplanten: Kommt die erste erst nach 25 Stunden, kommt die zweite nach 49.
    let spaet = probe
        .termin(&w.a, &ids(&[&w.c]), erinnern(24, Some(5)), t0() + std(480))
        .await;
    assert_eq!(probe.durchgang(t0() + std(25)).await.zugestellt, 1);
    assert_eq!(probe.durchgang(t0() + std(48)).await.beansprucht, 0);
    assert_eq!(probe.durchgang(t0() + std(49)).await.zugestellt, 1);
    let nummern: Vec<i16> = probe
        .zeilen_von(&spaet, &w.c)
        .await
        .iter()
        .map(|zeile| zeile.nummer)
        .collect();
    assert_eq!(nummern, vec![1, 2]);

    // „Bis zum Termin“ bei einem sehr fernen Termin: genau zehn, dann nichts.
    let fern = probe
        .termin(
            &w.a,
            &ids(&[&w.d]),
            json!({ "nachStunden": 12, "anzahl": null }),
            t0() + std(24 * 400),
        )
        .await;
    for runde in 1..=14 {
        probe.durchgang(t0() + std(12 * runde)).await;
    }
    assert_eq!(probe.zeilen_von(&fern, &w.d).await.len(), 10);
    let nummern: Vec<i16> = probe
        .zeilen_von(&fern, &w.d)
        .await
        .iter()
        .map(|zeile| zeile.nummer)
        .collect();
    assert_eq!(nummern, (1..=10).collect::<Vec<i16>>());
}

// ---------------------------------------------------------------------------
// Wann nicht mehr
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn jede_antwort_beendet_das_erinnern_auch_vielleicht() {
    let Some(probe) = aufbauen("r3a").await else {
        return;
    };
    let w = welt(&probe).await;
    let id = probe
        .termin(
            &w.a,
            &ids(&[&w.b, &w.c, &w.d]),
            erinnern(24, Some(5)),
            t0() + std(480),
        )
        .await;

    // Vor der Fälligkeit geantwortet: Ja, Nein, Vielleicht – keiner wird erinnert.
    probe.rsvp(&w.b, &id, "yes").await;
    probe.rsvp(&w.c, &id, "no").await;
    probe.rsvp(&w.d, &id, "maybe").await;
    let bilanz = probe.durchgang(t0() + std(24)).await;
    assert_eq!(bilanz, Bilanz::default(), "{bilanz:?}");
    assert_eq!(probe.karten_zahl(&id).await, 0);

    // Wer die Antwort zurücknimmt, ist wieder offen – und wird erinnert, aber
    // frühestens eine Frist nach der LETZTEN Erinnerung (hier: der Einladung).
    probe.rsvp(&w.b, &id, "pending").await;
    assert_eq!(probe.durchgang(t0() + std(24)).await.zugestellt, 1);
    assert_eq!(probe.zeilen_von(&id, &w.b).await.len(), 1);

    // Nach der ersten Erinnerung antwortet B: Keine weitere.
    probe.rsvp(&w.b, &id, "maybe").await;
    assert_eq!(probe.durchgang(t0() + std(48)).await, Bilanz::default());
    // B nimmt die Antwort wieder zurück: frühestens eine Frist nach der
    // letzten Erinnerung (+24 h), die Zählung läuft weiter (Nummer 2).
    probe.rsvp(&w.b, &id, "pending").await;
    assert_eq!(
        probe.durchgang(t0() + std(48) - Duration::seconds(1)).await,
        Bilanz::default()
    );
    assert_eq!(probe.durchgang(t0() + std(48)).await.zugestellt, 1);
    assert_eq!(probe.zeilen_von(&id, &w.b).await.last().unwrap().nummer, 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn ausladen_loeschen_absage_abstimmung_und_ersteller_beenden_es() {
    let Some(probe) = aufbauen("r3b").await else {
        return;
    };
    let w = welt(&probe).await;

    // ---- Ausladen --------------------------------------------------------
    let id = probe
        .termin(
            &w.a,
            &ids(&[&w.b, &w.c]),
            erinnern(24, Some(5)),
            t0() + std(480),
        )
        .await;
    assert_eq!(probe.durchgang(t0() + std(24)).await.zugestellt, 2);
    probe.ausladen(&w.a, &id, &w.b).await;
    assert!(probe.zeilen_von(&id, &w.b).await.is_empty());
    let bilanz = probe.durchgang(t0() + std(48)).await;
    assert_eq!(bilanz.zugestellt, 1, "nur noch C: {bilanz:?}");
    assert_eq!(probe.zeilen_von(&id, &w.c).await.len(), 2);

    // ---- Absage, Wiederaufnahme ------------------------------------------
    let (status, _) = probe
        .aendern(&w.a, &id, json!({ "status": "cancelled" }))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(probe.durchgang(t0() + std(72)).await, Bilanz::default());
    let (status, _) = probe
        .aendern(&w.a, &id, json!({ "status": "confirmed" }))
        .await;
    assert_eq!(status, StatusCode::OK);
    // Die Wiederaufnahme startet die Uhr neu – hier auf die erfundene Zeit
    // gestellt, in der die Datenbank gespeichert hätte.
    probe.uhr_stellen(&id, t0() + std(100)).await;
    assert_eq!(
        probe.durchgang(t0() + std(100) + std(23)).await,
        Bilanz::default(),
        "nicht sofort nach der Wiederaufnahme"
    );
    assert_eq!(
        probe.durchgang(t0() + std(100) + std(24)).await.zugestellt,
        1
    );

    // ---- Löschen ---------------------------------------------------------
    probe.loeschen(&w.a, &id).await;
    assert_eq!(probe.durchgang(t0() + std(300)).await, Bilanz::default());
    assert_eq!(probe.karten_zahl(&id).await, 0, "alle Karten sind gelöscht");

    // ---- In Abstimmung ---------------------------------------------------
    let abstimmung = probe
        .termin(&w.a, &ids(&[&w.b]), erinnern(24, Some(5)), t0() + std(480))
        .await;
    probe
        .sql(&format!(
            "update calendar_events set status = 'planning' where id = '{abstimmung}'"
        ))
        .await;
    assert_eq!(probe.durchgang(t0() + std(30)).await, Bilanz::default());
    probe
        .sql(&format!(
            "update calendar_events set status = 'confirmed' where id = '{abstimmung}'"
        ))
        .await;
    assert_eq!(probe.durchgang(t0() + std(30)).await.zugestellt, 1);

    // ---- Der Ersteller ist weg -------------------------------------------
    let ohne = probe
        .termin(&w.a, &ids(&[&w.d]), erinnern(24, Some(5)), t0() + std(480))
        .await;
    probe
        .sql(&format!(
            "update calendar_events set created_by = null where id = '{ohne}'"
        ))
        .await;
    assert_eq!(probe.durchgang(t0() + std(30)).await, Bilanz::default());
    assert!(probe.zeilen(&ohne).await.is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn der_beginn_setzt_die_grenze_zwei_stunden_vorher_inklusive() {
    let Some(probe) = aufbauen("r3d").await else {
        return;
    };
    let w = welt(&probe).await;

    // Beginn bei +26 h, Abstand 12 h: Die zweite Erinnerung läge bei +24 h, also
    // genau zwei Stunden vor dem Beginn – sie kommt noch. Eine Sekunde später
    // nicht mehr.
    let id = probe
        .termin(&w.a, &ids(&[&w.b]), erinnern(12, None), t0() + std(26))
        .await;
    assert_eq!(probe.durchgang(t0() + std(12)).await.zugestellt, 1);
    assert_eq!(
        probe.durchgang(t0() + std(24) + Duration::seconds(1)).await,
        Bilanz::default(),
        "eine Sekunde zu spät"
    );
    assert_eq!(probe.durchgang(t0() + std(24)).await.zugestellt, 1);
    assert_eq!(probe.zeilen_von(&id, &w.b).await.len(), 2);
    assert_eq!(probe.durchgang(t0() + std(36)).await, Bilanz::default());

    // Ganztägig: Der Tag beginnt zwölf Stunden vor dem gespeicherten Beginn. Bei
    // `starts_at = +40 h` ist das +28 h, die Grenze +26 h: Erinnerungen bei +12
    // und +24 h, die bei +36 h nicht.
    let ganztags = probe
        .termin(&w.a, &ids(&[&w.c]), erinnern(12, None), t0() + std(40))
        .await;
    probe.zeiten(&ganztags, t0(), t0() + std(40), true).await;
    assert_eq!(probe.durchgang(t0() + std(12)).await.zugestellt, 1);
    assert_eq!(probe.durchgang(t0() + std(24)).await.zugestellt, 1);
    assert_eq!(probe.durchgang(t0() + std(36)).await, Bilanz::default());

    // Der erste Termin einer Serie ist längst vorbei: nichts.
    let serie = probe
        .termin(&w.a, &ids(&[&w.d]), erinnern(12, None), t0() + std(10))
        .await;
    probe
        .sql(&format!(
            "update calendar_events set rrule = 'FREQ=WEEKLY' where id = '{serie}'"
        ))
        .await;
    assert_eq!(probe.durchgang(t0() + std(12)).await, Bilanz::default());
    assert_eq!(probe.durchgang(t0() + std(24 * 8)).await, Bilanz::default());
}

// ---------------------------------------------------------------------------
// Wer
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn nur_einzelchats_nur_ausstehende_nur_mit_einzelkarte() {
    let Some(probe) = aufbauen("r4").await else {
        return;
    };
    let w = welt(&probe).await;
    let e = probe.konto("emil").await;
    let g = probe.gruppe(&w.a, "Runde", &[&w.b, &w.c, &w.d]).await;

    // D bekommt keine Einzelkarte: Beim Anlegen sind Einzelchats aus. Danach
    // kommen B und C dazu – für sie sind sie an.
    let termin = probe
        .termin_roh(&w.a, &ids(&[&w.d]), erinnern(24, Some(3)), false, "Hütte")
        .await;
    let id = termin["id"].as_str().unwrap().to_string();
    let (status, antwort) = probe
        .aendern(
            &w.a,
            &id,
            json!({
                "attendeeIds": ids(&[&w.b, &w.c, &w.d]),
                "zustellung": { "senden": true, "einzelchats": true, "gruppenChatIds": [g] }
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    probe.zeiten(&id, t0(), t0() + std(480), false).await;

    let chats_vorher: i64 = sqlx::query_scalar("select count(*) from conversations")
        .fetch_one(&probe.state.pool)
        .await
        .unwrap();
    let gruppe_vorher = probe.nachrichten(&w.a, &g).await.len();

    // A ist laut Tabelle offen – und wird trotzdem nie erinnert.
    probe
        .sql(&format!(
            "update event_attendees set status = 'pending'
              where event_id = '{id}' and user_id = '{}'",
            w.a.id
        ))
        .await;
    // C hat den Einzelchat verlassen: Auch dann nichts.
    let ac = probe.einzelchat(&id, w.c.uuid()).await;
    probe
        .sql(&format!(
            "delete from conversation_members where conversation_id = '{ac}' and user_id = '{}'",
            w.c.id
        ))
        .await;

    let bilanz = probe.durchgang(t0() + std(24)).await;
    assert_eq!(bilanz.beansprucht, 1, "nur B: {bilanz:?}");
    assert_eq!(bilanz.zugestellt, 1, "{bilanz:?}");
    let ab = probe.einzelchat(&id, w.b.uuid()).await;
    assert_eq!(probe.erinnerungskarten(&w.b, &ab, &id).await.len(), 1);
    assert_eq!(probe.karten_zahl(&id).await, 1);

    // Der Gruppenchat bekommt nichts, es entsteht kein Chat.
    assert_eq!(probe.nachrichten(&w.a, &g).await.len(), gruppe_vorher);
    let chats_nachher: i64 = sqlx::query_scalar("select count(*) from conversations")
        .fetch_one(&probe.state.pool)
        .await
        .unwrap();
    assert_eq!(
        chats_nachher, chats_vorher,
        "der Dienst legt keinen Chat an"
    );
    assert!(probe.zeilen_von(&id, &w.d).await.is_empty());
    assert!(probe.zeilen_von(&id, &w.a).await.is_empty());

    // Der Ersteller hat den Einzelchat verlassen: Auch B wird nicht mehr erinnert.
    probe
        .sql(&format!(
            "delete from conversation_members where conversation_id = '{ab}' and user_id = '{}'",
            w.a.id
        ))
        .await;
    assert_eq!(probe.durchgang(t0() + std(48)).await, Bilanz::default());

    // Ein Fremder sieht die Karten nicht: Er ist nicht im Chat.
    let (status, _) = probe
        .call(
            "GET",
            &format!("/api/v1/conversations/{ab}/messages"),
            Some(&e.token),
            None,
        )
        .await;
    assert_ne!(status, StatusCode::OK);
}

// ---------------------------------------------------------------------------
// Genau einmal
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gleichzeitige_durchgaenge_beanspruchen_jede_erinnerung_einmal() {
    let Some(probe) = aufbauen("r5").await else {
        return;
    };
    let w = welt(&probe).await;
    let mut personen = Vec::new();
    for nummer in 0..20 {
        personen.push(probe.nutzer(&format!("gast{nummer:02}")).await);
    }
    let zweite = probe.zweite_instanz().await;

    // Zehn Abstände von 30 Tagen: Frühere Termine sind in Runde n noch nicht
    // wieder fällig, der neue schon.
    let jetzt = t0() + std(720);
    for runde in 0..8 {
        let id = probe
            .termin(
                &w.a,
                &personen,
                erinnern(720, Some(3)),
                t0() + std(24 * 400),
            )
            .await;
        let arbeiter: Vec<_> = (0..4)
            .map(|nummer| {
                let state = if nummer % 2 == 0 {
                    probe.state.clone()
                } else {
                    zweite.clone()
                };
                tokio::spawn(async move { erinnern::durchgang(&state, jetzt).await })
            })
            .collect();
        let mut beansprucht = 0;
        let mut zugestellt = 0;
        for arbeiter in arbeiter {
            let bilanz = arbeiter.await.expect("Durchgang");
            beansprucht += bilanz.beansprucht;
            zugestellt += bilanz.zugestellt;
        }
        assert_eq!(beansprucht, 20, "Runde {runde}: jede Person einmal");
        assert_eq!(zugestellt, 20, "Runde {runde}");

        // Je Person genau eine Zeile und genau eine Karte.
        let zeilen = probe.zeilen(&id).await;
        assert_eq!(zeilen.len(), 20, "Runde {runde}");
        let verschieden: std::collections::HashSet<Uuid> =
            zeilen.iter().map(|zeile| zeile.person).collect();
        assert_eq!(verschieden.len(), 20);
        assert!(zeilen
            .iter()
            .all(|zeile| zeile.nummer == 1 && zeile.nachricht.is_some()));
        assert_eq!(
            probe.karten_zahl(&id).await,
            20,
            "Runde {runde}: keine Doppelten"
        );
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn nach_langem_stillstand_kommt_eine_erinnerung_je_person() {
    let Some(probe) = aufbauen("r6").await else {
        return;
    };
    let w = welt(&probe).await;
    let id = probe
        .termin(
            &w.a,
            &ids(&[&w.b, &w.c]),
            erinnern(24, Some(5)),
            t0() + std(24 * 60),
        )
        .await;

    // Der Dienst stand dreissig Tage: Es kommt EINE je Person, nicht dreissig.
    let spaet = t0() + std(24 * 30);
    let bilanz = probe.durchgang(spaet).await;
    assert_eq!(bilanz.zugestellt, 2, "{bilanz:?}");
    assert_eq!(probe.durchgang(spaet).await, Bilanz::default());
    assert_eq!(
        probe.durchgang(spaet + std(23)).await,
        Bilanz::default(),
        "die Uhr startet bei der Beanspruchung neu"
    );
    let zweite = probe.durchgang(spaet + std(24)).await;
    assert_eq!(zweite.zugestellt, 2, "{zweite:?}");
    let nummern: Vec<i16> = probe
        .zeilen_von(&id, &w.b)
        .await
        .iter()
        .map(|zeile| zeile.nummer)
        .collect();
    assert_eq!(nummern, vec![1, 2]);
}

#[tokio::test(flavor = "multi_thread")]
async fn mehrere_termine_einer_person_kommen_in_getrennten_durchgaengen() {
    let Some(probe) = aufbauen("r7").await else {
        return;
    };
    let w = welt(&probe).await;
    let x = probe
        .termin(
            &w.a,
            &ids(&[&w.b, &w.c]),
            erinnern(24, Some(3)),
            t0() + std(480),
        )
        .await;
    let y = probe
        .termin(
            &w.a,
            &ids(&[&w.b, &w.c]),
            erinnern(24, Some(3)),
            t0() + std(480),
        )
        .await;

    let jetzt = t0() + std(24);
    let erste = probe.durchgang(jetzt).await;
    assert_eq!(erste.zugestellt, 2, "eine je Person: {erste:?}");
    let zweite = probe.durchgang(jetzt).await;
    assert_eq!(zweite.zugestellt, 2, "der zweite Termin: {zweite:?}");
    assert_eq!(probe.durchgang(jetzt).await, Bilanz::default());

    for person in [&w.b, &w.c] {
        let in_x = probe.zeilen_von(&x, person).await.len();
        let in_y = probe.zeilen_von(&y, person).await.len();
        assert_eq!((in_x, in_y), (1, 1), "{}", person.name);
    }
}

// ---------------------------------------------------------------------------
// Fehler und Nachholen
// ---------------------------------------------------------------------------

/// Lässt jedes Anlegen einer Nachricht in diesem Chat scheitern.
async fn chat_sperren(probe: &Probe, chat: &str) {
    probe
        .sql(&format!(
            "create or replace function sperre_chat() returns trigger language plpgsql as $f$
             begin
               if new.conversation_id = '{chat}'::uuid then raise exception 'gesperrt'; end if;
               return new;
             end $f$"
        ))
        .await;
    probe
        .sql(
            "create trigger sperre before insert on messages
             for each row execute function sperre_chat()",
        )
        .await;
}

async fn chat_freigeben(probe: &Probe) {
    probe.sql("drop trigger sperre on messages").await;
}

#[tokio::test(flavor = "multi_thread")]
async fn eine_kaputte_zeile_haelt_die_anderen_nicht_auf_und_wird_nachgeholt() {
    let Some(probe) = aufbauen("r8").await else {
        return;
    };
    let w = welt(&probe).await;
    let id = probe
        .termin(
            &w.a,
            &ids(&[&w.b, &w.c, &w.d]),
            erinnern(24, Some(3)),
            t0() + std(480),
        )
        .await;
    let ac = probe.einzelchat(&id, w.c.uuid()).await;
    chat_sperren(&probe, &ac).await;

    let bilanz = probe.durchgang(t0() + std(24)).await;
    assert_eq!(bilanz.beansprucht, 3, "{bilanz:?}");
    assert_eq!(bilanz.zugestellt, 2, "B und D: {bilanz:?}");
    assert_eq!(bilanz.gescheitert, 1, "C: {bilanz:?}");
    let zeilen_c = probe.zeilen_von(&id, &w.c).await;
    assert_eq!(zeilen_c.len(), 1);
    assert!(zeilen_c[0].nachricht.is_none(), "die Zeile bleibt offen");

    // Der Fehler ist behoben: nach drei Minuten wird nachgeholt.
    chat_freigeben(&probe).await;
    assert_eq!(
        probe.durchgang(t0() + std(24) + Duration::minutes(1)).await,
        Bilanz::default(),
        "zu jung zum Nachholen"
    );
    let nachgeholt = probe.durchgang(t0() + std(24) + Duration::minutes(3)).await;
    assert_eq!(nachgeholt.nachgeholt, 1, "{nachgeholt:?}");
    assert_eq!(nachgeholt.zugestellt, 1, "{nachgeholt:?}");
    assert_eq!(nachgeholt.beansprucht, 0, "{nachgeholt:?}");
    assert!(probe.zeilen_von(&id, &w.c).await[0].nachricht.is_some());
    // Keine Doppelten: je Person genau eine Karte.
    assert_eq!(probe.karten_zahl(&id).await, 3);
    assert_eq!(probe.erinnerungskarten(&w.c, &ac, &id).await.len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn offene_zeilen_werden_nachgeholt_hoechstens_dreimal() {
    let Some(probe) = aufbauen("r9").await else {
        return;
    };
    let w = welt(&probe).await;
    let e = probe.konto("emil").await;
    let f = probe.konto("fina").await;
    let id = probe
        .termin(
            &w.a,
            &ids(&[&w.b, &w.c, &w.d, &e, &f]),
            erinnern(720, Some(5)),
            t0() + std(24 * 400),
        )
        .await;
    let jetzt = t0() + std(100);

    // Von Hand: offene Zeilen aller Art.
    let faelle = [
        (&w.b, Duration::minutes(3), 0), // alt genug: wird zugestellt
        (&w.c, Duration::minutes(1), 0), // zu jung
        (&w.d, Duration::hours(25), 0),  // älter als ein Tag
        (&e, Duration::minutes(3), 3),   // dreimal versucht
        (&f, Duration::minutes(3), 0),   // hat inzwischen geantwortet
    ];
    for (person, alter, versuche) in faelle {
        let chat = probe.einzelchat(&id, person.uuid()).await;
        sqlx::query(
            "insert into event_erinnerungen
               (id, event_id, user_id, nummer, conversation_id, beansprucht_am, versuche)
             values ($1, $2, $3, 1, $4, $5, $6)",
        )
        .bind(Uuid::now_v7())
        .bind(id.parse::<Uuid>().unwrap())
        .bind(person.uuid())
        .bind(chat.parse::<Uuid>().unwrap())
        .bind(jetzt - alter)
        .bind(versuche as i16)
        .execute(&probe.state.pool)
        .await
        .unwrap();
    }
    probe.rsvp(&f, &id, "yes").await;

    let bilanz = probe.durchgang(jetzt).await;
    assert_eq!(bilanz.nachgeholt, 1, "nur B: {bilanz:?}");
    assert_eq!(bilanz.zugestellt, 1, "{bilanz:?}");
    assert_eq!(bilanz.zurueckgenommen, 1, "F hat geantwortet: {bilanz:?}");
    assert_eq!(bilanz.beansprucht, 0, "{bilanz:?}");
    assert!(probe.zeilen_von(&id, &f).await.is_empty(), "zurückgenommen");
    assert!(probe.zeilen_von(&id, &w.b).await[0].nachricht.is_some());
    assert!(probe.zeilen_von(&id, &w.c).await[0].nachricht.is_none());
    assert!(probe.zeilen_von(&id, &w.d).await[0].nachricht.is_none());
    assert!(probe.zeilen_von(&id, &e).await[0].nachricht.is_none());

    // Ein zweiter Durchgang fasst nichts mehr an: kein Duplikat.
    assert_eq!(probe.durchgang(jetzt).await, Bilanz::default());
    assert_eq!(probe.karten_zahl(&id).await, 1);

    // C ist zwei Minuten später alt genug.
    let spaeter = probe.durchgang(jetzt + Duration::minutes(2)).await;
    assert_eq!(spaeter.nachgeholt, 1, "{spaeter:?}");
    assert_eq!(probe.karten_zahl(&id).await, 2);

    // Was dauernd scheitert, wird dreimal versucht und bleibt dann liegen.
    let kaputt = probe
        .termin(&w.a, &ids(&[&w.d]), erinnern(24, Some(3)), t0() + std(480))
        .await;
    let ad = probe.einzelchat(&kaputt, w.d.uuid()).await;
    chat_sperren(&probe, &ad).await;
    let t = t0() + std(24);
    let erste = probe.durchgang(t).await;
    assert_eq!(erste.gescheitert, 1, "{erste:?}");
    for minuten in [3, 4, 5] {
        let versuch = probe.durchgang(t + Duration::minutes(minuten)).await;
        assert_eq!(versuch.gescheitert, 1, "{minuten} min: {versuch:?}");
    }
    assert_eq!(probe.zeilen_von(&kaputt, &w.d).await[0].versuche, 3);
    chat_freigeben(&probe).await;
    assert_eq!(
        probe.durchgang(t + Duration::minutes(6)).await,
        Bilanz::default(),
        "nach drei Versuchen bleibt sie liegen"
    );
    assert!(probe.zeilen_von(&kaputt, &w.d).await[0].nachricht.is_none());
}

// ---------------------------------------------------------------------------
// Die Einstellung
// ---------------------------------------------------------------------------

async fn seit_von(probe: &Probe, termin: &str) -> Option<DateTime<Utc>> {
    sqlx::query_scalar("select erinnern_seit from calendar_events where id = $1")
        .bind(termin.parse::<Uuid>().unwrap())
        .fetch_one(&probe.state.pool)
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn einstellung_pruefen_speichern_anzeigen() {
    let Some(probe) = aufbauen("r10").await else {
        return;
    };
    let w = welt(&probe).await;
    let fremder = probe.konto("emil").await;
    let g = probe.gruppe(&w.a, "Runde", &[&w.b, &w.c]).await;

    // ---- Grenzen mit den deutschen Texten --------------------------------
    for (fall, text) in [
        (
            erinnern(11, Some(3)),
            "Die Erinnerung braucht mindestens 12 Stunden Abstand.",
        ),
        (
            erinnern(721, Some(3)),
            "Höchstens 30 Tage (720 Stunden) Abstand.",
        ),
        (erinnern(24, Some(0)), "Mindestens eine Erinnerung."),
        (erinnern(24, Some(11)), "Höchstens 10 Erinnerungen."),
    ] {
        let beginn = Utc::now() + Duration::days(3);
        let (status, antwort) = probe
            .call(
                "POST",
                "/api/v1/calendar/events",
                Some(&w.a.token),
                Some(json!({
                    "title": "X", "startsAt": beginn, "endsAt": beginn + Duration::hours(1),
                    "erinnern": fall
                })),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{fall}: {antwort}");
        assert_eq!(antwort["error"]["message"], text);
    }

    // ---- Anlegen und Anzeigen --------------------------------------------
    let termin = probe
        .termin_roh(
            &w.a,
            &ids(&[&w.b, &w.c]),
            erinnern(48, Some(3)),
            true,
            "Grillen",
        )
        .await;
    let id = termin["id"].as_str().unwrap().to_string();
    assert_eq!(
        termin["erinnern"],
        json!({ "nachStunden": 48, "anzahl": 3 })
    );
    let (_, geholt) = probe.holen(&w.b, &id).await;
    assert_eq!(
        geholt["erinnern"],
        json!({ "nachStunden": 48, "anzahl": 3 })
    );
    let von = Utc::now() - Duration::days(1);
    let (status, liste) = probe
        .call(
            "GET",
            &format!(
                "/api/v1/calendar/events?from={}&to={}",
                urlencoding::encode(&von.to_rfc3339()),
                urlencoding::encode(&(von + Duration::days(30)).to_rfc3339())
            ),
            Some(&w.c.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{liste}");
    assert_eq!(
        liste["items"][0]["erinnern"],
        json!({ "nachStunden": 48, "anzahl": 3 }),
        "{liste}"
    );
    let rundruf = {
        let mut hoerer = probe.hoeren(&w.b);
        probe.rsvp(&w.b, &id, "maybe").await;
        vom_typ(&hoerer.alles(), "event.updated")
    };
    assert_eq!(
        rundruf[0]["payload"]["event"]["erinnern"],
        json!({ "nachStunden": 48, "anzahl": 3 })
    );
    probe.rsvp(&w.b, &id, "pending").await;

    // „Bis zum Termin“ kommt als `null` zurück.
    let offen = probe
        .termin_roh(
            &w.a,
            &ids(&[&w.b]),
            json!({ "nachStunden": 24 }),
            true,
            "Offen",
        )
        .await;
    assert_eq!(
        offen["erinnern"],
        json!({ "nachStunden": 24, "anzahl": null })
    );

    // ---- Wer darf ändern -------------------------------------------------
    probe.zeiten(&id, t0(), t0() + std(480), false).await;
    let (status, antwort) = probe
        .aendern(&w.b, &id, json!({ "erinnern": erinnern(24, Some(2)) }))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{antwort}");
    assert_eq!(
        antwort["error"]["message"],
        "Nur wer den Termin angelegt hat, kann Erinnerungen einstellen"
    );
    let (status, _) = probe
        .aendern(&fremder, &id, json!({ "erinnern": erinnern(24, Some(2)) }))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // Ein Gruppen-Admin ändert den Titel, aber nicht das Erinnern.
    let gruppentermin = probe
        .call(
            "POST",
            "/api/v1/calendar/events",
            Some(&w.a.token),
            Some(json!({
                "title": "Gruppe",
                "startsAt": Utc::now() + Duration::days(3),
                "endsAt": Utc::now() + Duration::days(3) + Duration::hours(1),
                "attendeeIds": ids(&[&w.b, &w.c]),
                "zustellung": { "gruppenChatIds": [g] },
                "erinnern": erinnern(24, Some(2))
            })),
        )
        .await
        .1;
    let gid = gruppentermin["id"].as_str().unwrap();
    probe
        .sql(&format!(
            "update conversation_members set role = 'admin'
              where conversation_id = '{g}' and user_id = '{}'",
            w.b.id
        ))
        .await;
    let (status, _) = probe
        .aendern(&w.b, gid, json!({ "title": "Gruppe neu" }))
        .await;
    assert_eq!(status, StatusCode::OK, "der Admin darf den Titel ändern");
    let (status, _) = probe
        .aendern(&w.b, gid, json!({ "erinnern": erinnern(24, Some(3)) }))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "aber nicht das Erinnern");

    // ---- Termin in Abstimmung --------------------------------------------
    let (status, geplant) = probe
        .call(
            "POST",
            "/api/v1/calendar/planning",
            Some(&w.a.token),
            Some(json!({
                "conversationId": g,
                "title": "Wann?",
                "slots": [
                    { "startsAt": Utc::now() + Duration::days(2) },
                    { "startsAt": Utc::now() + Duration::days(3) }
                ]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{geplant}");
    assert!(geplant["erinnern"].is_null());
    let (status, antwort) = probe
        .aendern(
            &w.a,
            geplant["id"].as_str().unwrap(),
            json!({ "erinnern": erinnern(24, Some(3)) }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{antwort}");
    assert_eq!(
        antwort["error"]["message"],
        "Solange über den Zeitpunkt abgestimmt wird, lässt sich keine Erinnerung einstellen – lege zuerst den Zeitpunkt fest."
    );

    // ---- Die Uhr startet nur bei einem Unterschied neu --------------------
    assert_eq!(seit_von(&probe, &id).await, Some(t0()));
    // Nur der Titel, Einstellung unverändert mitgeschickt: unverändert.
    let (status, _) = probe
        .aendern(
            &w.a,
            &id,
            json!({ "title": "Neuer Titel", "erinnern": erinnern(48, Some(3)) }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(seit_von(&probe, &id).await, Some(t0()), "kein Unterschied");
    // Nur der Titel, ohne das Feld: unverändert.
    probe
        .aendern(&w.a, &id, json!({ "title": "Noch ein Titel" }))
        .await;
    assert_eq!(seit_von(&probe, &id).await, Some(t0()));
    // Abstand, Anzahl, „bis zum Termin“: jeweils eine neue Uhr.
    for neu in [
        erinnern(24, Some(3)),
        erinnern(24, Some(5)),
        json!({ "nachStunden": 24, "anzahl": null }),
    ] {
        probe.uhr_stellen(&id, t0()).await;
        let (status, antwort) = probe.aendern(&w.a, &id, json!({ "erinnern": neu })).await;
        assert_eq!(status, StatusCode::OK, "{antwort}");
        assert_ne!(seit_von(&probe, &id).await, Some(t0()), "{neu}");
    }
    // Absage und Wiederaufnahme: neue Uhr.
    probe.uhr_stellen(&id, t0()).await;
    probe
        .aendern(&w.a, &id, json!({ "status": "cancelled" }))
        .await;
    assert_eq!(
        seit_von(&probe, &id).await,
        Some(t0()),
        "die Absage ändert nichts"
    );
    probe
        .aendern(&w.a, &id, json!({ "status": "confirmed" }))
        .await;
    assert_ne!(seit_von(&probe, &id).await, Some(t0()), "Wiederaufnahme");

    // `null` schaltet aus: alle drei Spalten leer, im Termin `null`.
    let (status, aus) = probe.aendern(&w.a, &id, json!({ "erinnern": null })).await;
    assert_eq!(status, StatusCode::OK, "{aus}");
    assert!(aus["erinnern"].is_null(), "{aus}");
    let spalten: (Option<i32>, Option<i16>, Option<DateTime<Utc>>) = sqlx::query_as(
        "select erinnern_nach_std, erinnern_anzahl, erinnern_seit
           from calendar_events where id = $1",
    )
    .bind(id.parse::<Uuid>().unwrap())
    .fetch_one(&probe.state.pool)
    .await
    .unwrap();
    assert_eq!(spalten, (None, None, None));
    // Wieder ein: neue Uhr, Einstellung wieder da.
    let (_, an) = probe
        .aendern(&w.a, &id, json!({ "erinnern": erinnern(72, Some(2)) }))
        .await;
    assert_eq!(an["erinnern"], json!({ "nachStunden": 72, "anzahl": 2 }));
    assert!(seit_von(&probe, &id).await.is_some());

    // ---- Der Stand: nur für den Ersteller ---------------------------------
    let (status, stand) = probe.stand(&w.a, &id).await;
    assert_eq!(status, StatusCode::OK, "{stand}");
    assert_eq!(stand["aktiv"], true);
    assert_eq!(stand["hoechstens"], 2);
    let (status, antwort) = probe.stand(&w.b, &id).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{antwort}");
    let (status, _) = probe.stand(&fremder, &id).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // Bei einem Termin ohne Erinnern: nicht aktiv, leere Listen.
    let (_, still) = probe.stand(&w.a, &id).await;
    assert!(still["personen"].is_array());
    let (_, ohne) = probe.aendern(&w.a, &id, json!({ "erinnern": null })).await;
    assert!(ohne["erinnern"].is_null());
    let (status, leer) = probe.stand(&w.a, &id).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        leer,
        json!({ "aktiv": false, "hoechstens": 0, "personen": [], "ohneEinzelchat": [] })
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn der_stand_zaehlt_je_person_und_nennt_wer_nicht_erreichbar_ist() {
    let Some(probe) = aufbauen("r10b").await else {
        return;
    };
    let w = welt(&probe).await;
    // D bekommt keine Einzelkarte.
    let termin = probe
        .termin_roh(&w.a, &ids(&[&w.d]), erinnern(24, None), false, "Hütte")
        .await;
    let id = termin["id"].as_str().unwrap().to_string();
    let (status, _) = probe
        .aendern(
            &w.a,
            &id,
            json!({
                "attendeeIds": ids(&[&w.b, &w.c, &w.d]),
                "zustellung": { "senden": true, "einzelchats": true, "gruppenChatIds": [] }
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    probe.zeiten(&id, t0(), t0() + std(480), false).await;

    probe.durchgang(t0() + std(24)).await;
    probe.durchgang(t0() + std(48)).await;
    probe.rsvp(&w.c, &id, "yes").await;

    let (status, stand) = probe.stand(&w.a, &id).await;
    assert_eq!(status, StatusCode::OK, "{stand}");
    assert_eq!(stand["aktiv"], true);
    assert_eq!(stand["hoechstens"], 10, "bis zum Termin: höchstens zehn");
    let personen = stand["personen"].as_array().unwrap();
    assert_eq!(
        personen.len(),
        1,
        "nur B ist noch offen und erreichbar: {stand}"
    );
    assert_eq!(personen[0]["userId"], w.b.id.as_str());
    assert_eq!(personen[0]["gesendet"], 2);
    assert!(personen[0]["zuletztAm"].is_string());
    assert_eq!(stand["ohneEinzelchat"], json!([w.d.id]));
}

// ---------------------------------------------------------------------------
// Aufräumen
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn ausladen_und_loeschen_raeumen_auf_und_wiedereinladen_zaehlt_neu() {
    let Some(probe) = aufbauen("r11").await else {
        return;
    };
    let w = welt(&probe).await;
    let id = probe
        .termin(
            &w.a,
            &ids(&[&w.b, &w.c]),
            erinnern(24, Some(5)),
            t0() + std(480),
        )
        .await;
    probe.durchgang(t0() + std(24)).await;
    probe.durchgang(t0() + std(48)).await;
    let alte: Vec<Uuid> = probe
        .zeilen_von(&id, &w.b)
        .await
        .iter()
        .filter_map(|zeile| zeile.nachricht)
        .collect();
    assert_eq!(alte.len(), 2);

    // Ausladen: beide Karten werden als gelöscht gemeldet, die Zeilen sind weg.
    let mut hoerer_a = probe.hoeren(&w.a);
    let mut hoerer_b = probe.hoeren(&w.b);
    probe.ausladen(&w.a, &id, &w.b).await;
    let geloescht_a = vom_typ(&hoerer_a.alles(), "message.deleted");
    let geloescht_b = vom_typ(&hoerer_b.alles(), "message.deleted");
    assert!(geloescht_a.len() >= 2, "{geloescht_a:?}");
    assert!(geloescht_b.len() >= 2, "{geloescht_b:?}");
    let noch_da: i64 = sqlx::query_scalar(
        "select count(*) from messages where id = any($1) and deleted_at is null",
    )
    .bind(&alte)
    .fetch_one(&probe.state.pool)
    .await
    .unwrap();
    assert_eq!(noch_da, 0, "die Karten sind gelöscht");
    assert!(probe.zeilen_von(&id, &w.b).await.is_empty());
    // C ist unberührt.
    assert_eq!(probe.zeilen_von(&id, &w.c).await.len(), 2);

    // Wieder eingeladen: Die Zählung beginnt bei null, die neue Erinnerung hat
    // einen neuen Schlüssel und bekommt die gelöschte Nachricht nicht zurück.
    let (status, antwort) = probe
        .aendern(
            &w.a,
            &id,
            json!({
                "attendeeIds": ids(&[&w.b, &w.c]),
                "zustellung": { "senden": true, "einzelchats": true, "gruppenChatIds": [] }
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    probe
        .sql(&format!(
            "update event_attendees set eingeladen_am = '{}' where event_id = '{id}' and user_id = '{}'",
            (t0() + std(100)).to_rfc3339(),
            w.b.id
        ))
        .await;
    let bilanz = probe.durchgang(t0() + std(100) + std(24)).await;
    assert!(bilanz.zugestellt >= 1, "{bilanz:?}");
    let neu = probe.zeilen_von(&id, &w.b).await;
    assert_eq!(neu.len(), 1);
    assert_eq!(neu[0].nummer, 1, "die Zählung beginnt neu");
    let neue_nachricht = neu[0].nachricht.expect("Nachricht");
    assert!(
        !alte.contains(&neue_nachricht),
        "nicht die gelöschte zurück"
    );
    let ab = probe.einzelchat(&id, w.b.uuid()).await;
    assert_eq!(probe.erinnerungskarten(&w.b, &ab, &id).await.len(), 1);

    // Termin löschen: alle Erinnerungskarten sind gelöscht, die Zeilen weg.
    probe.loeschen(&w.a, &id).await;
    assert_eq!(probe.karten_zahl(&id).await, 0);
    assert!(probe.zeilen(&id).await.is_empty());
}

// ---------------------------------------------------------------------------
// Mitteilungen
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn eine_mitteilung_je_erinnerung_nach_den_einstellungen_der_person() {
    let Some(probe) = aufbauen("r12").await else {
        return;
    };
    let w = welt(&probe).await;
    let e = probe.konto("emil").await;
    let id = probe
        .termin(
            &w.a,
            &ids(&[&w.b, &w.c, &w.d, &e]),
            erinnern(24, Some(3)),
            t0() + std(480),
        )
        .await;
    // C hat den Einzelchat stummgeschaltet, D den Push ausgeschaltet, E die
    // Vorschau.
    let ac = probe.einzelchat(&id, w.c.uuid()).await;
    probe
        .sql(&format!(
            "update conversation_members set muted_until = now() + interval '10 years'
              where conversation_id = '{ac}' and user_id = '{}'",
            w.c.id
        ))
        .await;
    probe
        .sql(&format!(
            "update users set settings = settings || '{{\"notifications\":{{\"push\":false}}}}'::jsonb
              where id = '{}'",
            w.d.id
        ))
        .await;
    probe
        .sql(&format!(
            "update users set settings = settings || '{{\"notifications\":{{\"previews\":false}}}}'::jsonb
              where id = '{}'",
            e.id
        ))
        .await;
    let ab = probe.einzelchat(&id, w.b.uuid()).await;
    let mut hoerer_b = probe.hoeren(&w.b);
    let mut hoerer_a = probe.hoeren(&w.a);
    hoerer_b.alles();
    hoerer_a.alles();
    probe.push_leeren();

    let bilanz = probe.durchgang(t0() + std(24)).await;
    assert_eq!(bilanz.zugestellt, 4, "{bilanz:?}");

    // Genau eine Mitteilung je Erinnerung – und nur, wo die Person sie will.
    assert_eq!(probe.push_anzahl(), 2, "B und E");
    let an_b = probe.push_an(&w.b);
    assert_eq!(an_b.len(), 1, "{an_b:?}");
    assert_eq!(an_b[0]["title"], "Initiative");
    assert_eq!(
        an_b[0]["body"],
        "Erinnerung: Du hast noch nicht auf „Grillen“ geantwortet."
    );
    assert_eq!(an_b[0]["kind"], "event");
    assert_eq!(an_b[0]["tag"], format!("termin:{id}"));
    assert_eq!(an_b[0]["url"], format!("/chats/{ab}"));
    assert_eq!(an_b[0]["conversationId"], ab.as_str());
    let karte = &probe.erinnerungskarten(&w.b, &ab, &id).await[0];
    assert_eq!(an_b[0]["messageId"], karte["id"]);
    let an_e = probe.push_an(&e);
    assert_eq!(an_e.len(), 1);
    assert_eq!(
        an_e[0]["body"], "Erinnerung an einen Termin",
        "ohne Vorschau"
    );
    assert!(
        !an_e[0].to_string().contains("Grillen"),
        "ohne Vorschau kein Titel: {an_e:?}"
    );
    assert!(probe.push_an(&w.c).is_empty(), "stummgeschalteter Chat");
    assert!(probe.push_an(&w.d).is_empty(), "Push ausgeschaltet");
    // Die Karten stehen trotzdem im Chat.
    let ad = probe.einzelchat(&id, w.d.uuid()).await;
    assert_eq!(probe.erinnerungskarten(&w.d, &ad, &id).await.len(), 1);
    assert_eq!(probe.erinnerungskarten(&w.c, &ac, &id).await.len(), 1);
    // Keine Mitteilung für den Ersteller, keine über den Weg der Nachricht.
    assert!(probe.push_an(&w.a).is_empty());

    // Der Rundruf: die Karte (live) und der Termin einmal je Durchgang.
    let rahmen_b = hoerer_b.alles();
    assert_eq!(vom_typ(&rahmen_b, "message.new").len(), 1);
    assert_eq!(
        vom_typ(&rahmen_b, "event.updated").len(),
        1,
        "einmal je Termin, nicht je Person: {rahmen_b:?}"
    );
    let rahmen_a = hoerer_a.alles();
    assert_eq!(vom_typ(&rahmen_a, "event.updated").len(), 1);
}

// ---------------------------------------------------------------------------
// Mindestabstand
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn der_mindestabstand_haelt_bei_jeder_aenderung() {
    let Some(probe) = aufbauen("r13").await else {
        return;
    };
    let w = welt(&probe).await;
    let id = probe
        .termin(
            &w.a,
            &ids(&[&w.b]),
            erinnern(48, Some(8)),
            t0() + std(24 * 90),
        )
        .await;

    // Eine Folge aus Durchgängen und Änderungen. Nach jeder Änderung steht die
    // Uhr der Einstellung auf der erfundenen Zeit (`uhr_stellen`), und ein
    // Durchgang zur selben Zeit löst nichts aus.
    let mut jetzt = t0();
    let mut gesendet = 0;
    let schritte: Vec<(&str, Option<Value>)> = vec![
        ("durchgang", None),
        ("durchgang", None),
        (
            "aendern",
            Some(json!({ "erinnern": erinnern(12, Some(8)) })),
        ),
        ("durchgang", None),
        (
            "aendern",
            Some(json!({ "erinnern": erinnern(96, Some(8)) })),
        ),
        ("durchgang", None),
        ("aendern", Some(json!({ "erinnern": null }))),
        ("durchgang", None),
        (
            "aendern",
            Some(json!({ "erinnern": erinnern(12, Some(8)) })),
        ),
        ("durchgang", None),
        ("aendern", Some(json!({ "status": "cancelled" }))),
        ("durchgang", None),
        ("aendern", Some(json!({ "status": "confirmed" }))),
        ("durchgang", None),
        (
            "aendern",
            Some(json!({ "erinnern": erinnern(12, Some(9)) })),
        ),
        ("durchgang", None),
    ];
    for (nummer, (art, koerper)) in schritte.into_iter().enumerate() {
        if art == "aendern" {
            let (status, antwort) = probe.aendern(&w.a, &id, koerper.unwrap()).await;
            assert_eq!(status, StatusCode::OK, "{antwort}");
            probe.uhr_stellen(&id, jetzt).await;
            // Gleich nach der Änderung: nichts.
            assert_eq!(
                probe.durchgang(jetzt).await,
                Bilanz::default(),
                "Schritt {nummer}: keine sofortige Erinnerung"
            );
        } else {
            // Stündlich ein Durchgang, hundert Stunden weit: Jede Fälligkeit
            // (Vielfache von zwölf Stunden) wird auf die Stunde getroffen.
            for _ in 0..100 {
                jetzt += Duration::hours(1);
                gesendet += probe.durchgang(jetzt).await.zugestellt;
            }
        }
        // Die Invariante: Zwischen zwei Erinnerungen an dieselbe Person zum
        // selben Termin liegen immer mindestens zwölf Stunden.
        let zeilen = probe.zeilen_von(&id, &w.b).await;
        for paar in zeilen.windows(2) {
            assert!(
                paar[1].beansprucht - paar[0].beansprucht >= Duration::hours(12),
                "Schritt {nummer}: {paar:?}"
            );
        }
    }
    // Acht Erinnerungen bis zur Obergrenze – sie hielt durch Verkürzen,
    // Verlängern, Aus- und Einschalten und Absage hindurch. Erst das Erhöhen auf
    // neun liess noch eine zu.
    assert_eq!(gesendet, 9);
}

// ---------------------------------------------------------------------------
// Client und Server rechnen dasselbe
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct Datei {
    faelle: Vec<Fall>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fall {
    name: String,
    ab: DateTime<Utc>,
    beginn: DateTime<Utc>,
    ganztaegig: bool,
    nach_stunden: i64,
    anzahl: Option<i64>,
    erwartet: usize,
}

const FAELLE: &str = include_str!("../../../packages/shared/src/testdaten/erinnern.json");

#[tokio::test(flavor = "multi_thread")]
async fn die_gemeinsamen_faelle_aus_der_datei() {
    let Some(probe) = aufbauen("r14").await else {
        return;
    };
    let datei: Datei = serde_json::from_str(FAELLE).expect("erinnern.json lesbar");
    assert!(datei.faelle.len() >= 10, "die Datei ist nicht leer");
    let w = welt(&probe).await;

    for fall in datei.faelle {
        let termin = probe
            .termin_roh(
                &w.a,
                &ids(&[&w.b]),
                json!({ "nachStunden": fall.nach_stunden, "anzahl": fall.anzahl }),
                true,
                "Fall",
            )
            .await;
        let id = termin["id"].as_str().unwrap().to_string();
        probe
            .zeiten(&id, fall.ab, fall.beginn, fall.ganztaegig)
            .await;

        // Durchgänge zu den Fälligkeitszeitpunkten, ohne Verzug: Gezählt wird, was
        // als Karte ankommt. Mehr als zwölf braucht keiner – mehr als zehn gibt es
        // nicht.
        let mut gesendet = 0;
        for runde in 1..=12 {
            let bilanz = probe
                .durchgang(fall.ab + std(fall.nach_stunden * runde))
                .await;
            gesendet += bilanz.zugestellt;
        }
        assert_eq!(gesendet, fall.erwartet, "Fall: {}", fall.name);
        assert_eq!(
            probe.karten_zahl(&id).await as usize,
            fall.erwartet,
            "Fall: {}",
            fall.name
        );
        // Weg damit: Der nächste Fall soll sich nicht mit den Resten dieses
        // streiten (eine Erinnerung je Person und Durchgang).
        probe.loeschen(&w.a, &id).await;
    }
}

// ---------------------------------------------------------------------------
// Konten
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn konto_loeschen_nimmt_die_zeilen_mit() {
    let Some(probe) = aufbauen("r15").await else {
        return;
    };
    let w = welt(&probe).await;
    let id = probe
        .termin(
            &w.a,
            &ids(&[&w.b, &w.c]),
            erinnern(24, Some(5)),
            t0() + std(480),
        )
        .await;
    probe.durchgang(t0() + std(24)).await;
    assert_eq!(probe.zeilen(&id).await.len(), 2);

    // Das Konto der erinnerten Person: Ihre Zeilen gehen mit, keine Waisen.
    let (status, antwort) = probe
        .call(
            "DELETE",
            "/api/v1/users/me",
            Some(&w.b.token),
            Some(json!({ "password": PASSWORT })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{antwort}");
    assert!(probe.zeilen_von(&id, &w.b).await.is_empty());
    assert_eq!(probe.zeilen_von(&id, &w.c).await.len(), 1);
    assert_eq!(probe.durchgang(t0() + std(48)).await.zugestellt, 1);

    // Das Konto des Erstellers: kein Fehler im Durchgang, keine Erinnerung mehr.
    let (status, antwort) = probe
        .call(
            "DELETE",
            "/api/v1/users/me",
            Some(&w.a.token),
            Some(json!({ "password": PASSWORT })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{antwort}");
    assert_eq!(probe.durchgang(t0() + std(72)).await.zugestellt, 0);
}

// ---------------------------------------------------------------------------
// Rückwärtsverträglich
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn rueckwaertsvertraeglich_alte_anfragen_und_termine_bleiben_stumm() {
    let Some(probe) = aufbauen("r16").await else {
        return;
    };
    let w = welt(&probe).await;
    let g = probe.gruppe(&w.a, "Drei", &[&w.b, &w.c]).await;

    // Eine alte Anfrage: nur `conversationId`, kein `zustellung`, kein `erinnern`.
    let beginn = Utc::now() + Duration::days(3);
    let (status, alt) = probe
        .call(
            "POST",
            "/api/v1/calendar/events",
            Some(&w.a.token),
            Some(json!({
                "conversationId": g, "title": "Alt",
                "startsAt": beginn, "endsAt": beginn + Duration::hours(1)
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{alt}");
    assert!(alt["erinnern"].is_null(), "{alt}");

    // Termin aus einer Terminumfrage.
    let start = Utc::now() + Duration::days(1);
    let (_, umfrage) = probe
        .call(
            "POST",
            "/api/v1/polls",
            Some(&w.a.token),
            Some(json!({
                "conversationId": g, "kind": "date", "question": "Wann?",
                "options": [{ "startsAt": start }, { "startsAt": start + Duration::days(1) }]
            })),
        )
        .await;
    let option = umfrage["options"][0]["id"].as_str().unwrap();
    let (status, aus_umfrage) = probe
        .call(
            "POST",
            &format!("/api/v1/polls/{}/event", umfrage["id"].as_str().unwrap()),
            Some(&w.a.token),
            Some(json!({ "optionId": option })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{aus_umfrage}");
    assert!(aus_umfrage["erinnern"].is_null());

    // Terminfindung, bestätigt.
    let (_, geplant) = probe
        .call(
            "POST",
            "/api/v1/calendar/planning",
            Some(&w.a.token),
            Some(json!({
                "conversationId": g, "title": "Wann grillen wir?",
                "slots": [
                    { "startsAt": start + Duration::days(2) },
                    { "startsAt": start + Duration::days(3) }
                ]
            })),
        )
        .await;
    assert!(geplant["erinnern"].is_null());
    let (status, bestaetigt) = probe
        .call(
            "POST",
            &format!(
                "/api/v1/calendar/events/{}/confirm",
                geplant["id"].as_str().unwrap()
            ),
            Some(&w.a.token),
            Some(json!({})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{bestaetigt}");
    assert!(bestaetigt["erinnern"].is_null());

    // Ein Durchgang weit in der Zukunft beansprucht nichts.
    let bilanz = probe.durchgang(Utc::now() + Duration::days(60)).await;
    assert_eq!(bilanz, Bilanz::default());
    let zeilen: i64 = sqlx::query_scalar("select count(*) from event_erinnerungen")
        .fetch_one(&probe.state.pool)
        .await
        .unwrap();
    assert_eq!(zeilen, 0);

    // Eine Anfrage ohne `anzahl` heisst „bis zum Termin“, `null` bei POST wie fehlend.
    let (status, mit_null) = probe
        .call(
            "POST",
            "/api/v1/calendar/events",
            Some(&w.a.token),
            Some(json!({
                "title": "Null", "startsAt": beginn, "endsAt": beginn + Duration::hours(1),
                "erinnern": null
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{mit_null}");
    assert!(mit_null["erinnern"].is_null());
}

#[tokio::test(flavor = "multi_thread")]
async fn der_dienst_startet_nur_mit_takt() {
    let Some(probe) = aufbauen("r16b").await else {
        return;
    };
    // Ausgeschaltet: kein Faden.
    let aus = Config {
        erinnern_takt_s: 0,
        ..(*probe.config).clone()
    };
    let state = AppState::from_pool(probe.state.pool.clone(), Arc::new(aus))
        .await
        .expect("state");
    assert!(erinnern::starten(state).is_none());

    // Eingeschaltet: ein Faden – der erste Durchgang liegt dreissig Sekunden
    // entfernt, der Test beendet ihn gleich wieder.
    let an = Config {
        erinnern_takt_s: 300,
        ..(*probe.config).clone()
    };
    let state = AppState::from_pool(probe.state.pool.clone(), Arc::new(an))
        .await
        .expect("state");
    let faden = erinnern::starten(state).expect("läuft");
    faden.abort();
}

// ---------------------------------------------------------------------------
// Das Programm für Entwicklung und Tests
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread")]
async fn erinnern_einmal_laeuft_gegen_ein_schema() {
    let Some(probe) = aufbauen("r17").await else {
        return;
    };
    let w = welt(&probe).await;
    let id = probe
        .termin(
            &w.a,
            &ids(&[&w.b, &w.c]),
            erinnern(24, Some(3)),
            t0() + std(480),
        )
        .await;

    let programm = env!("CARGO_BIN_EXE_erinnern_einmal");
    let url = format!(
        "{}{}options[search_path]={}",
        probe.url,
        if probe.url.contains('?') { "&" } else { "?" },
        probe.schema
    );
    let laufen = |argumente: &[&str]| {
        std::process::Command::new(programm)
            .args(argumente)
            .env("DATABASE_URL", &url)
            .env("NODE_ENV", "test")
            .env("JWT_SECRET", "test-secret-value-at-least-16-characters")
            .env("REALTIME_BUS", "memory")
            .env("STORAGE_DRIVER", "local")
            .env("LOCAL_STORAGE_DIR", "./.data/erinnern-einmal")
            .output()
            .expect("Programm startet")
    };

    // Mit festem Zeitpunkt: zwei Erinnerungen, die Karten stehen im Schema.
    let ausgabe = laufen(&["--jetzt", &(t0() + std(24)).to_rfc3339()]);
    assert!(
        ausgabe.status.success(),
        "{}",
        String::from_utf8_lossy(&ausgabe.stderr)
    );
    let bilanz: Value =
        serde_json::from_str(String::from_utf8_lossy(&ausgabe.stdout).trim()).expect("JSON");
    assert_eq!(bilanz["beansprucht"], 2, "{bilanz}");
    assert_eq!(bilanz["zugestellt"], 2, "{bilanz}");
    assert_eq!(probe.karten_zahl(&id).await, 2);

    // Falsche Angaben: Ausgang 2 und der Hilfetext.
    let falsch = laufen(&["--plus-stunden", "viel"]);
    assert_eq!(falsch.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&falsch.stderr).contains("NUR FÜR ENTWICKLUNG UND TESTS"));
    let unbekannt = laufen(&["--hintertuer"]);
    assert_eq!(unbekannt.status.code(), Some(2));

    // Die Hilfe.
    let hilfe = laufen(&["--help"]);
    assert!(hilfe.status.success());
    assert!(String::from_utf8_lossy(&hilfe.stdout).contains("NUR FÜR ENTWICKLUNG UND TESTS"));
}
