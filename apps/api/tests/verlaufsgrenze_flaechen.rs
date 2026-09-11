//! Die Verlaufsgrenze auf den Flächen neben der Nachrichtenliste.
//!
//! Die Liste war der offensichtliche Weg in den Altverlauf und früh
//! abgesichert. Daneben liegen vier weitere, die es nicht waren:
//!
//!   * **Echtzeit.** Der Empfängerkreis war die blosse Mitgliederliste, und die
//!     Fassung war die des Absenders – ein Zitat auf etwas Altes fuhr mit.
//!   * **Lesezeichen.** `read.updated` und `lastReadMessageId` tragen eine
//!     Nachrichtenkennung. Aus einer v7-Kennung fällt die Millisekunde heraus,
//!     in der sie geschrieben wurde.
//!   * **Anhängsel.** Umfragen und Partien hingen an der Mitgliedschaft, nicht
//!     an der Karte, über die man sie erreicht.
//!   * **Anhänge.** Zwei Handabschriften der Zugriffsprüfung ohne die Grenze.
//!
//! Jeder Test hier wäre vor der Änderung durchgefallen; die bestehende Reihe
//! nicht, weil dort alle Beteiligten von Anfang an dabei sind.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;
use tower::ServiceExt;
use uuid::Uuid;

use initiative_api::config::Config;
use initiative_api::state::AppState;
use initiative_api::{app, MIGRATOR};

struct Probe {
    router: Router,
    state: AppState,
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
        (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
    }

