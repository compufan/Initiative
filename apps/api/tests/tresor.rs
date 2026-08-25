//! Die Dateiverschlüsselung an der echten Route.
//!
//! Die Bausteine haben eigene Tests in `storage/tresor.rs`. Hier geht es um
//! die Frage, die zählt: Wenn jemand ein Foto in den Chat lädt – liegt es
//! danach verschlüsselt auf der Platte, und kommt es trotzdem unversehrt
//! wieder heraus?
//!
//! Beides zusammen ist der Punkt. Verschlüsselt und kaputt wäre wertlos,
//! lesbar und heil wäre der Zustand, den wir loswerden wollten.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

use initiative_api::config::Config;
use initiative_api::state::AppState;
use initiative_api::{app, MIGRATOR};

struct Probe {
    router: Router,
    ordner: String,
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

    async fn roh(
        &self,
        method: &str,
        uri: &str,
        token: Option<&str>,
        kopfzeilen: Vec<(&str, String)>,
        body: Body,
    ) -> (StatusCode, Vec<(String, String)>, Vec<u8>) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        for (name, value) in kopfzeilen {
            builder = builder.header(name, value);
        }
        let response = self
            .router
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let kopf = response
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_string(),
                    value.to_str().unwrap_or_default().to_string(),
                )
            })
            .collect();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, kopf, bytes.to_vec())
    }
}

fn multipart(boundary: &str, daten: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"file\"; filename=\"urlaub.bin\"\r\n",
    );
    body.extend_from_slice(b"Content-Type: application/octet-stream\r\n\r\n");
    body.extend_from_slice(daten);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

/// Der Aufbau muss nacheinander laufen.
///
/// Die Umgebung gehört dem ganzen Prozess, nicht dem einzelnen Test. Ohne
/// dieses Schloss setzt der zweite Test `LOCAL_STORAGE_DIR` um, während der
/// erste seinen Zustand baut – der schaut dann in den Ordner des anderen und
/// findet dort nichts. Genau das ist beim ersten Lauf passiert, und zwar
/// unzuverlässig, also auf die unangenehme Art.
static AUFBAU: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn aufbauen() -> Option<Probe> {
    let url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;
    let ordner = format!("./.data/tresor-route-{}", Uuid::now_v7().simple());

    let _schloss = AUFBAU.lock().await;
    std::env::set_var("DATABASE_URL", &url);
    std::env::set_var("NODE_ENV", "test");
    std::env::set_var("JWT_SECRET", "test-secret-value-at-least-16-characters");
    std::env::set_var("REALTIME_BUS", "memory");
    std::env::set_var("STORAGE_DRIVER", "local");
    std::env::set_var("LOCAL_STORAGE_DIR", &ordner);
    std::env::set_var("PUBLIC_API_URL", "http://localhost:8080");
    std::env::set_var("PUBLIC_APP_URL", "http://localhost:5173");
    std::env::set_var("MEDIA_KEY", STANDARD.encode([42u8; 32]));

    let state = AppState::new(Config::from_env().expect("config"))
        .await
        .expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    Some(Probe {
        router: app::build(state),
        ordner,
    })
}

/// Ein Inhalt, den man auf der Platte eindeutig wiedererkennen würde – und
/// gross genug, dass er über mehrere Blöcke geht.
fn urlaubsfoto() -> Vec<u8> {
    let satz = b"Bankverbindung DE00 1234 5678 9012, Adresse Musterweg 1, 12345 Musterstadt. ";
    let mut daten = Vec::new();
    while daten.len() < 200_000 {
        daten.extend_from_slice(satz);
    }
    daten
}

