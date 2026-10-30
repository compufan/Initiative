//! Lücken aus einem Sicherheits-Review – jede mit dem Weg, auf dem sie offen war.
//!
//! Jeder Test hier war gegen den Stand vor der Behebung rot (oder brach die
//! Anfrage ab). Sie stehen beisammen, weil sie dieselbe Frage stellen: Lässt
//! sich mit einer Eingabe, die die eigene Oberfläche nie schickt, etwas
//! erreichen, das sie nie erlaubt?

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
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

    async fn senden(&self, token: &str, chat: &str, text: &str) -> String {
        let (status, nachricht) = self
            .call(
                "POST",
                &format!("/api/v1/conversations/{chat}/messages"),
                Some(token),
                Some(json!({ "body": text })),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{nachricht}");
        nachricht["id"].as_str().unwrap().to_string()
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

/* ---------- Kalender: die Wiederholungsregel ---------- */

/// Die Regel wanderte ungeprüft in jedes Kalender-Abo der Eingeladenen, und
/// `BYDAY=€` brach jede Anfrage ab, die die Reihe ausrechnet.
#[tokio::test]
async fn eine_wiederholung_ist_eine_regel_und_sonst_nichts() {
    let probe = probe!();
    let (token, _) = probe.konto("regel").await;
    let termin = |regel: &str| {
        json!({
            "title": "Probe",
            "startsAt": "2027-03-01T18:00:00Z",
            "endsAt": "2027-03-01T19:00:00Z",
            "rrule": regel,
        })
    };

    for regel in [
        "FREQ=DAILY\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:Untergeschoben",
        "FREQ=WEEKLY;BYDAY=€",
    ] {
        let (status, body) = probe
            .call(
                "POST",
                "/api/v1/calendar/events",
                Some(&token),
                Some(termin(regel)),
            )
            .await;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{regel:?}: {body}"
        );
    }

    // Eine echte Regel geht weiter durch – und lässt sich nicht nachträglich
    // verderben.
    let (status, angelegt) = probe
        .call(
            "POST",
            "/api/v1/calendar/events",
            Some(&token),
            Some(termin("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10")),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{angelegt}");
    let id = angelegt["event"]["id"]
        .as_str()
        .or_else(|| angelegt["id"].as_str())
        .expect("Kennung des Termins")
        .to_string();
    let (status, body) = probe
        .call(
            "PATCH",
            &format!("/api/v1/calendar/events/{id}"),
            Some(&token),
            Some(json!({ "rrule": "FREQ=DAILY\nURL:https://fremd.example" })),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");

    // Zu viele Erinnerungen trügen beliebig viele Wecker in fremde Kalender.
    let mut zu_viele = termin("FREQ=DAILY;COUNT=2");
    zu_viele["reminderMinutes"] = json!([1, 2, 3, 4, 5, 6]);
    let (status, body) = probe
        .call(
            "POST",
            "/api/v1/calendar/events",
            Some(&token),
            Some(zu_viele),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
}

/* ---------- Push: wohin der Server Anfragen schickt ---------- */

#[tokio::test]
async fn push_geht_nur_an_oeffentliche_dienste() {
    let probe = probe!();
    let (token, _) = probe.konto("push").await;
    // Ein echter P-256-Punkt: Der Server prüft die Schlüssel beim Anlegen.
    let p256dh = initiative_api::push::vapid::generate_keys().public_key;
    let abo = |endpunkt: &str, geraet: &str| {
        json!({
            "endpoint": endpunkt,
            "keys": { "p256dh": p256dh, "auth": "AAECAwQFBgcICQoLDA0ODw" },
            "userAgent": geraet,
        })
    };

    for endpunkt in [
        "http://127.0.0.1:5432/",
        "https://169.254.169.254/latest/meta-data/",
        "https://localhost/x",
        "https://postgres/x",
        "https://[::1]/x",
        "http://fcm.googleapis.com/fcm/send/x",
    ] {
        let (status, body) = probe
            .call(
                "POST",
                "/api/v1/push/subscriptions",
                Some(&token),
                Some(abo(endpunkt, "Firefox")),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{endpunkt}: {body}");
    }

    // Ein Gerätename, bei dem Byte 300 mitten in einem Umlaut liegt: Vorher
    // wurde nach Bytes geschnitten, und die Anfrage stürzte ab.
    let geraet = format!("a{}", "ä".repeat(200));
    let endpunkt = format!(
        "https://updates.push.services.mozilla.com/wpush/v2/{}",
        Uuid::now_v7().simple()
    );
    let (status, body) = probe
        .call(
            "POST",
            "/api/v1/push/subscriptions",
            Some(&token),
            Some(abo(&endpunkt, &geraet)),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{body}");
}

/* ---------- Nachrichten: Karten, die der Server anlegt ---------- */

/// Eine Karte mit fremder `pollId` zeigte Frage und Stimmen jedem im Chat –
/// an der Prüfung der Umfrage vorbei.
#[tokio::test]
async fn umfrage_und_spielkarten_lassen_sich_nicht_faelschen() {
    let probe = probe!();
    let (anna, anna_id) = probe.konto("anna").await;
    let (_, bert_id) = probe.konto("bert").await;
    let (cleo, _) = probe.konto("cleo").await;

    // Anna und Bert haben eine Umfrage, Cleo ist nicht dabei.
    let chat = probe.gruppe(&anna, &[&bert_id]).await;
    let (status, umfrage) = probe
        .call(
            "POST",
            "/api/v1/polls",
            Some(&anna),
            Some(json!({
                "conversationId": chat,
                "question": "Geheim?",
                "options": [{ "label": "ja" }, { "label": "nein" }],
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{umfrage}");
    let umfrage_id = umfrage["id"].as_str().unwrap();
    let (status, _) = probe
        .call(
            "GET",
            &format!("/api/v1/polls/{umfrage_id}"),
            Some(&cleo),
            None,
        )
        .await;
    assert!(
        status.is_client_error(),
        "Cleo darf die Umfrage nicht sehen"
    );

    // Cleo kennt die Kennung (etwa aus der Zeit, bevor sie entfernt wurde)
    // und legt sie in ihren eigenen Chat.
    let eigener = probe.gruppe(&cleo, &[&anna_id]).await;
    for metadaten in [
        json!({ "pollId": umfrage_id }),
        json!({ "gameSessionId": Uuid::now_v7() }),
    ] {
        let (status, body) = probe
            .call(
                "POST",
                &format!("/api/v1/conversations/{eigener}/messages"),
                Some(&cleo),
                Some(json!({ "type": "poll", "body": "schau", "metadata": metadaten })),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert!(
            body["poll"].is_null(),
            "die Umfrage darf nicht mitkommen: {body}"
        );
    }
}

/// Wer nach einer Nachricht beitritt, reagiert nicht auf sie – die Antwort
/// trüge alle Reaktionen samt Personen.
#[tokio::test]
async fn reaktionen_halten_die_grenze_des_beitritts() {
    let probe = probe!();
    let (anna, _) = probe.konto("anna").await;
    let (bert, bert_id) = probe.konto("bert").await;
    let (neu, neu_id) = probe.konto("neu").await;
    let chat = probe.gruppe(&anna, &[&bert_id]).await;
    let alt = probe.senden(&anna, &chat, "vor deiner Zeit").await;
    let (status, _) = probe
        .call(
            "PUT",
            &format!("/api/v1/messages/{alt}/reactions"),
            Some(&bert),
            Some(json!({ "emoji": "👍" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = probe
        .call(
            "POST",
            &format!("/api/v1/conversations/{chat}/members"),
            Some(&anna),
            Some(json!({ "memberIds": [neu_id] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let (status, body) = probe
        .call(
            "PUT",
            &format!("/api/v1/messages/{alt}/reactions"),
            Some(&neu),
            Some(json!({ "emoji": "👀" })),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert!(body.get("reactions").is_none(), "{body}");

    let frisch = probe.senden(&anna, &chat, "jetzt").await;
    let (status, _) = probe
        .call(
            "PUT",
            &format!("/api/v1/messages/{frisch}/reactions"),
            Some(&neu),
            Some(json!({ "emoji": "👀" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
}

/* ---------- Grenzen bei Längen und Beträgen ---------- */

#[tokio::test]
async fn chattitel_und_spitzname_haben_eine_grenze() {
    let probe = probe!();
    let (anna, _) = probe.konto("anna").await;
    let (_, bert_id) = probe.konto("bert").await;
    let lang = "x".repeat(5_000);

    let (status, body) = probe
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&anna),
            Some(json!({ "type": "group", "title": lang, "memberIds": [bert_id] })),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");

    let chat = probe.gruppe(&anna, &[&bert_id]).await;
    let (status, body) = probe
        .call(
            "PATCH",
            &format!("/api/v1/conversations/{chat}"),
            Some(&anna),
            Some(json!({ "title": lang })),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    let (status, body) = probe
        .call(
            "PATCH",
            &format!("/api/v1/conversations/{chat}/members/{bert_id}"),
            Some(&anna),
            Some(json!({ "nickname": lang })),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
}

/// Zwei Anteile von `i64::MAX` und einer von 3 ergaben nach dem Überlauf 1 –
/// und passten damit zu einer Ausgabe von einem Cent.
#[tokio::test]
async fn ausgaben_laufen_nicht_ueber() {
    let probe = probe!();
    let (anna, anna_id) = probe.konto("anna").await;
    let (_, bert_id) = probe.konto("bert").await;
    let (_, cleo_id) = probe.konto("cleo").await;

    let (status, body) = probe
        .call(
            "POST",
            "/api/v1/expenses",
            Some(&anna),
            Some(json!({
                "title": "Überlauf",
                "amountCents": 1,
                "shares": [
                    { "userId": bert_id, "amountCents": i64::MAX },
                    { "userId": cleo_id, "amountCents": i64::MAX },
                    { "userId": anna_id, "amountCents": 3 },
                ],
            })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");

    let (status, body) = probe
        .call(
            "POST",
            "/api/v1/expenses",
            Some(&anna),
            Some(json!({
                "title": "Zu viel",
                "amountCents": i64::MAX,
                "shares": [{ "userId": bert_id }],
            })),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
}

/// Das Löschen des Kontos prüft das Passwort – ohne Bremse ein Weg, es zu
/// einem abgegriffenen Zugang zu erraten.
#[tokio::test]
async fn konto_loeschen_ist_gebremst() {
    let probe = probe!();
    let (token, _) = probe.konto("bleibt").await;
    let mut letzter = StatusCode::OK;
    for _ in 0..11 {
        let (status, _) = probe
            .call(
                "DELETE",
                "/api/v1/users/me",
                Some(&token),
                Some(json!({ "password": "geraten123" })),
            )
            .await;
        letzter = status;
        if status == StatusCode::TOO_MANY_REQUESTS {
            break;
        }
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    assert_eq!(letzter, StatusCode::TOO_MANY_REQUESTS);
}

/* ---------- Echtzeit: eine widerrufene Sitzung verbindet nicht ---------- */

/// Öffnet eine Websocket-Leitung von Hand und liefert das erste Datenpaket:
/// (Opcode, Nutzlast).
async fn erstes_paket(adresse: std::net::SocketAddr, token: &str) -> (u8, Vec<u8>) {
    let mut leitung = tokio::net::TcpStream::connect(adresse).await.unwrap();
    let anfrage = format!(
        "GET /ws?token={token} HTTP/1.1\r\nHost: {adresse}\r\nUpgrade: websocket\r\n\
         Connection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\
         Sec-WebSocket-Version: 13\r\n\r\n"
    );
    leitung.write_all(anfrage.as_bytes()).await.unwrap();

    // Kopf der Antwort lesen, bis zur Leerzeile.
    let mut kopf = Vec::new();
    let mut byte = [0u8; 1];
    while !kopf.ends_with(b"\r\n\r\n") {
        leitung.read_exact(&mut byte).await.unwrap();
        kopf.push(byte[0]);
    }
    let kopf = String::from_utf8_lossy(&kopf);
    assert!(kopf.starts_with("HTTP/1.1 101"), "{kopf}");

    let mut anfang = [0u8; 2];
    leitung.read_exact(&mut anfang).await.unwrap();
    let opcode = anfang[0] & 0x0f;
    let laenge = match anfang[1] & 0x7f {
        126 => {
            let mut zwei = [0u8; 2];
            leitung.read_exact(&mut zwei).await.unwrap();
            usize::from(u16::from_be_bytes(zwei))
        }
        127 => panic!("unerwartet langes Paket"),
        kurz => usize::from(kurz),
    };
    let mut nutzlast = vec![0u8; laenge];
    leitung.read_exact(&mut nutzlast).await.unwrap();
    (opcode, nutzlast)
}

/// Nach einem Passwortwechsel (oder einer Kontolöschung) sind alle
/// Erneuerungs-Token widerrufen. Ein noch nicht abgelaufenes Zugriffstoken
/// öffnete trotzdem eine Leitung – und die las dann ohne Ende mit.
#[tokio::test]
async fn widerrufene_sitzung_bekommt_keine_echtzeit() {
    let probe = probe!();
    let (token, _) = probe.konto("leitung").await;

    let lauscher = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let adresse = lauscher.local_addr().unwrap();
    let router = probe.router.clone();
    tokio::spawn(async move {
        axum::serve(lauscher, router).await.unwrap();
    });

    // Solange die Sitzung besteht, grüsst der Server.
    let (opcode, nutzlast) = erstes_paket(adresse, &token).await;
    assert_eq!(opcode, 0x1, "Textpaket erwartet");
    assert!(String::from_utf8_lossy(&nutzlast).contains("hello"));

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

    // Dasselbe, noch gültige Zugriffstoken: jetzt Schluss mit 4401.
    let (opcode, nutzlast) = erstes_paket(adresse, &token).await;
    assert_eq!(opcode, 0x8, "Schlusspaket erwartet");
    assert_eq!(u16::from_be_bytes([nutzlast[0], nutzlast[1]]), 4401);

    // Und die Prüfung, die eine schon offene Leitung regelmässig stellt, sagt
    // dasselbe.
    let user_id =
        initiative_api::auth::jwt::decode(&token, "test-secret-value-at-least-16-characters")
            .map(|claims| Uuid::parse_str(&claims.sub).unwrap())
            .unwrap();
    assert!(!initiative_api::realtime::ws::sitzung_lebt(&probe.state.pool, user_id).await);
}
