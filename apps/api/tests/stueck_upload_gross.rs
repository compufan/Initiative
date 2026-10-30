//! Eine grosse Datei in Stücken – und was der Server dabei an Speicher braucht.
//!
//! Eigene Testdatei, damit der Prozess nichts anderes nebenher tut: Gemessen
//! wird die Speicherspitze (`VmHWM`) des ganzen Prozesses, und die soll beim
//! Hochladen, Prüfen und Ausliefern von einer halben Gigabyte-Datei
//! weit unter der Dateigrösse bleiben. Genau das war beim alten Weg anders –
//! `field.bytes()` hielt die ganze Datei.
//!
//! 512 MiB und nicht Gigabytes: Die Platte des Prüfrechners ist knapp, und
//! ob eine Datei 0,5 oder 4 GiB hat, ändert an einem Weg, der nie mehr als
//! ein Netzpaket hält, nichts. Die Testdateien werden sofort wieder gelöscht.
//! `GROSS_MIB` setzt die Grösse für einen Lauf von Hand.

use axum::body::{Body, Bytes};
use axum::http::{Request, StatusCode};
use futures_util::StreamExt;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use sha2::Digest;
use tower::ServiceExt;
use uuid::Uuid;

use initiative_api::config::Config;
use initiative_api::constants::STUECK_GROESSE;
use initiative_api::state::AppState;
use initiative_api::{app, MIGRATOR};

const STUECK: usize = STUECK_GROESSE as usize;

/// `VmRSS` und `VmHWM` in KiB aus `/proc/self/status`.
fn speicher() -> (u64, u64) {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    let wert = |name: &str| {
        status
            .lines()
            .find(|z| z.starts_with(name))
            .and_then(|z| z.split_whitespace().nth(1))
            .and_then(|w| w.parse::<u64>().ok())
            .unwrap_or(0)
    };
    (wert("VmRSS:"), wert("VmHWM:"))
}

/// Stück `nr` der Datei – reproduzierbar, damit nichts davon im Speicher
/// liegen bleiben muss, um es später zu vergleichen.
fn stueck(nr: usize, laenge: usize) -> Vec<u8> {
    let mut x = (nr as u64 + 1).wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1;
    let mut aus = Vec::with_capacity(laenge);
    while aus.len() < laenge {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        aus.extend_from_slice(&x.to_le_bytes());
    }
    aus.truncate(laenge);
    aus
}