#[tokio::test(flavor = "multi_thread")]
async fn eine_hochgeladene_datei_liegt_verschluesselt_und_kommt_heil_zurueck() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };

    let kennung = Uuid::now_v7().simple().to_string();
    let name = format!("tresor{}", &kennung[kennung.len() - 12..]);
    let (status, konto) = probe
        .call(
            "POST",
            "/api/v1/auth/register",
            None,
            Some(json!({
                "username": &name,
                "displayName": "Tresor Test",
                "password": "richtigespasswort",
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{konto}");
    let token = konto["accessToken"].as_str().expect("Token").to_string();

    let daten = urlaubsfoto();
    let (status, upload) = probe
        .call(
            "POST",
            "/api/v1/media/uploads",
            Some(&token),
            Some(json!({
                "kind": "file",
                "mime": "application/octet-stream",
                "size": daten.len(),
                "fileName": "urlaub.bin",
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{upload}");
    // Mit Verschlüsselung darf es keinen direkten Weg in den Speicher geben –
    // sonst käme dort Klartext an.
    assert_eq!(
        upload["strategy"], "direct",
        "vorsignierte Uploads würden die Verschlüsselung umgehen"
    );
    let anhang = upload["attachmentId"]
        .as_str()
        .expect("Kennung")
        .to_string();

    let boundary = "----initiativetresor";
    let (status, _, _) = probe
        .roh(
            "POST",
            &format!("/api/v1/media/uploads/{anhang}/data"),
            Some(&token),
            vec![(
                "content-type",
                format!("multipart/form-data; boundary={boundary}"),
            )],
            Body::from(multipart(boundary, &daten)),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    // 1. Auf der Platte darf nichts davon zu lesen sein.
    let auf_platte = dateien_sammeln(&probe.ordner);
    assert_eq!(auf_platte.len(), 1, "genau eine Datei erwartet");
    let roh = std::fs::read(&auf_platte[0]).expect("Datei lesen");
    assert!(
        !roh.windows(9).any(|f| f == b"Musterweg"),
        "der Klartext steht unverändert in {}",
        auf_platte[0]
    );
    assert!(
        roh.starts_with(b"INIVLT"),
        "die Datei trägt keinen Tresor-Kopf"
    );
    assert!(
        roh.len() > daten.len(),
        "verschlüsselt sollte etwas grösser sein (Kopf und Prüfsummen)"
    );

    // 2. Durch die API kommt sie unverändert zurück.
    let (status, _, zurueck) = probe
        .roh(
            "GET",
            &format!("/api/v1/media/{anhang}/bytes"),
            Some(&token),
            vec![],
            Body::empty(),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(zurueck.len(), daten.len(), "Länge stimmt nicht");
    assert_eq!(zurueck, daten, "Inhalt stimmt nicht");
}

#[tokio::test(flavor = "multi_thread")]
async fn vorspulen_im_video_holt_die_richtigen_bytes() {
    // Ein Range mitten in der Datei ist der Fall, an dem eine blockweise
    // Verschlüsselung scheitert, wenn man sich verrechnet: Der Browser zeigt
    // dann ein Video, das an der falschen Stelle weiterläuft, ohne Fehler.
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };

    let kennung = Uuid::now_v7().simple().to_string();
    let name = format!("spulen{}", &kennung[kennung.len() - 12..]);
    let (status, konto) = probe
        .call(
            "POST",
            "/api/v1/auth/register",
            None,
            Some(json!({
                "username": &name,
                "displayName": "Spulen Test",
                "password": "richtigespasswort",
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{konto}");
    let token = konto["accessToken"].as_str().expect("Token").to_string();

    let daten: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
    let (_, upload) = probe
        .call(
            "POST",
            "/api/v1/media/uploads",
            Some(&token),
            Some(json!({
                "kind": "file",
                "mime": "application/octet-stream",
                "size": daten.len(),
                "fileName": "film.bin",
            })),
        )
        .await;
    let anhang = upload["attachmentId"]
        .as_str()
        .expect("Kennung")
        .to_string();
    let boundary = "----initiativetresor";
    let (status, _, _) = probe
        .roh(
            "POST",
            &format!("/api/v1/media/uploads/{anhang}/data"),
            Some(&token),
            vec![(
                "content-type",
                format!("multipart/form-data; boundary={boundary}"),
            )],
            Body::from(multipart(boundary, &daten)),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    // Quer über Blockgrenzen (64 KiB) hinweg, damit sich ein Rechenfehler
    // nicht verstecken kann.
    for (von, bis) in [
        (0usize, 99usize),
        (65_530, 65_545),
        (65_536, 131_071),
        (131_090, 299_999),
        (299_999, 299_999),
    ] {
        let (status, kopf, teil) = probe
            .roh(
                "GET",
                &format!("/api/v1/media/{anhang}/bytes"),
                Some(&token),
                vec![("range", format!("bytes={von}-{bis}"))],
                Body::empty(),
            )
            .await;
        assert_eq!(status, StatusCode::PARTIAL_CONTENT, "{von}-{bis}");
        let bereich = kopf
            .iter()
            .find(|(name, _)| name == "content-range")
            .map(|(_, wert)| wert.clone())
            .unwrap_or_default();
        assert_eq!(
            bereich,
            format!("bytes {von}-{bis}/{}", daten.len()),
            "Content-Range bei {von}-{bis}"
        );
        assert_eq!(teil, &daten[von..=bis], "Inhalt bei {von}-{bis}");
    }
}

fn dateien_sammeln(wurzel: &str) -> Vec<String> {
    let mut gefunden = Vec::new();
    let mut offen = vec![std::path::PathBuf::from(wurzel)];
    while let Some(pfad) = offen.pop() {
        let Ok(eintraege) = std::fs::read_dir(&pfad) else {
            continue;
        };
        for eintrag in eintraege.flatten() {
            let pfad = eintrag.path();
            if pfad.is_dir() {
                offen.push(pfad);
            } else {
                gefunden.push(pfad.to_string_lossy().to_string());
            }
        }
    }
    gefunden
}
