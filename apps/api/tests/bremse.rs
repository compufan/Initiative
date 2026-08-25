//! Die Ratenbremse an der Anmeldung – gegen Durchprobieren von Passwörtern.
//!
//! Auf Fly.io lag ein Proxy des Anbieters davor. Auf einem eigenen Server
//! steht die API hinter Caddy und sonst nichts: Wer die Adresse kennt, könnte
//! ohne Bremse Passwörter im Sekundentakt durchprobieren, und das kostet ihn
//! nichts ausser Zeit.
//!
//! Geprüft wird hier nicht die Zählmechanik – die hat eigene Tests in
//! `drossel.rs` – sondern dass sie an der echten Route wirklich greift und
//! dass sie **niemanden aussperrt, der sich nur vertippt hat**.

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

struct Probe {
    router: Router,
}

impl Probe {
    async fn post(&self, uri: &str, body: Value) -> (StatusCode, Value) {
        let request = Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap();
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn anmelden(&self, name: &str, passwort: &str) -> (StatusCode, Value) {
        self.post(
            "/api/v1/auth/login",
            json!({ "username": name, "password": passwort }),
        )
        .await
    }
}

/// Ein eindeutiger, aber kurzer Name – Benutzernamen sind auf 32 Zeichen
/// begrenzt, eine ganze UUID passt also nicht davor.
fn kurz(vorne: &str) -> String {
    let kennung = Uuid::now_v7().simple().to_string();
    format!("{vorne}{}", &kennung[kennung.len() - 12..])
}

async fn aufbauen() -> Option<Probe> {
    let url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;
    std::env::set_var("DATABASE_URL", &url);
    std::env::set_var("NODE_ENV", "test");
    std::env::set_var("JWT_SECRET", "test-secret-value-at-least-16-characters");
    std::env::set_var("REALTIME_BUS", "memory");
    std::env::set_var("STORAGE_DRIVER", "local");
    std::env::set_var("LOCAL_STORAGE_DIR", "./.data/test-uploads");
    let state = AppState::new(Config::from_env().expect("config"))
        .await
        .expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    Some(Probe {
        router: app::build(state),
    })
}

#[tokio::test]
async fn durchprobieren_wird_nach_fuenf_versuchen_gestoppt() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let name = kurz("opfer");

    // Fünf Fehlversuche sind erlaubt – ein vertipptes Passwort soll niemanden
    // aufhalten.
    for versuch in 1..=5 {
        let (status, _) = probe.anmelden(&name, "falsch").await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "Versuch {versuch} sollte noch durchgehen"
        );
    }

    // Der sechste nicht mehr.
    let (status, body) = probe.anmelden(&name, "falsch").await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");

    // Und die Absage darf nicht verraten, ob es das Konto überhaupt gibt –
    // dieses hier existiert nämlich gar nicht.
    let text = body["error"]["message"].as_str().unwrap_or_default();
    assert!(
        !text.to_lowercase().contains("konto") && !text.to_lowercase().contains("benutzer"),
        "die Absage verrät zu viel: {text}"
    );
}

#[tokio::test]
async fn wer_sich_vertippt_und_dann_richtig_liegt_wird_nicht_gebremst() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let name = kurz("tipp");
    let (status, _) = probe
        .post(
            "/api/v1/auth/register",
            json!({
                "username": &name,
                "displayName": "Tipp Fehler",
                "password": "richtigespasswort",
            }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);

    // Viermal daneben …
    for _ in 0..4 {
        let (status, _) = probe.anmelden(&name, "daneben").await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    // … dann richtig. Das setzt den Zähler zurück.
    let (status, _) = probe.anmelden(&name, "richtigespasswort").await;
    assert_eq!(status, StatusCode::OK);

    // Also stehen wieder alle Versuche zur Verfügung. Ohne das Zurücksetzen
    // wäre man nach dem zweiten Vertippen am selben Tag ausgesperrt.
    for versuch in 1..=5 {
        let (status, _) = probe.anmelden(&name, "daneben").await;
        assert_eq!(
            status,
            StatusCode::UNAUTHORIZED,
            "Versuch {versuch} nach geglückter Anmeldung"
        );
    }
}

#[tokio::test]
async fn ein_gebremstes_konto_sperrt_kein_anderes() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    // Beide Anfragen kommen aus derselben Quelle – im Test gibt es keine
    // Gegenstelle, der Adressschlüssel ist für beide gleich. Genau so sieht es
    // hinter einem Router aus: Der ganze Haushalt teilt sich eine Adresse.
    //
    // Dieser Test hat die erste Fassung widerlegt. Dort galten je Adresse
    // dieselben fünf Versuche wie je Konto – fünf Vertipper im Wohnzimmer, und
    // niemand im Haus kam mehr hinein.
    let opfer = kurz("eins");
    let anderer = kurz("zwei");
    let (status, _) = probe
        .post(
            "/api/v1/auth/register",
            json!({
                "username": &anderer,
                "displayName": "Zwei",
                "password": "richtigespasswort",
            }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);

    for _ in 0..6 {
        let _ = probe.anmelden(&opfer, "falsch").await;
    }

    let (status, body) = probe.anmelden(&anderer, "richtigespasswort").await;
    assert_eq!(
        status,
        StatusCode::OK,
        "der Unbeteiligte muss weiterhin hineinkommen: {body}"
    );
}

#[tokio::test]
async fn eine_unbekannte_kennung_braucht_genauso_lange_wie_eine_bekannte() {
    // Der Kern der Sache: Wenn die Anmeldung fuer einen unbekannten Namen
    // sofort antwortet und fuer einen bekannten eine halbe Sekunde rechnet,
    // ist die Mitgliederliste mit einer Stoppuhr auslesbar. Genau das war der
    // Fall - der von Hand geschriebene Dummy-Hash war ungueltig und wurde nie
    // geprueft: 8 Mikrosekunden gegen 505 Millisekunden.
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let bekannt = kurz("zeit");
    let (status, _) = probe
        .post(
            "/api/v1/auth/register",
            json!({
                "username": &bekannt,
                "displayName": "Zeit Test",
                "password": "richtigespasswort",
            }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);

    async fn messen(probe: &Probe, name: &str) -> std::time::Duration {
        let start = std::time::Instant::now();
        let _ = probe.anmelden(name, "falschespasswort").await;
        start.elapsed()
    }

    // Je einmal vorweg, damit einmalige Kosten (Verbindungsaufbau, das erste
    // Erzeugen des Dummy-Hashes) nicht in die Messung fallen.
    let _ = messen(&probe, &bekannt).await;
    let _ = messen(&probe, &kurz("warm")).await;

    let mit = messen(&probe, &bekannt).await;
    let ohne = messen(&probe, &kurz("gibtsnicht")).await;

    // Grosszuegig: Es geht nicht um Mikrosekunden, sondern darum, dass nicht
    // die eine Antwort sofort kommt und die andere nach einer halben Sekunde.
    let verhaeltnis = mit.as_secs_f64() / ohne.as_secs_f64().max(1e-9);
    assert!(
        (0.1..=10.0).contains(&verhaeltnis),
        "Antwortzeiten verraten das Konto: bekannt {mit:?}, unbekannt {ohne:?} (Faktor {verhaeltnis:.0})"
    );
}
