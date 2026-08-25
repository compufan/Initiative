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
