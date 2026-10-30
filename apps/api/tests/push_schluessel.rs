//! Push ohne Handarbeit: Fehlt das VAPID-Paar in der Umgebung, legt der Server
//! eines in der Datenbank an – und benutzt nach einem Neustart dasselbe.
//!
//! Vorher war Push ohne `VAPID_*` schlicht aus, und jedes Gerät hörte nach
//! erteilter Erlaubnis „Dieser Server verschickt gerade keine
//! Benachrichtigungen“.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

use initiative_api::config::{Config, VapidConfig};
use initiative_api::push::{schluessel_aus_datenbank, vapid, PushService};
use initiative_api::state::AppState;
use initiative_api::{app, MIGRATOR};

fn konfiguration() -> Option<Config> {
    let url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;
    std::env::set_var("DATABASE_URL", &url);
    std::env::set_var("NODE_ENV", "test");
    std::env::set_var("JWT_SECRET", "test-secret-value-at-least-16-characters");
    std::env::set_var("REALTIME_BUS", "memory");
    std::env::set_var("STORAGE_DRIVER", "local");
    std::env::set_var("LOCAL_STORAGE_DIR", "./.data/test-uploads");
    let mut config = Config::from_env().expect("config");
    // Bewusst am Wert, nicht an der Umgebung: Die Tests laufen nebeneinander
    // im selben Prozess.
    config.vapid = None;
    config.vapid_unvollstaendig = false;
    Some(config)
}

macro_rules! konfig {
    () => {
        match konfiguration() {
            Some(config) => config,
            None => {
                eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
                return;
            }
        }
    };
}

#[tokio::test]
async fn ohne_umgebung_kommt_das_paar_aus_der_datenbank_und_bleibt() {
    let config = Arc::new(konfig!());
    let state = AppState::from_pool(
        sqlx::PgPool::connect(&config.database_url).await.unwrap(),
        config.clone(),
    )
    .await
    .unwrap();
    MIGRATOR.run(&state.pool).await.expect("migrations");

    // Vor dem ersten Bedarf ist noch nichts geladen …
    let erster = PushService::new(config.clone());
    assert!(!erster.enabled());
    // … danach ist Push an, mit einem gültigen Paar.
    assert!(erster.bereit(&state.pool).await);
    let oeffentlich = erster.public_key().expect("öffentlicher Schlüssel");
    let (gespeichert, privat) = schluessel_aus_datenbank(&state.pool).await.unwrap();
    assert_eq!(oeffentlich, gespeichert);
    assert_eq!(vapid::paar_pruefen(&gespeichert, &privat), Ok(()));

    // „Neustart“: ein frischer Dienst liest dasselbe Paar, statt ein neues
    // anzulegen – sonst wäre jedes Abo nach einem Deploy tot.
    let zweiter = PushService::new(config.clone());
    assert!(zweiter.bereit(&state.pool).await);
    assert_eq!(zweiter.public_key().as_deref(), Some(oeffentlich.as_str()));

    // Viele gleichzeitig (mehrere Instanzen, viele Geräte): ein Paar.
    let mut auftraege = Vec::new();
    for _ in 0..8 {
        let pool = state.pool.clone();
        let config = config.clone();
        auftraege.push(tokio::spawn(async move {
            let dienst = PushService::new(config);
            assert!(dienst.bereit(&pool).await);
            dienst.public_key().unwrap()
        }));
    }
    for auftrag in auftraege {
        assert_eq!(auftrag.await.unwrap(), oeffentlich);
    }

    // Und die App bekommt ihn über die öffentliche Schnittstelle.
    let antwort = app::build(state.clone())
        .oneshot(
            Request::builder()
                .uri("/api/v1/push/public-key")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(antwort.status(), StatusCode::OK);
    let koerper: Value =
        serde_json::from_slice(&antwort.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(koerper["enabled"], true, "{koerper}");
    assert_eq!(koerper["publicKey"], oeffentlich.as_str(), "{koerper}");
}

#[tokio::test]
async fn die_umgebung_hat_vorrang() {
    let mut config = konfig!();
    let eigenes = vapid::generate_keys();
    config.vapid = Some(VapidConfig {
        public_key: eigenes.public_key.clone(),
        private_key: eigenes.private_key.clone(),
        subject: "mailto:betrieb@example.org".into(),
    });
    let dienst = PushService::new(Arc::new(config));
    // Ohne jede Datenbank an: Das Paar steht in der Umgebung.
    assert!(dienst.enabled());
    assert_eq!(dienst.public_key(), Some(eigenes.public_key));
}

#[tokio::test]
async fn ein_kaputtes_paar_aus_der_umgebung_wird_nicht_benutzt() {
    let mut config = konfig!();
    let eins = vapid::generate_keys();
    let zwei = vapid::generate_keys();
    config.vapid = Some(VapidConfig {
        public_key: eins.public_key,
        private_key: zwei.private_key,
        subject: "mailto:betrieb@example.org".into(),
    });
    let dienst = PushService::new(Arc::new(config));
    // Mit einem Paar, das nicht zusammenpasst, scheiterte jeder Versand an
    // einer 403 – lieber das (funktionierende) aus der Datenbank.
    assert!(!dienst.enabled());
}
