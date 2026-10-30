//! Lücken aus dem zweiten Sicherheits-Review – Fortsetzung von `sicherheit.rs`.
//!
//! Dieselbe Frage wie dort: Lässt sich mit einer Eingabe, die die eigene
//! Oberfläche nie schickt, etwas erreichen, das sie nie erlaubt? Jeder Test
//! hier war gegen den Stand vor der Behebung rot.

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
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    /// Legt ein Konto an: (Zugriffstoken, Kennung).
    async fn konto(&self, vorne: &str) -> (String, String) {
        let (token, id, _) = self.konto_voll(vorne).await;
        (token, id)
    }

    /// Wie `konto`, dazu das Erneuerungs-Token.
    async fn konto_voll(&self, vorne: &str) -> (String, String, String) {
        let kennung = Uuid::now_v7().simple().to_string();
        let name = format!("{vorne}{}", &kennung[kennung.len() - 12..]);
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
            body["refreshToken"].as_str().unwrap().to_string(),
        )
    }

    async fn gruppe(&self, token: &str, mitglieder: &[&str]) -> String {
        let (status, chat) = self
            .call(
                "POST",
                "/api/v1/conversations",
                Some(token),
                Some(json!({ "type": "group", "title": "Runde", "memberIds": mitglieder })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{chat}");
        chat["id"].as_str().unwrap().to_string()
    }

    async fn ausgabe(&self, token: &str, koerper: Value) -> (StatusCode, Value) {
        self.call("POST", "/api/v1/expenses", Some(token), Some(koerper))
            .await
    }

    async fn salden(&self, token: &str) -> Vec<(String, i64)> {
        let (status, body) = self
            .call("GET", "/api/v1/expenses/balances", Some(token), None)
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let mut liste: Vec<(String, i64)> = body["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|eintrag| {
                (
                    eintrag["userId"].as_str().unwrap().to_string(),
                    eintrag["netCents"].as_i64().unwrap(),
                )
            })
            .collect();
        liste.sort();
        liste
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
    std::env::set_var("LOCAL_STORAGE_DIR", "./.data/test-uploads");
    let state = AppState::new(Config::from_env().expect("config"))
        .await
        .expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    Some(Probe {
        router: app::build(state.clone()),
        state,
    })
}

macro_rules! probe {
    () => {
        match aufbauen().await {
            Some(probe) => probe,
            None => {
                eprintln!("TEST_DATABASE_URL fehlt – übersprungen");
                return;
            }
        }
    };
}

/* ---------- Ausgaben: wen eine Ausgabe nennen darf ---------- */

/// Anteile, Auslegende, Zuschauer und Ausgenommene nahmen jede Konto-Kennung
/// an – man konnte einem Fremden eine Schuld anhängen oder ihm Ereignisse
/// schicken.
#[tokio::test]
async fn ausgaben_nennen_nur_leute_aus_dem_zusammenhang() {
    let probe = probe!();
    let (anna, anna_id) = probe.konto("anna").await;
    let (_, bert_id) = probe.konto("bert").await;
    let (_, cleo_id) = probe.konto("cleo").await;
    let (_, dora_id) = probe.konto("dora").await;
    let chat = probe.gruppe(&anna, &[&bert_id]).await;
    // Dora teilt mit Anna einen anderen Chat, aber nicht diesen.
    probe.gruppe(&anna, &[&dora_id]).await;

    let mit_chat = |zusatz: Value| {
        let mut koerper = json!({
            "conversationId": chat,
            "title": "Pizza",
            "amountCents": 3000,
            "shares": [{ "userId": anna_id }, { "userId": bert_id }],
        });
        for (schluessel, wert) in zusatz.as_object().unwrap() {
            koerper[schluessel] = wert.clone();
        }
        koerper
    };

    for (fall, zusatz) in [
        (
            "Fremder als Anteil",
            json!({ "shares": [{ "userId": anna_id }, { "userId": cleo_id }] }),
        ),
        ("Fremder legt aus", json!({ "paidBy": cleo_id })),
        (
            "Fremder als Zuschauer",
            json!({ "visibility": "listed", "viewerIds": [cleo_id] }),
        ),
        ("Fremder ausgenommen", json!({ "hiddenFromIds": [cleo_id] })),
        (
            "aus einem anderen Chat",
            json!({ "shares": [{ "userId": anna_id }, { "userId": dora_id }] }),
        ),
        (
            "unbekannte Kennung",
            json!({ "shares": [{ "userId": Uuid::now_v7() }] }),
        ),
    ] {
        let (status, body) = probe.ausgabe(&anna, mit_chat(zusatz)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{fall}: {body}");
    }

    // Doppelt im Anteil: abgelehnt. Doppelt als Zuschauer: still entdoppelt.
    let (status, body) = probe
        .ausgabe(
            &anna,
            mit_chat(json!({ "shares": [{ "userId": bert_id }, { "userId": bert_id }] })),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    let (status, body) = probe
        .ausgabe(
            &anna,
            mit_chat(json!({ "visibility": "listed", "viewerIds": [bert_id, bert_id] })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert_eq!(body["viewerIds"], json!([bert_id]), "{body}");

    // Zu viele auf einmal.
    let viele: Vec<String> = (0..101).map(|_| Uuid::now_v7().to_string()).collect();
    let (status, body) = probe
        .ausgabe(
            &anna,
            mit_chat(json!({ "visibility": "listed", "viewerIds": viele })),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");

    // Ohne Chat und Termin: nur wer mit mir einen Chat teilt.
    let ohne = |wer: &str| {
        json!({
            "title": "Kino",
            "amountCents": 1000,
            "shares": [{ "userId": anna_id }, { "userId": wer }],
        })
    };
    let (status, body) = probe.ausgabe(&anna, ohne(&dora_id)).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let (status, body) = probe.ausgabe(&anna, ohne(&cleo_id)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    // Mit Termin: wer eingeladen ist, auch ohne den Chat.
    let (status, termin) = probe
        .call(
            "POST",
            "/api/v1/calendar/events",
            Some(&anna),
            Some(json!({
                "title": "Grillen",
                "startsAt": "2027-06-01T18:00:00Z",
                "endsAt": "2027-06-01T21:00:00Z",
                "attendeeIds": [dora_id],
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{termin}");
    let termin_id = termin["event"]["id"]
        .as_str()
        .or_else(|| termin["id"].as_str())
        .unwrap()
        .to_string();
    let mit_termin = |wer: &str| {
        json!({
            "eventId": termin_id,
            "title": "Kohle",
            "amountCents": 1000,
            "shares": [{ "userId": anna_id }, { "userId": wer }],
        })
    };
    let (status, body) = probe.ausgabe(&anna, mit_termin(&dora_id)).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let (status, body) = probe.ausgabe(&anna, mit_termin(&bert_id)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    // Der gewöhnliche Fall geht weiter durch.
    let (status, body) = probe.ausgabe(&anna, mit_chat(json!({}))).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
}

/// Die Übersicht lud alle offenen Ausgaben des Systems und fragte je Ausgabe
/// nach der Sichtbarkeit. Jetzt filtert die Abfrage vor – das Ergebnis muss
/// für alle sichtbaren Fälle dasselbe bleiben, auch beim Geschenk.
#[tokio::test]
async fn salden_bleiben_dieselben_nur_schneller() {
    let probe = probe!();
    let (anna, anna_id) = probe.konto("anna").await;
    let (bert, bert_id) = probe.konto("bert").await;
    let (cleo, cleo_id) = probe.konto("cleo").await;
    let chat = probe.gruppe(&anna, &[&bert_id, &cleo_id]).await;

    // 1. Anna legt 30 € für alle drei aus: Bert und Cleo schulden je 10 €.
    let (status, body) = probe
        .ausgabe(
            &anna,
            json!({
                "conversationId": chat, "title": "Pizza", "amountCents": 3000,
                "visibility": "conversation",
                "shares": [{ "userId": anna_id }, { "userId": bert_id }, { "userId": cleo_id }],
            }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");

    // 2. Das Geschenk für Cleo: Anna legt 20 € aus, Bert zahlt die Hälfte –
    //    vor Cleo verborgen. Cleos Saldo darf es nicht kennen.
    let (status, body) = probe
        .ausgabe(
            &anna,
            json!({
                "conversationId": chat, "title": "Geschenk", "amountCents": 2000,
                "visibility": "conversation", "hiddenFromIds": [cleo_id],
                "shares": [{ "userId": anna_id }, { "userId": bert_id }],
            }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");

    // 3. Bert legt 9 € für Cleo aus – geht Anna nichts an, obwohl sie es sieht.
    let (status, body) = probe
        .ausgabe(
            &bert,
            json!({
                "conversationId": chat, "title": "Taxi", "amountCents": 900,
                "visibility": "conversation",
                "shares": [{ "userId": cleo_id, "amountCents": 900 }],
            }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");

    // 4. Cleo hat ihren Anteil an einer weiteren Ausgabe schon beglichen.
    let (status, beglichen) = probe
        .ausgabe(
            &anna,
            json!({
                "conversationId": chat, "title": "Kaffee", "amountCents": 400,
                "shares": [{ "userId": cleo_id, "amountCents": 400 }],
            }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{beglichen}");
    let id = beglichen["id"].as_str().unwrap();
    let (status, body) = probe
        .call(
            "POST",
            &format!("/api/v1/expenses/{id}/settle"),
            Some(&cleo),
            Some(json!({})),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let mut erwartet_anna = vec![(bert_id.clone(), 1000 + 1000), (cleo_id.clone(), 1000)];
    erwartet_anna.sort();
    assert_eq!(probe.salden(&anna).await, erwartet_anna);

    let mut erwartet_bert = vec![(anna_id.clone(), -2000), (cleo_id.clone(), 900)];
    erwartet_bert.sort();
    assert_eq!(probe.salden(&bert).await, erwartet_bert);

    let mut erwartet_cleo = vec![(anna_id.clone(), -1000), (bert_id.clone(), -900)];
    erwartet_cleo.sort();
    assert_eq!(probe.salden(&cleo).await, erwartet_cleo);

    // Und je Chat gefiltert dasselbe.
    let (status, body) = probe
        .call(
            "GET",
            &format!("/api/v1/expenses/balances?conversationId={chat}"),
            Some(&cleo),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["items"].as_array().unwrap().len(), 2, "{body}");

    // Die Liste zeigt Cleo das Geschenk weiter nicht.
    let (status, liste) = probe
        .call(
            "GET",
            &format!("/api/v1/expenses?conversationId={chat}"),
            Some(&cleo),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{liste}");
    assert!(
        liste["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|ausgabe| ausgabe["title"] != "Geschenk"),
        "{liste}"
    );
    let _ = &probe.state;
}

/* ---------- Chat-Rollen: die Rangordnung ---------- */

/// Ein Admin konnte sich selbst zum Besitzer machen und den bisherigen danach
/// herabstufen oder entfernen.
#[tokio::test]
async fn admins_greifen_nicht_nach_oben() {
    let probe = probe!();
    let (anna, anna_id) = probe.konto("anna").await;
    let (bert, bert_id) = probe.konto("bert").await;
    let (cleo, cleo_id) = probe.konto("cleo").await;
    let (_, dora_id) = probe.konto("dora").await;
    let chat = probe.gruppe(&anna, &[&bert_id, &cleo_id, &dora_id]).await;
    let mitglied = |wer: &str| format!("/api/v1/conversations/{chat}/members/{wer}");
    let rolle = |rolle: &str| Some(json!({ "role": rolle }));

    // Anna (Besitzerin) ernennt Bert und Cleo zu Admins.
    for wer in [&bert_id, &cleo_id] {
        let (status, body) = probe
            .call("PATCH", &mitglied(wer), Some(&anna), rolle("admin"))
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }

    // Bert greift nach oben: sich selbst zum Besitzer, Anna herabstufen,
    // Anna entfernen, Cleo (gleichrangig) herabstufen oder entfernen.
    for (fall, methode, wer, koerper) in [
        ("sich zum Besitzer", "PATCH", &bert_id, rolle("owner")),
        ("Cleo zum Besitzer", "PATCH", &cleo_id, rolle("owner")),
        ("Anna herabstufen", "PATCH", &anna_id, rolle("member")),
        (
            "Anna umbenennen",
            "PATCH",
            &anna_id,
            Some(json!({ "nickname": "x" })),
        ),
        ("Anna entfernen", "DELETE", &anna_id, None),
        ("Cleo herabstufen", "PATCH", &cleo_id, rolle("member")),
        ("Cleo entfernen", "DELETE", &cleo_id, None),
        (
            "sich selbst herabstufen",
            "PATCH",
            &bert_id,
            rolle("member"),
        ),
    ] {
        let (status, body) = probe
            .call(methode, &mitglied(wer), Some(&bert), koerper)
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{fall}: {body}");
    }

    // Was unter ihm liegt, darf er: Dora zur Admin machen. Danach ist sie
    // gleichrangig – zurückstufen kann sie nur noch Anna.
    let (status, body) = probe
        .call("PATCH", &mitglied(&dora_id), Some(&bert), rolle("admin"))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = probe
        .call("PATCH", &mitglied(&dora_id), Some(&bert), rolle("member"))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let (status, body) = probe
        .call("PATCH", &mitglied(&dora_id), Some(&anna), rolle("member"))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // Die Übergabe durch die Besitzerin: Cleo wird Besitzerin, Anna Admin.
    let (status, body) = probe
        .call("PATCH", &mitglied(&cleo_id), Some(&anna), rolle("owner"))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let rollen: std::collections::HashMap<String, String> = body["members"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| {
            (
                m["userId"].as_str().unwrap().to_string(),
                m["role"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    assert_eq!(rollen[&cleo_id], "owner", "{body}");
    assert_eq!(rollen[&anna_id], "admin", "{body}");

    // Danach kann Anna Cleo nichts mehr – Cleo aber Anna.
    let (status, _) = probe
        .call("DELETE", &mitglied(&cleo_id), Some(&anna), None)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = probe
        .call("PATCH", &mitglied(&anna_id), Some(&cleo), rolle("member"))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // Gehen darf jeder, auch ein Admin.
    let (status, body) = probe
        .call("DELETE", &mitglied(&bert_id), Some(&bert), None)
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
}

/// Im Direktchat ist, wer ihn anlegt, „owner“ – und konnte das Gegenüber
/// entfernen und den Chat für beide umbenennen.
#[tokio::test]
async fn im_direktchat_moderiert_niemand() {
    let probe = probe!();
    let (anna, _) = probe.konto("anna").await;
    let (bert, bert_id) = probe.konto("bert").await;
    let (status, chat) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&anna),
            Some(json!({ "type": "direct", "memberIds": [bert_id] })),
        )
        .await;
    assert!(status.is_success(), "{chat}");
    let chat = chat["id"].as_str().unwrap().to_string();

    let (status, body) = probe
        .call(
            "PATCH",
            &format!("/api/v1/conversations/{chat}"),
            Some(&anna),
            Some(json!({ "title": "Meins" })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let (status, body) = probe
        .call(
            "PATCH",
            &format!("/api/v1/conversations/{chat}/members/{bert_id}"),
            Some(&anna),
            Some(json!({ "nickname": "Spitz" })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let (status, body) = probe
        .call(
            "DELETE",
            &format!("/api/v1/conversations/{chat}/members/{bert_id}"),
            Some(&anna),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    // Eigenes bleibt erlaubt: stummschalten, archivieren, der eigene Spitzname.
    let (status, body) = probe
        .call(
            "PATCH",
            &format!("/api/v1/conversations/{chat}"),
            Some(&bert),
            Some(json!({ "archived": true })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = probe
        .call(
            "PATCH",
            &format!("/api/v1/conversations/{chat}/members/{bert_id}"),
            Some(&bert),
            Some(json!({ "nickname": "Ich" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

/* ---------- Push: ein fremdes Abo umhängen ---------- */

/// `on conflict (endpoint) do update set user_id` hängte das Abo eines
/// anderen auf das eigene Konto um – samt neuer Schlüssel.
#[tokio::test]
async fn ein_fremdes_push_abo_bleibt_wo_es_ist() {
    let probe = probe!();
    let (anna, anna_id) = probe.konto("anna").await;
    let (bert, _) = probe.konto("bert").await;
    let endpunkt = format!(
        "https://updates.push.services.mozilla.com/wpush/v2/{}",
        Uuid::now_v7().simple()
    );
    // Echte P-256-Punkte: Der Server prüft die Schlüssel beim Anlegen.
    let annas = initiative_api::push::vapid::generate_keys().public_key;
    let berts = initiative_api::push::vapid::generate_keys().public_key;
    let neu = initiative_api::push::vapid::generate_keys().public_key;
    let abo = |schluessel: &str| {
        json!({
            "endpoint": endpunkt,
            "keys": { "p256dh": schluessel, "auth": "AAECAwQFBgcICQoLDA0ODw" },
        })
    };

    let (status, body) = probe
        .call(
            "POST",
            "/api/v1/push/subscriptions",
            Some(&anna),
            Some(abo(&annas)),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");

    let (status, body) = probe
        .call(
            "POST",
            "/api/v1/push/subscriptions",
            Some(&bert),
            Some(abo(&berts)),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");

    let (besitzer, schluessel): (Uuid, String) =
        sqlx::query_as("select user_id, p256dh from push_subscriptions where endpoint = $1")
            .bind(&endpunkt)
            .fetch_one(&probe.state.pool)
            .await
            .unwrap();
    assert_eq!(besitzer.to_string(), anna_id);
    assert_eq!(schluessel, annas);

    // Das eigene Abo zu erneuern (neue Schlüssel) geht weiter.
    let (status, body) = probe
        .call(
            "POST",
            "/api/v1/push/subscriptions",
            Some(&anna),
            Some(abo(&neu)),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
}

/* ---------- Nachrichten: Zusatzangaben, die der Server setzt ---------- */

/// `metadata` nahm beliebiges JSON bis 2 MB an – auch `system`, womit sich
/// eine Systemzeile im Namen eines anderen fälschen liess, und eine
/// `erinnerung` ohne Termin. `clientId` hatte keine Längengrenze.
#[tokio::test]
async fn zusatzangaben_kommen_nur_aus_der_positivliste() {
    let probe = probe!();
    let (anna, anna_id) = probe.konto("anna").await;
    let (_, bert_id) = probe.konto("bert").await;
    let chat = probe.gruppe(&anna, &[&bert_id]).await;
    let senden = |koerper: Value| {
        let probe = &probe;
        let anna = anna.clone();
        let chat = chat.clone();
        async move {
            probe
                .call(
                    "POST",
                    &format!("/api/v1/conversations/{chat}/messages"),
                    Some(&anna),
                    Some(koerper),
                )
                .await
        }
    };

    for (fall, koerper) in [
        (
            "Systemzeile",
            json!({ "body": "x", "metadata": { "system": {
                "kind": "member.removed", "actorId": bert_id, "targetIds": [anna_id] } } }),
        ),
        (
            "Erinnerung",
            json!({ "body": "x", "metadata": { "erinnerung": { "nummer": 1 } } }),
        ),
        (
            "Unbekannt",
            json!({ "body": "x", "metadata": { "linkPreview": { "url": "https://x" } } }),
        ),
        ("kein Objekt", json!({ "body": "x", "metadata": [1, 2] })),
        (
            "zu gross",
            json!({ "body": "x", "metadata": { "module": { "x": "y".repeat(5000) } } }),
        ),
        (
            "Sticker ohne Kennung",
            json!({ "type": "sticker", "metadata": { "stickerId": "kein-sticker" } }),
        ),
    ] {
        let (status, body) = senden(koerper).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{fall}: {body}");
    }

    for (fall, schluessel) in [
        ("zu lang", "x".repeat(65)),
        ("Schlüssel des Servers", format!("karte:{}", Uuid::now_v7())),
    ] {
        let (status, body) = senden(json!({ "body": "x", "clientId": schluessel })).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{fall}: {body}");
    }

    // Was die Oberfläche schickt, geht weiter durch.
    let schluessel = Uuid::now_v7().to_string();
    let (status, body) = senden(json!({
        "body": "Hallo", "metadata": {}, "clientId": schluessel,
    }))
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let (status, body) = senden(json!({
        "body": "weiter",
        "metadata": { "forwardedFrom": { "conversationId": chat, "messageId": body["id"] } },
    }))
    .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
}

/// Legt einen Sticker unmittelbar in der Datenbank an: (Kennung, Anhang).
async fn sticker(probe: &Probe, besitzer: &str, oeffentlich: bool) -> (Uuid, Uuid) {
    let besitzer = Uuid::parse_str(besitzer).unwrap();
    let anhang = Uuid::now_v7();
    let paket = Uuid::now_v7();
    let sticker = Uuid::now_v7();
    sqlx::query(
        "insert into attachments (id, uploader_id, kind, mime, size, storage_key, status)
         values ($1, $2, 'sticker', 'image/webp', 10, $3, 'ready')",
    )
    .bind(anhang)
    .bind(besitzer)
    .bind(format!("probe/{anhang}"))
    .execute(&probe.state.pool)
    .await
    .unwrap();
    sqlx::query(
        "insert into sticker_packs (id, owner_id, name, is_public) values ($1, $2, 'P', $3)",
    )
    .bind(paket)
    .bind(besitzer)
    .bind(oeffentlich)
    .execute(&probe.state.pool)
    .await
    .unwrap();
    sqlx::query("insert into stickers (id, pack_id, attachment_id) values ($1, $2, $3)")
        .bind(sticker)
        .bind(paket)
        .bind(anhang)
        .execute(&probe.state.pool)
        .await
        .unwrap();
    (sticker, anhang)
}

/// Eine bekannte Sticker-Kennung aus einem privaten Paket machte das Bild in
/// jedem Chat sichtbar, in den man sie legte.
#[tokio::test]
async fn fremde_private_sticker_bleiben_privat() {
    let probe = probe!();
    let (anna, anna_id) = probe.konto("anna").await;
    let (bert, bert_id) = probe.konto("bert").await;
    let (cleo, _) = probe.konto("cleo").await;
    let annas_chat = probe.gruppe(&anna, &[&bert_id]).await;
    let cleos_chat = probe.gruppe(&cleo, &[&bert_id]).await;
    let (privat, _) = sticker(&probe, &anna_id, false).await;
    let (oeffentlich, _) = sticker(&probe, &anna_id, true).await;

    let senden = |wer: &str, chat: &str, sticker: Uuid| {
        let wer = wer.to_string();
        let chat = chat.to_string();
        let probe = &probe;
        async move {
            probe
                .call(
                    "POST",
                    &format!("/api/v1/conversations/{chat}/messages"),
                    Some(&wer),
                    Some(json!({ "type": "sticker", "metadata": { "stickerId": sticker } })),
                )
                .await
        }
    };

    // Cleo kennt die Kennung und legt sie in ihren eigenen Chat: abgelehnt.
    let (status, body) = senden(&cleo, &cleos_chat, privat).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert!(body["sticker"].is_null(), "{body}");
    // Öffentliche gehen, eigene auch.
    let (status, body) = senden(&cleo, &cleos_chat, oeffentlich).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let (status, body) = senden(&anna, &annas_chat, privat).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    // Bert hat ihn in Annas Chat gesehen und darf dort mit demselben antworten
    // – aber nicht in Cleos Chat weitertragen.
    let (status, body) = senden(&bert, &annas_chat, privat).await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let (status, body) = senden(&bert, &cleos_chat, privat).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
}

/* ---------- Kleinere Grenzen ---------- */

/// `/media/teilen` legte eine Nachricht an, ohne die Textlänge zu prüfen –
/// am Senden-Handler vorbei, der sie prüft.
#[tokio::test]
async fn weitergeben_haelt_die_textgrenze() {
    let probe = probe!();
    let (anna, anna_id) = probe.konto("anna").await;
    let (_, bert_id) = probe.konto("bert").await;
    let chat = probe.gruppe(&anna, &[&bert_id]).await;
    let anhang = Uuid::now_v7();
    sqlx::query(
        "insert into attachments (id, uploader_id, kind, mime, size, storage_key, status)
         values ($1, $2, 'file', 'application/pdf', 10, $3, 'ready')",
    )
    .bind(anhang)
    .bind(Uuid::parse_str(&anna_id).unwrap())
    .bind(format!("probe/{anhang}"))
    .execute(&probe.state.pool)
    .await
    .unwrap();

    let (status, body) = probe
        .call(
            "POST",
            "/api/v1/media/teilen",
            Some(&anna),
            Some(json!({ "ids": [anhang], "conversationId": chat, "body": "x".repeat(8001) })),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    let neue: i64 = sqlx::query_scalar("select count(*) from attachments where quelle_id = $1")
        .bind(anhang)
        .fetch_one(&probe.state.pool)
        .await
        .unwrap();
    assert_eq!(neue, 0, "abgelehnt, bevor etwas angelegt wurde");

    let (status, body) = probe
        .call(
            "POST",
            "/api/v1/media/teilen",
            Some(&anna),
            Some(json!({ "ids": [anhang], "conversationId": chat, "body": "schau" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

/// Die Wellenform einer Sprachnachricht nahm beliebig viele Werte an.
#[tokio::test]
async fn die_wellenform_hat_eine_grenze() {
    let probe = probe!();
    let (anna, _) = probe.konto("anna").await;
    let (status, upload) = probe
        .call(
            "POST",
            "/api/v1/media/uploads",
            Some(&anna),
            Some(
                json!({ "kind": "audio", "mime": "audio/webm", "size": 10, "fileName": "a.webm" }),
            ),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{upload}");
    let anhang = upload["attachmentId"].as_str().unwrap();
    let pfad = format!("/api/v1/media/uploads/{anhang}/complete");
    let fertig = |wellenform: Value| {
        probe.call(
            "POST",
            &pfad,
            Some(&anna),
            Some(json!({ "waveform": wellenform, "durationMs": 1000 })),
        )
    };

    let (status, body) = fertig(json!(vec![0.5; 600])).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, body) = fertig(json!([0.1, 7.0, 0.3])).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, body) = fertig(json!(vec![0.25; 64])).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["waveform"].as_array().map(Vec::len),
        Some(64),
        "{body}"
    );
}

/* ---------- Offenlegung ---------- */

/// `/healthz` nannte jedem den rohen Datenbankfehler, die Zahl der
/// Verbindungen und die eingerichteten Dienste. Öffentlich bleiben Status und
/// Version (die App zeigt sie an); alles andere sieht ein Admin.
#[tokio::test]
async fn das_lebenszeichen_verraet_nur_status_und_version() {
    let probe = probe!();
    for pfad in ["/healthz", "/readyz"] {
        let (status, body) = probe.call("GET", pfad, None, None).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        let mut felder: Vec<&str> = body
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        felder.sort();
        assert_eq!(felder, ["status", "version"], "{pfad}: {body}");
    }

    let (gast, _) = probe.konto("gast").await;
    let (status, body) = probe.call("GET", "/healthz", Some(&gast), None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.get("connections").is_none(), "{body}");

    let (chef, chef_id) = probe.konto("chef").await;
    sqlx::query("update users set is_admin = true where id = $1")
        .bind(Uuid::parse_str(&chef_id).unwrap())
        .execute(&probe.state.pool)
        .await
        .unwrap();
    let (status, body) = probe.call("GET", "/healthz", Some(&chef), None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.get("connections").is_some(), "{body}");
    assert!(body.get("busConnected").is_some(), "{body}");
}

/// `passkeys/login/start` antwortete für Namen ohne Schlüssel mit 401 – eine
/// Abfrage, wer Passkeys nutzt (und welche Namen es gibt).
#[tokio::test]
async fn der_passkey_start_verraet_keine_namen() {
    let probe = probe!();
    let start = |name: &str| {
        probe.call(
            "POST",
            "/api/v1/passkeys/login/start",
            None,
            Some(json!({ "username": name })),
        )
    };
    let (_, _) = probe.konto("ohne").await;
    let unbekannt = format!("niemand{}", Uuid::now_v7().simple());

    let (status, erste) = start(&unbekannt).await;
    assert_eq!(status, StatusCode::OK, "{erste}");
    let (status, zweite) = start(&unbekannt).await;
    assert_eq!(status, StatusCode::OK, "{zweite}");

    // Dieselbe Gestalt wie eine echte Anfrage: genau ein Schlüssel, frische
    // Herausforderung, aber bei jeder Anfrage dieselbe Kennung.
    let erlaubt = |antwort: &Value| antwort["options"]["publicKey"]["allowCredentials"].clone();
    assert_eq!(erlaubt(&erste).as_array().map(Vec::len), Some(1), "{erste}");
    assert_eq!(erlaubt(&erste), erlaubt(&zweite));
    assert!(erlaubt(&erste)[0].get("transports").is_none());
    assert_ne!(
        erste["options"]["publicKey"]["challenge"],
        zweite["options"]["publicKey"]["challenge"]
    );

    // Ein Abschluss dazu scheitert wie jede andere abgelehnte Anmeldung.
    let (status, body) = probe
        .call(
            "POST",
            "/api/v1/passkeys/login/finish",
            None,
            Some(json!({
                "requestId": erste["requestId"],
                "credential": {
                    "id": "AAAA", "rawId": "AAAA", "type": "public-key",
                    "response": {
                        "authenticatorData": "AAAA", "clientDataJSON": "AAAA",
                        "signature": "AAAA", "userHandle": null,
                    },
                    "extensions": {},
                },
            })),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
}

/* ---------- Robustheit ---------- */

/// Gleichzeitige Wiederholungen mit demselben `clientId` sahen beide keine
/// Nachricht, und die zweite scheiterte am eindeutigen Index – der Client
/// hielt eine gesendete Nachricht für nicht gesendet.
#[tokio::test]
async fn gleichzeitige_wiederholungen_liefern_das_original() {
    let probe = probe!();
    let (anna, _) = probe.konto("anna").await;
    let (_, bert_id) = probe.konto("bert").await;
    let chat = probe.gruppe(&anna, &[&bert_id]).await;
    let schluessel = Uuid::now_v7().to_string();
    let pfad = format!("/api/v1/conversations/{chat}/messages");
    let senden = || {
        probe.call(
            "POST",
            &pfad,
            Some(&anna),
            Some(json!({ "body": "einmal", "clientId": schluessel })),
        )
    };

    let antworten = futures_util::future::join_all((0..8).map(|_| senden())).await;
    let mut kennungen: Vec<String> = antworten
        .iter()
        .map(|(status, body)| {
            assert!(status.is_success(), "{status}: {body}");
            body["id"].as_str().unwrap().to_string()
        })
        .collect();
    kennungen.dedup();
    assert_eq!(kennungen.len(), 1, "alle bekommen dieselbe Nachricht");

    let anzahl: i64 = sqlx::query_scalar(
        "select count(*) from messages where conversation_id = $1 and client_id = $2",
    )
    .bind(Uuid::parse_str(&chat).unwrap())
    .bind(&schluessel)
    .fetch_one(&probe.state.pool)
    .await
    .unwrap();
    assert_eq!(anzahl, 1);
}

/// „Für alle löschen“ lief in drei Schritten ohne Transaktion. Hier nur der
/// Weg selbst: Nachricht leer, Anhang fort.
#[tokio::test]
async fn fuer_alle_loeschen_raeumt_vollstaendig() {
    let probe = probe!();
    let (anna, anna_id) = probe.konto("anna").await;
    let (_, bert_id) = probe.konto("bert").await;
    let chat = probe.gruppe(&anna, &[&bert_id]).await;
    let anhang = Uuid::now_v7();
    sqlx::query(
        "insert into attachments (id, uploader_id, kind, mime, size, storage_key, status)
         values ($1, $2, 'file', 'application/pdf', 10, $3, 'ready')",
    )
    .bind(anhang)
    .bind(Uuid::parse_str(&anna_id).unwrap())
    .bind(format!("probe/{anhang}"))
    .execute(&probe.state.pool)
    .await
    .unwrap();
    let (status, nachricht) = probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat}/messages"),
            Some(&anna),
            Some(json!({ "type": "file", "body": "PDF", "attachmentIds": [anhang] })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{nachricht}");
    let id = nachricht["id"].as_str().unwrap();

    let (status, body) = probe
        .call(
            "DELETE",
            &format!("/api/v1/messages/{id}"),
            Some(&anna),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");
    let (geloescht, text): (bool, Option<String>) =
        sqlx::query_as("select deleted_at is not null, body from messages where id = $1")
            .bind(Uuid::parse_str(id).unwrap())
            .fetch_one(&probe.state.pool)
            .await
            .unwrap();
    assert!(geloescht);
    assert!(text.is_none());
    let anhaenge: i64 = sqlx::query_scalar("select count(*) from attachments where id = $1")
        .bind(anhang)
        .fetch_one(&probe.state.pool)
        .await
        .unwrap();
    assert_eq!(anhaenge, 0);
}

/* ---------- Erneuerung: Nachfrist nach der Rotation ---------- */

impl Probe {
    async fn erneuern(&self, token: &str) -> (StatusCode, Value) {
        self.call(
            "POST",
            "/api/v1/auth/refresh",
            None,
            Some(json!({ "refreshToken": token })),
        )
        .await
    }

    async fn frist_vorbei(&self, token: &str) {
        sqlx::query(
            "update refresh_tokens set revoked_at = now() - interval '1 minute'
              where token_hash = $1",
        )
        .bind(initiative_api::auth::password::sha256_hex(token))
        .execute(&self.state.pool)
        .await
        .unwrap();
    }

    /// Eine zweite Sitzung desselben Kontos, wie von einem anderen Gerät.
    async fn zweites_geraet(&self, name: &str) -> String {
        let (status, body) = self
            .call(
                "POST",
                "/api/v1/auth/login",
                None,
                Some(json!({ "username": name, "password": "richtigespasswort" })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["refreshToken"].as_str().unwrap().to_string()
    }
}

/// Ging die Antwort einer Erneuerung verloren, legte das Gerät den alten
/// Token noch einmal vor – und das beendete als „Diebstahl“ alle Sitzungen
/// des Kontos. In den ersten Sekunden nach der Rotation bekommt es jetzt
/// dieselbe neue Sitzung.
#[tokio::test]
async fn ein_gerade_rotierter_token_gilt_kurz_noch_einmal() {
    let probe = probe!();
    let (token, _, r1) = probe.konto_voll("frist").await;
    let (_, ich) = probe
        .call("GET", "/api/v1/auth/me", Some(&token), None)
        .await;
    let anderes = probe
        .zweites_geraet(ich["username"].as_str().unwrap())
        .await;

    let (status, erste) = probe.erneuern(&r1).await;
    assert_eq!(status, StatusCode::OK, "{erste}");
    let r2 = erste["refreshToken"].as_str().unwrap().to_string();

    // Dasselbe alte Stück noch einmal: dieselbe neue Sitzung, kein Abbruch.
    let (status, zweite) = probe.erneuern(&r1).await;
    assert_eq!(status, StatusCode::OK, "{zweite}");
    assert_eq!(zweite["refreshToken"], json!(r2));
    assert!(zweite["accessToken"].is_string());

    // Zwei Tabs kurz nacheinander: r2 rotiert weiter zu r3 – wer noch r1
    // vorlegt, landet beim lebenden Ende der Kette.
    let (status, dritte) = probe.erneuern(&r2).await;
    assert_eq!(status, StatusCode::OK, "{dritte}");
    let r3 = dritte["refreshToken"].as_str().unwrap().to_string();
    let (status, vierte) = probe.erneuern(&r1).await;
    assert_eq!(status, StatusCode::OK, "{vierte}");
    assert_eq!(vierte["refreshToken"], json!(r3));

    // Gleichzeitig vorgelegt: beide bekommen dasselbe.
    let (a, b) = tokio::join!(probe.erneuern(&r3), probe.erneuern(&r3));
    assert_eq!(a.0, StatusCode::OK, "{}", a.1);
    assert_eq!(b.0, StatusCode::OK, "{}", b.1);
    assert_eq!(a.1["refreshToken"], b.1["refreshToken"]);

    // Das andere Gerät hat von alledem nichts gemerkt.
    let (status, body) = probe.erneuern(&anderes).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

/// Außerhalb der Frist bleibt die Wiederverwendung, was sie war: der Beweis,
/// dass zwei dieselbe Kette benutzen – alle Sitzungen enden.
#[tokio::test]
async fn nach_der_frist_beendet_die_wiederverwendung_alles() {
    let probe = probe!();
    let (token, _, r1) = probe.konto_voll("dieb").await;
    let (_, ich) = probe
        .call("GET", "/api/v1/auth/me", Some(&token), None)
        .await;
    let anderes = probe
        .zweites_geraet(ich["username"].as_str().unwrap())
        .await;

    let (status, erste) = probe.erneuern(&r1).await;
    assert_eq!(status, StatusCode::OK, "{erste}");
    let r2 = erste["refreshToken"].as_str().unwrap().to_string();
    probe.frist_vorbei(&r1).await;

    let (status, body) = probe.erneuern(&r1).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    for stueck in [&r2, &anderes] {
        let (status, body) = probe.erneuern(stueck).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "alles beendet: {body}");
    }
}

/// Die Frist hebelt kein Abmelden aus: Ein Token, dessen Nachfolger durch
/// einen Passwortwechsel widerrufen wurde, bekommt auch in der Frist nichts.
#[tokio::test]
async fn die_frist_hilft_nicht_ueber_einen_passwortwechsel() {
    let probe = probe!();
    let (token, _, r1) = probe.konto_voll("wechsel").await;
    let (status, erste) = probe.erneuern(&r1).await;
    assert_eq!(status, StatusCode::OK, "{erste}");
    let (status, body) = probe
        .call(
            "POST",
            "/api/v1/auth/password",
            Some(&token),
            Some(json!({
                "currentPassword": "richtigespasswort",
                "newPassword": "ganzneuespasswort",
            })),
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT, "{body}");

    let (status, body) = probe.erneuern(&r1).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
    let (status, body) = probe
        .erneuern(erste["refreshToken"].as_str().unwrap())
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED, "{body}");
}
