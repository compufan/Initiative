//! Viele Eingeladene: Das Anlegen bleibt zügig, und Phase 1 kennt keine
//! Abfragen je Person.
//!
//! Die erste Fassung von `create_event` schrieb jeden Teilnehmer mit einer
//! eigenen Anweisung – bei hundert Eingeladenen hundert Runden, und ein Abbruch
//! mittendrin hinterliess einen halben Termin. Jetzt sind es eine Anweisung für
//! Termin, eine für alle Teilnehmer, eine für alle neuen Einzelchats, eine für
//! deren Mitglieder und eine für alle Karten. Das wird hier GEZÄHLT, nicht
//! vermutet: Die Zahl der Schreibanweisungen darf mit der Zahl der Eingeladenen
//! nicht wachsen.
//!
//! Die Nachrichten der Karten (Phase 2) wachsen linear mit – das ist gewollt,
//! sie laufen begrenzt parallel und nie innerhalb der Transaktion.
//!
//! Läuft auf einem Thread (`current_thread`), damit der zählende Zuhörer nur
//! die Anweisungen DIESES Tests sieht und nicht die der anderen.

use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;
use tracing::field::{Field, Visit};
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::Layer;
use uuid::Uuid;

use initiative_api::config::Config;
use initiative_api::state::AppState;
use initiative_api::{app, MIGRATOR};

/// Hört auf die Anweisungen, die sqlx ausführt, und merkt sich ihren Text.
#[derive(Clone, Default)]
struct Zaehler {
    anweisungen: Arc<Mutex<Vec<String>>>,
}

struct Text(Option<String>);

impl Visit for Text {
    fn record_debug(&mut self, feld: &Field, wert: &dyn std::fmt::Debug) {
        if feld.name() == "db.statement" {
            self.0 = Some(format!("{wert:?}"));
        }
    }

    fn record_str(&mut self, feld: &Field, wert: &str) {
        if feld.name() == "db.statement" {
            self.0 = Some(wert.to_string());
        }
    }
}

impl<S: tracing::Subscriber> Layer<S> for Zaehler {
    fn on_event(&self, ereignis: &tracing::Event<'_>, _: Context<'_, S>) {
        if ereignis.metadata().target() != "sqlx::query" {
            return;
        }
        let mut text = Text(None);
        ereignis.record(&mut text);
        if let Some(text) = text.0 {
            self.anweisungen.lock().unwrap().push(text);
        }
    }
}

impl Zaehler {
    fn leeren(&self) {
        self.anweisungen.lock().unwrap().clear();
    }

    /// Wie viele Anweisungen beginnen so (ohne Gross-/Kleinschreibung, Leerraum und Anführungszeichen)?
    fn beginnend_mit(&self, anfang: &str) -> usize {
        self.anweisungen
            .lock()
            .unwrap()
            .iter()
            .filter(|text| {
                text.trim_matches('"')
                    .trim_start()
                    .to_lowercase()
                    .starts_with(anfang)
            })
            .count()
    }

