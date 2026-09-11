//! Wer neu dazukommt, sieht ab jetzt – und kann den Verlauf beantragen.
//!
//! Die Regel hat zwei Seiten, und beide brauchen einen Test:
//!
//!   * Der Altverlauf bleibt zu, und zwar auf JEDEM Weg. Die Liste ist nur der
//!     offensichtlichste; ebenso zählen das Blättern mit einem selbst
//!     gewählten Cursor, der Griff über die Nachrichtenkennung, die Suche, das
//!     Zitat in einer Antwort, die Vorschau in der Chatliste und der Anhang.
//!   * Stimmen alle zu, fällt die Grenze – mit einem einzigen Federstrich,
//!     unabhängig davon, wie viel dahinterliegt.

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

    async fn senden(&self, token: &str, chat: &str, text: &str) -> String {
        let (status, nachricht) = self
            .call(
                "POST",
                &format!("/api/v1/conversations/{chat}/messages"),
                Some(token),
                Some(json!({ "type": "text", "body": text })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{nachricht}");
        nachricht["id"].as_str().unwrap().to_string()
    }

    async fn verlauf(&self, token: &str, chat: &str) -> Vec<String> {
        let (status, liste) = self
            .call(
                "GET",
                &format!("/api/v1/conversations/{chat}/messages"),
                Some(token),
                None,
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{liste}");
        liste["items"]
            .as_array()
            .expect("Liste")
            .iter()
            .filter_map(|m| m["body"].as_str().map(str::to_string))
            .collect()
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
        format!("./.data/verlauf-{}", Uuid::now_v7().simple()),
    );
    std::env::set_var("PUBLIC_API_URL", "http://localhost:8080");
    std::env::set_var("PUBLIC_APP_URL", "http://localhost:5173");

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
async fn der_altverlauf_bleibt_zu_bis_alle_zustimmen() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – übersprungen");
        return;
    };
    let n = kurz();
    let (anna, anna_id) = probe.konto(&format!("anna{n}")).await;
    let (bodo, bodo_id) = probe.konto(&format!("bodo{n}")).await;
    let (cleo, cleo_id) = probe.konto(&format!("cleo{n}")).await;

    // Anna und Bodo gründen und reden.
    let (status, chat) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&anna),
            Some(json!({ "type": "group", "title": "Runde", "memberIds": [bodo_id] })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{chat}");
    let chat_id = chat["id"].as_str().unwrap().to_string();

    let alt = probe.senden(&anna, &chat_id, "Das war vorher").await;
    assert_eq!(
        probe.verlauf(&anna, &chat_id).await,
        vec!["Das war vorher"],
        "die Gruenderin sieht ihr eigenes Gespraech"
    );

    // Cleo kommt dazu.
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat_id}/members"),
            Some(&anna),
            Some(json!({ "memberIds": [cleo_id] })),
        )
        .await;
    assert!(status.is_success(), "Hinzufuegen: {status}");

    probe.senden(&anna, &chat_id, "Das ist nachher").await;

    // ---- Der Altverlauf bleibt zu, auf jedem Weg -------------------------
    assert_eq!(
        probe.verlauf(&cleo, &chat_id).await,
        vec!["Das ist nachher"],
        "die Liste zeigt nur, was nach dem Beitritt kam"
    );

    // Ein selbst gewaehlter Cursor hilft nicht.
    let (_, geblaettert) = probe
        .call(
            "GET",
            &format!("/api/v1/conversations/{chat_id}/messages?after=00000000-0000-0000-0000-000000000000"),
            Some(&cleo),
            None,
        )
        .await;
    let texte: Vec<&str> = geblaettert["items"]
        .as_array()
        .expect("Liste")
        .iter()
        .filter_map(|m| m["body"].as_str())
        .collect();
    assert!(
        !texte.contains(&"Das war vorher"),
        "auch mit eigenem Cursor nicht: {geblaettert}"
    );

    // Der Griff ueber die Kennung auch nicht.
    let (status, _) = probe
        .call("GET", &format!("/api/v1/messages/{alt}"), Some(&cleo), None)
        .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "eine bekannte Kennung oeffnet den Altverlauf nicht"
    );

    // Und die Suche auch nicht.
    let (_, treffer) = probe
        .call("GET", "/api/v1/search/messages?q=vorher", Some(&cleo), None)
        .await;
    assert!(
        treffer["items"].as_array().expect("Liste").is_empty(),
        "die Suche findet nichts von vor dem Beitritt: {treffer}"
    );

    // Ein Zitat verraet den alten Text nicht.
    let (status, antwort) = probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat_id}/messages"),
            Some(&anna),
            Some(json!({ "type": "text", "body": "Dazu", "replyToId": alt })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{antwort}");
    let (_, liste) = probe
        .call(
            "GET",
            &format!("/api/v1/conversations/{chat_id}/messages"),
            Some(&cleo),
            None,
        )
        .await;
    let zitat = liste["items"]
        .as_array()
        .expect("Liste")
        .iter()
        .find(|m| m["body"] == "Dazu")
        .expect("die Antwort sieht sie");
    assert!(
        zitat["replyTo"].is_null() || zitat["replyTo"]["body"].is_null(),
        "das Zitat darf den alten Text nicht mitliefern: {zitat}"
    );

    // Anna und Bodo sehen selbstverstaendlich weiter alles – sonst pruefte
    // dieser Test nur, dass gar nichts geht.
    assert!(
        probe
            .verlauf(&anna, &chat_id)
            .await
            .contains(&"Das war vorher".to_string()),
        "die Gruenderin behaelt ihren Verlauf"
    );

    // ---- Der Antrag ------------------------------------------------------
    let (status, antrag) = probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat_id}/verlauf"),
            Some(&cleo),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{antrag}");
    let antrag_id = antrag["id"].as_str().unwrap().to_string();
    assert_eq!(antrag["offenBei"].as_array().unwrap().len(), 2, "{antrag}");

    // Eine Zustimmung genuegt nicht.
    let (status, nach_anna) = probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat_id}/verlauf/{antrag_id}"),
            Some(&anna),
            Some(json!({ "zustimmung": true })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{nach_anna}");
    assert_eq!(nach_anna["status"], "offen", "einer fehlt noch");
    assert_eq!(
        probe.verlauf(&cleo, &chat_id).await.len(),
        2,
        "solange bleibt der Altverlauf zu"
    );

    // Mit der zweiten faellt die Grenze.
    let (status, nach_bodo) = probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat_id}/verlauf/{antrag_id}"),
            Some(&bodo),
            Some(json!({ "zustimmung": true })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{nach_bodo}");
    assert_eq!(nach_bodo["status"], "angenommen");
    assert!(
        probe
            .verlauf(&cleo, &chat_id)
            .await
            .contains(&"Das war vorher".to_string()),
        "jetzt sieht sie den ganzen Verlauf"
    );
    let (status, _) = probe
        .call("GET", &format!("/api/v1/messages/{alt}"), Some(&cleo), None)
        .await;
    assert_eq!(status, StatusCode::OK, "und auch ueber die Kennung");

    let _ = anna_id;
}

