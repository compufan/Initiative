//! Medienübersicht, Chat-Export, 1:1-Anrufe und die drei Restpunkte der
//! Atomaritäts-Prüfung (hängende Umzüge, doppelter Upload, Sticker ohne Bytes).
//!
//! Läuft gegen `TEST_DATABASE_URL`; ohne sie wird übersprungen.

#![allow(dead_code)]

use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tower::ServiceExt;
use uuid::Uuid;

use initiative_api::config::Config;
use initiative_api::services::{anrufe, auslagern, zip_strom};
use initiative_api::state::AppState;
use initiative_api::{app, MIGRATOR};

const GEHEIMNIS: &str = "turn-geheimnis-fuer-den-test";

#[derive(Clone)]
struct Probe {
    router: Router,
    state: AppState,
}

struct Konto {
    token: String,
    id: Uuid,
}

fn kurz() -> String {
    let kennung = Uuid::now_v7().simple().to_string();
    kennung[kennung.len() - 10..].to_string()
}

/// Die Umgebung gehört dem Prozess – Aufbau nacheinander.
static AUFBAU: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn grund_umgebung(url: &str, lokal: &str) {
    std::env::set_var("DATABASE_URL", url);
    std::env::set_var("NODE_ENV", "test");
    std::env::set_var("JWT_SECRET", "test-secret-value-at-least-16-characters");
    std::env::set_var("REALTIME_BUS", "memory");
    std::env::set_var("DATABASE_POOL_MAX", "6");
    std::env::set_var("RATE_LIMIT", "false");
    std::env::set_var("STORAGE_DRIVER", "local");
    std::env::set_var("LOCAL_STORAGE_DIR", lokal);
    std::env::set_var("PUBLIC_API_URL", "http://localhost:8080");
    std::env::set_var("PUBLIC_APP_URL", "http://localhost:5173");
    std::env::set_var("STUN_URLS", "stun:turn.example.org:3478");
    std::env::set_var(
        "TURN_URLS",
        "turn:turn.example.org:3478?transport=udp,turns:turn.example.org:5349",
    );
    std::env::set_var("TURN_SECRET", GEHEIMNIS);
    std::env::remove_var("MEDIA_KEY");
    std::env::remove_var("KALT_TREIBER");
}

async fn aufbauen(name: &str) -> Option<Probe> {
    let url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;
    let config = {
        let _schloss = AUFBAU.lock().await;
        grund_umgebung(&url, &format!("./.data/{name}-{}", Uuid::now_v7().simple()));
        Config::from_env().expect("config")
    };
    let state = AppState::new(config).await.expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    Some(Probe {
        router: app::build(state.clone()),
        state,
    })
}

macro_rules! probe {
    ($name:expr) => {
        match aufbauen($name).await {
            Some(probe) => probe,
            None => {
                eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
                return;
            }
        }
    };
}