    fn gesamt(&self) -> usize {
        self.anweisungen.lock().unwrap().len()
    }
}

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

    /// Hundertfünfzig Konten ohne Anmeldung: Der Test prüft das Einladen, nicht
    /// das Passwort-Hashen – das kostet im Debug-Build je Konto eine halbe
    /// Sekunde.
    async fn konten(&self, anzahl: usize, vorsilbe: &str) -> Vec<Uuid> {
        let ids: Vec<Uuid> = (0..anzahl).map(|_| Uuid::now_v7()).collect();
        let namen: Vec<String> = ids
            .iter()
            .enumerate()
            .map(|(nummer, _)| format!("{vorsilbe}{nummer}"))
            .collect();
        sqlx::query(
            "insert into users (id, username, display_name, password_hash, calendar_token)
             select t.id, t.name, t.name, 'x', t.id::text
               from unnest($1::uuid[], $2::text[]) as t(id, name)",
        )
        .bind(&ids)
        .bind(&namen)
        .execute(&self.state.pool)
        .await
        .unwrap();
        ids
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
    std::env::set_var("DATABASE_POOL_MAX", "8");
    std::env::set_var("STORAGE_DRIVER", "local");
    std::env::set_var(
        "LOCAL_STORAGE_DIR",
        format!("./.data/einladen-viele-{}", Uuid::now_v7().simple()),
    );
    std::env::set_var("PUBLIC_API_URL", "http://localhost:8080");
    std::env::set_var("PUBLIC_APP_URL", "http://localhost:5173");
    // Die Bremsen sind für Menschen gedacht, nicht für einen Test, der mit
    // einem Konto hundertfünfzig Chats anlegt.
    std::env::set_var("RATE_LIMIT", "false");

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

#[tokio::test(flavor = "current_thread")]
async fn viele_eingeladene_bleiben_im_zeitrahmen_und_phase_eins_waechst_nicht() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – übersprungen");
        return;
    };
    let zaehler = Zaehler::default();
    let _zuhoerer =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(zaehler.clone()));

    let n = kurz();
    let (status, konto) = probe
        .call(
            "POST",
            "/api/v1/auth/register",
            None,
            Some(json!({
                "username": format!("anna{n}"),
                "displayName": "Anna",
                "password": "richtigespasswort",
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{konto}");
    let token = konto["accessToken"].as_str().unwrap().to_string();

    let beginn = chrono::Utc::now() + chrono::Duration::days(3);
    let mut schreibend = Vec::new();
    for anzahl in [20usize, 150] {
        let leute = probe.konten(anzahl, &format!("g{n}a{anzahl}x")).await;
        let ids: Vec<String> = leute.iter().map(|id| id.to_string()).collect();
        let hoerer = probe.state.hub.register(leute[0]);
        let mut empfaenger = hoerer.1;

        zaehler.leeren();
        let zeit = Instant::now();
        let (status, termin) = probe
            .call(
                "POST",
                "/api/v1/calendar/events",
                Some(&token),
                Some(json!({
                    "title": format!("Fest für {anzahl}"),
                    "startsAt": beginn,
                    "endsAt": beginn + chrono::Duration::hours(2),
                    "attendeeIds": ids,
                    "zustellung": { "einzelchats": true, "gruppenChatIds": [] }
                })),
            )
            .await;
        let dauer = zeit.elapsed();
        assert_eq!(status, StatusCode::CREATED, "{termin}");
        eprintln!(
            "{anzahl} Eingeladene: {:.1} s, {} Anweisungen",
            dauer.as_secs_f64(),
            zaehler.gesamt()
        );

        // Alles steht da: Teilnehmer, Einzelchats, Karten.
        assert_eq!(termin["attendees"].as_array().unwrap().len(), anzahl + 1);
        assert_eq!(termin["zustellung"]["einzelchats"], anzahl);
        assert_eq!(termin["zustellung"]["neueEinzelchats"], anzahl);
        assert_eq!(termin["zustellung"]["ausstehend"], 0);
        let id = termin["id"].as_str().unwrap();
        let karten: i64 = sqlx::query_scalar(
            "select count(*) from event_placements where event_id = $1 and message_id is not null",
        )
        .bind(Uuid::parse_str(id).unwrap())
        .fetch_one(&probe.state.pool)
        .await
        .unwrap();
        assert_eq!(karten, anzahl as i64);

        // Der Rundruf `event.updated` ging EINMAL raus, nicht einmal je Person.
        let mut aktualisiert = 0;
        while let Ok(rahmen) = empfaenger.try_recv() {
            let rahmen: Value = serde_json::from_str(&rahmen).unwrap();
            if rahmen["type"] == "event.updated" {
                aktualisiert += 1;
            }
        }
        assert_eq!(aktualisiert, 1, "ein Rundruf an alle");

        // Die Schreibanweisungen der Phase 1: je eine, gleich für wie viele.
        let zaehl = |anfang: &str| zaehler.beginnend_mit(anfang);
        let zeile = (
            zaehl("insert into calendar_events"),
            zaehl("insert into event_attendees"),
            zaehl("insert into event_placements"),
            zaehl("insert into conversations"),
            zaehl("insert into conversation_members"),
        );
        assert_eq!(zeile, (1, 1, 1, 1, 1), "bei {anzahl} Eingeladenen");
        // Die Nachrichten dagegen sind eine je Karte – Phase 2, begrenzt parallel.
        assert_eq!(zaehl("insert into messages"), anzahl);
        schreibend.push((anzahl, zeile));

        // Grosszügig: auf langsamer Hardware darf es Sekunden dauern, aber keine
        // Minuten.
        assert!(
            dauer.as_secs() < 120,
            "{anzahl} Eingeladene brauchten {:.0} s",
            dauer.as_secs_f64()
        );
    }
    assert_eq!(schreibend[0].1, schreibend[1].1, "{schreibend:?}");
}