    async fn hochladen(&self, token: &str) -> String {
        // Kleinstes gültiges PNG: ein durchsichtiger Punkt.
        let png = {
            use base64::engine::general_purpose::STANDARD;
            use base64::Engine;
            STANDARD
                .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")
                .expect("base64")
        };
        let (status, upload) = self
            .call(
                "POST",
                "/api/v1/media/uploads",
                Some(token),
                Some(json!({
                    "kind": "image",
                    "mime": "image/png",
                    "size": png.len(),
                    "fileName": "punkt.png"
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{upload}");
        let id = upload["attachmentId"].as_str().unwrap().to_string();

        let grenze = "----initiativegrenze";
        let mut body = Vec::new();
        body.extend_from_slice(format!("--{grenze}\r\n").as_bytes());
        body.extend_from_slice(
            b"Content-Disposition: form-data; name=\"file\"; filename=\"punkt.png\"\r\n",
        );
        body.extend_from_slice(b"Content-Type: image/png\r\n\r\n");
        body.extend_from_slice(&png);
        body.extend_from_slice(format!("\r\n--{grenze}--\r\n").as_bytes());

        let request = Request::builder()
            .method("POST")
            .uri(format!("/api/v1/media/uploads/{id}/data"))
            .header("authorization", format!("Bearer {token}"))
            .header(
                "content-type",
                format!("multipart/form-data; boundary={grenze}"),
            )
            .body(Body::from(body))
            .unwrap();
        let antwort = self.router.clone().oneshot(request).await.unwrap();
        assert_eq!(antwort.status(), StatusCode::OK);

        let (status, fertig) = self
            .call(
                "POST",
                &format!("/api/v1/media/uploads/{id}/complete"),
                Some(token),
                Some(json!({ "width": 1, "height": 1 })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{fertig}");
        id
    }

    async fn konto(&self, name: &str) -> (String, String) {
        let (status, body) = self
            .call(
                "POST",
                "/api/v1/auth/register",
                None,
                Some(json!({
                    "username": name,
                    "displayName": name,
                    "password": "richtigespasswort",
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{body}");
        (
            body["accessToken"].as_str().unwrap().to_string(),
            body["user"]["id"].as_str().unwrap().to_string(),
        )
    }

    async fn senden(&self, token: &str, chat: &str, body: Value) -> Value {
        let (status, nachricht) = self
            .call(
                "POST",
                &format!("/api/v1/conversations/{chat}/messages"),
                Some(token),
                Some(body),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{nachricht}");
        nachricht
    }

    async fn dazu(&self, token: &str, chat: &str, wer: &str) {
        let (status, body) = self
            .call(
                "POST",
                &format!("/api/v1/conversations/{chat}/members"),
                Some(token),
                Some(json!({ "memberIds": [wer] })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    /// Eine Leitung anmelden und alles abholen, was seither aufgelaufen ist.
    fn horchen(&self, wer: &str) -> UnboundedReceiver<String> {
        let (_id, empfang, _) = self.state.hub.register(Uuid::parse_str(wer).unwrap());
        empfang
    }
}

/// Alles einsammeln, was bis jetzt angekommen ist.
fn eingang(empfang: &mut UnboundedReceiver<String>) -> Vec<Value> {
    let mut alles = Vec::new();
    while let Ok(rahmen) = empfang.try_recv() {
        if let Ok(wert) = serde_json::from_str::<Value>(&rahmen) {
            alles.push(wert);
        }
    }
    alles
}

fn vom_typ<'a>(rahmen: &'a [Value], typ: &str) -> Vec<&'a Value> {
    rahmen
        .iter()
        .filter(|r| r["type"] == typ)
        .collect::<Vec<_>>()
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
        format!("./.data/flaechen-{}", Uuid::now_v7().simple()),
    );
    std::env::set_var("PUBLIC_API_URL", "http://localhost:8080");
    std::env::set_var("PUBLIC_APP_URL", "http://localhost:5173");

    let state = AppState::new(Config::from_env().expect("config"))
        .await
        .expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    Some(Probe {
        router: app::build(state.clone()),
        state,
    })
}

fn kurz() -> String {
    let voll = Uuid::now_v7().simple().to_string();
    voll[voll.len() - 10..].to_string()
}

/// Anna und Bodo reden, dann kommt Cleo dazu. Gibt (Probe, Tokens, Kennungen).
struct Lage {
    probe: Probe,
    anna: String,
    bodo: String,
    cleo: String,
    anna_id: String,
    cleo_id: String,
    chat: String,
    alt: Value,
}

async fn lage(vorwort: Value) -> Option<Lage> {
    let probe = aufbauen().await?;
    let n = kurz();
    let (anna, anna_id) = probe.konto(&format!("anna{n}")).await;
    let (bodo, bodo_id) = probe.konto(&format!("bodo{n}")).await;
    let (cleo, cleo_id) = probe.konto(&format!("cleo{n}")).await;

    let (status, chat) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&anna),
            Some(json!({ "type": "group", "title": "Altbestand", "memberIds": [bodo_id] })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{chat}");
    let chat_id = chat["id"].as_str().unwrap().to_string();

    let alt = probe.senden(&anna, &chat_id, vorwort).await;
    probe.dazu(&anna, &chat_id, &cleo_id).await;

    Some(Lage {
        probe,
        anna,
        bodo,
        cleo,
        anna_id,
        cleo_id,
        chat: chat_id,
        alt,
    })
}

/// Das Zitat fährt im Echtzeit-Ereignis nicht mit.
///
/// `hydrate_messages` füllt `replyTo` für DEN ÜBERGEBENEN Betrachter. Beim
/// Senden ist das der Absender – wurde sein `MessageDto` unverändert an alle
/// weitergereicht, trug es das Zitat zu Leuten, die es nie sehen dürfen.
#[tokio::test(flavor = "multi_thread")]
async fn das_zitat_auf_etwas_altes_erreicht_den_neuzugang_nicht() {
    let Some(l) = lage(json!({ "type": "text", "body": "Geheimes von damals" })).await else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – übersprungen");
        return;
    };
    let alt_id = l.alt["id"].as_str().unwrap().to_string();

    let mut bei_cleo = l.probe.horchen(&l.cleo_id);
    let mut bei_anna = l.probe.horchen(&l.anna_id);

    // Bodo antwortet auf die alte Nachricht.
    l.probe
        .senden(
            &l.bodo,
            &l.chat,
            json!({ "type": "text", "body": "Sehe ich auch so", "replyToId": alt_id }),
        )
        .await;

    let bei_anna = eingang(&mut bei_anna);
    let neu_bei_anna = vom_typ(&bei_anna, "message.new");
    assert_eq!(neu_bei_anna.len(), 1, "Anna bekommt die Antwort: {bei_anna:?}");
    assert_eq!(
        neu_bei_anna[0]["payload"]["message"]["replyTo"]["body"], "Geheimes von damals",
        "Anna war dabei und sieht das Zitat"
    );

    let bei_cleo = eingang(&mut bei_cleo);
    let neu_bei_cleo = vom_typ(&bei_cleo, "message.new");
    assert_eq!(
        neu_bei_cleo.len(),
        1,
        "die Antwort selbst bekommt Cleo sehr wohl: {bei_cleo:?}"
    );
    assert!(
        neu_bei_cleo[0]["payload"]["message"]["replyTo"].is_null(),
        "aber das Zitat darauf nicht: {}",
        neu_bei_cleo[0]
    );
}

/// Eine alte Nachricht bearbeiten meldet sich nicht beim Neuzugang.
#[tokio::test(flavor = "multi_thread")]
async fn das_bearbeiten_einer_alten_nachricht_bleibt_unter_den_alten() {
    let Some(l) = lage(json!({ "type": "text", "body": "Geheimes von damals" })).await else {
        return;
    };
    let alt_id = l.alt["id"].as_str().unwrap().to_string();

    let mut bei_cleo = l.probe.horchen(&l.cleo_id);
    let mut bei_anna = l.probe.horchen(&l.anna_id);

    let (status, geaendert) = l
        .probe
        .call(
            "PATCH",
            &format!("/api/v1/messages/{alt_id}"),
            Some(&l.anna),
            Some(json!({ "body": "Geheimes von damals, berichtigt" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{geaendert}");

    assert_eq!(
        vom_typ(&eingang(&mut bei_anna), "message.updated").len(),
        1,
        "Anna erfährt von ihrer eigenen Änderung"
    );
    let bei_cleo = eingang(&mut bei_cleo);
    assert!(
        vom_typ(&bei_cleo, "message.updated").is_empty(),
        "Cleo darf die Nachricht nicht kennen – auch nicht ihre Änderung: {bei_cleo:?}"
    );
}

/// Das Lesezeichen eines Altmitglieds verrät keine alte Kennung.
#[tokio::test(flavor = "multi_thread")]
async fn das_lesezeichen_der_anderen_hoert_an_meiner_grenze_auf() {
    let Some(l) = lage(json!({ "type": "text", "body": "Geheimes von damals" })).await else {
        return;
    };
    let alt_id = l.alt["id"].as_str().unwrap().to_string();

    let mut bei_cleo = l.probe.horchen(&l.cleo_id);

    // Anna meldet die alte Nachricht als gelesen.
    let (status, _) = l
        .probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{}/read", l.chat),
            Some(&l.anna),
            Some(json!({ "messageId": alt_id })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let rahmen = eingang(&mut bei_cleo);
    assert!(
        vom_typ(&rahmen, "read.updated").is_empty(),
        "Cleo bekommt die Kennung nicht zugestellt: {rahmen:?}"
    );

    // Und sie steht auch nicht in der Mitgliederliste des Chats.
    let (status, gesehen) = l
        .probe
        .call(
            "GET",
            &format!("/api/v1/conversations/{}", l.chat),
            Some(&l.cleo),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let annas_zeichen = gesehen["members"]
        .as_array()
        .expect("Mitglieder")
        .iter()
        .find(|m| m["userId"] == l.anna_id.as_str())
        .expect("Anna")["lastReadMessageId"]
        .clone();
    assert!(
        annas_zeichen.is_null(),
        "Annas Lesezeichen zeigt auf etwas, das Cleo nicht sehen darf: {annas_zeichen}"
    );

    // Umgekehrt: Cleo kann auch keine Kennung von vorher in den Rundruf setzen.
    let (status, fehler) = l
        .probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{}/read", l.chat),
            Some(&l.cleo),
            Some(json!({ "messageId": alt_id })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "eine fremde Kennung zu melden ist kein Lesen: {fehler}"
    );
}

/// Eine Umfrage von vor dem Beitritt bleibt zu – samt ihrer Stimmen.
///
/// Der Zugang hing an der blossen Mitgliedschaft in einem der beteiligten
/// Chats. Damit stand eine Umfrage von vor dem Beitritt offen, samt Stimmen
/// und – bei einer offenen Umfrage – samt Namen. Die Karte, die sie trug,
/// blieb dabei unsichtbar; die Frage selbst nicht.
#[tokio::test(flavor = "multi_thread")]
async fn eine_umfrage_von_vorher_bleibt_zu() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let (anna, _) = probe.konto(&format!("uanna{n}")).await;
    let (bodo, bodo_id) = probe.konto(&format!("ubodo{n}")).await;
    let (cleo, cleo_id) = probe.konto(&format!("ucleo{n}")).await;

    let (_, chat) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&anna),
            Some(json!({ "type": "group", "title": "Umfragerunde", "memberIds": [bodo_id] })),
        )
        .await;
    let chat_id = chat["id"].as_str().unwrap().to_string();

    let (status, umfrage) = probe
        .call(
            "POST",
            "/api/v1/polls",
            Some(&anna),
            Some(json!({
                "conversationId": chat_id,
                "kind": "choice",
                "question": "Wohin im Sommer?",
                "options": [{ "label": "Berge" }, { "label": "Meer" }]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{umfrage}");
    let umfrage_id = umfrage["id"].as_str().unwrap().to_string();
    let berge = umfrage["options"][0]["id"].as_str().unwrap().to_string();

    // Bodo stimmt ab, solange Cleo noch nicht da ist.
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/polls/{umfrage_id}/vote"),
            Some(&bodo),
            Some(json!({ "votes": [{ "optionId": berge }] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    // Jetzt erst kommt Cleo dazu.
    probe.dazu(&anna, &chat_id, &cleo_id).await;

    let (status, fehler) = probe
        .call(
            "GET",
            &format!("/api/v1/polls/{umfrage_id}"),
            Some(&cleo),
            None,
        )
        .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "die Karte ist unsichtbar, die Frage muss es auch sein: {fehler}"
    );

    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/polls/{umfrage_id}/vote"),
            Some(&cleo),
            Some(json!({ "votes": [{ "optionId": berge }] })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "abstimmen erst recht nicht");

    // Wer dabei war, kommt selbstverständlich weiterhin heran.
    let (status, weiterhin) = probe
        .call(
            "GET",
            &format!("/api/v1/polls/{umfrage_id}"),
            Some(&bodo),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{weiterhin}");
}

/// Eine Partie von vor dem Beitritt ist weder aufzurufen noch zu listen.
#[tokio::test(flavor = "multi_thread")]
async fn eine_partie_von_vorher_bleibt_zu() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let (anna, _) = probe.konto(&format!("panna{n}")).await;
    let (bodo, bodo_id) = probe.konto(&format!("pbodo{n}")).await;
    let (cleo, cleo_id) = probe.konto(&format!("pcleo{n}")).await;

    let (_, chat) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&anna),
            Some(json!({ "type": "group", "title": "Spielrunde", "memberIds": [bodo_id] })),
        )
        .await;
    let chat_id = chat["id"].as_str().unwrap().to_string();

    let (status, partie) = probe
        .call(
            "POST",
            "/api/v1/games/sessions",
            Some(&anna),
            Some(json!({
                "conversationId": chat_id,
                "gameKey": "tic-tac-toe",
                "opponentIds": [bodo_id]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{partie}");
    let partie_id = partie["id"].as_str().unwrap().to_string();

    probe.dazu(&anna, &chat_id, &cleo_id).await;

    let (status, fehler) = probe
        .call(
            "GET",
            &format!("/api/v1/games/sessions/{partie_id}"),
            Some(&cleo),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{fehler}");

    let (status, liste) = probe
        .call(
            "GET",
            &format!("/api/v1/games/sessions?conversationId={chat_id}"),
            Some(&cleo),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        liste["items"].as_array().expect("Liste").len(),
        0,
        "auch in der Liste taucht sie nicht auf: {liste}"
    );

    // Bodo, der mitspielt, kommt weiterhin heran.
    let (status, _) = probe
        .call(
            "GET",
            &format!("/api/v1/games/sessions/{partie_id}"),
            Some(&bodo),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "wer dabei war, spielt weiter");
}

/// Eine Datei aus einer Nachricht von vor dem Beitritt landet nicht in der
/// eigenen Sammlung.
///
/// Der Weg war ein Umweg mit Wirkung: Die Nachricht blieb unsichtbar, ihr
/// Anhang liess sich aber in eine eigene Sammlung holen und dort ansehen. Zwei
/// Handabschriften der Zugriffsprüfung – in `collections` und in `calendar` –
/// kannten die Grenze nicht; `services::zugriff`, das sie beantworten soll,
/// kennt sie.
#[tokio::test(flavor = "multi_thread")]
async fn eine_datei_aus_einer_alten_nachricht_bleibt_draussen() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let (anna, _) = probe.konto(&format!("danna{n}")).await;
    let (bodo, bodo_id) = probe.konto(&format!("dbodo{n}")).await;
    let (cleo, cleo_id) = probe.konto(&format!("dcleo{n}")).await;

    let (_, chat) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&anna),
            Some(json!({ "type": "group", "title": "Ablage", "memberIds": [bodo_id] })),
        )
        .await;
    let chat_id = chat["id"].as_str().unwrap().to_string();

    let anhang = probe.hochladen(&anna).await;
    probe
        .senden(
            &anna,
            &chat_id,
            json!({ "type": "image", "attachmentIds": [anhang] }),
        )
        .await;

    probe.dazu(&anna, &chat_id, &cleo_id).await;

    let (status, sammlung) = probe
        .call(
            "POST",
            "/api/v1/collections",
            Some(&cleo),
            Some(json!({ "name": "Meins" })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{sammlung}");
    let sammlung_id = sammlung["id"].as_str().unwrap().to_string();

    let (status, fehler) = probe
        .call(
            "POST",
            &format!("/api/v1/collections/{sammlung_id}/items"),
            Some(&cleo),
            Some(json!({ "attachmentId": anhang })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "die Nachricht ist zu, die Datei darin auch: {fehler}"
    );

    // Und die Datei selbst ist auch nicht auszuliefern. Dort lautet die
    // Antwort „nicht gefunden" statt „verboten" – die Auslieferung bestätigt
    // nicht, dass es die Datei gibt.
    let (status, _) = probe
        .call("GET", &format!("/api/v1/media/{anhang}"), Some(&cleo), None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Bodo, der dabei war, legt sie sehr wohl ab.
    let (status, seine) = probe
        .call(
            "POST",
            "/api/v1/collections",
            Some(&bodo),
            Some(json!({ "name": "Seins" })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let seine_id = seine["id"].as_str().unwrap().to_string();
    let (status, abgelegt) = probe
        .call(
            "POST",
            &format!("/api/v1/collections/{seine_id}/items"),
            Some(&bodo),
            Some(json!({ "attachmentId": anhang })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{abgelegt}");
}