#[tokio::test(flavor = "multi_thread")]
async fn ein_einziges_nein_entscheidet() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let (anna, _) = probe.konto(&format!("anna{n}")).await;
    let (bodo, bodo_id) = probe.konto(&format!("bodo{n}")).await;
    let (cleo, cleo_id) = probe.konto(&format!("cleo{n}")).await;

    let (_, chat) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&anna),
            Some(json!({ "type": "group", "title": "Runde", "memberIds": [bodo_id] })),
        )
        .await;
    let chat_id = chat["id"].as_str().unwrap().to_string();
    probe.senden(&anna, &chat_id, "Geheim").await;
    probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat_id}/members"),
            Some(&anna),
            Some(json!({ "memberIds": [cleo_id] })),
        )
        .await;

    let (_, antrag) = probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat_id}/verlauf"),
            Some(&cleo),
            None,
        )
        .await;
    let antrag_id = antrag["id"].as_str().unwrap().to_string();

    // Anna ist dafuer, Bodo dagegen – ein Nein wiegt schwerer.
    probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat_id}/verlauf/{antrag_id}"),
            Some(&anna),
            Some(json!({ "zustimmung": true })),
        )
        .await;
    let (status, entschieden) = probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat_id}/verlauf/{antrag_id}"),
            Some(&bodo),
            Some(json!({ "zustimmung": false })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{entschieden}");
    assert_eq!(entschieden["status"], "abgelehnt");
    assert!(
        !probe
            .verlauf(&cleo, &chat_id)
            .await
            .contains(&"Geheim".to_string()),
        "abgelehnt heisst abgelehnt"
    );

    // Und ueber einen entschiedenen Antrag wird nicht weiter abgestimmt.
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat_id}/verlauf/{antrag_id}"),
            Some(&anna),
            Some(json!({ "zustimmung": true })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
}

/// Nach einer Ablehnung ist erst einmal Ruhe – und die App weiss, woran sie ist.
///
/// Beides hängt zusammen: Solange es den Knopf nur in der Schnittstelle gab,
/// war Nachfassen Handarbeit. Mit einem Knopf in der App ist es ein
/// Fingertipp, und jeder neue Antrag legt allen anderen wieder ein Band über
/// den Chat. Deshalb hält ein Nein einen Tag lang.
#[tokio::test(flavor = "multi_thread")]
async fn nach_einer_ablehnung_haelt_das_nein() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let (anna, _) = probe.konto(&format!("anna{n}")).await;
    let (bodo, bodo_id) = probe.konto(&format!("bodo{n}")).await;
    let (cleo, cleo_id) = probe.konto(&format!("cleo{n}")).await;

    let (_, chat) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&anna),
            Some(json!({ "type": "group", "title": "Runde", "memberIds": [bodo_id] })),
        )
        .await;
    let chat_id = chat["id"].as_str().unwrap().to_string();
    probe.senden(&anna, &chat_id, "Geheim").await;
    probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat_id}/members"),
            Some(&anna),
            Some(json!({ "memberIds": [cleo_id] })),
        )
        .await;

    let (_, antrag) = probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat_id}/verlauf"),
            Some(&cleo),
            None,
        )
        .await;
    let antrag_id = antrag["id"].as_str().unwrap().to_string();
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat_id}/verlauf/{antrag_id}"),
            Some(&bodo),
            Some(json!({ "zustimmung": false })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    // Sofort wieder fragen geht nicht.
    let (status, fehler) = probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat_id}/verlauf"),
            Some(&cleo),
            None,
        )
        .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "ein Nein muss halten: {fehler}"
    );

    // Und die anderen bekommen dadurch auch kein neues Band zu sehen.
    let (status, offene) = probe
        .call(
            "GET",
            &format!("/api/v1/conversations/{chat_id}/verlauf"),
            Some(&bodo),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        offene["items"].as_array().expect("Liste").len(),
        0,
        "nach der Ablehnung steht kein Antrag mehr offen: {offene}"
    );
}

