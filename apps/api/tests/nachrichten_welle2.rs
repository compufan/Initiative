//! Zweite Welle Nachrichtenfunktionen: Erwähnungen, Bearbeiten mit Verlauf und
//! Zeitfenster, „Für alle löschen“ mit Frist, Anheften, geplante und
//! selbstlöschende Nachrichten, einmal ansehbare Medien, Link-Vorschau (SSRF),
//! Quiz, Kontaktkarte und Standort – jeweils mit Rechten und Grenzfällen.

use std::net::{IpAddr, Ipv4Addr};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tower::ServiceExt;
use uuid::Uuid;

use initiative_api::config::Config;
use initiative_api::push::Mitschnitt;
use initiative_api::state::AppState;
use initiative_api::{app, MIGRATOR};

struct Probe {
    router: Router,
    state: AppState,
    push: Mitschnitt,
}

impl Drop for Probe {
    fn drop(&mut self) {
        let vorrat = self.state.pool.clone();
        tokio::task::block_in_place(|| tokio::runtime::Handle::current().block_on(vorrat.close()));
    }
}

struct Konto {
    token: String,
    id: String,
}

impl Probe {
    async fn roh(
        &self,
        method: &str,
        uri: &str,
        token: &str,
        kopf: Vec<(&str, String)>,
        body: Body,
    ) -> (StatusCode, Vec<u8>) {
        let mut builder = Request::builder()
            .method(method)
            .uri(format!("/api/v1{uri}"))
            .header("authorization", format!("Bearer {token}"));
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
        token: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let (status, bytes) = match body {
            Some(body) => {
                self.roh(
                    method,
                    uri,
                    token,
                    vec![("content-type", "application/json".into())],
                    Body::from(serde_json::to_vec(&body).unwrap()),
                )
                .await
            }
            None => self.roh(method, uri, token, vec![], Body::empty()).await,
        };
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    async fn konto(&self, name: &str) -> Konto {
        let request = Request::builder()
            .method("POST")
            .uri("/api/v1/auth/register")
            .header("content-type", "application/json")
            .body(Body::from(
                serde_json::to_vec(&json!({
                    "username": name,
                    "displayName": name,
                    "password": "richtigespasswort",
                }))
                .unwrap(),
            ))
            .unwrap();
        let response = self.router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap();
        Konto {
            token: body["accessToken"].as_str().unwrap().to_string(),
            id: body["user"]["id"].as_str().unwrap().to_string(),
        }
    }

    async fn chat(&self, von: &Konto, art: &str, andere: &[&Konto]) -> String {
        let ids: Vec<&str> = andere.iter().map(|k| k.id.as_str()).collect();
        let mut body = json!({ "type": art, "memberIds": ids });
        if art == "group" {
            body["title"] = json!("Runde");
        }
        let (status, chat) = self
            .call("POST", "/conversations", &von.token, Some(body))
            .await;
        assert!(status.is_success(), "{chat}");
        chat["id"].as_str().unwrap().to_string()
    }

    async fn senden_mit(&self, von: &Konto, chat: &str, body: Value) -> (StatusCode, Value) {
        self.call(
            "POST",
            &format!("/conversations/{chat}/messages"),
            &von.token,
            Some(body),
        )
        .await
    }

    async fn senden(&self, von: &Konto, chat: &str, text: &str) -> String {
        let (status, nachricht) = self
            .senden_mit(von, chat, json!({ "type": "text", "body": text }))
            .await;
        assert_eq!(status, StatusCode::CREATED, "{nachricht}");
        nachricht["id"].as_str().unwrap().to_string()
    }

    async fn hochladen(&self, wer: &Konto, art: &str, mime: &str, daten: &[u8]) -> String {
        let (status, upload) = self
            .call(
                "POST",
                "/media/uploads",
                &wer.token,
                Some(json!({ "kind": art, "mime": mime, "size": daten.len(), "fileName": "probe.png" })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{upload}");
        let anhang = upload["attachmentId"].as_str().unwrap().to_string();
        let grenze = "----welle2";
        let mut body = Vec::new();
        body.extend_from_slice(format!("--{grenze}\r\n").as_bytes());
        body.extend_from_slice(
            b"Content-Disposition: form-data; name=\"file\"; filename=\"probe.png\"\r\n",
        );
        body.extend_from_slice(format!("Content-Type: {mime}\r\n\r\n").as_bytes());
        body.extend_from_slice(daten);
        body.extend_from_slice(format!("\r\n--{grenze}--\r\n").as_bytes());
        let (status, antwort) = self
            .roh(
                "POST",
                &format!("/media/uploads/{anhang}/data"),
                &wer.token,
                vec![(
                    "content-type",
                    format!("multipart/form-data; boundary={grenze}"),
                )],
                Body::from(body),
            )
            .await;
        assert_eq!(
            status,
            StatusCode::OK,
            "{}",
            String::from_utf8_lossy(&antwort)
        );
        anhang
    }

    async fn chatliste_eintrag(&self, wer: &Konto, chat: &str) -> Value {
        let (_, liste) = self.call("GET", "/conversations", &wer.token, None).await;
        liste["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == chat)
            .cloned()
            .unwrap()
    }

    async fn nachrichten(&self, wer: &Konto, chat: &str) -> Vec<Value> {
        let (status, liste) = self
            .call(
                "GET",
                &format!("/conversations/{chat}/messages"),
                &wer.token,
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{liste}");
        liste["items"].as_array().unwrap().clone()
    }

    /// Die Erstellungszeit einer Nachricht verschieben (für Zeitfenster).
    async fn altern(&self, nachricht: &str, minuten: i32) {
        sqlx::query(
            "update messages set created_at = created_at - make_interval(mins => $2) where id = $1",
        )
        .bind(Uuid::parse_str(nachricht).unwrap())
        .bind(minuten)
        .execute(&self.state.pool)
        .await
        .unwrap();
    }

    async fn pushes_fuer(&self, person: &str) -> usize {
        // Push läuft im Hintergrund – kurz warten.
        tokio::time::sleep(Duration::from_millis(300)).await;
        self.push
            .lock()
            .unwrap()
            .iter()
            .filter(|(id, _)| id.to_string() == person)
            .count()
    }
}

async fn aufbauen(name: &str) -> Option<Probe> {
    let url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;
    std::env::set_var("DATABASE_URL", &url);
    std::env::set_var("NODE_ENV", "test");
    std::env::set_var("JWT_SECRET", "test-secret-value-at-least-16-characters");
    std::env::set_var("REALTIME_BUS", "memory");
    std::env::set_var("DATABASE_POOL_MAX", "4");
    std::env::set_var("STORAGE_DRIVER", "local");
    std::env::set_var("RATE_LIMIT", "false");
    std::env::set_var(
        "LOCAL_STORAGE_DIR",
        format!("./.data/{name}-{}", Uuid::now_v7().simple()),
    );
    std::env::set_var("PUBLIC_API_URL", "http://localhost:8080");
    std::env::set_var("PUBLIC_APP_URL", "http://localhost:5173");
    let state = AppState::new(Config::from_env().expect("config"))
        .await
        .expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    let push = state.push.mitschneiden();
    Some(Probe {
        router: app::build(state.clone()),
        state,
        push,
    })
}

fn kurz() -> String {
    let voll = Uuid::now_v7().simple().to_string();
    voll[voll.len() - 10..].to_string()
}

fn png() -> Vec<u8> {
    vec![
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ]
}

/* ---------- 1. Erwähnungen ------------------------------------------------- */

#[tokio::test(flavor = "multi_thread")]
async fn erwaehnungen_nur_mitglieder_zaehlen_und_melden_auch_stumm() {
    let Some(p) = aufbauen("erwaehnung").await else {
        return;
    };
    let n = kurz();
    let anna = p.konto(&format!("ea{n}")).await;
    let bodo = p.konto(&format!("eb{n}")).await;
    let cleo = p.konto(&format!("ec{n}")).await;
    let fremd = p.konto(&format!("ef{n}")).await;
    let chat = p.chat(&anna, "group", &[&bodo, &cleo]).await;

    // Fremde lassen sich nicht erwähnen, kaputte Formen auch nicht.
    let (status, _) = p
        .senden_mit(
            &anna,
            &chat,
            json!({ "body": "@x", "metadata": { "mentions": [fremd.id] } }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let viele: Vec<String> = (0..51).map(|_| Uuid::now_v7().to_string()).collect();
    let (status, _) = p
        .senden_mit(
            &anna,
            &chat,
            json!({ "body": "@x", "metadata": { "mentions": viele } }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "höchstens fünfzig");

    // Bodo stellt den Chat stumm, Cleo auf „Nur @Erwähnungen“.
    let (status, _) = p
        .call(
            "PATCH",
            &format!("/conversations/{chat}"),
            &bodo.token,
            Some(json!({ "mutedUntil": "2099-01-01T00:00:00Z" })),
        )
        .await;
    assert!(status.is_success());
    let (status, _) = p
        .call(
            "PATCH",
            &format!("/conversations/{chat}"),
            &cleo.token,
            Some(json!({ "notifyLevel": "erwaehnungen" })),
        )
        .await;
    assert!(status.is_success());

    p.push.lock().unwrap().clear();
    p.senden(&anna, &chat, "ohne Erwähnung").await;
    assert_eq!(p.pushes_fuer(&bodo.id).await, 0, "stumm");
    assert_eq!(p.pushes_fuer(&cleo.id).await, 0, "nur Erwähnungen");

    let (status, erwaehnt) = p
        .senden_mit(
            &anna,
            &chat,
            json!({ "body": "@bodo @cleo schaut mal", "metadata": { "mentions": [bodo.id, cleo.id, bodo.id] } }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{erwaehnt}");
    assert_eq!(
        erwaehnt["metadata"]["mentions"].as_array().unwrap().len(),
        2,
        "ohne Doppelte"
    );
    assert_eq!(
        p.pushes_fuer(&bodo.id).await,
        1,
        "persönlich erwähnt: auch stumm"
    );
    assert_eq!(p.pushes_fuer(&cleo.id).await, 1);

    // Chatliste: ungelesene Erwähnungen; Sprungliste.
    let eintrag = p.chatliste_eintrag(&bodo, &chat).await;
    assert_eq!(eintrag["ungeleseneErwaehnungen"], 1, "{eintrag}");
    assert_eq!(
        p.chatliste_eintrag(&anna, &chat).await["ungeleseneErwaehnungen"],
        0
    );
    let (_, ids) = p
        .call(
            "GET",
            &format!("/conversations/{chat}/erwaehnungen"),
            &bodo.token,
            None,
        )
        .await;
    assert_eq!(ids["items"], json!([erwaehnt["id"]]));
    let (status, _) = p
        .call(
            "POST",
            &format!("/conversations/{chat}/read"),
            &bodo.token,
            Some(json!({ "messageId": erwaehnt["id"] })),
        )
        .await;
    assert!(status.is_success());
    assert_eq!(
        p.chatliste_eintrag(&bodo, &chat).await["ungeleseneErwaehnungen"],
        0
    );

    // „@alle“: nur Admins. Für Cleo (nur Erwähnungen) gilt es als Erwähnung,
    // durch Bodos Stummschaltung kommt es nicht.
    let (status, _) = p
        .senden_mit(
            &bodo,
            &chat,
            json!({ "body": "@alle", "metadata": { "mentionsAlle": true } }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    p.push.lock().unwrap().clear();
    let (status, _) = p
        .senden_mit(
            &anna,
            &chat,
            json!({ "body": "@alle hallo", "metadata": { "mentionsAlle": true } }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(p.pushes_fuer(&cleo.id).await, 1);
    assert_eq!(p.pushes_fuer(&bodo.id).await, 0);
    assert_eq!(
        p.chatliste_eintrag(&cleo, &chat).await["ungeleseneErwaehnungen"],
        2
    );
}

/* ---------- 2./3. Bearbeiten und Löschen ----------------------------------- */

#[tokio::test(flavor = "multi_thread")]
async fn bearbeiten_mit_verlauf_zeitfenster_und_bildunterschrift() {
    let Some(p) = aufbauen("bearbeiten").await else {
        return;
    };
    let n = kurz();
    let anna = p.konto(&format!("ba{n}")).await;
    let bodo = p.konto(&format!("bb{n}")).await;
    let fremd = p.konto(&format!("bf{n}")).await;
    let chat = p.chat(&anna, "direct", &[&bodo]).await;
    let id = p.senden(&anna, &chat, "Treffen um 8").await;

    let (status, neu) = p
        .call(
            "PATCH",
            &format!("/messages/{id}"),
            &anna.token,
            Some(json!({ "body": "Treffen um 9" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{neu}");
    assert!(neu["editedAt"].is_string());
    let (status, _) = p
        .call(
            "PATCH",
            &format!("/messages/{id}"),
            &bodo.token,
            Some(json!({ "body": "x" })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "nur eigene");

    // Der Verlauf: für alle im Chat, nicht für Fremde.
    let (status, verlauf) = p
        .call(
            "GET",
            &format!("/messages/{id}/bearbeitungen"),
            &bodo.token,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{verlauf}");
    assert_eq!(verlauf["items"][0]["body"], "Treffen um 8");
    assert_eq!(verlauf["aktuell"]["body"], "Treffen um 9");
    let (status, _) = p
        .call(
            "GET",
            &format!("/messages/{id}/bearbeitungen"),
            &fremd.token,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Nach fünfzehn Minuten steht sie fest.
    p.altern(&id, 16).await;
    let (status, _) = p
        .call(
            "PATCH",
            &format!("/messages/{id}"),
            &anna.token,
            Some(json!({ "body": "Treffen um 10" })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Bildunterschrift: bearbeitbar, auch leer.
    let bild = p.hochladen(&anna, "image", "image/png", &png()).await;
    let (status, foto) = p
        .senden_mit(
            &anna,
            &chat,
            json!({ "type": "image", "body": "Strand", "attachmentIds": [bild] }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{foto}");
    let foto_id = foto["id"].as_str().unwrap();
    let (status, foto) = p
        .call(
            "PATCH",
            &format!("/messages/{foto_id}"),
            &anna.token,
            Some(json!({ "body": "Am Strand" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{foto}");
    assert_eq!(foto["body"], "Am Strand");
    assert_eq!(foto["attachments"].as_array().unwrap().len(), 1);
    let (status, foto) = p
        .call(
            "PATCH",
            &format!("/messages/{foto_id}"),
            &anna.token,
            Some(json!({ "body": "" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{foto}");
    assert!(foto["body"].is_null());

    // Gelöscht: kein Verlauf mehr.
    let id2 = p.senden(&anna, &chat, "eins").await;
    p.call(
        "PATCH",
        &format!("/messages/{id2}"),
        &anna.token,
        Some(json!({ "body": "zwei" })),
    )
    .await;
    let (status, _) = p
        .call(
            "DELETE",
            &format!("/messages/{id2}?scope=all"),
            &anna.token,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let reste: i64 = sqlx::query_scalar("select count(*) from message_edits where message_id = $1")
        .bind(Uuid::parse_str(&id2).unwrap())
        .fetch_one(&p.state.pool)
        .await
        .unwrap();
    assert_eq!(reste, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn fuer_alle_loeschen_mit_frist_ausser_admins_in_gruppen() {
    let Some(p) = aufbauen("loeschfrist").await else {
        return;
    };
    let n = kurz();
    let anna = p.konto(&format!("la{n}")).await;
    let bodo = p.konto(&format!("lb{n}")).await;
    let direkt = p.chat(&anna, "direct", &[&bodo]).await;
    let alt = p.senden(&anna, &direkt, "alt").await;
    p.altern(&alt, 48 * 60 + 5).await;
    let (status, _) = p
        .call(
            "DELETE",
            &format!("/messages/{alt}?scope=all"),
            &anna.token,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "nach 48 h nicht mehr");
    let (status, _) = p
        .call(
            "DELETE",
            &format!("/messages/{alt}?scope=me"),
            &anna.token,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "nur für mich geht immer");
    let frisch = p.senden(&anna, &direkt, "frisch").await;
    let (status, _) = p
        .call(
            "DELETE",
            &format!("/messages/{frisch}?scope=all"),
            &anna.token,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Gruppe: Admin löscht Bodos alte Nachricht ohne Frist.
    let gruppe = p.chat(&anna, "group", &[&bodo]).await;
    let von_bodo = p.senden(&bodo, &gruppe, "entgleist").await;
    p.altern(&von_bodo, 10 * 24 * 60).await;
    let (status, _) = p
        .call(
            "DELETE",
            &format!("/messages/{von_bodo}?scope=all"),
            &bodo.token,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "Bodo selbst: Frist vorbei");
    let (status, _) = p
        .call(
            "DELETE",
            &format!("/messages/{von_bodo}?scope=all"),
            &anna.token,
            None,
        )
        .await;
    assert_eq!(
        status,
        StatusCode::NO_CONTENT,
        "Admin: Moderation ohne Frist"
    );
}

/* ---------- 4. Anheften ---------------------------------------------------- */

#[tokio::test(flavor = "multi_thread")]
async fn anheften_mit_rechten_grenze_und_systemzeile() {
    let Some(p) = aufbauen("anheften").await else {
        return;
    };
    let n = kurz();
    let anna = p.konto(&format!("aa{n}")).await;
    let bodo = p.konto(&format!("ab{n}")).await;
    let direkt = p.chat(&anna, "direct", &[&bodo]).await;
    let m = p.senden(&anna, &direkt, "wichtig").await;
    let (status, _) = p
        .call("PUT", &format!("/messages/{m}/anheften"), &bodo.token, None)
        .await;
    assert_eq!(status, StatusCode::CREATED, "im Direktchat beide");
    let (status, _) = p
        .call("PUT", &format!("/messages/{m}/anheften"), &anna.token, None)
        .await;
    assert_eq!(status, StatusCode::OK, "schon angeheftet: Neuversuch");
    let verlauf = p.nachrichten(&anna, &direkt).await;
    let zeilen: Vec<&Value> = verlauf
        .iter()
        .filter(|v| v["metadata"]["system"]["kind"] == "message.pinned")
        .collect();
    assert_eq!(zeilen.len(), 1, "eine Systemzeile");
    assert_eq!(zeilen[0]["metadata"]["system"]["value"], m.as_str());

    // Gruppe: „Nur Admins ändern Gruppeninfo“ ist Voreinstellung.
    let gruppe = p.chat(&anna, "group", &[&bodo]).await;
    let ids: Vec<String> = futures_ids(&p, &anna, &gruppe, 4).await;
    let (status, _) = p
        .call(
            "PUT",
            &format!("/messages/{}/anheften", ids[0]),
            &bodo.token,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    for id in &ids {
        let (status, _) = p
            .call(
                "PUT",
                &format!("/messages/{id}/anheften"),
                &anna.token,
                None,
            )
            .await;
        assert_eq!(status, StatusCode::CREATED);
    }
    let (_, liste) = p
        .call(
            "GET",
            &format!("/conversations/{gruppe}/angeheftet"),
            &bodo.token,
            None,
        )
        .await;
    let angeheftet: Vec<&str> = liste["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["id"].as_str().unwrap())
        .collect();
    assert_eq!(angeheftet.len(), 3, "höchstens drei");
    assert!(
        !angeheftet.contains(&ids[0].as_str()),
        "die älteste fiel heraus"
    );

    // Lösen, und Löschen für alle löst mit.
    let (status, _) = p
        .call(
            "DELETE",
            &format!("/messages/{}/anheften", ids[1]),
            &anna.token,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = p
        .call(
            "DELETE",
            &format!("/messages/{}?scope=all", ids[2]),
            &anna.token,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, liste) = p
        .call(
            "GET",
            &format!("/conversations/{gruppe}/angeheftet"),
            &anna.token,
            None,
        )
        .await;
    assert_eq!(liste["items"].as_array().unwrap().len(), 1);
}

async fn futures_ids(p: &Probe, von: &Konto, chat: &str, anzahl: usize) -> Vec<String> {
    let mut ids = Vec::new();
    for i in 0..anzahl {
        ids.push(p.senden(von, chat, &format!("Nachricht {i}")).await);
    }
    ids
}

/* ---------- 5. Geplante Nachrichten ---------------------------------------- */

#[tokio::test(flavor = "multi_thread")]
async fn geplante_nachrichten_genau_einmal_und_mit_pruefung_beim_senden() {
    let Some(p) = aufbauen("geplant").await else {
        return;
    };
    let n = kurz();
    let anna = p.konto(&format!("ga{n}")).await;
    let bodo = p.konto(&format!("gb{n}")).await;
    let cleo = p.konto(&format!("gc{n}")).await;
    let gruppe = p.chat(&anna, "group", &[&bodo, &cleo]).await;
    let spaeter = (chrono::Utc::now() + chrono::Duration::minutes(10)).to_rfc3339();

    let (status, _) = p
        .call(
            "POST",
            &format!("/conversations/{gruppe}/geplant"),
            &anna.token,
            Some(json!({ "body": "zu früh", "sendenUm": chrono::Utc::now().to_rfc3339() })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "Vergangenheit");
    let (status, geplant) = p
        .call(
            "POST",
            &format!("/conversations/{gruppe}/geplant"),
            &anna.token,
            Some(json!({ "body": "Guten Morgen @bodo", "sendenUm": spaeter, "zeitzone": "Europe/Berlin",
                          "metadata": { "mentions": [bodo.id] } })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{geplant}");
    let gid = geplant["id"].as_str().unwrap().to_string();
    let (_, liste) = p
        .call(
            "GET",
            &format!("/conversations/{gruppe}/geplant"),
            &bodo.token,
            None,
        )
        .await;
    assert_eq!(
        liste["items"].as_array().unwrap().len(),
        0,
        "nur der Absender sieht sie"
    );

    // Ändern, dann fällig machen und den Dienst zweimal (und gleichzeitig)
    // laufen lassen: genau eine Nachricht.
    let (status, _) = p
        .call(
            "PATCH",
            &format!("/geplant/{gid}"),
            &anna.token,
            Some(json!({ "body": "Guten Morgen, @bodo" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    sqlx::query(
        "update scheduled_messages set senden_um = now() - interval '1 second' where id = $1",
    )
    .bind(Uuid::parse_str(&gid).unwrap())
    .execute(&p.state.pool)
    .await
    .unwrap();
    let (a, b) = tokio::join!(
        initiative_api::services::messages::geplant::durchgang(&p.state),
        initiative_api::services::messages::geplant::durchgang(&p.state)
    );
    assert_eq!(a.unwrap().0 + b.unwrap().0, 1);
    initiative_api::services::messages::geplant::durchgang(&p.state)
        .await
        .unwrap();
    let gesendet: Vec<Value> = p
        .nachrichten(&bodo, &gruppe)
        .await
        .into_iter()
        .filter(|m| m["body"] == "Guten Morgen, @bodo")
        .collect();
    assert_eq!(gesendet.len(), 1, "genau einmal");
    assert_eq!(gesendet[0]["clientId"], format!("geplant:{gid}"));
    assert_eq!(gesendet[0]["metadata"]["mentions"][0], bodo.id.as_str());

    // Eine liegengebliebene Beanspruchung wird neu versucht – und bleibt eine.
    sqlx::query(
        "update scheduled_messages set status = 'sendet', beansprucht_at = now() - interval '10 minutes'
          where id = $1",
    )
    .bind(Uuid::parse_str(&gid).unwrap())
    .execute(&p.state.pool)
    .await
    .unwrap();
    initiative_api::services::messages::geplant::durchgang(&p.state)
        .await
        .unwrap();
    let anzahl = p
        .nachrichten(&bodo, &gruppe)
        .await
        .into_iter()
        .filter(|m| m["body"] == "Guten Morgen, @bodo")
        .count();
    assert_eq!(anzahl, 1, "der feste Schlüssel verhindert die zweite");

    // Prüfung beim Senden: Cleo plant, wird entfernt → fehlgeschlagen.
    let (_, geplant) = p
        .call(
            "POST",
            &format!("/conversations/{gruppe}/geplant"),
            &cleo.token,
            Some(json!({ "body": "Tschüss", "sendenUm": spaeter })),
        )
        .await;
    let cid = geplant["id"].as_str().unwrap().to_string();
    let (status, _) = p
        .call(
            "DELETE",
            &format!("/conversations/{gruppe}/members/{}", cleo.id),
            &anna.token,
            None,
        )
        .await;
    assert!(status.is_success());
    sqlx::query(
        "update scheduled_messages set senden_um = now() - interval '1 second' where id = $1",
    )
    .bind(Uuid::parse_str(&cid).unwrap())
    .execute(&p.state.pool)
    .await
    .unwrap();
    initiative_api::services::messages::geplant::durchgang(&p.state)
        .await
        .unwrap();
    let status: String = sqlx::query_scalar("select status from scheduled_messages where id = $1")
        .bind(Uuid::parse_str(&cid).unwrap())
        .fetch_one(&p.state.pool)
        .await
        .unwrap();
    assert_eq!(status, "fehlgeschlagen");

    // Anhang weg zum Sendezeitpunkt → fehlgeschlagen; Jetzt senden; Löschen
    // räumt den Anhang weg.
    let bild = p.hochladen(&anna, "image", "image/png", &png()).await;
    let (status, geplant) = p
        .call(
            "POST",
            &format!("/conversations/{gruppe}/geplant"),
            &anna.token,
            Some(json!({ "type": "image", "attachmentIds": [bild], "sendenUm": spaeter })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{geplant}");
    let bid = geplant["id"].as_str().unwrap().to_string();
    sqlx::query("delete from attachments where id = $1")
        .bind(Uuid::parse_str(&bild).unwrap())
        .execute(&p.state.pool)
        .await
        .unwrap();
    let (status, _) = p
        .call("POST", &format!("/geplant/{bid}/jetzt"), &anna.token, None)
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "Anhang fehlt");

    let (_, geplant) = p
        .call(
            "POST",
            &format!("/conversations/{gruppe}/geplant"),
            &anna.token,
            Some(json!({ "body": "sofort", "sendenUm": spaeter })),
        )
        .await;
    let sid = geplant["id"].as_str().unwrap().to_string();
    let (status, antwort) = p
        .call("POST", &format!("/geplant/{sid}/jetzt"), &anna.token, None)
        .await;
    assert_eq!(status, StatusCode::OK, "{antwort}");
    let (status, nochmal) = p
        .call("POST", &format!("/geplant/{sid}/jetzt"), &anna.token, None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        antwort["messageId"], nochmal["messageId"],
        "Neuversuch: dieselbe Nachricht"
    );

    let bild2 = p.hochladen(&anna, "image", "image/png", &png()).await;
    let (_, geplant) = p
        .call(
            "POST",
            &format!("/conversations/{gruppe}/geplant"),
            &anna.token,
            Some(json!({ "type": "image", "attachmentIds": [bild2], "sendenUm": spaeter })),
        )
        .await;
    let did = geplant["id"].as_str().unwrap().to_string();
    let (status, _) = p
        .call("DELETE", &format!("/geplant/{did}"), &anna.token, None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let da: bool = sqlx::query_scalar("select exists (select 1 from attachments where id = $1)")
        .bind(Uuid::parse_str(&bild2).unwrap())
        .fetch_one(&p.state.pool)
        .await
        .unwrap();
    assert!(!da, "der nie gesendete Anhang ist weg");
}

/* ---------- 6. Selbstlöschende Nachrichten --------------------------------- */

#[tokio::test(flavor = "multi_thread")]
async fn selbstloeschen_mit_rechten_ablauf_und_aufraeumen_samt_anhang() {
    let Some(p) = aufbauen("selbstloeschen").await else {
        return;
    };
    let n = kurz();
    let anna = p.konto(&format!("sa{n}")).await;
    let bodo = p.konto(&format!("sb{n}")).await;
    let gruppe = p.chat(&anna, "group", &[&bodo]).await;
    let (status, _) = p
        .call(
            "PUT",
            &format!("/conversations/{gruppe}/selbstloeschen"),
            &bodo.token,
            Some(json!({ "sekunden": 86400 })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "Mitglied ohne Gruppeninfo-Recht"
    );
    let (status, _) = p
        .call(
            "PUT",
            &format!("/conversations/{gruppe}/selbstloeschen"),
            &anna.token,
            Some(json!({ "sekunden": 5 })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "nur feste Stufen");

    let direkt = p.chat(&anna, "direct", &[&bodo]).await;
    let vorher = p.senden(&anna, &direkt, "bleibt").await;
    let (status, chat) = p
        .call(
            "PUT",
            &format!("/conversations/{direkt}/selbstloeschen"),
            &bodo.token,
            Some(json!({ "sekunden": 86400 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{chat}");
    assert_eq!(chat["selbstloeschenS"], 86400);
    let verlauf = p.nachrichten(&anna, &direkt).await;
    let zeile = verlauf
        .iter()
        .find(|m| m["metadata"]["system"]["kind"] == "conversation.selbstloeschen")
        .expect("Systemzeile");
    assert!(
        zeile.get("expiresAt").is_none(),
        "Systemzeilen laufen nicht ab"
    );

    let bild = p.hochladen(&anna, "image", "image/png", &png()).await;
    let (_, foto) = p
        .senden_mit(
            &anna,
            &direkt,
            json!({ "type": "image", "attachmentIds": [bild] }),
        )
        .await;
    assert!(foto["expiresAt"].is_string(), "{foto}");
    let foto_id = foto["id"].as_str().unwrap().to_string();
    let schluessel: String =
        sqlx::query_scalar("select storage_key from attachments where id = $1")
            .bind(Uuid::parse_str(&bild).unwrap())
            .fetch_one(&p.state.pool)
            .await
            .unwrap();

    sqlx::query("update messages set expires_at = now() - interval '1 second' where id = $1")
        .bind(Uuid::parse_str(&foto_id).unwrap())
        .execute(&p.state.pool)
        .await
        .unwrap();
    let (a, b) = tokio::join!(
        initiative_api::services::messages::selbstloeschen::durchgang(&p.state),
        initiative_api::services::messages::selbstloeschen::durchgang(&p.state)
    );
    assert!(a.unwrap() + b.unwrap() >= 1);
    let ids: Vec<String> = p
        .nachrichten(&bodo, &direkt)
        .await
        .iter()
        .map(|m| m["id"].as_str().unwrap().to_string())
        .collect();
    assert!(!ids.contains(&foto_id), "fort");
    assert!(ids.contains(&vorher), "Älteres läuft nicht ab");
    let im_muell: bool =
        sqlx::query_scalar("select exists (select 1 from storage_muell where storage_key = $1)")
            .bind(&schluessel)
            .fetch_one(&p.state.pool)
            .await
            .unwrap();
    assert!(im_muell, "die Datei geht den Weg alles Gelöschten");

    // Ausschalten: neue Nachrichten ohne Ablauf.
    let (status, _) = p
        .call(
            "PUT",
            &format!("/conversations/{direkt}/selbstloeschen"),
            &anna.token,
            Some(json!({ "sekunden": null })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, neu) = p
        .senden_mit(&anna, &direkt, json!({ "body": "dauerhaft" }))
        .await;
    assert!(neu.get("expiresAt").is_none());
}

/* ---------- 7. Einmal ansehen ---------------------------------------------- */

#[tokio::test(flavor = "multi_thread")]
async fn einmal_ansehbar_je_person_genau_einmal() {
    let Some(p) = aufbauen("einmal").await else {
        return;
    };
    let n = kurz();
    let anna = p.konto(&format!("oa{n}")).await;
    let bodo = p.konto(&format!("ob{n}")).await;
    let cleo = p.konto(&format!("oc{n}")).await;
    let gruppe = p.chat(&anna, "group", &[&bodo, &cleo]).await;

    let bild = p.hochladen(&anna, "image", "image/png", &png()).await;
    let (status, _) = p
        .senden_mit(&anna, &gruppe, json!({ "type": "image", "body": "geheim", "attachmentIds": [bild], "metadata": { "einmalAnsehen": true } }))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "keine Bildunterschrift");
    let (status, _) = p
        .senden_mit(
            &anna,
            &gruppe,
            json!({ "type": "text", "body": "x", "metadata": { "einmalAnsehen": true } }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "nur Fotos und Videos");
    let (status, nachricht) = p
        .senden_mit(&anna, &gruppe, json!({ "type": "image", "attachmentIds": [bild], "metadata": { "einmalAnsehen": true } }))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{nachricht}");
    let id = nachricht["id"].as_str().unwrap().to_string();
    let anhang = &nachricht["attachments"][0];
    assert_eq!(anhang["url"], "", "keine Adresse");
    assert!(anhang["previewDataUrl"].is_null(), "keine Vorschau");

    // Über die Medienroute gibt es sie für niemanden.
    for wer in [&anna, &bodo] {
        let (status, _) = p
            .roh(
                "GET",
                &format!("/media/{bild}"),
                &wer.token,
                vec![],
                Body::empty(),
            )
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
    // Absender: nicht noch einmal.
    let (status, _) = p
        .roh(
            "GET",
            &format!("/messages/{id}/einmal/{bild}"),
            &anna.token,
            vec![],
            Body::empty(),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Bodo: einmal, dann 410. Gleichzeitig: genau einer gewinnt.
    let pfad = format!("/messages/{id}/einmal/{bild}");
    let (a, b) = tokio::join!(
        p.roh("GET", &pfad, &bodo.token, vec![], Body::empty()),
        p.roh("GET", &pfad, &bodo.token, vec![], Body::empty())
    );
    let mut stati = [a.0, b.0];
    stati.sort();
    assert_eq!(stati, [StatusCode::OK, StatusCode::GONE]);
    let bytes = if a.0 == StatusCode::OK { a.1 } else { b.1 };
    assert_eq!(bytes, png());
    let (status, _) = p
        .roh(
            "GET",
            &format!("/messages/{id}/einmal/{bild}"),
            &bodo.token,
            vec![],
            Body::empty(),
        )
        .await;
    assert_eq!(status, StatusCode::GONE);
    // Cleo hat ihren eigenen Zähler.
    let (status, _) = p
        .roh(
            "GET",
            &format!("/messages/{id}/einmal/{bild}"),
            &cleo.token,
            vec![],
            Body::empty(),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    // Der Absender sieht „geöffnet“, Bodo „von mir geöffnet“.
    let (_, fuer_anna) = p
        .call("GET", &format!("/messages/{id}"), &anna.token, None)
        .await;
    assert_eq!(fuer_anna["metadata"]["einmalStatus"]["geoeffnet"], 2);
    let (_, fuer_bodo) = p
        .call("GET", &format!("/messages/{id}"), &bodo.token, None)
        .await;
    assert_eq!(fuer_bodo["metadata"]["einmalStatus"]["ichGeoeffnet"], true);

    // Kein Weiterleiten, kein Stern.
    let (status, _) = p
        .call(
            "POST",
            &format!("/messages/{id}/weiterleiten"),
            &bodo.token,
            Some(json!({ "conversationIds": [gruppe] })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = p
        .call(
            "PUT",
            &format!("/messages/{id}/stern"),
            &bodo.token,
            Some(json!({})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

/* ---------- 8. Link-Vorschau mit SSRF-Schutz ------------------------------- */

/// Ein winziger HTTP-Server für die Vorschau-Tests: je Pfad eine feste Antwort.
async fn testserver() -> u16 {
    let lauscher = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = lauscher.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((mut leitung, _)) = lauscher.accept().await else {
                break;
            };
            tokio::spawn(async move {
                let mut puffer = vec![0u8; 4096];
                let gelesen = leitung.read(&mut puffer).await.unwrap_or(0);
                let anfrage = String::from_utf8_lossy(&puffer[..gelesen]).to_string();
                let pfad = anfrage.split_whitespace().nth(1).unwrap_or("/").to_string();
                let antwort: Vec<u8> = match pfad.as_str() {
                    "/seite" => {
                        let html = format!(
                            "<html><head><title>Alt</title><meta property=\"og:title\" content=\"Probe &amp; Seite\">\
                             <meta property=\"og:description\" content=\"Beschreibung\">\
                             <meta property=\"og:image\" content=\"/bild.png\"></head><body>x</body></html>"
                        );
                        format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}", html.len()).into_bytes()
                    }
                    "/bild.png" => {
                        let mut a = format!("HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", png().len()).into_bytes();
                        a.extend(png());
                        a
                    }
                    "/umleitung-lokal" => format!("HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:{port}/seite\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes(),
                    "/umleitung-name" => format!("HTTP/1.1 302 Found\r\nLocation: http://localhost:{port}/seite\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes(),
                    "/umleitung-metadaten" => b"HTTP/1.1 301 Moved\r\nLocation: http://169.254.169.254/latest/meta-data/\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
                    "/umleitung-gut" => format!("HTTP/1.1 302 Found\r\nLocation: http://vorschau.test:{port}/seite\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").into_bytes(),
                    "/langsam" => {
                        tokio::time::sleep(Duration::from_secs(12)).await;
                        b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 0\r\n\r\n".to_vec()
                    }
                    "/gross" => {
                        let mut html = String::from("<html><head>");
                        html.push_str(&"<!-- Füllung -->".repeat(40_000));
                        html.push_str("<meta property=\"og:title\" content=\"zu spät\"></head></html>");
                        format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}", html.len()).into_bytes()
                    }
                    "/kein-html" => b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}".to_vec(),
                    _ => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
                };
                let _ = leitung.write_all(&antwort).await;
                let _ = leitung.shutdown().await;
            });
        }
    });
    port
}

#[tokio::test(flavor = "multi_thread")]
async fn link_vorschau_nur_auf_wunsch_und_nie_ins_interne_netz() {
    let Some(p) = aufbauen("linkvorschau").await else {
        return;
    };
    let port = testserver().await;
    initiative_api::services::messages::linkvorschau::testname_eintragen(
        "vorschau.test",
        IpAddr::V4(Ipv4Addr::LOCALHOST),
    );
    let n = kurz();
    let anna = p.konto(&format!("va{n}")).await;
    let bodo = p.konto(&format!("vb{n}")).await;
    let chat = p.chat(&anna, "direct", &[&bodo]).await;
    let seite = format!("http://vorschau.test:{port}/seite");

    // Standard aus.
    let (status, _) = p
        .call(
            "POST",
            "/link-vorschau",
            &anna.token,
            Some(json!({ "url": seite })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = p
        .call(
            "PATCH",
            "/users/me",
            &anna.token,
            Some(json!({ "settings": { "linkVorschauen": true } })),
        )
        .await;
    assert!(status.is_success());

    let (status, vorschau) = p
        .call(
            "POST",
            "/link-vorschau",
            &anna.token,
            Some(json!({ "url": seite })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{vorschau}");
    assert_eq!(vorschau["titel"], "Probe & Seite");
    assert_eq!(vorschau["beschreibung"], "Beschreibung");
    let bild_id = vorschau["bildId"]
        .as_str()
        .expect("Bild abgelegt")
        .to_string();

    // Über eine gute Umleitung geht es auch.
    let (status, _) = p
        .call(
            "POST",
            "/link-vorschau",
            &anna.token,
            Some(json!({ "url": format!("http://vorschau.test:{port}/umleitung-gut") })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    // Ins interne Netz nicht – direkt, über einen Namen, über Umleitungen.
    for (url, was) in [
        (format!("http://127.0.0.1:{port}/seite"), "IP direkt"),
        (format!("http://localhost:{port}/seite"), "localhost"),
        (
            format!("http://vorschau.test:{port}/umleitung-lokal"),
            "Umleitung auf 127.0.0.1",
        ),
        (
            format!("http://vorschau.test:{port}/umleitung-name"),
            "Umleitung auf localhost",
        ),
        (
            format!("http://vorschau.test:{port}/umleitung-metadaten"),
            "Umleitung auf 169.254.169.254",
        ),
        (
            "http://169.254.169.254/latest/meta-data/".to_string(),
            "Metadaten-Dienst",
        ),
        ("file:///etc/passwd".to_string(), "Datei"),
    ] {
        let (status, antwort) = p
            .call(
                "POST",
                "/link-vorschau",
                &anna.token,
                Some(json!({ "url": url })),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{was}: {antwort}");
    }

    // Zeitlimit: nach gut fünf Sekunden ist Schluss.
    let start = Instant::now();
    let (status, _) = p
        .call(
            "POST",
            "/link-vorschau",
            &anna.token,
            Some(json!({ "url": format!("http://vorschau.test:{port}/langsam") })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert!(
        start.elapsed() < Duration::from_secs(8),
        "{:?}",
        start.elapsed()
    );
    // Grössenlimit: was nach 512 KB kommt, wird nicht mehr gelesen.
    let (status, _) = p
        .call(
            "POST",
            "/link-vorschau",
            &anna.token,
            Some(json!({ "url": format!("http://vorschau.test:{port}/gross") })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::BAD_GATEWAY,
        "kein Titel in den ersten 512 KB"
    );
    let (status, _) = p
        .call(
            "POST",
            "/link-vorschau",
            &anna.token,
            Some(json!({ "url": format!("http://vorschau.test:{port}/kein-html") })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);

    // Senden: die Vorschau gehört zum Link im Text; das Bild wird Teil der
    // Nachricht, aber nicht als Foto, sondern als `bildUrl`.
    let (status, _) = p
        .senden_mit(&anna, &chat, json!({ "body": "ohne Link", "metadata": { "linkVorschau": { "url": seite, "titel": "x" } } }))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = p
        .senden_mit(&bodo, &chat, json!({ "body": seite, "metadata": { "linkVorschau": { "url": seite, "bildId": bild_id } } }))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "fremdes Bild");
    let (status, nachricht) = p
        .senden_mit(&anna, &chat, json!({ "body": format!("schau {seite}"), "metadata": { "linkVorschau": {
            "url": seite, "titel": vorschau["titel"], "beschreibung": vorschau["beschreibung"], "bildId": bild_id } } }))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{nachricht}");
    assert_eq!(nachricht["attachments"].as_array().unwrap().len(), 0);
    assert!(nachricht["metadata"]["linkVorschau"]["bildUrl"]
        .as_str()
        .unwrap()
        .contains(&bild_id));
    // Bodo sieht das Bild über den eigenen Speicher.
    let (status, _) = p
        .roh(
            "GET",
            &format!("/media/{bild_id}"),
            &bodo.token,
            vec![],
            Body::empty(),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
}

/* ---------- 9. Quiz -------------------------------------------------------- */

#[tokio::test(flavor = "multi_thread")]
async fn quiz_zeigt_die_aufloesung_erst_nach_der_eigenen_stimme() {
    let Some(p) = aufbauen("quiz").await else {
        return;
    };
    let n = kurz();
    let anna = p.konto(&format!("qa{n}")).await;
    let bodo = p.konto(&format!("qb{n}")).await;
    let gruppe = p.chat(&anna, "group", &[&bodo]).await;
    let (status, _) = p
        .call(
            "POST",
            "/polls",
            &anna.token,
            Some(
                json!({ "conversationId": gruppe, "question": "Hauptstadt?", "quiz": true,
                          "options": [{ "label": "Bern" }, { "label": "Zürich" }] }),
            ),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "ohne richtige Antwort"
    );
    let (status, umfrage) = p
        .call(
            "POST",
            "/polls",
            &anna.token,
            Some(json!({ "conversationId": gruppe, "question": "Hauptstadt?", "quiz": true,
                          "erklaerung": "Bern ist Bundesstadt.",
                          "options": [{ "label": "Bern", "richtig": true }, { "label": "Zürich" }] })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{umfrage}");
    assert!(
        umfrage["aufloesung"]["richtig"].is_array(),
        "die Erstellerin sieht sie"
    );
    let id = umfrage["id"].as_str().unwrap();
    let falsch = umfrage["options"][1]["id"].as_str().unwrap();
    let (_, fuer_bodo) = p
        .call("GET", &format!("/polls/{id}"), &bodo.token, None)
        .await;
    assert!(fuer_bodo.get("aufloesung").is_none(), "{fuer_bodo}");
    assert_eq!(fuer_bodo["quiz"], true);

    let (status, nach) = p
        .call(
            "POST",
            &format!("/polls/{id}/vote"),
            &bodo.token,
            Some(json!({ "votes": [{ "optionId": falsch }] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{nach}");
    assert_eq!(
        nach["aufloesung"]["richtig"][0],
        umfrage["options"][0]["id"]
    );
    assert_eq!(nach["aufloesung"]["erklaerung"], "Bern ist Bundesstadt.");
    let (status, _) = p
        .call(
            "POST",
            &format!("/polls/{id}/vote"),
            &bodo.token,
            Some(json!({ "votes": [{ "optionId": umfrage["options"][0]["id"] }] })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "die erste Antwort zählt");
}

/* ---------- 10./11. Kontakt und Standort ----------------------------------- */

#[tokio::test(flavor = "multi_thread")]
async fn kontaktkarte_nur_fuer_kontakte_ohne_sperre() {
    let Some(p) = aufbauen("kontakt").await else {
        return;
    };
    let n = kurz();
    let anna = p.konto(&format!("ka{n}")).await;
    let bodo = p.konto(&format!("kb{n}")).await;
    let cleo = p.konto(&format!("kc{n}")).await;
    let fremd = p.konto(&format!("kf{n}")).await;
    let chat = p.chat(&anna, "direct", &[&bodo]).await;
    p.chat(&anna, "direct", &[&cleo]).await;

    let (status, _) = p
        .senden_mit(
            &anna,
            &chat,
            json!({ "type": "contact", "metadata": { "kontakt": { "userId": fremd.id } } }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "kein Kontakt");
    let (status, _) = p
        .senden_mit(&anna, &chat, json!({ "type": "contact", "body": "x" }))
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "Karte ohne Kontakt");
    let (status, karte) = p
        .senden_mit(
            &anna,
            &chat,
            json!({ "type": "contact", "metadata": { "kontakt": { "userId": cleo.id } } }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{karte}");
    let (_, fuer_bodo) = p
        .call(
            "GET",
            &format!("/messages/{}", karte["id"].as_str().unwrap()),
            &bodo.token,
            None,
        )
        .await;
    assert_eq!(
        fuer_bodo["metadata"]["kontaktProfil"]["displayName"],
        format!("kc{n}")
    );

    // Cleo sperrt Anna: keine Karte mehr von ihr.
    let (status, _) = p
        .call(
            "PUT",
            &format!("/users/{}/block", anna.id),
            &cleo.token,
            Some(json!({})),
        )
        .await;
    assert!(status.is_success());
    let (status, _) = p
        .senden_mit(
            &anna,
            &chat,
            json!({ "type": "contact", "metadata": { "kontakt": { "userId": cleo.id } } }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "gesperrt");
}

#[tokio::test(flavor = "multi_thread")]
async fn standort_einmalig_und_live_mit_ende() {
    let Some(p) = aufbauen("standort").await else {
        return;
    };
    let n = kurz();
    let anna = p.konto(&format!("pa{n}")).await;
    let bodo = p.konto(&format!("pb{n}")).await;
    let chat = p.chat(&anna, "direct", &[&bodo]).await;
    let (status, _) = p
        .senden_mit(
            &anna,
            &chat,
            json!({ "type": "location", "metadata": { "standort": { "lat": 99, "lon": 0 } } }),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, einmal) = p
        .senden_mit(&anna, &chat, json!({ "type": "location", "metadata": { "standort": { "lat": 47.37, "lon": 8.54, "genauigkeit": 15, "adresse": "Zürich" } } }))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{einmal}");
    assert!(einmal["metadata"]["standort"].get("live").is_none());

    let (status, live) = p
        .senden_mit(&anna, &chat, json!({ "type": "location", "metadata": { "standort": { "lat": 47.0, "lon": 8.0, "live": { "minuten": 15 } } } }))
        .await;
    assert_eq!(status, StatusCode::CREATED, "{live}");
    assert!(live["metadata"]["standort"]["live"]["bis"].is_string());
    let id = live["id"].as_str().unwrap();
    let (status, _) = p
        .call(
            "PUT",
            &format!("/messages/{id}/standort"),
            &bodo.token,
            Some(json!({ "lat": 1, "lon": 1 })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "nur der eigene");
    let (status, neu) = p
        .call(
            "PUT",
            &format!("/messages/{id}/standort"),
            &anna.token,
            Some(json!({ "lat": 47.1, "lon": 8.1, "genauigkeit": 5 })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{neu}");
    assert_eq!(neu["metadata"]["standort"]["lat"], 47.1);
    let (status, _) = p
        .call(
            "POST",
            &format!("/messages/{id}/standort/beenden"),
            &anna.token,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = p
        .call(
            "PUT",
            &format!("/messages/{id}/standort"),
            &anna.token,
            Some(json!({ "lat": 47.2, "lon": 8.2 })),
        )
        .await;
    assert_eq!(status, StatusCode::GONE, "beendet ist beendet");
}
