//! Viele gleichzeitige Änderungen lassen den Verbindungsvorrat nicht leerlaufen.
//!
//! Eine Änderung der Einladungen hält eine Transaktion offen. Forderte sie
//! darin noch eine zweite Verbindung an (Personen prüfen, Chats lesen), hielten
//! bei genug gleichzeitigen Änderungen alle eine und warteten auf die nächste –
//! bis der Vorrat nach fünfzehn Sekunden mit einem Fehler aufgibt. Der Vorrat
//! ist hier auf **zwei** Verbindungen gestellt: Wer darin mehr als eine je
//! Anfrage braucht, bleibt hängen.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

use initiative_api::config::Config;
use initiative_api::state::AppState;
use initiative_api::{app, MIGRATOR};

async fn call(
    router: &axum::Router,
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
    let response = router.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn gleichzeitige_aenderungen_brauchen_nur_eine_verbindung_je_anfrage() {
    let Ok(url) = std::env::var("TEST_DATABASE_URL").or_else(|_| std::env::var("DATABASE_URL"))
    else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – übersprungen");
        return;
    };
    std::env::set_var("DATABASE_URL", &url);
    std::env::set_var("NODE_ENV", "test");
    std::env::set_var("JWT_SECRET", "test-secret-value-at-least-16-characters");
    std::env::set_var("REALTIME_BUS", "memory");
    std::env::set_var("DATABASE_POOL_MAX", "2");
    std::env::set_var("RATE_LIMIT", "false");
    std::env::set_var("STORAGE_DRIVER", "local");
    std::env::set_var(
        "LOCAL_STORAGE_DIR",
        format!("./.data/einladen-vorrat-{}", Uuid::now_v7().simple()),
    );
    std::env::set_var("PUBLIC_API_URL", "http://localhost:8080");
    std::env::set_var("PUBLIC_APP_URL", "http://localhost:5173");

    let state = AppState::new(Config::from_env().expect("config"))
        .await
        .expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    let router = app::build(state);

    let zufall = Uuid::now_v7().simple().to_string();
    let n = &zufall[zufall.len() - 10..];
    let mut konten = Vec::new();
    for name in ["anna", "bodo", "cleo"] {
        let (status, konto) = call(
            &router,
            "POST",
            "/api/v1/auth/register",
            None,
            Some(json!({
                "username": format!("{name}{n}"),
                "displayName": name,
                "password": "richtigespasswort",
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{konto}");
        konten.push((
            konto["accessToken"].as_str().unwrap().to_string(),
            konto["user"]["id"].as_str().unwrap().to_string(),
        ));
    }
    let (anna, bodo, cleo) = (&konten[0], &konten[1], &konten[2]);

    // Sechs Termine von Anna, alle mit Bodo.
    let beginn = chrono::Utc::now() + chrono::Duration::days(3);
    let mut termine = Vec::new();
    for nummer in 0..6 {
        let (status, termin) = call(
            &router,
            "POST",
            "/api/v1/calendar/events",
            Some(&anna.0),
            Some(json!({
                "title": format!("Termin {nummer}"),
                "startsAt": beginn,
                "endsAt": beginn + chrono::Duration::hours(1),
                "attendeeIds": [bodo.1],
                "zustellung": {}
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED, "{termin}");
        termine.push(termin["id"].as_str().unwrap().to_string());
    }

    // Gleichzeitig: Cleo zu allen sechs hinzufügen. Jede Anfrage legt einen
    // Einzelchat an, prüft Personen und liest Karten – alles in EINER
    // Transaktion.
    let zeit = std::time::Instant::now();
    let pfade: Vec<String> = termine
        .iter()
        .map(|id| format!("/api/v1/calendar/events/{id}"))
        .collect();
    let antworten = futures_util::future::join_all(pfade.iter().map(|pfad| {
        call(
            &router,
            "PATCH",
            pfad,
            Some(&anna.0),
            Some(json!({ "attendeeIds": [bodo.1, cleo.1] })),
        )
    }))
    .await;
    for (status, antwort) in &antworten {
        assert_eq!(*status, StatusCode::OK, "{antwort}");
        assert_eq!(antwort["zustellung"]["einzelchats"], 1, "{antwort}");
    }
    assert!(
        zeit.elapsed().as_secs() < 14,
        "kein Hängen bis zur Zeitüberschreitung des Vorrats: {:?}",
        zeit.elapsed()
    );
}