async fn json_aufruf(
    router: &axum::Router,
    methode: &str,
    uri: &str,
    token: Option<&str>,
    body: Value,
) -> (StatusCode, Value) {
    let mut b = Request::builder()
        .method(methode)
        .uri(uri)
        .header("content-type", "application/json");
    if let Some(token) = token {
        b = b.header("authorization", format!("Bearer {token}"));
    }
    let antwort = router
        .clone()
        .oneshot(
            b.body(Body::from(serde_json::to_vec(&body).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = antwort.status();
    let bytes = antwort.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test(flavor = "multi_thread")]
async fn eine_grosse_datei_geht_durch_ohne_den_speicher_zu_fuellen() {
    let Ok(url) = std::env::var("TEST_DATABASE_URL").or_else(|_| std::env::var("DATABASE_URL"))
    else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    std::env::set_var("DATABASE_URL", &url);
    std::env::set_var("NODE_ENV", "test");
    std::env::set_var("JWT_SECRET", "test-secret-value-at-least-16-characters");
    std::env::set_var("REALTIME_BUS", "memory");
    std::env::set_var("STORAGE_DRIVER", "local");
    std::env::remove_var("MEDIA_KEY");

    let mib: usize = std::env::var("GROSS_MIB")
        .ok()
        .and_then(|w| w.parse().ok())
        .unwrap_or(512);
    let groesse = mib * 1024 * 1024 + 4321; // krumm, damit das letzte Stück kürzer ist
    let anzahl = groesse.div_ceil(STUECK);

    let ablage = format!("./.data/stueck-gross-{}", Uuid::now_v7().simple());
    struct Weg(String);
    impl Drop for Weg {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _weg = Weg(ablage.clone());

    let mut config = Config::from_env().expect("config");
    config.local_storage_dir = format!("{ablage}/medien");
    config.upload_teile_dir = format!("{ablage}/medien/.teile");
    config.rate_limit = false;
    config.media_key = None;
    config.upload_platte_reserve_bytes = 256 * 1024 * 1024;
    let state = AppState::new(config).await.expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    let router = app::build(state.clone());

    let name = format!("gross{}", &Uuid::now_v7().simple().to_string()[20..]);
    let (status, konto) = json_aufruf(
        &router,
        "POST",
        "/api/v1/auth/register",
        None,
        json!({ "username": name, "displayName": "Gross", "password": "richtigespasswort" }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{konto}");
    let token = konto["accessToken"].as_str().unwrap().to_string();

    // Die Prüfsumme vorab, Stück für Stück – auch hier nie die ganze Datei.
    let mut hasher = sha2::Sha256::new();
    for nr in 0..anzahl {
        hasher.update(stueck(nr, STUECK.min(groesse - nr * STUECK)));
    }
    let pruef = hex::encode(hasher.finalize());

    let (status, stand) = json_aufruf(
        &router,
        "POST",
        "/api/v1/media/stuecke",
        Some(&token),
        json!({ "kind": "file", "mime": "application/octet-stream", "size": groesse, "fileName": "gross.bin", "sha256": pruef }),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED, "{stand}");
    let sitzung = stand["sitzungId"].as_str().unwrap().to_string();

    let (rss_vorher, _) = speicher();
    let start = std::time::Instant::now();

    // Zwei Stücke gleichzeitig, wie der Client es tut; jedes als Strom in
    // Paketen zu 64 KiB, wie es aus dem Netz käme.
    let senden = |nr: usize| {
        let router = router.clone();
        let token = token.clone();
        let sitzung = sitzung.clone();
        async move {
            let laenge = STUECK.min(groesse - nr * STUECK);
            let daten = Bytes::from(stueck(nr, laenge));
            let pakete: Vec<Result<Bytes, std::io::Error>> = (0..laenge)
                .step_by(64 * 1024)
                .map(|ab| Ok(daten.slice(ab..(ab + 64 * 1024).min(laenge))))
                .collect();
            let anfrage = Request::builder()
                .method("PUT")
                .uri(format!("/api/v1/media/stuecke/{sitzung}"))
                .header("authorization", format!("Bearer {token}"))
                .header(
                    "content-range",
                    format!(
                        "bytes {}-{}/{}",
                        nr * STUECK,
                        nr * STUECK + laenge - 1,
                        groesse
                    ),
                )
                .body(Body::from_stream(futures_util::stream::iter(pakete)))
                .unwrap();
            let antwort = router.oneshot(anfrage).await.unwrap();
            assert_eq!(antwort.status(), StatusCode::OK, "Stück {nr}");
        }
    };
    // Rückwärts, damit auch hier keine Reihenfolge vorausgesetzt wird.
    let mut reihe: Vec<usize> = (0..anzahl).rev().collect();
    while let Some(a) = reihe.pop() {
        match reihe.pop() {
            Some(b) => {
                tokio::join!(senden(a), senden(b));
            }
            None => senden(a).await,
        }
    }
    let hochladen = start.elapsed();

    let (status, anhang) = json_aufruf(
        &router,
        "POST",
        &format!("/api/v1/media/stuecke/{sitzung}/abschliessen"),
        Some(&token),
        json!({}),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{anhang}");
    let id = anhang["id"].as_str().unwrap().to_string();

    // Ganz herunterladen, im Strom gezählt und geprüft – nicht gesammelt.
    let antwort = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/media/{id}/download"))
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(antwort.status(), StatusCode::OK);
    let mut strom = antwort.into_body().into_data_stream();
    let mut hasher = sha2::Sha256::new();
    let mut gezaehlt = 0usize;
    while let Some(paket) = strom.next().await {
        let paket = paket.unwrap();
        gezaehlt += paket.len();
        hasher.update(&paket);
    }
    assert_eq!(gezaehlt, groesse);
    assert_eq!(hex::encode(hasher.finalize()), pruef);

    // Ein Sprung ans Ende, wie beim Spulen.
    let antwort = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/media/{id}"))
                .header("authorization", format!("Bearer {token}"))
                .header("range", format!("bytes={}-", groesse - 100))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(antwort.status(), StatusCode::PARTIAL_CONTENT);
    let ende = antwort.into_body().collect().await.unwrap().to_bytes();
    let letztes = stueck(anzahl - 1, groesse - (anzahl - 1) * STUECK);
    assert_eq!(&ende[..], &letztes[letztes.len() - 100..]);

    let (rss_nachher, spitze) = speicher();
    let zuwachs_mib = spitze.saturating_sub(rss_vorher) / 1024;
    eprintln!(
        "grosser Upload: {mib} MiB in {anzahl} Stücken, hochgeladen in {:.1} s, gesamt {:.1} s; \
         RSS vorher {} MiB, nachher {} MiB, Spitze {} MiB (Zuwachs {zuwachs_mib} MiB)",
        hochladen.as_secs_f64(),
        start.elapsed().as_secs_f64(),
        rss_vorher / 1024,
        rss_nachher / 1024,
        spitze / 1024,
    );
    // Je Anfrage ein Stück (8 MiB) im TEST, zwei gleichzeitig, dazu Puffer
    // für Prüfsumme und Auslieferung. Das Hundertfache Abstand zur Datei.
    assert!(
        zuwachs_mib < 96,
        "Speicherspitze wuchs um {zuwachs_mib} MiB – da hält jemand die Datei fest"
    );
}
