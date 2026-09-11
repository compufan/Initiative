//! Wer darf welchen Anhang sehen?
//!
//! Bis zum Medien-Keks war die Antwort: jeder, der die Kennung kennt. Das war
//! kein Versehen, sondern der Preis dafür, dass `<img>`, `<video>` und der
//! Dienst-Arbeiter keinen `Authorization`-Kopf setzen können – ein
//! weitergegebener Verweis blieb damit für immer gültig, auch für Leute ohne
//! Konto.
//!
//! Seit der Keks die Person trägt, lässt sich die Frage wirklich stellen.
//! Diese Tests halten die Antworten fest, und zwar die drei Entscheidungen,
//! die dahinterstehen:
//!
//!   * Ein Profilbild sieht **jede angemeldete Person**.
//!   * Wer ein Gespräch **verlässt**, verliert den Zugriff auf das, was dort
//!     liegt – rückwirkend.
//!   * Ein Sticker ist ein Medium wie jedes andere und bekommt keinen
//!     Freibrief.

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

/// Wie eine Person auftritt: mit Token (wie die App) oder mit Keks (wie `<img>`).
enum Ausweis<'a> {
    Token(&'a str),
    Keks(&'a str),
    Keiner,
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

    /// Ein Anhang abgerufen – so, wie es der jeweilige Ausweis tut.
    async fn holen(&self, anhang: &str, ausweis: Ausweis<'_>) -> StatusCode {
        let (token, kopfzeilen) = match ausweis {
            Ausweis::Token(t) => (Some(t), vec![]),
            Ausweis::Keks(k) => (
                None,
                vec![("cookie", format!("initiative_medien={k}"))],
            ),
            Ausweis::Keiner => (None, vec![]),
        };
        let (status, _, _) = self
            .roh(
                "GET",
                &format!("/api/v1/media/{anhang}"),
                token,
                kopfzeilen,
                None,
            )
            .await;
        status
    }

    /// Registriert ein Konto und gibt Token, Kennung und Medien-Keks zurück.
    async fn konto(&self, name: &str) -> (String, String, String) {
        let (status, kopf, bytes) = self
            .roh(
                "POST",
                "/api/v1/auth/register",
                None,
                vec![],
                Some(json!({
                    "username": name,
                    "displayName": name,
                    "password": "richtigespasswort",
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "Registrierung von {name}");
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        let keks = kopf
            .iter()
            .find(|(n, _)| n == "set-cookie")
            .map(|(_, w)| w.clone())
            .expect("Sitzungsantwort muss einen Medien-Keks tragen");
        let wert = keks
            .split(';')
            .next()
            .and_then(|erstes| erstes.split_once('='))
            .map(|(_, wert)| wert.to_string())
            .expect("Keks mit Wert");
        (
            body["accessToken"].as_str().unwrap().to_string(),
            body["user"]["id"].as_str().unwrap().to_string(),
            wert,
        )
    }

    async fn hochladen(&self, token: &str) -> String {
        let (status, upload) = self
            .call(
                "POST",
                "/api/v1/media/uploads",
                Some(token),
                Some(json!({
                    "kind": "image",
                    "mime": "image/png",
                    "size": png_pixel().len(),
                    "fileName": "bild.png",
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{upload}");
        let kennung = upload["attachmentId"].as_str().unwrap().to_string();

        let grenze = "----initiativemedien";
        let mut body = Vec::new();
        body.extend_from_slice(format!("--{grenze}\r\n").as_bytes());
        body.extend_from_slice(
            b"Content-Disposition: form-data; name=\"file\"; filename=\"bild.png\"\r\n",
        );
        body.extend_from_slice(b"Content-Type: image/png\r\n\r\n");
        body.extend_from_slice(&png_pixel());
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
        assert_eq!(antwort.status(), StatusCode::OK, "Hochladen");
        kennung
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
        format!("./.data/rechte-{}", Uuid::now_v7().simple()),
    );
    std::env::set_var("PUBLIC_API_URL", "http://localhost:8080");
    std::env::set_var("PUBLIC_APP_URL", "http://localhost:5173");
    std::env::remove_var("MEDIA_KEY");
    std::env::remove_var("MEDIA_AUTH");

    let state = AppState::new(Config::from_env().expect("config"))
        .await
        .expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    Some(Probe {
        router: app::build(state),
    })
}

fn kurz() -> String {
    let voll = Uuid::now_v7().simple().to_string();
    voll[voll.len() - 10..].to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn wer_darf_welchen_anhang_sehen() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – übersprungen");
        return;
    };
    let n = kurz();
    let (anna_token, _anna_id, anna_keks) = probe.konto(&format!("anna{n}")).await;
    let (bodo_token, bodo_id, bodo_keks) = probe.konto(&format!("bodo{n}")).await;
    let (_cleo_token, _cleo_id, cleo_keks) = probe.konto(&format!("cleo{n}")).await;

    // ---- Ohne Ausweis geht gar nichts mehr -------------------------------
    let annas_bild = probe.hochladen(&anna_token).await;
    assert_eq!(
        probe.holen(&annas_bild, Ausweis::Keiner).await,
        StatusCode::UNAUTHORIZED,
        "die blosse Kennung darf nicht mehr genuegen"
    );

    // ---- Das eigene sieht man immer, auf beiden Wegen ---------------------
    assert_eq!(
        probe.holen(&annas_bild, Ausweis::Token(&anna_token)).await,
        StatusCode::OK
    );
    assert_eq!(
        probe.holen(&annas_bild, Ausweis::Keks(&anna_keks)).await,
        StatusCode::OK,
        "der Keks ist der Weg, den ein <img> geht"
    );

    // ---- Eine fremde Datei bleibt fremd ----------------------------------
    assert_eq!(
        probe.holen(&annas_bild, Ausweis::Keks(&bodo_keks)).await,
        StatusCode::NOT_FOUND,
        "wer die Kennung nur kennt, sieht nichts"
    );

    // ---- Im Chat sehen es alle Mitglieder --------------------------------
    let (status, chat) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&anna_token),
            // Eine Gruppe, weil der Austritt geprueft werden soll – aus einem
            // Einzelchat tritt man nicht aus.
            Some(json!({ "type": "group", "title": "Runde", "memberIds": [bodo_id] })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{chat}");
    let chat_id = chat["id"].as_str().unwrap().to_string();

    let geteilt = probe.hochladen(&anna_token).await;
    let (status, nachricht) = probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat_id}/messages"),
            Some(&anna_token),
            Some(json!({ "type": "image", "attachmentIds": [geteilt] })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{nachricht}");

    assert_eq!(
        probe.holen(&geteilt, Ausweis::Keks(&bodo_keks)).await,
        StatusCode::OK,
        "wer im Gespraech ist, sieht den Anhang"
    );
    assert_eq!(
        probe.holen(&geteilt, Ausweis::Keks(&cleo_keks)).await,
        StatusCode::NOT_FOUND,
        "wer nicht im Gespraech ist, sieht ihn nicht"
    );

    // ---- Entscheidung: Austritt entzieht rueckwirkend ---------------------
    // Verlassen heisst: sich selbst aus der Mitgliederliste nehmen.
    let (status, _) = probe
        .call(
            "DELETE",
            &format!("/api/v1/conversations/{chat_id}/members/{bodo_id}"),
            Some(&bodo_token),
            None,
        )
        .await;
    assert!(
        status.is_success(),
        "Verlassen muss gehen, sonst prueft der Test nichts: {status}"
    );
    assert_eq!(
        probe.holen(&geteilt, Ausweis::Keks(&bodo_keks)).await,
        StatusCode::NOT_FOUND,
        "nach dem Verlassen ist der Zugriff fort – auch auf schon Gesehenes"
    );

    // ---- Entscheidung: Profilbilder sieht jede angemeldete Person ---------
    let annas_profilbild = probe.hochladen(&anna_token).await;
    let (status, _) = probe
        .call(
            "PATCH",
            "/api/v1/users/me",
            Some(&anna_token),
            Some(json!({ "avatarAttachmentId": annas_profilbild })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        probe.holen(&annas_profilbild, Ausweis::Keks(&cleo_keks)).await,
        StatusCode::OK,
        "ein Profilbild sieht jede angemeldete Person"
    );
    assert_eq!(
        probe.holen(&annas_profilbild, Ausweis::Keiner).await,
        StatusCode::UNAUTHORIZED,
        "aber eben nur eine ANGEMELDETE"
    );

    // ---- Entscheidung: Sticker sind Medien wie andere ---------------------
    let stickerbild = probe.hochladen(&anna_token).await;
    let (status, paket) = probe
        .call(
            "POST",
            "/api/v1/stickers/packs",
            Some(&anna_token),
            Some(json!({ "name": "Annas Paket", "isPublic": false })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{paket}");
    let paket_id = paket["id"].as_str().unwrap().to_string();
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/stickers/packs/{paket_id}/stickers"),
            Some(&anna_token),
            Some(json!({ "attachmentId": stickerbild })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);

    assert_eq!(
        probe.holen(&stickerbild, Ausweis::Keks(&anna_keks)).await,
        StatusCode::OK,
        "das eigene Paket"
    );
    assert_eq!(
        probe.holen(&stickerbild, Ausweis::Keks(&cleo_keks)).await,
        StatusCode::NOT_FOUND,
        "ein Sticker aus einem privaten Paket ist kein Freibrief"
    );

    // Oeffentlich gestellt, sieht ihn jeder Angemeldete.
    let (status, _) = probe
        .call(
            "PATCH",
            &format!("/api/v1/stickers/packs/{paket_id}"),
            Some(&anna_token),
            Some(json!({ "isPublic": true })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        probe.holen(&stickerbild, Ausweis::Keks(&cleo_keks)).await,
        StatusCode::OK,
        "aus einem oeffentlichen Paket schon"
    );
}

/// Das kleinstmögliche gültige PNG – ein Pixel.
fn png_pixel() -> Vec<u8> {
    const ROH: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];
    ROH.to_vec()
}