impl Probe {
    async fn roh(
        &self,
        method: &str,
        uri: &str,
        token: Option<&str>,
        kopf: Vec<(&str, String)>,
        body: Body,
    ) -> (StatusCode, Vec<u8>) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        for (name, wert) in kopf {
            builder = builder.header(name, wert);
        }
        let response = self
            .router
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, bytes.to_vec())
    }

    async fn call(
        &self,
        method: &str,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let (kopf, rumpf) = match body {
            Some(body) => (
                vec![("content-type", "application/json".to_string())],
                Body::from(serde_json::to_vec(&body).unwrap()),
            ),
            None => (vec![], Body::empty()),
        };
        let (status, bytes) = self.roh(method, uri, token, kopf, rumpf).await;
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn konto(&self, vorsilbe: &str) -> Konto {
        let name = format!("{vorsilbe}{}", kurz());
        let (status, body) = self
            .call(
                "POST",
                "/api/v1/auth/register",
                None,
                Some(json!({
                    "username": name,
                    "displayName": vorsilbe,
                    "password": "richtigespasswort",
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        Konto {
            token: body["accessToken"].as_str().unwrap().to_string(),
            id: Uuid::parse_str(body["user"]["id"].as_str().unwrap()).unwrap(),
        }
    }

    async fn chat(&self, wer: &Konto, typ: &str, mit: &[&Konto]) -> Uuid {
        let ids: Vec<String> = mit.iter().map(|k| k.id.to_string()).collect();
        let (status, body) = self
            .call(
                "POST",
                "/api/v1/conversations",
                Some(&wer.token),
                Some(json!({ "type": typ, "title": "Runde", "memberIds": ids })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        Uuid::parse_str(body["id"].as_str().unwrap()).unwrap()
    }

    async fn anlegen(&self, wer: &Konto, art: &str, mime: &str, name: &str, laenge: usize) -> Uuid {
        let (status, upload) = self
            .call(
                "POST",
                "/api/v1/media/uploads",
                Some(&wer.token),
                Some(json!({ "kind": art, "mime": mime, "size": laenge, "fileName": name })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{upload}");
        Uuid::parse_str(upload["attachmentId"].as_str().unwrap()).unwrap()
    }

    async fn daten(
        &self,
        wer: &Konto,
        anhang: Uuid,
        mime: &str,
        name: &str,
        inhalt: &[u8],
    ) -> StatusCode {
        let grenze = "----medienanrufe";
        let mut body = Vec::new();
        body.extend_from_slice(format!("--{grenze}\r\n").as_bytes());
        body.extend_from_slice(
            format!("Content-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n")
                .as_bytes(),
        );
        body.extend_from_slice(format!("Content-Type: {mime}\r\n\r\n").as_bytes());
        body.extend_from_slice(inhalt);
        body.extend_from_slice(format!("\r\n--{grenze}--\r\n").as_bytes());
        self.roh(
            "POST",
            &format!("/api/v1/media/uploads/{anhang}/data"),
            Some(&wer.token),
            vec![(
                "content-type",
                format!("multipart/form-data; boundary={grenze}"),
            )],
            Body::from(body),
        )
        .await
        .0
    }

    async fn hochladen(
        &self,
        wer: &Konto,
        art: &str,
        mime: &str,
        name: &str,
        inhalt: &[u8],
    ) -> Uuid {
        let anhang = self.anlegen(wer, art, mime, name, inhalt.len()).await;
        assert_eq!(
            self.daten(wer, anhang, mime, name, inhalt).await,
            StatusCode::OK
        );
        anhang
    }

    async fn senden(&self, wer: &Konto, chat: Uuid, nachricht: Value) -> Value {
        let (status, body) = self
            .call(
                "POST",
                &format!("/api/v1/conversations/{chat}/messages"),
                Some(&wer.token),
                Some(nachricht),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        body
    }

    async fn text(&self, wer: &Konto, chat: Uuid, text: &str) -> Value {
        self.senden(wer, chat, json!({ "type": "text", "body": text }))
            .await
    }

    async fn reiter(&self, wer: &Konto, chat: Uuid, art: &str) -> Vec<Value> {
        let (status, body) = self
            .call(
                "GET",
                &format!("/api/v1/conversations/{chat}/anhaenge?art={art}"),
                Some(&wer.token),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["items"].as_array().cloned().unwrap_or_default()
    }
}

const PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0, 0, 0,
    1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1F, 0x15, 0xC4, 0x89, 0, 0, 0, 13, b'I', b'D', b'A', b'T',
    0x78, 0xDA, 0x63, 0x64, 0x60, 0xF8, 0x5F, 0x0F, 0, 0x02, 0x87, 0x01, 0x80, 0xEB, 0x47, 0xBA,
    0x92, 0, 0, 0, 0, b'I', b'E', b'N', b'D', 0xAE, 0x42, 0x60, 0x82,
];

fn ids(liste: &[Value], feld: &str) -> Vec<String> {
    liste
        .iter()
        .map(|e| e[feld].as_str().unwrap_or_default().to_string())
        .collect()
}

/* ---------- 1. Medienübersicht ------------------------------------------- */

#[tokio::test(flavor = "multi_thread")]
async fn medienuebersicht_zeigt_nur_was_man_sieht() {
    let p = probe!("medienuebersicht");
    let anna = p.konto("anna").await;
    let bert = p.konto("bert").await;
    let cleo = p.konto("cleo").await;
    let fremd = p.konto("fremd").await;
    let chat = p.chat(&anna, "group", &[&bert]).await;

    let bild = p
        .hochladen(&anna, "image", "image/png", "eins.png", PNG)
        .await;
    let foto = p
        .senden(
            &anna,
            chat,
            json!({ "type": "image", "attachmentIds": [bild] }),
        )
        .await;
    let pdf = p
        .hochladen(&anna, "file", "application/pdf", "plan.pdf", b"%PDF-1.4 x")
        .await;
    p.senden(
        &anna,
        chat,
        json!({ "type": "file", "body": "Plan", "attachmentIds": [pdf] }),
    )
    .await;
    let ton = p
        .hochladen(
            &bert,
            "audio",
            "audio/webm",
            "sprach.webm",
            b"\x1a\x45\xdf\xa3 ton",
        )
        .await;
    p.senden(
        &bert,
        chat,
        json!({ "type": "audio", "attachmentIds": [ton] }),
    )
    .await;
    let link = p
        .text(
            &bert,
            chat,
            "Schau: https://example.org/seite. Und www.test.de!",
        )
        .await;
    // Einmal ansehbar – gehört in kein Raster.
    let geheim = p
        .hochladen(&anna, "image", "image/png", "geheim.png", PNG)
        .await;
    p.senden(
        &anna,
        chat,
        json!({ "type": "image", "attachmentIds": [geheim], "metadata": { "einmalAnsehen": true } }),
    )
    .await;
    // Für alle gelöscht.
    let weg = p
        .hochladen(&anna, "image", "image/png", "weg.png", PNG)
        .await;
    let weg_msg = p
        .senden(
            &anna,
            chat,
            json!({ "type": "image", "attachmentIds": [weg] }),
        )
        .await;
    let (status, _) = p
        .call(
            "DELETE",
            &format!("/api/v1/messages/{}", weg_msg["id"].as_str().unwrap()),
            Some(&anna.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let medien = p.reiter(&anna, chat, "medien").await;
    assert_eq!(
        ids(&medien, "messageId"),
        vec![foto["id"].as_str().unwrap()]
    );
    assert_eq!(medien[0]["attachment"]["id"], json!(bild));
    assert_eq!(p.reiter(&anna, chat, "dokumente").await.len(), 1);
    assert_eq!(p.reiter(&anna, chat, "audio").await.len(), 1);
    let links = p.reiter(&anna, chat, "links").await;
    assert_eq!(
        ids(&links, "url"),
        vec!["https://example.org/seite", "https://www.test.de"]
    );
    assert_eq!(links[0]["messageId"], link["id"]);

    // Bert blendet das Foto für sich aus.
    let (status, _) = p
        .call(
            "DELETE",
            &format!("/api/v1/messages/{}?scope=me", foto["id"].as_str().unwrap()),
            Some(&bert.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(p.reiter(&bert, chat, "medien").await.is_empty());
    assert_eq!(p.reiter(&anna, chat, "medien").await.len(), 1);

    // Cleo kommt später: Ihre Verlaufsgrenze lässt alles Alte draussen.
    let (status, body) = p
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat}/members"),
            Some(&anna.token),
            Some(json!({ "memberIds": [cleo.id] })),
        )
        .await;
    assert!(status.is_success(), "{body}");
    for art in ["medien", "dokumente", "audio", "links"] {
        assert!(p.reiter(&cleo, chat, art).await.is_empty(), "{art}");
    }

    // Anna leert den Chat; danach zählt nur Neues.
    let (status, body) = p
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat}/leeren"),
            Some(&anna.token),
            None,
        )
        .await;
    assert!(status.is_success(), "{body}");
    assert!(p.reiter(&anna, chat, "medien").await.is_empty());
    assert!(p.reiter(&anna, chat, "links").await.is_empty());
    tokio::time::sleep(Duration::from_millis(5)).await;
    let neu1 = p
        .hochladen(&bert, "image", "image/png", "n1.png", PNG)
        .await;
    let neu2 = p
        .hochladen(&bert, "video", "video/mp4", "n2.mp4", b"\0\0\0\x18ftypmp42")
        .await;
    p.senden(
        &bert,
        chat,
        json!({ "type": "image", "attachmentIds": [neu1, neu2] }),
    )
    .await;
    let medien = p.reiter(&anna, chat, "medien").await;
    assert_eq!(medien.len(), 2);
    assert_eq!(p.reiter(&cleo, chat, "medien").await.len(), 2);

    // Blättern: eins je Seite, ohne Doppelte, bis zum Ende.
    let (status, seite) = p
        .call(
            "GET",
            &format!("/api/v1/conversations/{chat}/anhaenge?art=medien&limit=1"),
            Some(&anna.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let zeiger = seite["nextCursor"].as_str().expect("Zeiger").to_string();
    let (_, zweite) = p
        .call(
            "GET",
            &format!("/api/v1/conversations/{chat}/anhaenge?art=medien&limit=1&vor={zeiger}"),
            Some(&anna.token),
            None,
        )
        .await;
    assert_ne!(
        seite["items"][0]["attachment"]["id"],
        zweite["items"][0]["attachment"]["id"]
    );

    // Wer nicht dabei ist, bekommt nichts; unbekannte Art ist ein Fehler.
    let (status, _) = p
        .call(
            "GET",
            &format!("/api/v1/conversations/{chat}/anhaenge?art=medien"),
            Some(&fremd.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = p
        .call(
            "GET",
            &format!("/api/v1/conversations/{chat}/anhaenge?art=alles"),
            Some(&anna.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/* ---------- 2. Export ---------------------------------------------------- */

async fn export_holen(
    p: &Probe,
    wer: &Konto,
    chat: Uuid,
    mit_medien: bool,
) -> Vec<(String, Vec<u8>)> {
    let (status, adresse) = p
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat}/export"),
            Some(&wer.token),
            Some(json!({ "mitMedien": mit_medien, "zeitzoneVersatz": -60 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{adresse}");
    let url = adresse["url"].as_str().unwrap();
    let pfad = url.trim_start_matches("http://localhost:8080");
    // Die Karte reicht – ohne Kopf, wie beim Herunterladen im Browser.
    let (status, bytes) = p.roh("GET", pfad, None, vec![], Body::empty()).await;
    assert_eq!(status, StatusCode::OK);
    zip_strom::lesen(&bytes).expect("gültiges ZIP")
}

#[tokio::test(flavor = "multi_thread")]
async fn export_enthaelt_nur_sichtbares() {
    let p = probe!("export");
    let anna = p.konto("Anna").await;
    let bert = p.konto("Bert").await;
    let fremd = p.konto("Fremd").await;
    let chat = p.chat(&anna, "direct", &[&bert]).await;

    p.text(&anna, chat, "vor dem Leeren").await;
    let (status, _) = p
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat}/leeren"),
            Some(&bert.token),
            None,
        )
        .await;
    assert!(status.is_success());
    tokio::time::sleep(Duration::from_millis(5)).await;
    p.text(&anna, chat, "Hallo Bert\nzweite Zeile").await;
    let bild = p
        .hochladen(&anna, "image", "image/png", "urlaub.png", PNG)
        .await;
    p.senden(
        &anna,
        chat,
        json!({ "type": "image", "body": "Strand", "attachmentIds": [bild] }),
    )
    .await;
    let geheim = p
        .hochladen(&anna, "image", "image/png", "geheim.png", PNG)
        .await;
    p.senden(
        &anna,
        chat,
        json!({ "type": "image", "attachmentIds": [geheim], "metadata": { "einmalAnsehen": true } }),
    )
    .await;
    let weg = p.text(&bert, chat, "gleich weg").await;
    p.call(
        "DELETE",
        &format!("/api/v1/messages/{}", weg["id"].as_str().unwrap()),
        Some(&bert.token),
        None,
    )
    .await;
    p.text(&bert, chat, "Danke!").await;

    let ohne = export_holen(&p, &bert, chat, false).await;
    assert_eq!(ohne.len(), 1);
    assert_eq!(ohne[0].0, "chat.txt");
    let text = String::from_utf8(ohne[0].1.clone()).unwrap();
    assert!(!text.contains("vor dem Leeren"), "{text}");
    assert!(!text.contains("gleich weg"), "{text}");
    assert!(!text.contains("geheim"), "{text}");
    assert!(
        text.contains(" - Anna: Hallo Bert\nzweite Zeile\n"),
        "{text}"
    );
    assert!(
        text.contains(" - Anna: <Medien ausgeschlossen>\nStrand\n"),
        "{text}"
    );
    assert!(text.contains(" - Bert: Danke!\n"), "{text}");
    // Format „TT.MM.JJ, HH:MM - “.
    let erste = text.lines().find(|z| z.contains("Hallo Bert")).unwrap();
    let datum = &erste[..17];
    assert_eq!(&datum[2..3], ".");
    assert_eq!(&datum[8..10], ", ");
    assert_eq!(&datum[12..13], ":");
    assert_eq!(&datum[15..17], " -");

    // Mit Medien: die Datei, Byte für Byte – das Einmal-Bild nicht.
    let mit = export_holen(&p, &anna, chat, true).await;
    let namen: Vec<&str> = mit.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(
        namen,
        vec!["chat.txt", "medien/0001-urlaub.png"],
        "{namen:?}"
    );
    assert_eq!(mit[1].1, PNG);
    let text = String::from_utf8(mit[0].1.clone()).unwrap();
    assert!(text.contains("0001-urlaub.png (Datei angehängt)"), "{text}");
    // Anna hat nicht geleert: Sie sieht auch das Frühere.
    assert!(text.contains("vor dem Leeren"), "{text}");

    // Fremde bekommen keine Adresse; eine kaputte Karte gilt nicht.
    let (status, _) = p
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat}/export"),
            Some(&fremd.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = p
        .roh(
            "GET",
            "/api/v1/chat-export/abc.def.ghi",
            None,
            vec![],
            Body::empty(),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // Eine Karte für einen anderen Zweck (Zugangstoken) öffnet keinen Export.
    let (status, _) = p
        .roh(
            "GET",
            &format!("/api/v1/chat-export/{}", anna.token),
            None,
            vec![],
            Body::empty(),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

/* ---------- 3. Anrufe ---------------------------------------------------- */

struct Leitung {
    user: Uuid,
    id: Uuid,
    empfang: tokio::sync::mpsc::Receiver<String>,
}

impl Leitung {
    fn neu(p: &Probe, wer: &Konto) -> Self {
        let (id, ausgang, _) = p.state.hub.register(wer.id);
        Self {
            user: wer.id,
            id,
            empfang: ausgang.empfang,
        }
    }

    /// Alle Ereignisse, die bis jetzt ankamen (Typ, Nutzlast).
    fn ereignisse(&mut self) -> Vec<(String, Value)> {
        let mut liste = Vec::new();
        while let Ok(rahmen) = self.empfang.try_recv() {
            let wert: Value = serde_json::from_str(&rahmen).unwrap();
            liste.push((
                wert["type"].as_str().unwrap_or_default().to_string(),
                wert["payload"].clone(),
            ));
        }
        liste
    }

    fn anrufe(&mut self) -> Vec<(String, Value)> {
        self.ereignisse()
            .into_iter()
            .filter(|(typ, _)| typ.starts_with("anruf."))
            .collect()
    }

    async fn signal(&self, p: &Probe, typ: &str, payload: Value) {
        anrufe::ereignis(&p.state, self.user, self.id, typ, &payload)
            .await
            .unwrap();
    }
}

async fn ruhe() {
    tokio::time::sleep(Duration::from_millis(50)).await;
}

async fn anruf_zeilen(p: &Probe, anruf: Uuid) -> Vec<(String, Option<String>)> {
    sqlx::query_as("select type, body from messages where client_id = $1")
        .bind(format!("anruf:{anruf}"))
        .fetch_all(&p.state.pool)
        .await
        .unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn anrufsignale_gehen_nur_zwischen_den_beiden() {
    let p = probe!("anrufe");
    let mitschnitt = p.state.push.mitschneiden();
    let anna = p.konto("Anna").await;
    let bert = p.konto("Bert").await;
    let cleo = p.konto("Cleo").await;
    let chat = p.chat(&anna, "direct", &[&bert]).await;
    let gruppe = p.chat(&anna, "group", &[&bert, &cleo]).await;
    let cleo_bert = p.chat(&cleo, "direct", &[&bert]).await;

    let mut a = Leitung::neu(&p, &anna);
    let mut b1 = Leitung::neu(&p, &bert);
    let mut b2 = Leitung::neu(&p, &bert);
    let mut c = Leitung::neu(&p, &cleo);

    let anruf = Uuid::now_v7();
    a.signal(
        &p,
        "anruf.angebot",
        json!({ "anrufId": anruf, "conversationId": chat, "video": true, "sdp": "v=0 angebot" }),
    )
    .await;
    ruhe().await;
    for b in [&mut b1, &mut b2] {
        let ev = b.anrufe();
        assert_eq!(ev.len(), 1, "{ev:?}");
        assert_eq!(ev[0].0, "anruf.angebot");
        assert_eq!(ev[0].1["von"], json!(anna.id));
        assert_eq!(ev[0].1["video"], json!(true));
        // Das SDP reist nicht über den Bus.
        assert!(ev[0].1.get("sdp").is_none());
    }
    assert!(c.anrufe().is_empty());
    // Push „Anruf von …“ mit eigenem Tag an Bert.
    let pushes = mitschnitt.lock().unwrap().clone();
    let klingel: Vec<_> = pushes
        .iter()
        .filter(|(id, payload)| *id == bert.id && payload.kind == "anruf")
        .collect();
    assert_eq!(klingel.len(), 1);
    assert_eq!(
        klingel[0].1.tag.as_deref(),
        Some(format!("anruf:{anruf}").as_str())
    );
    assert_eq!(klingel[0].1.title, "Anruf von Anna");

    // Unbeteiligte: weder lesen noch einmischen.
    let (status, _) = p
        .call(
            "GET",
            &format!("/api/v1/anrufe/{anruf}"),
            Some(&cleo.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    c.signal(
        &p,
        "anruf.ice",
        json!({ "anrufId": anruf, "candidate": { "candidate": "x" } }),
    )
    .await;
    c.signal(&p, "anruf.ende", json!({ "anrufId": anruf }))
        .await;
    c.signal(
        &p,
        "anruf.antwort",
        json!({ "anrufId": anruf, "sdp": "boese" }),
    )
    .await;
    ruhe().await;
    assert!(a
        .anrufe()
        .iter()
        .all(|(t, _)| t == "anruf.fehler" || t.is_empty()));
    assert!(b1.anrufe().is_empty());
    let (status, zeile) = p
        .call(
            "GET",
            &format!("/api/v1/anrufe/{anruf}"),
            Some(&bert.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(zeile["status"], "klingelt");
    assert_eq!(zeile["angebotSdp"], "v=0 angebot");

    // Bert nimmt auf Gerät 1 an: Anna bekommt die Antwort, beide Geräte von
    // Bert erfahren es (Gerät 2 hört auf zu klingeln).
    b1.signal(
        &p,
        "anruf.antwort",
        json!({ "anrufId": anruf, "sdp": "v=0 antwort" }),
    )
    .await;
    ruhe().await;
    let ev = a.anrufe();
    assert_eq!(
        ev.iter().map(|e| e.0.as_str()).collect::<Vec<_>>(),
        vec!["anruf.antwort"]
    );
    let geraet1 = b1.id;
    for b in [&mut b1, &mut b2] {
        let ev = b.anrufe();
        assert_eq!(ev[0].0, "anruf.angenommen");
        assert_eq!(ev[0].1["verbindung"], json!(geraet1));
    }
    // Ein zweites Annehmen (Gerät 2) gewinnt nicht mehr.
    b2.signal(
        &p,
        "anruf.antwort",
        json!({ "anrufId": anruf, "sdp": "spaet" }),
    )
    .await;
    ruhe().await;
    let ev = b2.anrufe();
    assert_eq!(
        ev.iter().filter(|e| e.0 == "anruf.fehler").count(),
        1,
        "{ev:?}"
    );
    let (_, zeile) = p
        .call(
            "GET",
            &format!("/api/v1/anrufe/{anruf}"),
            Some(&anna.token),
            None,
        )
        .await;
    assert_eq!(zeile["antwortSdp"], "v=0 antwort");

    // ICE geht zum Gegenüber.
    a.signal(
        &p,
        "anruf.ice",
        json!({ "anrufId": anruf, "candidate": { "candidate": "c1" } }),
    )
    .await;
    ruhe().await;
    let ev = b1.anrufe();
    assert_eq!(ev[0].0, "anruf.ice");
    assert_eq!(ev[0].1["candidate"]["candidate"], "c1");
    assert!(a.anrufe().is_empty());

    // Cleo ruft Bert an, während er telefoniert: besetzt, und es steht als
    // verpasster Anruf in ihrem Chat.
    let besetzt = Uuid::now_v7();
    c.signal(
        &p,
        "anruf.angebot",
        json!({ "anrufId": besetzt, "conversationId": cleo_bert, "video": false, "sdp": "x" }),
    )
    .await;
    ruhe().await;
    assert!(c.anrufe().iter().any(|(t, _)| t == "anruf.besetzt"));
    assert!(b1.anrufe().iter().all(|(t, _)| t != "anruf.angebot"));
    assert_eq!(
        anruf_zeilen(&p, besetzt).await,
        vec![("system".to_string(), Some("Verpasster Anruf".to_string()))]
    );

    // Gruppen: kein Anruf.
    let g = Uuid::now_v7();
    a.signal(
        &p,
        "anruf.angebot",
        json!({ "anrufId": g, "conversationId": gruppe, "video": false, "sdp": "x" }),
    )
    .await;
    ruhe().await;
    let ev = a.anrufe();
    assert!(
        ev.iter()
            .any(|(t, pl)| t == "anruf.fehler" && pl["grund"] == "nur_direkt"),
        "{ev:?}"
    );

    // Auflegen: „Anruf, m:ss“ genau einmal, beide erfahren das Ende.
    tokio::time::sleep(Duration::from_millis(1100)).await;
    a.signal(&p, "anruf.ende", json!({ "anrufId": anruf }))
        .await;
    b1.signal(&p, "anruf.ende", json!({ "anrufId": anruf }))
        .await;
    ruhe().await;
    let zeilen = anruf_zeilen(&p, anruf).await;
    assert_eq!(zeilen.len(), 1);
    assert!(
        zeilen[0]
            .1
            .as_deref()
            .unwrap()
            .starts_with("Videoanruf, 0:0"),
        "{zeilen:?}"
    );
    assert!(a
        .anrufe()
        .iter()
        .any(|(t, pl)| t == "anruf.ende" && pl["grund"] == "aufgelegt"));

    // Gesperrt: Bert blockiert Anna – kein Anruf, Bert merkt nichts.
    let (status, body) = p
        .call(
            "PUT",
            &format!("/api/v1/users/{}/block", anna.id),
            Some(&bert.token),
            None,
        )
        .await;
    assert!(status.is_success(), "{status} {body}");
    b1.ereignisse();
    let gesperrt = Uuid::now_v7();
    a.signal(
        &p,
        "anruf.angebot",
        json!({ "anrufId": gesperrt, "conversationId": chat, "video": false, "sdp": "x" }),
    )
    .await;
    ruhe().await;
    assert!(a
        .anrufe()
        .iter()
        .any(|(t, pl)| t == "anruf.fehler" && pl["grund"] == "gesperrt"));
    assert!(b1.anrufe().is_empty());
    let (status, _) = p
        .call(
            "GET",
            &format!("/api/v1/anrufe/{gesperrt}"),
            Some(&anna.token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    p.state.hub.unregister(anna.id, a.id);
    p.state.hub.unregister(bert.id, b1.id);
    p.state.hub.unregister(bert.id, b2.id);
    p.state.hub.unregister(cleo.id, c.id);
}

#[tokio::test(flavor = "multi_thread")]
async fn verpasster_anruf_steht_genau_einmal_im_chat() {
    let p = probe!("verpasst");
    let anna = p.konto("Anna").await;
    let bert = p.konto("Bert").await;
    let chat = p.chat(&anna, "direct", &[&bert]).await;
    let a = Leitung::neu(&p, &anna);
    let mut b = Leitung::neu(&p, &bert);

    let anruf = Uuid::now_v7();
    a.signal(
        &p,
        "anruf.angebot",
        json!({ "anrufId": anruf, "conversationId": chat, "video": false, "sdp": "x" }),
    )
    .await;
    // Dasselbe Angebot noch einmal (Neuversuch) ändert nichts.
    a.signal(
        &p,
        "anruf.angebot",
        json!({ "anrufId": anruf, "conversationId": chat, "video": false, "sdp": "x" }),
    )
    .await;

    // Das Zeitlimit ist vorbei (zurückdatiert), und alle wollen es zugleich
    // abschliessen: Auflegen, Aufräumdienst, Zeitgeber.
    sqlx::query("update anrufe set begonnen_at = now() - interval '2 minutes' where id = $1")
        .bind(anruf)
        .execute(&p.state.pool)
        .await
        .unwrap();
    let mut laeufe = Vec::new();
    for i in 0..6 {
        let s = p.state.clone();
        laeufe.push(tokio::spawn(async move {
            match i % 3 {
                0 => {
                    anrufe::abraeumen(&s).await;
                }
                1 => {
                    let _ = anrufe::abschliessen(&s, anruf, &["klingelt"], "verpasst", "zeitlimit")
                        .await;
                }
                _ => {
                    let _ = anrufe::auflegen(&s, anna.id, anruf, false).await;
                }
            }
        }));
    }
    for lauf in laeufe {
        lauf.await.unwrap();
    }
    let zeilen = anruf_zeilen(&p, anruf).await;
    assert_eq!(
        zeilen,
        vec![("system".to_string(), Some("Verpasster Anruf".to_string()))]
    );
    let (status, nachricht): (String, Option<Uuid>) =
        sqlx::query_as("select status, nachricht_id from anrufe where id = $1")
            .bind(anruf)
            .fetch_one(&p.state.pool)
            .await
            .unwrap();
    assert_eq!(status, "verpasst");
    assert!(nachricht.is_some());
    ruhe().await;
    let ende: Vec<_> = b
        .ereignisse()
        .into_iter()
        .filter(|(t, _)| t == "anruf.ende")
        .collect();
    assert_eq!(ende.len(), 1, "{ende:?}");
    // Die Systemzeile im Verlauf: Anna als Handelnde, Bert als Ziel.
    let (_, verlauf) = p
        .call(
            "GET",
            &format!("/api/v1/conversations/{chat}/messages"),
            Some(&bert.token),
            None,
        )
        .await;
    let zeile = verlauf["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["metadata"]["system"]["kind"] == "anruf")
        .expect("Systemzeile");
    assert_eq!(zeile["metadata"]["anruf"]["status"], "verpasst");
    assert_eq!(zeile["metadata"]["system"]["targetIds"][0], json!(bert.id));

    // Ein abgelehnter Anruf ebenso genau einmal.
    let zwei = Uuid::now_v7();
    a.signal(
        &p,
        "anruf.angebot",
        json!({ "anrufId": zwei, "conversationId": chat, "video": true, "sdp": "x" }),
    )
    .await;
    b.signal(&p, "anruf.abgelehnt", json!({ "anrufId": zwei }))
        .await;
    b.signal(&p, "anruf.abgelehnt", json!({ "anrufId": zwei }))
        .await;
    assert_eq!(
        anruf_zeilen(&p, zwei).await,
        vec![(
            "system".to_string(),
            Some("Verpasster Videoanruf".to_string())
        )]
    );
    p.state.hub.unregister(anna.id, a.id);
    p.state.hub.unregister(bert.id, b.id);
}

#[tokio::test(flavor = "multi_thread")]
async fn ice_zugangsdaten_nach_coturn() {
    let p = probe!("ice");
    let anna = p.konto("Anna").await;
    let (status, _) = p.call("GET", "/api/v1/anrufe/ice", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, body) = p
        .call("GET", "/api/v1/anrufe/ice", Some(&anna.token), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let server = body["iceServers"].as_array().unwrap();
    assert_eq!(server[0]["urls"], json!(["stun:turn.example.org:3478"]));
    assert!(server[0].get("credential").is_none());
    let turn = &server[1];
    assert_eq!(turn["urls"].as_array().unwrap().len(), 2);
    let benutzer = turn["username"].as_str().unwrap();
    let (ablauf, wer) = benutzer.split_once(':').unwrap();
    assert_eq!(wer, anna.id.to_string());
    let ablauf: i64 = ablauf.parse().unwrap();
    let jetzt = chrono::Utc::now().timestamp();
    assert!(
        (ablauf - jetzt - 4 * 3600).abs() < 60,
        "kurzlebig: {ablauf}"
    );
    // Was coturn nachrechnet: base64(HMAC-SHA1(Geheimnis, Benutzername)).
    use base64::Engine;
    let erwartet = base64::engine::general_purpose::STANDARD
        .encode(anrufe::hmac_sha1(GEHEIMNIS.as_bytes(), benutzer.as_bytes()));
    assert_eq!(turn["credential"], erwartet);
    // Unabhängig nachgerechnet (Python: hmac.new(b'geheim', u, sha1)).
    let fest = Uuid::parse_str("0190e7a2-0000-7000-8000-000000000001").unwrap();
    assert_eq!(
        anrufe::turn_zugang("geheim", fest, 1_700_000_000),
        (
            "1700000000:0190e7a2-0000-7000-8000-000000000001".to_string(),
            "LXMKZ63kCZWL/ecj1Qap6FXPdjo=".to_string()
        )
    );
    // Das Geheimnis selbst steht nirgends in der Antwort.
    assert!(!body.to_string().contains(GEHEIMNIS));
}

/* ---------- 4. Restpunkte ------------------------------------------------ */

#[tokio::test(flavor = "multi_thread")]
async fn zweiter_upload_auf_denselben_anhang_wird_abgewiesen() {
    let p = probe!("upload-sperre");
    let anna = p.konto("anna").await;
    let anhang = p.anlegen(&anna, "file", "text/plain", "a.txt", 5).await;

    // Ein laufender Upload hält den Anspruch: Ein zweiter bekommt 409 und
    // überschreibt nichts.
    sqlx::query("update attachments set empfang_seit = now() where id = $1")
        .bind(anhang)
        .execute(&p.state.pool)
        .await
        .unwrap();
    assert_eq!(
        p.daten(&anna, anhang, "text/plain", "a.txt", b"zweit")
            .await,
        StatusCode::CONFLICT
    );
    let schluessel: String =
        sqlx::query_scalar("select storage_key from attachments where id = $1")
            .bind(anhang)
            .fetch_one(&p.state.pool)
            .await
            .unwrap();
    assert!(p
        .state
        .storage
        .read(&schluessel, None)
        .await
        .unwrap()
        .is_none());

    // Ein abgestürzter Anspruch verfällt nach der Frist.
    sqlx::query(
        "update attachments set empfang_seit = now() - interval '30 minutes' where id = $1",
    )
    .bind(anhang)
    .execute(&p.state.pool)
    .await
    .unwrap();
    assert_eq!(
        p.daten(&anna, anhang, "text/plain", "a.txt", b"erst!")
            .await,
        StatusCode::OK
    );
    // Danach ist der Anhang fertig: Kein weiterer Upload überschreibt ihn.
    assert_eq!(
        p.daten(&anna, anhang, "text/plain", "a.txt", b"spaet")
            .await,
        StatusCode::BAD_REQUEST
    );

    // Gleichzeitig: genau einer gewinnt, die Bytes gehören ihm.
    let zweit = p.anlegen(&anna, "file", "text/plain", "b.txt", 5).await;
    let (eins, zwei) = tokio::join!(
        p.daten(&anna, zweit, "text/plain", "b.txt", b"AAAAA"),
        p.daten(&anna, zweit, "text/plain", "b.txt", b"BBBBB"),
    );
    let erfolge = [eins, zwei]
        .iter()
        .filter(|s| **s == StatusCode::OK)
        .count();
    assert_eq!(erfolge, 1, "{eins} {zwei}");
    assert!([eins, zwei].iter().all(|s| *s == StatusCode::OK
        || *s == StatusCode::CONFLICT
        || *s == StatusCode::BAD_REQUEST));
    let (status, bytes) = p
        .roh(
            "GET",
            &format!("/api/v1/media/{zweit}/bytes"),
            Some(&anna.token),
            vec![],
            Body::empty(),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let gewinner: &[u8] = if eins == StatusCode::OK {
        b"AAAAA"
    } else {
        b"BBBBB"
    };
    assert_eq!(bytes, gewinner);
}

#[tokio::test(flavor = "multi_thread")]
async fn sticker_ohne_bytes_wird_nicht_beansprucht() {
    let p = probe!("sticker-bytes");
    let anna = p.konto("anna").await;
    let (status, paket) = p
        .call(
            "POST",
            "/api/v1/stickers/packs",
            Some(&anna.token),
            Some(json!({ "name": "Probe" })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{paket}");
    let paket = paket["id"].as_str().unwrap().to_string();
    let leer = p
        .anlegen(&anna, "sticker", "image/png", "s.png", PNG.len())
        .await;
    let (status, body) = p
        .call(
            "POST",
            &format!("/api/v1/stickers/packs/{paket}/stickers"),
            Some(&anna.token),
            Some(json!({ "attachmentId": leer })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status_zeile,): (String,) = sqlx::query_as("select status from attachments where id = $1")
        .bind(leer)
        .fetch_one(&p.state.pool)
        .await
        .unwrap();
    assert_eq!(status_zeile, "pending", "nicht als fertig markiert");

    assert_eq!(
        p.daten(&anna, leer, "image/png", "s.png", PNG).await,
        StatusCode::OK
    );
    let (status, body) = p
        .call(
            "POST",
            &format!("/api/v1/stickers/packs/{paket}/stickers"),
            Some(&anna.token),
            Some(json!({ "attachmentId": leer })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
}

/// Ein eigener Zustand mit kalter Ablage in einem eigenen Schema: Der
/// Auslagerungsdienst arbeitet auf ALLEN Anhängen, die er sieht.
async fn kalter_aufbau(name: &str) -> Option<(AppState, String)> {
    let url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;
    let kennung = Uuid::now_v7().simple();
    let warm = format!("./.data/ma-warm-{name}-{kennung}");
    let kalt = format!("./.data/ma-kalt-{name}-{kennung}");
    let schema = format!("medienanrufe_{name}");
    let config = {
        let _schloss = AUFBAU.lock().await;
        grund_umgebung(&url, &warm);
        std::env::set_var("KALT_TREIBER", "lokal");
        std::env::set_var("KALT_LOKAL_DIR", &kalt);
        let config = Arc::new(Config::from_env().expect("config"));
        std::env::remove_var("KALT_TREIBER");
        config
    };
    let vorbereiten = sqlx::PgPool::connect(&url).await.expect("Datenbank");
    sqlx::query(&format!("drop schema if exists {schema} cascade"))
        .execute(&vorbereiten)
        .await
        .unwrap();
    sqlx::query(&format!("create schema {schema}"))
        .execute(&vorbereiten)
        .await
        .unwrap();
    vorbereiten.close().await;
    let fuer_pfad = schema.clone();
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(6)
        .after_connect(move |verbindung, _| {
            let schema = fuer_pfad.clone();
            Box::pin(async move {
                sqlx::query(&format!("set search_path to {schema}"))
                    .execute(verbindung)
                    .await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .unwrap();
    let state = AppState::from_pool(pool, config).await.expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    Some((state, schema))
}

#[tokio::test(flavor = "multi_thread")]
async fn haengende_umzuege_fallen_nach_der_frist_zurueck() {
    let Some((state, schema)) = kalter_aufbau("haengend").await else {
        eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
        return;
    };
    let p = Probe {
        router: app::build(state.clone()),
        state: state.clone(),
    };
    let anna = p.konto("anna").await;
    let alt = p
        .hochladen(&anna, "file", "text/plain", "alt.txt", b"alt")
        .await;
    let frisch = p
        .hochladen(&anna, "file", "text/plain", "frisch.txt", b"frisch")
        .await;
    // Zwei Umzüge, deren Prozess abgestürzt ist – einer seit Stunden, einer
    // gerade erst (der könnte noch leben).
    sqlx::query(
        "update attachments set ablage = 'wandert',
                wandert_seit = case when id = $1 then now() - interval '7 hours'
                                    else now() - interval '1 hour' end
          where id = any($2)",
    )
    .bind(alt)
    .bind(vec![alt, frisch])
    .execute(&state.pool)
    .await
    .unwrap();
    assert_eq!(
        auslagern::haengende_zuruecksetzen(&state.pool, auslagern::WANDERT_FRIST).await,
        1
    );
    let lage = |id: Uuid| {
        let pool = state.pool.clone();
        async move {
            sqlx::query_as::<_, (String, Option<chrono::DateTime<chrono::Utc>>)>(
                "select ablage, wandert_seit from attachments where id = $1",
            )
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    assert_eq!(lage(alt).await, ("lokal".to_string(), None));
    assert_eq!(lage(frisch).await.0, "wandert");

    // Zwei Instanzen ziehen gleichzeitig um: Jede Datei genau einmal, keine
    // bleibt auf `wandert`, und jede ist danach lesbar.
    sqlx::query(
        "update attachments set ablage = 'lokal', wandert_seit = null, prioritaet = 'niedrig'",
    )
    .execute(&state.pool)
    .await
    .unwrap();
    let mehr: Vec<Uuid> = {
        let mut liste = vec![alt, frisch];
        for i in 0..4 {
            liste.push(
                p.hochladen(
                    &anna,
                    "file",
                    "text/plain",
                    &format!("n{i}.txt"),
                    format!("inhalt {i}").as_bytes(),
                )
                .await,
            );
        }
        sqlx::query("update attachments set prioritaet = 'niedrig'")
            .execute(&state.pool)
            .await
            .unwrap();
        liste
    };
    let kalt = state.speicher.kalt.clone().expect("kalte Ablage");
    let (eins, zwei) = tokio::join!(
        auslagern::durchgang(
            &state.pool,
            &state.speicher.warm,
            &kalt,
            i64::MAX / 4,
            i64::MAX / 4
        ),
        auslagern::durchgang(
            &state.pool,
            &state.speicher.warm,
            &kalt,
            i64::MAX / 4,
            i64::MAX / 4
        ),
    );
    assert_eq!(eins.bewegt + zwei.bewegt, mehr.len(), "{eins:?} {zwei:?}");
    assert_eq!(eins.gescheitert + zwei.gescheitert, 0);
    let wandernd: i64 =
        sqlx::query_scalar("select count(*) from attachments where ablage <> 'fern'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(wandernd, 0);
    for id in &mehr {
        let (status, _) = p
            .roh(
                "GET",
                &format!("/api/v1/media/{id}/bytes"),
                Some(&anna.token),
                vec![],
                Body::empty(),
            )
            .await;
        assert_eq!(status, StatusCode::OK);
    }

    let aufraeumen = sqlx::PgPool::connect(
        &std::env::var("TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .unwrap(),
    )
    .await
    .unwrap();
    let _ = sqlx::query(&format!("drop schema if exists {schema} cascade"))
        .execute(&aufraeumen)
        .await;
}
