//! Schulden begleichen – der Schritt, der in der Oberfläche fehlte.
//!
//! Der Anwender meldete: „Bei Ausgaben sehe ich noch nicht, wo man seine
//! Schulden bezahlen kann.“ Das Blatt zeigte Bankdaten und PayPal-Link und
//! hörte dort auf. Abhaken ging nur je Ausgabe, an jeder Karte einzeln –
//! während die Übersicht eine einzige Summe nennt.
//!
//! Dieser Test prüft den neuen Weg, und zwar in beiden Richtungen: der
//! Schuldner meldet, der Auslegende bestätigt. Ohne echte Datenbank
//! überspringt er sich.

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
        let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        (status, value)
    }

    async fn anmelden(&self, suffix: &str, name: &str) -> (String, String) {
        let (status, body) = self
            .call(
                "POST",
                "/api/v1/auth/register",
                None,
                Some(json!({
                    "username": format!("{name}{suffix}"),
                    "displayName": format!("{name} {suffix}"),
                    "password": "passwort123",
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "Registrierung: {body}");
        (
            body["accessToken"].as_str().unwrap().to_string(),
            body["user"]["id"].as_str().unwrap().to_string(),
        )
    }
}

async fn aufbauen() -> Option<Probe> {
    let url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;
    std::env::set_var("DATABASE_URL", &url);
    std::env::set_var("NODE_ENV", "test");
    std::env::set_var("DATABASE_SSL", "false");
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

#[tokio::test(flavor = "multi_thread")]
async fn abrechnen_in_beide_richtungen() {
    let Some(probe) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – übersprungen");
        return;
    };

    let simple = Uuid::now_v7().simple().to_string();
    let suffix = simple[simple.len() - 8..].to_string();

    let (anna_token, anna_id) = probe.anmelden(&suffix, "anna").await;
    let (bert_token, bert_id) = probe.anmelden(&suffix, "bert").await;

    // Ein Chat, damit sie einander sehen.
    let (status, chat) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&anna_token),
            Some(json!({ "type": "direct", "memberIds": [bert_id] })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "Chat: {chat}");
    let chat_id = chat["id"].as_str().unwrap().to_string();

    // Anna legt zweimal aus, Bert zahlt je die Hälfte mit.
    for (titel, cents) in [("Kohle", 2000_i64), ("Fleisch", 3000_i64)] {
        let (status, body) = probe
            .call(
                "POST",
                "/api/v1/expenses",
                Some(&anna_token),
                Some(json!({
                    "conversationId": chat_id,
                    "title": titel,
                    "amountCents": cents,
                    "paidBy": anna_id,
                    "shares": [{ "userId": anna_id }, { "userId": bert_id }],
                })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "Ausgabe {titel}: {body}");
    }

    // Bert schuldet 1000 + 1500 = 2500.
    let (_, salden) = probe
        .call("GET", "/api/v1/expenses/balances", Some(&bert_token), None)
        .await;
    let saldo = salden["items"][0]["netCents"].as_i64().unwrap();
    assert_eq!(saldo, -2500, "Bert schuldet 25 Euro: {salden}");

    // --- Der neue Weg: EINMAL abrechnen statt an jeder Karte -------------
    let (status, ergebnis) = probe
        .call(
            "POST",
            "/api/v1/expenses/settle-up",
            Some(&bert_token),
            Some(json!({ "userId": anna_id })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "Abrechnen: {ergebnis}");
    assert_eq!(ergebnis["count"], 2, "beide Anteile auf einmal: {ergebnis}");
    assert_eq!(ergebnis["amountCents"], 2500);

    // Danach ist zwischen den beiden nichts mehr offen.
    let (_, salden) = probe
        .call("GET", "/api/v1/expenses/balances", Some(&bert_token), None)
        .await;
    let offen = salden["items"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|eintrag| eintrag["netCents"].as_i64() != Some(0))
        .count();
    assert_eq!(offen, 0, "alles ausgeglichen: {salden}");

    // Und es steht dabei, WER abgehakt hat – Bert hat gemeldet, nicht Anna
    // bestätigt. Genau daran entzündet sich sonst der Streit.
    let (_, liste) = probe
        .call(
            "GET",
            "/api/v1/expenses?includeSettled=true",
            Some(&anna_token),
            None,
        )
        .await;
    let anteil = liste["items"][0]["shares"]
        .as_array()
        .unwrap()
        .iter()
        .find(|share| share["userId"] == json!(bert_id))
        .expect("Berts Anteil");
    assert_eq!(
        anteil["settledBy"],
        json!(bert_id),
        "von Bert gemeldet: {anteil}"
    );
    assert!(anteil["settledAt"].is_string());

    // --- Gegenprobe: Anna kann es zurücknehmen --------------------------
    let (status, ergebnis) = probe
        .call(
            "POST",
            "/api/v1/expenses/settle-up",
            Some(&anna_token),
            Some(json!({ "userId": bert_id, "settled": false })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "zurücknehmen: {ergebnis}");
    assert_eq!(ergebnis["count"], 2);

    let (_, salden) = probe
        .call("GET", "/api/v1/expenses/balances", Some(&bert_token), None)
        .await;
    assert_eq!(
        salden["items"][0]["netCents"].as_i64(),
        Some(-2500),
        "wieder offen: {salden}"
    );

    // --- Und die Bestätigung durch den Auslegenden ----------------------
    let (status, ergebnis) = probe
        .call(
            "POST",
            "/api/v1/expenses/settle-up",
            Some(&anna_token),
            Some(json!({ "userId": bert_id })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "Anna bestätigt: {ergebnis}");

    let (_, liste) = probe
        .call(
            "GET",
            "/api/v1/expenses?includeSettled=true",
            Some(&anna_token),
            None,
        )
        .await;
    let anteil = liste["items"][0]["shares"]
        .as_array()
        .unwrap()
        .iter()
        .find(|share| share["userId"] == json!(bert_id))
        .expect("Berts Anteil");
    assert_eq!(
        anteil["settledBy"],
        json!(anna_id),
        "diesmal hat Anna bestätigt: {anteil}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn mit_sich_selbst_rechnet_man_nicht_ab() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let simple = Uuid::now_v7().simple().to_string();
    let suffix = simple[simple.len() - 8..].to_string();
    let (token, id) = probe.anmelden(&suffix, "solo").await;

    let (status, body) = probe
        .call(
            "POST",
            "/api/v1/expenses/settle-up",
            Some(&token),
            Some(json!({ "userId": id })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
}

/// Vier Zustände, und der wichtigste ist der letzte.
///
/// Der Anwender beschreibt den Ablauf so: Einer meldet „bezahlt“, der andere
/// bestätigt den Eingang, und **erst beides zusammen** heißt abgeschlossen.
/// Genau das ging vorher nicht: Die zweite Markierung überschrieb die erste,
/// und der Vorgang sah aus, als hätte nur einer sich geäußert.
#[tokio::test(flavor = "multi_thread")]
async fn gemeldet_bestaetigt_abgeschlossen() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let simple = Uuid::now_v7().simple().to_string();
    let suffix = simple[simple.len() - 8..].to_string();

    let (lea_token, lea_id) = probe.anmelden(&suffix, "lea").await;
    let (max_token, max_id) = probe.anmelden(&suffix, "max").await;

    let (_, chat) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&lea_token),
            Some(json!({ "type": "direct", "memberIds": [max_id] })),
        )
        .await;
    let chat_id = chat["id"].as_str().unwrap().to_string();

    let (_, ausgabe) = probe
        .call(
            "POST",
            "/api/v1/expenses",
            Some(&lea_token),
            Some(json!({
                "conversationId": chat_id,
                "title": "Bahnfahrt",
                "amountCents": 4000,
                "paidBy": lea_id,
                "shares": [{ "userId": lea_id }, { "userId": max_id }],
            })),
        )
        .await;
    let id = ausgabe["id"].as_str().unwrap().to_string();
    assert_eq!(ausgabe["status"], "open", "frisch: offen");

    /// Den Zustand einer Ausgabe abfragen.
    async fn zustand(probe: &Probe, token: &str, id: &str) -> String {
        let (_, body) = probe
            .call("GET", &format!("/api/v1/expenses/{id}"), Some(token), None)
            .await;
        body["status"].as_str().unwrap_or("?").to_string()
    }

    // 1. Max meldet: „habe überwiesen“.
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/expenses/{id}/settle"),
            Some(&max_token),
            Some(json!({ "settled": true })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(zustand(&probe, &max_token, &id).await, "reported");

    // 2. Lea bestätigt den Eingang. Das darf die Meldung NICHT loeschen.
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/expenses/{id}/settle"),
            Some(&lea_token),
            Some(json!({ "userId": max_id, "settled": true })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let (_, body) = probe
        .call(
            "GET",
            &format!("/api/v1/expenses/{id}"),
            Some(&lea_token),
            None,
        )
        .await;
    assert_eq!(
        body["status"], "closed",
        "beide haben sich geaeussert: {body}"
    );

    let anteil = body["shares"]
        .as_array()
        .unwrap()
        .iter()
        .find(|share| share["userId"] == json!(max_id))
        .unwrap();
    assert_eq!(anteil["settledBy"], json!(max_id), "die Meldung steht noch");
    assert_eq!(
        anteil["confirmedBy"],
        json!(lea_id),
        "und die Bestaetigung daneben"
    );
    assert_eq!(anteil["status"], "closed");

    // 3. Und die Ausgabe ist weiterhin auffindbar – sie verschwindet nicht.
    let (_, liste) = probe
        .call(
            "GET",
            "/api/v1/expenses?includeSettled=true",
            Some(&lea_token),
            None,
        )
        .await;
    assert!(
        liste["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|eintrag| eintrag["id"] == json!(id)),
        "eine bezahlte Ausgabe bleibt nachlesbar: {liste}"
    );
}

/// Die Gegenprobe zu 2.: Bestaetigt der Empfaenger als ERSTER, ist das noch
/// keine Abschlussmeldung – der Schuldner hat sich nie geaeussert.
#[tokio::test(flavor = "multi_thread")]
async fn nur_der_empfaenger_reicht_nicht_zum_abschluss() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let simple = Uuid::now_v7().simple().to_string();
    let suffix = simple[simple.len() - 8..].to_string();

    let (nia_token, nia_id) = probe.anmelden(&suffix, "nia").await;
    let (ole_token, ole_id) = probe.anmelden(&suffix, "ole").await;
    let _ = ole_token;

    let (_, chat) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&nia_token),
            Some(json!({ "type": "direct", "memberIds": [ole_id] })),
        )
        .await;

    let (_, ausgabe) = probe
        .call(
            "POST",
            "/api/v1/expenses",
            Some(&nia_token),
            Some(json!({
                "conversationId": chat["id"],
                "title": "Kino",
                "amountCents": 2400,
                "paidBy": nia_id,
                "shares": [{ "userId": nia_id }, { "userId": ole_id }],
            })),
        )
        .await;
    let id = ausgabe["id"].as_str().unwrap().to_string();

    probe
        .call(
            "POST",
            &format!("/api/v1/expenses/{id}/settle"),
            Some(&nia_token),
            Some(json!({ "userId": ole_id, "settled": true })),
        )
        .await;

    let (_, body) = probe
        .call(
            "GET",
            &format!("/api/v1/expenses/{id}"),
            Some(&nia_token),
            None,
        )
        .await;
    assert_eq!(
        body["status"], "confirmed",
        "eine Seite allein schliesst nicht ab: {body}"
    );
}

/// Einer legt für mehrere aus – und für jeden bedeutet dieselbe Ausgabe etwas
/// anderes.
///
/// Der Anwender hat die Regel klar benannt: Bei jedem Einzelnen rückt sie
/// weiter, sobald er „bezahlt“ gedrückt hat. Beim Auslegenden bleibt sie
/// offen, bis er bei ALLEN bestätigt hat. Ein gemeinsamer Zustand für alle
/// kann das nicht abbilden – deshalb hängt er am Betrachter.
#[tokio::test(flavor = "multi_thread")]
async fn einer_legt_fuer_mehrere_aus() {
    let Some(probe) = aufbauen().await else {
        return;
    };
    let simple = Uuid::now_v7().simple().to_string();
    let suffix = simple[simple.len() - 8..].to_string();

    let (pia_token, pia_id) = probe.anmelden(&suffix, "pia").await;
    let (rob_token, rob_id) = probe.anmelden(&suffix, "rob").await;
    let (tom_token, tom_id) = probe.anmelden(&suffix, "tom").await;

    let (status, chat) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&pia_token),
            Some(json!({ "type": "group", "title": "Huette", "memberIds": [rob_id, tom_id] })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{chat}");

    let (_, ausgabe) = probe
        .call(
            "POST",
            "/api/v1/expenses",
            Some(&pia_token),
            Some(json!({
                "conversationId": chat["id"],
                "title": "Huettenmiete",
                "amountCents": 9000,
                "paidBy": pia_id,
                "shares": [{ "userId": pia_id }, { "userId": rob_id }, { "userId": tom_id }],
            })),
        )
        .await;
    let id = ausgabe["id"].as_str().unwrap().to_string();

    async fn zustand(probe: &Probe, token: &str, id: &str) -> String {
        let (_, body) = probe
            .call("GET", &format!("/api/v1/expenses/{id}"), Some(token), None)
            .await;
        body["status"].as_str().unwrap_or("?").to_string()
    }

    // Am Anfang ist für alle drei alles offen.
    assert_eq!(zustand(&probe, &pia_token, &id).await, "open");
    assert_eq!(zustand(&probe, &rob_token, &id).await, "open");
    assert_eq!(zustand(&probe, &tom_token, &id).await, "open");

    // Pias EIGENER Anteil ist erledigt – sie schuldet sich nichts. Ohne das
    // stand die Auslegende in ihrer eigenen Ausgabe als offener Posten.
    let (_, body) = probe
        .call(
            "GET",
            &format!("/api/v1/expenses/{id}"),
            Some(&pia_token),
            None,
        )
        .await;
    let ihrer = body["shares"]
        .as_array()
        .unwrap()
        .iter()
        .find(|share| share["userId"] == json!(pia_id))
        .unwrap();
    assert_eq!(
        ihrer["status"], "closed",
        "der eigene Anteil ist erledigt: {ihrer}"
    );

    // --- Rob meldet, dass er gezahlt hat --------------------------------
    probe
        .call(
            "POST",
            &format!("/api/v1/expenses/{id}/settle"),
            Some(&rob_token),
            Some(json!({ "settled": true })),
        )
        .await;

    assert_eq!(
        zustand(&probe, &rob_token, &id).await,
        "reported",
        "bei Rob rueckt sie sofort weiter"
    );
    assert_eq!(
        zustand(&probe, &tom_token, &id).await,
        "open",
        "Tom geht Robs Zahlung nichts an"
    );
    assert_eq!(
        zustand(&probe, &pia_token, &id).await,
        "open",
        "bei Pia bleibt sie offen – sie hat noch nichts bestaetigt"
    );

    // --- Pia bestätigt Rob, Tom hat noch nicht gezahlt ------------------
    let (status, _) = probe
        .call(
            "POST",
            &format!("/api/v1/expenses/{id}/settle"),
            Some(&pia_token),
            Some(json!({ "userId": rob_id, "settled": true })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "bestaetigen muss auch NACH der Meldung gehen"
    );

    assert_eq!(
        zustand(&probe, &rob_token, &id).await,
        "closed",
        "fuer Rob erledigt"
    );
    assert_eq!(
        zustand(&probe, &pia_token, &id).await,
        "open",
        "bei Pia weiter offen – Tom fehlt noch"
    );

    // --- Tom zahlt, Pia bestätigt ---------------------------------------
    probe
        .call(
            "POST",
            &format!("/api/v1/expenses/{id}/settle"),
            Some(&tom_token),
            Some(json!({ "settled": true })),
        )
        .await;
    assert_eq!(
        zustand(&probe, &pia_token, &id).await,
        "open",
        "eine Meldung allein schliesst fuer die Auslegende nichts ab"
    );

    probe
        .call(
            "POST",
            &format!("/api/v1/expenses/{id}/settle"),
            Some(&pia_token),
            Some(json!({ "userId": tom_id, "settled": true })),
        )
        .await;

    assert_eq!(
        zustand(&probe, &pia_token, &id).await,
        "closed",
        "erst wenn Pia bei allen bestaetigt hat"
    );
    assert_eq!(zustand(&probe, &tom_token, &id).await, "closed");
}