/// Die App muss wissen, dass es einen verdeckten Verlauf gibt.
///
/// Ohne diese Auskunft könnte sie den Knopf „Älteren Verlauf beantragen" nur
/// raten – aus `joinedAt` folgt sie nicht: Nach einer Freigabe bleibt der
/// Beitritt spät stehen und die Grenze fällt trotzdem.
#[tokio::test(flavor = "multi_thread")]
async fn der_chat_verraet_die_eigene_grenze() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let n = kurz();
    let (anna, anna_id) = probe.konto(&format!("anna{n}")).await;
    let (bodo, bodo_id) = probe.konto(&format!("bodo{n}")).await;
    let (cleo, cleo_id) = probe.konto(&format!("cleo{n}")).await;

    let (_, chat) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&anna),
            Some(json!({ "type": "group", "title": "Runde", "memberIds": [bodo_id] })),
        )
        .await;
    let chat_id = chat["id"].as_str().unwrap().to_string();
    probe.senden(&anna, &chat_id, "Geheim").await;
    probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat_id}/members"),
            Some(&anna),
            Some(json!({ "memberIds": [cleo_id] })),
        )
        .await;

    let grenze = |chat: &Value, wer: &str| -> Option<String> {
        chat["members"]
            .as_array()
            .expect("Mitglieder")
            .iter()
            .find(|m| m["userId"] == wer)
            .expect("Mitglied")["siehtAb"]
            .as_str()
            .map(str::to_string)
    };

    let (status, gesehen) = probe
        .call("GET", &format!("/api/v1/conversations/{chat_id}"), Some(&cleo), None)
        .await;
    assert_eq!(status, StatusCode::OK, "{gesehen}");
    assert!(
        grenze(&gesehen, &cleo_id).is_some(),
        "Cleo kam später dazu – ihre Grenze muss dastehen: {gesehen}"
    );
    assert_eq!(
        gesehen["verdeckterVerlauf"], true,
        "vor Cleos Beitritt liegt etwas: {gesehen}"
    );

    /*
     * Anna hat ebenfalls eine Grenze – die bekommt jeder, auch der Gründer.
     * Entscheidend ist, dass NICHTS dahinterliegt: Wer am gesetzten Feld statt
     * am Inhalt entscheidet, bietet Anna an, einen Verlauf zu beantragen, den
     * es nicht gibt.
     */
    let (_, annas_sicht) = probe
        .call("GET", &format!("/api/v1/conversations/{chat_id}"), Some(&anna), None)
        .await;
    assert!(
        grenze(&annas_sicht, &anna_id).is_some(),
        "auch der Gründer bekommt eine Grenze gesetzt: {annas_sicht}"
    );
    assert_eq!(
        annas_sicht["verdeckterVerlauf"], false,
        "aber dahinter liegt nichts: {annas_sicht}"
    );
    let (status, fehler) = probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat_id}/verlauf"),
            Some(&anna),
            None,
        )
        .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "und beantragen lässt sich das Nichts auch nicht: {fehler}"
    );

    // Und sie verschwindet, sobald alle zugestimmt haben.
    let (_, antrag) = probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat_id}/verlauf"),
            Some(&cleo),
            None,
        )
        .await;
    let antrag_id = antrag["id"].as_str().unwrap().to_string();
    for wer in [&anna, &bodo] {
        probe
            .call(
                "POST",
                &format!("/api/v1/conversations/{chat_id}/verlauf/{antrag_id}"),
                Some(wer),
                Some(json!({ "zustimmung": true })),
            )
            .await;
    }

    let (_, danach) = probe
        .call("GET", &format!("/api/v1/conversations/{chat_id}"), Some(&cleo), None)
        .await;
    assert!(
        grenze(&danach, &cleo_id).is_none(),
        "nach der Freigabe steht keine Grenze mehr: {danach}"
    );
    assert_eq!(
        danach["verdeckterVerlauf"], false,
        "und verdeckt ist auch nichts mehr: {danach}"
    );
}
