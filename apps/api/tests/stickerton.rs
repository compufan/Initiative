//! Ein Sticker, der klingt.
//!
//! # Was hier zusammengehalten wird
//!
//! Drei Dinge, die alle still schiefgehen können:
//!
//!   * **Der Zugriff.** Ein Sticker hat seit Migration 0022 zwei Anhänge, und
//!     die Rechteprüfung kannte lange nur einen. Wird die Tonspur dort
//!     vergessen, sieht der Empfänger das Bild und bekommt für den Ton ein
//!     404 – und zwar NUR der Empfänger, weil beim Hochladenden schon der
//!     Zweig „besitz" greift. Beim Ausprobieren merkt man davon nichts.
//!   * **Der Typ der Datei.** Für das Bild wird `kind` auf `sticker`
//!     festgeschrieben, damit es nie als gewöhnlicher Anhang durchgeht. Für
//!     den Ton wäre genau das ein Fehler: `kind = 'audio'` erbt die erlaubten
//!     MIME-Typen, die Grössengrenze und den Filter „Ton" in der Dateiansicht.
//!   * **Die Waisen.** `stickers.ton_attachment_id` steht auf `set null`,
//!     damit das Aufräumen einer Tondatei nicht den ganzen Sticker mitnimmt.
//!     Der Preis dafür ist, dass beide Löschwege den Anhang selbst wegräumen
//!     müssen – sonst liegt er für immer im Speicher.

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
        let (status, _, bytes) = self.roh(method, uri, token, vec![], body).await;
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn roh(
        &self,
        method: &str,
        uri: &str,
        token: Option<&str>,
        kopfzeilen: Vec<(&str, String)>,
        body: Option<Value>,
    ) -> (StatusCode, Vec<(String, String)>, Vec<u8>) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        for (name, wert) in kopfzeilen {
            builder = builder.header(name, wert);
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
        let kopf = response
            .headers()
            .iter()
            .map(|(name, wert)| {
                (
                    name.as_str().to_string(),
                    wert.to_str().unwrap_or_default().to_string(),
                )
            })
            .collect();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, kopf, bytes.to_vec())
    }

    /// Registriert ein Konto: Token und Medien-Keks.
    async fn konto(&self, was: &str) -> (String, String) {
        let kennung = Uuid::now_v7().simple().to_string();
        let name = format!("{was}{}", &kennung[kennung.len() - 12..]);
        let (status, kopf, bytes) = self
            .roh(
                "POST",
                "/api/v1/auth/register",
                None,
                vec![],
                Some(json!({
                    "username": &name,
                    "displayName": "Ton Test",
                    "password": "richtigespasswort",
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "Registrierung {name}");
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let keks = kopf
            .iter()
            .find(|(n, _)| n == "set-cookie")
            .and_then(|(_, w)| w.split(';').next())
            .and_then(|erstes| erstes.split_once('='))
            .map(|(_, wert)| wert.to_string())
            .expect("Medien-Keks");
        (body["accessToken"].as_str().unwrap().to_string(), keks)
    }

    /// Eine Datei hochladen und fertigmelden.
    async fn hochladen(&self, token: &str, art: &str, mime: &str, inhalt: &[u8]) -> String {
        let name = if art == "audio" { "ton.wav" } else { "bild.png" };
        let (status, upload) = self
            .call(
                "POST",
                "/api/v1/media/uploads",
                Some(token),
                Some(json!({
                    "kind": art,
                    "mime": mime,
                    "size": inhalt.len(),
                    "fileName": name,
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{upload}");
        let kennung = upload["attachmentId"].as_str().unwrap().to_string();

        let grenze = "----initiativeton";
        let mut body = Vec::new();
        body.extend_from_slice(format!("--{grenze}\r\n").as_bytes());
        body.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n")
                .as_bytes(),
        );
        body.extend_from_slice(format!("Content-Type: {mime}\r\n\r\n").as_bytes());
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
        assert_eq!(antwort.status(), StatusCode::OK, "Hochladen {art}");
        kennung
    }

    /// Ein Anhang abgerufen, wie es ein `<audio>` tut: mit Keks, ohne Kopf.
    async fn holen(&self, anhang: &str, keks: &str) -> StatusCode {
        let (status, _, _) = self
            .roh(
                "GET",
                &format!("/api/v1/media/{anhang}"),
                None,
                vec![("cookie", format!("initiative_medien={keks}"))],
                None,
            )
            .await;
        status
    }

    async fn paket(&self, token: &str, oeffentlich: bool) -> String {
        let (status, paket) = self
            .call(
                "POST",
                "/api/v1/stickers/packs",
                Some(token),
                Some(json!({ "name": "Tonpaket", "isPublic": oeffentlich })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{paket}");
        paket["id"].as_str().unwrap().to_string()
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
        format!("./.data/stickerton-{}", Uuid::now_v7().simple()),
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

/// Ein PNG von einem Bildpunkt – das kleinste, was als Sticker durchgeht.
fn png() -> Vec<u8> {
    vec![
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ]
}

/// Ein sehr kurzes WAV – derselbe Kopf, den `apps/web/src/lib/ton/wav.ts` schreibt.
fn wav() -> Vec<u8> {
    let werte: Vec<i16> = (0..240).map(|i| ((i as f32 * 0.1).sin() * 8000.0) as i16).collect();
    let daten: Vec<u8> = werte.iter().flat_map(|w| w.to_le_bytes()).collect();
    let mut aus = Vec::new();
    aus.extend_from_slice(b"RIFF");
    aus.extend_from_slice(&(36u32 + daten.len() as u32).to_le_bytes());
    aus.extend_from_slice(b"WAVEfmt ");
    aus.extend_from_slice(&16u32.to_le_bytes());
    aus.extend_from_slice(&1u16.to_le_bytes()); // PCM
    aus.extend_from_slice(&1u16.to_le_bytes()); // ein Kanal
    aus.extend_from_slice(&24_000u32.to_le_bytes());
    aus.extend_from_slice(&48_000u32.to_le_bytes());
    aus.extend_from_slice(&2u16.to_le_bytes());
    aus.extend_from_slice(&16u16.to_le_bytes());
    aus.extend_from_slice(b"data");
    aus.extend_from_slice(&(daten.len() as u32).to_le_bytes());
    aus.extend_from_slice(&daten);
    aus
}

#[tokio::test(flavor = "multi_thread")]
async fn ein_sticker_bekommt_ton_und_jeder_darf_ihn_hoeren() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let (anna, _) = probe.konto("tonanna").await;
    let (_, berts_keks) = probe.konto("tonbert").await;

    let bild = probe.hochladen(&anna, "sticker", "image/png", &png()).await;
    let ton = probe.hochladen(&anna, "audio", "audio/wav", &wav()).await;
    let paket = probe.paket(&anna, true).await;

    let (status, antwort) = probe
        .call(
            "POST",
            &format!("/api/v1/stickers/packs/{paket}/stickers"),
            Some(&anna),
            Some(json!({ "attachmentId": bild, "tonAttachmentId": ton, "tonDauerMs": 1200 })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{antwort}");

    let sticker = &antwort["stickers"][0];
    assert!(
        sticker["tonUrl"].as_str().is_some_and(|url| url.contains(&ton)),
        "die Adresse der Tonspur fehlt in der Antwort: {antwort}"
    );
    assert_eq!(sticker["tonDauerMs"], json!(1200));

    /*
     * DER Punkt dieses Tests: Bert darf den Ton hören.
     *
     * Das Paket ist öffentlich, also sieht Bert das Bild – das war schon
     * vorher so. Ob er auch den TON bekommt, hängt daran, ob die
     * Rechteprüfung beide Anhänge kennt. Bei Anna selbst würde es in jedem
     * Fall gehen, weil sie die Datei hochgeladen hat; die Frage stellt sich
     * nur bei jemand anderem.
     */
    assert_eq!(
        probe.holen(&bild, &berts_keks).await,
        StatusCode::OK,
        "das Bild eines öffentlichen Stickers sieht jeder Angemeldete"
    );
    assert_eq!(
        probe.holen(&ton, &berts_keks).await,
        StatusCode::OK,
        "und den Ton auch – sonst erscheint der Sticker und bleibt stumm"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn ein_privates_paket_gibt_auch_seinen_ton_nicht_heraus() {
    // Die Gegenprobe. Wäre die Rechteprüfung zu weit geöffnet worden, fiele
    // es hier auf – und nur hier.
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let (anna, _) = probe.konto("privanna").await;
    let (_, berts_keks) = probe.konto("privbert").await;

    let bild = probe.hochladen(&anna, "sticker", "image/png", &png()).await;
    let ton = probe.hochladen(&anna, "audio", "audio/wav", &wav()).await;
    let paket = probe.paket(&anna, false).await;
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/stickers/packs/{paket}/stickers"),
            Some(&anna),
            Some(json!({ "attachmentId": bild, "tonAttachmentId": ton })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);

    assert_eq!(probe.holen(&bild, &berts_keks).await, StatusCode::NOT_FOUND);
    assert_eq!(
        probe.holen(&ton, &berts_keks).await,
        StatusCode::NOT_FOUND,
        "ein Ton aus einem privaten Paket ist kein Freibrief"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn die_tonspur_behaelt_ihren_typ() {
    /*
     * `claim_attachment` schreibt für das Bild `kind = 'sticker'` fest. Würde
     * dieselbe Funktion für den Ton benutzt, verlöre die Datei ihren Typ – und
     * fiele damit aus der MIME-Prüfung beim Hochladen und aus dem Filter „Ton"
     * in der Dateiansicht.
     *
     * Geprüft wird über die Auslieferung: Ein Anhang mit `kind = 'audio'`
     * bekommt seinen MIME-Typ zurück; einer, der als Sticker gilt, nicht.
     */
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let (anna, annas_keks) = probe.konto("typanna").await;
    let bild = probe.hochladen(&anna, "sticker", "image/png", &png()).await;
    let ton = probe.hochladen(&anna, "audio", "audio/wav", &wav()).await;
    let paket = probe.paket(&anna, false).await;
    probe
        .call(
            "POST",
            &format!("/api/v1/stickers/packs/{paket}/stickers"),
            Some(&anna),
            Some(json!({ "attachmentId": bild, "tonAttachmentId": ton })),
        )
        .await;

    let (status, kopf, _) = probe
        .roh(
            "GET",
            &format!("/api/v1/media/{ton}"),
            None,
            vec![("cookie", format!("initiative_medien={annas_keks}"))],
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let typ = kopf
        .iter()
        .find(|(name, _)| name == "content-type")
        .map(|(_, wert)| wert.clone())
        .unwrap_or_default();
    assert!(
        typ.starts_with("audio/"),
        "die Tondatei wird nicht mehr als Ton ausgeliefert: {typ}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn ton_laesst_sich_nachtraeglich_anhaengen_und_wieder_wegnehmen() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let (anna, annas_keks) = probe.konto("nachanna").await;
    let bild = probe.hochladen(&anna, "sticker", "image/png", &png()).await;
    let paket = probe.paket(&anna, false).await;
    let (_, angelegt) = probe
        .call(
            "POST",
            &format!("/api/v1/stickers/packs/{paket}/stickers"),
            Some(&anna),
            Some(json!({ "attachmentId": bild })),
        )
        .await;
    let sticker = angelegt["stickers"][0]["id"].as_str().unwrap().to_string();
    assert!(angelegt["stickers"][0]["tonUrl"].is_null(), "erst ohne Ton");

    let ton = probe.hochladen(&anna, "audio", "audio/wav", &wav()).await;
    let (status, mit_ton) = probe
        .call(
            "PUT",
            &format!("/api/v1/stickers/packs/{paket}/stickers/{sticker}/ton"),
            Some(&anna),
            Some(json!({ "attachmentId": ton, "dauerMs": 900 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{mit_ton}");
    assert_eq!(mit_ton["stickers"][0]["tonDauerMs"], json!(900));

    /*
     * Und wieder weg – wobei die Datei WIRKLICH verschwinden muss.
     *
     * `ton_attachment_id` steht auf `set null`, damit das Aufräumen einer
     * Tondatei nicht den Sticker mitnimmt. Der Preis dafür ist, dass hier
     * ausdrücklich gelöscht werden muss; sonst läge der Anhang für immer im
     * Speicher, ohne dass ihn je wieder jemand fände.
     */
    let (status, ohne) = probe
        .call(
            "DELETE",
            &format!("/api/v1/stickers/packs/{paket}/stickers/{sticker}/ton"),
            Some(&anna),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{ohne}");
    assert!(ohne["stickers"][0]["tonUrl"].is_null());
    assert!(ohne["stickers"][0]["tonDauerMs"].is_null());
    assert_eq!(
        probe.holen(&ton, &annas_keks).await,
        StatusCode::NOT_FOUND,
        "die Tondatei liegt als Waise im Speicher"
    );
    // Der Sticker selbst lebt weiter – das ist der Unterschied zu `cascade`.
    assert_eq!(probe.holen(&bild, &annas_keks).await, StatusCode::OK);
}

#[tokio::test(flavor = "multi_thread")]
async fn eine_fremde_tondatei_kommt_nicht_an_den_eigenen_sticker() {
    // Ohne diese Prüfung könnte jemand die Kennung einer fremden Datei
    // einsetzen und sie über ein öffentliches Paket für alle sichtbar machen.
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let (anna, _) = probe.konto("fremdanna").await;
    let (bert, _) = probe.konto("fremdbert").await;

    let berts_ton = probe.hochladen(&bert, "audio", "audio/wav", &wav()).await;
    let bild = probe.hochladen(&anna, "sticker", "image/png", &png()).await;
    let paket = probe.paket(&anna, true).await;

    let (status, antwort) = probe
        .call(
            "POST",
            &format!("/api/v1/stickers/packs/{paket}/stickers"),
            Some(&anna),
            Some(json!({ "attachmentId": bild, "tonAttachmentId": berts_ton })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{antwort}");
}

#[tokio::test(flavor = "multi_thread")]
async fn dieselbe_tondatei_haengt_nicht_an_zwei_stickern() {
    /*
     * Zwei Sticker mit derselben Tondatei sind an sich harmlos. Der Tag, an
     * dem einer von beiden gelöscht wird, ist es nicht: Dann verstummt auch
     * der andere, und niemand käme auf die Idee, das mit der Löschung in
     * Verbindung zu bringen.
     */
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let (anna, _) = probe.konto("zweianna").await;
    let ton = probe.hochladen(&anna, "audio", "audio/wav", &wav()).await;
    let paket = probe.paket(&anna, false).await;

    let erstes_bild = probe.hochladen(&anna, "sticker", "image/png", &png()).await;
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/stickers/packs/{paket}/stickers"),
            Some(&anna),
            Some(json!({ "attachmentId": erstes_bild, "tonAttachmentId": ton })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);

    let zweites_bild = probe.hochladen(&anna, "sticker", "image/png", &png()).await;
    let (status, antwort) = probe
        .call(
            "POST",
            &format!("/api/v1/stickers/packs/{paket}/stickers"),
            Some(&anna),
            Some(json!({ "attachmentId": zweites_bild, "tonAttachmentId": ton })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{antwort}");
}

#[tokio::test(flavor = "multi_thread")]
async fn ein_geloeschtes_paket_laesst_keine_dateien_zurueck() {
    /*
     * `sticker_packs` kaskadiert auf `stickers`, aber NICHT auf `attachments`.
     * Diese Lücke gab es schon vor der Tonspur – mit ihr wären es doppelt so
     * viele Waisen, und Waisen räumt nur der Lösch-Auslöser auf `attachments`
     * weg (Migration 0013).
     */
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let (anna, annas_keks) = probe.konto("paketanna").await;
    let bild = probe.hochladen(&anna, "sticker", "image/png", &png()).await;
    let ton = probe.hochladen(&anna, "audio", "audio/wav", &wav()).await;
    let paket = probe.paket(&anna, false).await;
    probe
        .call(
            "POST",
            &format!("/api/v1/stickers/packs/{paket}/stickers"),
            Some(&anna),
            Some(json!({ "attachmentId": bild, "tonAttachmentId": ton })),
        )
        .await;

    let (status, _) = probe
        .call(
            "DELETE",
            &format!("/api/v1/stickers/packs/{paket}"),
            Some(&anna),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    assert_eq!(
        probe.holen(&bild, &annas_keks).await,
        StatusCode::NOT_FOUND,
        "das Sticker-Bild liegt als Waise im Speicher"
    );
    assert_eq!(
        probe.holen(&ton, &annas_keks).await,
        StatusCode::NOT_FOUND,
        "die Tondatei liegt als Waise im Speicher"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn die_dauer_wird_auf_das_erlaubte_mass_geklemmt() {
    // Ein Sticker ist eine Geste. Acht Sekunden sind die Grenze, und ein
    // Client, der etwas anderes behauptet, ändert daran nichts.
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let (anna, _) = probe.konto("dauanna").await;
    let bild = probe.hochladen(&anna, "sticker", "image/png", &png()).await;
    let ton = probe.hochladen(&anna, "audio", "audio/wav", &wav()).await;
    let paket = probe.paket(&anna, false).await;
    let (status, antwort) = probe
        .call(
            "POST",
            &format!("/api/v1/stickers/packs/{paket}/stickers"),
            Some(&anna),
            Some(json!({ "attachmentId": bild, "tonAttachmentId": ton, "tonDauerMs": 999_999 })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{antwort}");
    assert_eq!(antwort["stickers"][0]["tonDauerMs"], json!(8_000));
}
