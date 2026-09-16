//! Die Eintrittskarte, mit der ein Fernseher eine Datei abholt.
//!
//! # Warum es diesen Weg überhaupt gibt
//!
//! Beim Streamen holt das Gerät im Zimmer die Datei SELBST. Es ist kein
//! Rahmen im Browser und keine zweite Lasche, sondern ein eigener Rechner,
//! der nichts bekommt als eine Adresse – also weder den `Authorization`-Kopf
//! noch den Medien-Keks. Beide bestehenden Wege fallen damit aus, und es
//! bleibt nur einer: Der Ausweis muss in der Adresse stehen.
//!
//! # Was hier zusammengehalten wird
//!
//! Dass diese Adresse **eine** Datei aufschliesst und keine zweite. Das ist
//! der Unterschied zwischen einer Eintrittskarte und einem Generalschlüssel,
//! und man sieht ihn keiner der beiden an: Beide funktionieren beim ersten
//! Ausprobieren tadellos.
//!
//! Und dass die Rechte weiter GEFRAGT werden – beim Ausstellen wie beim
//! Abholen. Eine Karte, die nur beim Ausstellen geprüft wird, überlebt jeden
//! Austritt aus einem Gespräch, solange sie gilt.

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

    /// Ein Abruf ganz ohne Ausweis – so, wie ein Fernseher fragt.
    async fn wie_ein_fernseher(
        &self,
        uri: &str,
        bereich: Option<&str>,
    ) -> (StatusCode, Vec<u8>, Option<String>) {
        let mut builder = Request::builder().method("GET").uri(uri);
        if let Some(bereich) = bereich {
            builder = builder.header("range", bereich);
        }
        let response = self
            .router
            .clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let inhalt = response
            .headers()
            .get("content-range")
            .and_then(|w| w.to_str().ok())
            .map(str::to_string);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, bytes.to_vec(), inhalt)
    }

    async fn hochladen(&self, token: &str, inhalt: &[u8]) -> String {
        let (status, upload) = self
            .call(
                "POST",
                "/api/v1/media/uploads",
                Some(token),
                Some(json!({
                    "kind": "video",
                    "mime": "video/mp4",
                    "size": inhalt.len(),
                    "fileName": "urlaub.mp4",
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{upload}");
        let kennung = upload["attachmentId"]
            .as_str()
            .expect("Kennung")
            .to_string();

        let grenze = "----initiativefernsehen";
        let mut body = Vec::new();
        body.extend_from_slice(format!("--{grenze}\r\n").as_bytes());
        body.extend_from_slice(
            b"Content-Disposition: form-data; name=\"file\"; filename=\"urlaub.mp4\"\r\n",
        );
        body.extend_from_slice(b"Content-Type: video/mp4\r\n\r\n");
        body.extend_from_slice(inhalt);
        body.extend_from_slice(format!("\r\n--{grenze}--\r\n").as_bytes());

        let request = Request::builder()
            .method("POST")
            .uri(format!("/api/v1/media/uploads/{kennung}/data"))
            .header("authorization", format!("Bearer {token}"))
            .header(
                "content-type",
                format!("multipart/form-data; boundary={grenze}"),
            )
            .body(Body::from(body))
            .unwrap();
        let antwort = self.router.clone().oneshot(request).await.unwrap();
        assert_eq!(antwort.status(), StatusCode::OK, "Upload");
        kennung
    }

    async fn anmelden(&self, was: &str) -> String {
        let kennung = Uuid::now_v7().simple().to_string();
        let name = format!("{was}{}", &kennung[kennung.len() - 12..]);
        let (status, konto) = self
            .call(
                "POST",
                "/api/v1/auth/register",
                None,
                Some(json!({
                    "username": &name,
                    "displayName": "Fernseh Test",
                    "password": "richtigespasswort",
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{konto}");
        konto["accessToken"].as_str().expect("Token").to_string()
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
    std::env::set_var("STORAGE_DRIVER", "local");
    std::env::set_var(
        "LOCAL_STORAGE_DIR",
        format!("./.data/fernsehen-{}", Uuid::now_v7().simple()),
    );
    std::env::set_var("PUBLIC_API_URL", "http://localhost:8080");
    std::env::set_var("PUBLIC_APP_URL", "http://localhost:5173");
    std::env::remove_var("MEDIA_KEY");

    let state = AppState::new(Config::from_env().expect("config"))
        .await
        .expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    Some(Probe {
        router: app::build(state),
    })
}

/// Aus der vollen Adresse den Teil machen, den der Router sieht.
fn pfad(url: &str) -> String {
    let ohne_schema = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let ab_pfad = ohne_schema
        .find('/')
        .map(|i| &ohne_schema[i..])
        .unwrap_or("/");
    ab_pfad.to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn eine_karte_oeffnet_genau_eine_datei() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let token = probe.anmelden("fernseh").await;
    let inhalt: Vec<u8> = (0u8..=255).cycle().take(4096).collect();
    let video = probe.hochladen(&token, &inhalt).await;
    let anderes = probe.hochladen(&token, b"ein anderes video").await;

    let (status, karte) = probe
        .call(
            "POST",
            &format!("/api/v1/media/{video}/fernsehticket"),
            Some(&token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{karte}");
    let adresse = karte["url"].as_str().expect("Adresse").to_string();
    assert!(
        adresse.contains("tv="),
        "die Karte muss IN der Adresse stehen – ein Fernseher kann nichts anderes mitschicken: {adresse}"
    );
    assert!(
        adresse.starts_with("http://localhost:8080/"),
        "die Adresse muss von aussen erreichbar sein, nicht relativ: {adresse}"
    );

    /*
     * Der eigentliche Punkt: ohne Kopf, ohne Keks – so fragt das Gerät.
     */
    let (status, bytes, _) = probe.wie_ein_fernseher(&pfad(&adresse), None).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "der Fernseher kommt nicht an die Datei"
    );
    assert_eq!(bytes, inhalt, "es kamen andere Bytes zurück");

    /*
     * Ohne Karte bleibt die Tür zu. Sonst prüfte der Test nur, dass die
     * Auslieferung überhaupt Bytes herausgibt.
     */
    let (status, _, _) = probe
        .wie_ein_fernseher(&format!("/api/v1/media/{video}"), None)
        .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "ohne Karte darf ein anonymer Abruf nicht durchkommen"
    );

    /*
     * Und der Unterschied zwischen Eintrittskarte und Generalschlüssel:
     * dieselbe Karte, andere Datei.
     */
    let karte_roh = adresse.split("tv=").nth(1).expect("Karte").to_string();
    let (status, _, _) = probe
        .wie_ein_fernseher(&format!("/api/v1/media/{anderes}?tv={karte_roh}"), None)
        .await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "eine Karte für ein Video hat eine zweite Datei aufgeschlossen"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn der_fernseher_darf_vorspulen() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let token = probe.anmelden("spulen").await;
    let inhalt: Vec<u8> = (0u8..=255).cycle().take(4096).collect();
    let video = probe.hochladen(&token, &inhalt).await;
    let (_, karte) = probe
        .call(
            "POST",
            &format!("/api/v1/media/{video}/fernsehticket"),
            Some(&token),
            None,
        )
        .await;
    let adresse = pfad(karte["url"].as_str().expect("Adresse"));

    /*
     * Ein Fernseher spult mit Bereichsanfragen, und zwar mitten im Film.
     * Käme dabei die ganze Datei oder eine 401, stünde das Bild.
     */
    let (status, bytes, bereich) = probe
        .wie_ein_fernseher(&adresse, Some("bytes=100-199"))
        .await;
    assert_eq!(
        status,
        StatusCode::PARTIAL_CONTENT,
        "kein Vorspulen möglich"
    );
    assert_eq!(bytes.len(), 100);
    assert_eq!(bytes, inhalt[100..200]);
    assert_eq!(bereich.as_deref(), Some("bytes 100-199/4096"));
}

#[tokio::test(flavor = "multi_thread")]
async fn wer_die_datei_nicht_sehen_darf_bekommt_keine_karte() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let besitzer = probe.anmelden("besitz").await;
    let fremd = probe.anmelden("fremd").await;
    let video = probe.hochladen(&besitzer, b"privat").await;

    /*
     * Die Karte ist eine Rechteerweiterung auf Zeit. Wer sie ausstellen darf,
     * ohne die Datei sehen zu dürfen, hat den ganzen Zugriffsschutz umgangen –
     * und zwar auf einem Weg, der in keiner Auslieferung auftaucht.
     */
    let (status, antwort) = probe
        .call(
            "POST",
            &format!("/api/v1/media/{video}/fernsehticket"),
            Some(&fremd),
            None,
        )
        .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "eine fremde Person hat eine Karte bekommen: {antwort}"
    );

    // Ohne Anmeldung erst recht nicht.
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/media/{video}/fernsehticket"),
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}
