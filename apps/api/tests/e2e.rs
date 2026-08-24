//! End-to-end test against a real Postgres.
//!
//! The whole HTTP surface is driven through the router – no ports, no network.
//! Set `TEST_DATABASE_URL` (or `DATABASE_URL`) to enable it; without a database
//! the test skips instead of failing.

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

struct TestApp {
    router: Router,
    state: AppState,
}

impl TestApp {
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
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        (status, value)
    }

    async fn raw(
        &self,
        method: &str,
        uri: &str,
        token: Option<&str>,
        headers: Vec<(&str, String)>,
        body: Body,
    ) -> (StatusCode, Vec<(String, String)>, Vec<u8>) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        for (name, value) in headers {
            builder = builder.header(name, value);
        }
        let response = self
            .router
            .clone()
            .oneshot(builder.body(body).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let header_pairs = response
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_string(),
                    value.to_str().unwrap_or_default().to_string(),
                )
            })
            .collect();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        (status, header_pairs, bytes.to_vec())
    }
}

async fn setup() -> Option<TestApp> {
    let database_url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;

    std::env::set_var("DATABASE_URL", &database_url);
    std::env::set_var("NODE_ENV", "test");
    std::env::set_var("DATABASE_SSL", "false");
    std::env::set_var("JWT_SECRET", "test-secret-value-at-least-16-characters");
    std::env::set_var("REALTIME_BUS", "memory");
    std::env::set_var("STORAGE_DRIVER", "local");
    std::env::set_var("LOCAL_STORAGE_DIR", "./.data/test-uploads");
    std::env::set_var("PUBLIC_API_URL", "http://localhost:8080");
    std::env::set_var("PUBLIC_APP_URL", "http://localhost:5173");

    let config = Config::from_env().expect("config");
    let state = AppState::new(config).await.expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    let router = app::build(state.clone());
    Some(TestApp { router, state })
}

fn multipart_png(boundary: &str, png: &[u8]) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
    body.extend_from_slice(
        b"Content-Disposition: form-data; name=\"file\"; filename=\"pixel.png\"\r\n",
    );
    body.extend_from_slice(b"Content-Type: image/png\r\n\r\n");
    body.extend_from_slice(png);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

/// The suite runs as one test so the scenario builds on itself, exactly like a
/// real client session would.
#[tokio::test(flavor = "multi_thread")]
async fn full_api_scenario() {
    let Some(app) = setup().await else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – Integrationstest übersprungen");
        return;
    };

    let suffix = Uuid::now_v7().simple().to_string()[..8].to_string();
    let alice_name = format!("alice{suffix}");
    let bob_name = format!("bob{suffix}");

    // ---- health -----------------------------------------------------------
    let (status, body) = app.call("GET", "/healthz", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "ok");
    assert_eq!(body["storage"], "local");

    // ---- registration -----------------------------------------------------
    let (status, session) = app
        .call(
            "POST",
            "/api/v1/auth/register",
            None,
            Some(json!({
                "username": alice_name,
                "password": "passwort123",
                "displayName": "Alice"
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let alice_token = session["accessToken"].as_str().unwrap().to_string();
    let alice_refresh = session["refreshToken"].as_str().unwrap().to_string();
    let alice_id = session["user"]["id"].as_str().unwrap().to_string();
    assert_eq!(session["user"]["username"], alice_name);
    assert!(session["user"]["calendarToken"].is_string());

    let (status, session) = app
        .call(
            "POST",
            "/api/v1/auth/register",
            None,
            Some(json!({
                "username": bob_name,
                "password": "passwort123",
                "displayName": "Bob"
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let bob_token = session["accessToken"].as_str().unwrap().to_string();
    let bob_id = session["user"]["id"].as_str().unwrap().to_string();

    // Duplicate usernames are refused.
    let (status, _) = app
        .call(
            "POST",
            "/api/v1/auth/register",
            None,
            Some(json!({
                "username": alice_name,
                "password": "passwort123",
                "displayName": "Alice"
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);

    // ---- login and token rotation ----------------------------------------
    let (status, _) = app
        .call(
            "POST",
            "/api/v1/auth/login",
            None,
            Some(json!({ "username": alice_name, "password": "falsch" })),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, refreshed) = app
        .call(
            "POST",
            "/api/v1/auth/refresh",
            None,
            Some(json!({ "refreshToken": alice_refresh })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(refreshed["accessToken"].is_string());
    // A rotated refresh token cannot be replayed.
    let (status, _) = app
        .call(
            "POST",
            "/api/v1/auth/refresh",
            None,
            Some(json!({ "refreshToken": alice_refresh })),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Unauthenticated access is refused.
    let (status, _) = app.call("GET", "/api/v1/conversations", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // ---- direct conversation ---------------------------------------------
    let (status, conversation) = app
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&alice_token),
            Some(json!({ "type": "direct", "memberIds": [bob_id] })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let conversation_id = conversation["id"].as_str().unwrap().to_string();
    assert_eq!(conversation["members"].as_array().unwrap().len(), 2);

    // Creating it again returns the existing chat.
    let (_, again) = app
        .call(
            "POST",
            "/api/v1/conversations",
            Some(&alice_token),
            Some(json!({ "type": "direct", "memberIds": [bob_id] })),
        )
        .await;
    assert_eq!(again["id"], conversation_id);

    // ---- messages ---------------------------------------------------------
    let client_id = Uuid::now_v7().to_string();
    let (status, message) = app
        .call(
            "POST",
            &format!("/api/v1/conversations/{conversation_id}/messages"),
            Some(&alice_token),
            Some(json!({ "type": "text", "body": "Hallo Bob!", "clientId": client_id })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let message_id = message["id"].as_str().unwrap().to_string();

    // Idempotency: the same clientId returns the same message.
    let (_, retry) = app
        .call(
            "POST",
            &format!("/api/v1/conversations/{conversation_id}/messages"),
            Some(&alice_token),
            Some(json!({ "type": "text", "body": "Hallo Bob!", "clientId": client_id })),
        )
        .await;
    assert_eq!(retry["id"], message_id);

    let (_, inbox) = app
        .call("GET", "/api/v1/conversations", Some(&bob_token), None)
        .await;
    let chat = inbox["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == conversation_id.as_str())
        .expect("chat visible for bob");
    assert_eq!(chat["unreadCount"], 1);
    assert_eq!(chat["lastMessage"]["body"], "Hallo Bob!");

    let (status, _) = app
        .call(
            "POST",
            &format!("/api/v1/conversations/{conversation_id}/read"),
            Some(&bob_token),
            Some(json!({ "messageId": message_id })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let (_, inbox) = app
        .call("GET", "/api/v1/conversations", Some(&bob_token), None)
        .await;
    let chat = inbox["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["id"] == conversation_id.as_str())
        .unwrap();
    assert_eq!(chat["unreadCount"], 0);

    // ---- reactions --------------------------------------------------------
    let (status, reactions) = app
        .call(
            "PUT",
            &format!("/api/v1/messages/{message_id}/reactions"),
            Some(&bob_token),
            Some(json!({ "emoji": "👍" })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(reactions["reactions"][0]["emoji"], "👍");
    assert_eq!(reactions["reactions"][0]["userIds"][0], bob_id.as_str());

    let (_, reactions) = app
        .call(
            "DELETE",
            &format!("/api/v1/messages/{message_id}/reactions?emoji=%F0%9F%91%8D"),
            Some(&bob_token),
            None,
        )
        .await;
    assert_eq!(reactions["reactions"].as_array().unwrap().len(), 0);

    // ---- outsiders are locked out ----------------------------------------
    let (_, stranger) = app
        .call(
            "POST",
            "/api/v1/auth/register",
            None,
            Some(json!({
                "username": format!("eve{suffix}"),
                "password": "passwort123",
                "displayName": "Eve"
            })),
        )
        .await;
    let eve_token = stranger["accessToken"].as_str().unwrap().to_string();
    let (status, _) = app
        .call(
            "GET",
            &format!("/api/v1/conversations/{conversation_id}/messages"),
            Some(&eve_token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // ---- media upload and delivery ---------------------------------------
    // Smallest valid PNG (1x1 transparent pixel).
    let png = base64_decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    );
    let (status, upload) = app
        .call(
            "POST",
            "/api/v1/media/uploads",
            Some(&alice_token),
            Some(json!({
                "kind": "image",
                "mime": "image/png",
                "size": png.len(),
                "fileName": "pixel.png"
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(upload["strategy"], "direct");
    let attachment_id = upload["attachmentId"].as_str().unwrap().to_string();

    let boundary = "----initiativeboundary";
    let (status, _, _) = app
        .raw(
            "POST",
            &format!("/api/v1/media/uploads/{attachment_id}/data"),
            Some(&alice_token),
            vec![(
                "content-type",
                format!("multipart/form-data; boundary={boundary}"),
            )],
            Body::from(multipart_png(boundary, &png)),
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let (status, attachment) = app
        .call(
            "POST",
            &format!("/api/v1/media/uploads/{attachment_id}/complete"),
            Some(&alice_token),
            Some(json!({
                "width": 1,
                "height": 1,
                "previewDataUrl": "data:image/jpeg;base64,AAAA"
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(attachment["status"], "ready");
    assert_eq!(attachment["width"], 1);

    let (status, image_message) = app
        .call(
            "POST",
            &format!("/api/v1/conversations/{conversation_id}/messages"),
            Some(&alice_token),
            Some(json!({
                "type": "image",
                "body": "Ein Pixel",
                "attachmentIds": [attachment_id]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(image_message["attachments"].as_array().unwrap().len(), 1);

    // Capability URL: no Authorization header needed.
    let (status, headers, bytes) = app
        .raw(
            "GET",
            &format!("/api/v1/media/{attachment_id}"),
            None,
            vec![],
            Body::empty(),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(bytes.len(), png.len());
    assert!(headers
        .iter()
        .any(|(name, value)| name == "content-type" && value.contains("image/png")));

    // Range requests keep <video>/<audio> seeking working on iOS.
    let (status, headers, bytes) = app
        .raw(
            "GET",
            &format!("/api/v1/media/{attachment_id}"),
            None,
            vec![("range", "bytes=0-9".to_string())],
            Body::empty(),
        )
        .await;
    assert_eq!(status, StatusCode::PARTIAL_CONTENT);
    assert_eq!(bytes.len(), 10);
    assert!(headers.iter().any(
        |(name, value)| name == "content-range" && value == &format!("bytes 0-9/{}", png.len())
    ));

    // ---- stickers ---------------------------------------------------------
    let (status, pack) = app
        .call(
            "POST",
            "/api/v1/stickers/packs",
            Some(&alice_token),
            Some(json!({ "name": "Testpaket", "isPublic": true })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let pack_id = pack["id"].as_str().unwrap().to_string();

    let (_, sticker_upload) = app
        .call(
            "POST",
            "/api/v1/media/uploads",
            Some(&alice_token),
            Some(json!({
                "kind": "sticker",
                "mime": "image/png",
                "size": png.len(),
                "fileName": "sticker.png"
            })),
        )
        .await;
    let sticker_attachment = sticker_upload["attachmentId"].as_str().unwrap().to_string();
    app.call(
        "POST",
        &format!("/api/v1/media/uploads/{sticker_attachment}/complete"),
        Some(&alice_token),
        Some(json!({ "width": 512, "height": 512 })),
    )
    .await;

    let (status, pack) = app
        .call(
            "POST",
            &format!("/api/v1/stickers/packs/{pack_id}/stickers"),
            Some(&alice_token),
            Some(json!({ "attachmentId": sticker_attachment, "emoji": "😀" })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let sticker_id = pack["stickers"][0]["id"].as_str().unwrap().to_string();

    let (status, sticker_message) = app
        .call(
            "POST",
            &format!("/api/v1/conversations/{conversation_id}/messages"),
            Some(&alice_token),
            Some(json!({ "type": "sticker", "metadata": { "stickerId": sticker_id } })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    // The sticker is embedded by the message expander.
    assert_eq!(sticker_message["sticker"]["id"], sticker_id.as_str());
    assert_eq!(sticker_message["sticker"]["emoji"], "😀");

    let (_, discovered) = app
        .call("GET", "/api/v1/stickers/discover", Some(&bob_token), None)
        .await;
    assert!(discovered["items"]
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["id"] == pack_id.as_str()));

    // ---- poll -------------------------------------------------------------
    let (status, poll) = app
        .call(
            "POST",
            "/api/v1/polls",
            Some(&alice_token),
            Some(json!({
                "conversationId": conversation_id,
                "kind": "choice",
                "question": "Pizza oder Pasta?",
                "options": [{ "label": "Pizza" }, { "label": "Pasta" }]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let poll_id = poll["id"].as_str().unwrap().to_string();
    let pizza_id = poll["options"][0]["id"].as_str().unwrap().to_string();

    let (status, voted) = app
        .call(
            "POST",
            &format!("/api/v1/polls/{poll_id}/vote"),
            Some(&bob_token),
            Some(json!({ "votes": [{ "optionId": pizza_id, "value": "yes" }] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(voted["tally"][&pizza_id]["yes"], 1);
    assert_eq!(voted["voterCount"], 1);

    let (_, closed) = app
        .call(
            "POST",
            &format!("/api/v1/polls/{poll_id}/close"),
            Some(&alice_token),
            None,
        )
        .await;
    assert!(closed["closedAt"].is_string());

    let (status, _) = app
        .call(
            "POST",
            &format!("/api/v1/polls/{poll_id}/vote"),
            Some(&bob_token),
            Some(json!({ "votes": [{ "optionId": pizza_id, "value": "yes" }] })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // ---- date poll → calendar event --------------------------------------
    let start = chrono::Utc::now() + chrono::Duration::days(1);
    let (status, date_poll) = app
        .call(
            "POST",
            "/api/v1/polls",
            Some(&alice_token),
            Some(json!({
                "conversationId": conversation_id,
                "kind": "date",
                "question": "Wann treffen wir uns?",
                "options": [
                    { "startsAt": start, "endsAt": start + chrono::Duration::hours(1) },
                    {
                        "startsAt": start + chrono::Duration::days(1),
                        "endsAt": start + chrono::Duration::days(1) + chrono::Duration::hours(1)
                    }
                ]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let date_poll_id = date_poll["id"].as_str().unwrap().to_string();
    let option_id = date_poll["options"][0]["id"].as_str().unwrap().to_string();

    app.call(
        "POST",
        &format!("/api/v1/polls/{date_poll_id}/vote"),
        Some(&bob_token),
        Some(json!({ "votes": [{ "optionId": option_id, "value": "yes" }] })),
    )
    .await;

    let (_, best) = app
        .call(
            "GET",
            &format!("/api/v1/polls/{date_poll_id}/best-option"),
            Some(&alice_token),
            None,
        )
        .await;
    assert_eq!(best["option"]["id"], option_id.as_str());

    let (status, event) = app
        .call(
            "POST",
            &format!("/api/v1/polls/{date_poll_id}/event"),
            Some(&alice_token),
            Some(json!({
                "optionId": option_id,
                "title": "Gemeinsames Essen",
                "closePoll": true
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(event["title"], "Gemeinsames Essen");
    assert_eq!(event["sourcePollId"], date_poll_id.as_str());
    // Bob's "yes" is carried over as an RSVP.
    let bob_rsvp = event["attendees"]
        .as_array()
        .unwrap()
        .iter()
        .find(|attendee| attendee["userId"] == bob_id.as_str())
        .unwrap();
    assert_eq!(bob_rsvp["status"], "yes");

    // Creating a second event from the same poll is refused.
    let (status, _) = app
        .call(
            "POST",
            &format!("/api/v1/polls/{date_poll_id}/event"),
            Some(&alice_token),
            Some(json!({ "optionId": option_id })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // ---- calendar and ICS feed -------------------------------------------
    let series_start = chrono::Utc::now() + chrono::Duration::days(2);
    let (status, series) = app
        .call(
            "POST",
            "/api/v1/calendar/events",
            Some(&alice_token),
            Some(json!({
                "conversationId": conversation_id,
                "title": "Wöchentliches Treffen",
                "startsAt": series_start,
                "endsAt": series_start + chrono::Duration::hours(1),
                "rrule": "FREQ=WEEKLY;INTERVAL=1;COUNT=4",
                "reminderMinutes": [60]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let event_id = series["id"].as_str().unwrap().to_string();

    let (_, rsvp) = app
        .call(
            "POST",
            &format!("/api/v1/calendar/events/{event_id}/rsvp"),
            Some(&bob_token),
            Some(json!({ "status": "maybe" })),
        )
        .await;
    let bob_status = rsvp["attendees"]
        .as_array()
        .unwrap()
        .iter()
        .find(|attendee| attendee["userId"] == bob_id.as_str())
        .unwrap();
    assert_eq!(bob_status["status"], "maybe");

    let from = chrono::Utc::now();
    let to = chrono::Utc::now() + chrono::Duration::days(60);
    let (_, occurrences) = app
        .call(
            "GET",
            &format!(
                "/api/v1/calendar/events/{event_id}/occurrences?from={}&to={}",
                urlencoding::encode(&from.to_rfc3339()),
                urlencoding::encode(&to.to_rfc3339())
            ),
            Some(&alice_token),
            None,
        )
        .await;
    assert_eq!(occurrences["items"].as_array().unwrap().len(), 4);

    let (_, me) = app
        .call("GET", "/api/v1/auth/me", Some(&alice_token), None)
        .await;
    let calendar_token = me["calendarToken"].as_str().unwrap().to_string();

    let (status, headers, bytes) = app
        .raw(
            "GET",
            &format!("/api/v1/calendar/{calendar_token}/feed.ics"),
            None,
            vec![],
            Body::empty(),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers
        .iter()
        .any(|(name, value)| name == "content-type" && value.contains("text/calendar")));
    let ics = String::from_utf8(bytes).unwrap();
    assert!(ics.contains("BEGIN:VEVENT"));
    assert!(ics.contains("RRULE:FREQ=WEEKLY"));
    assert!(ics.contains("SUMMARY:Wöchentliches Treffen"));
    assert!(ics.contains("TRIGGER:-PT60M"));

    // ---- tic tac toe with server-side rule enforcement --------------------
    let (status, game) = app
        .call(
            "POST",
            "/api/v1/games/sessions",
            Some(&alice_token),
            Some(json!({
                "conversationId": conversation_id,
                "gameKey": "tic-tac-toe",
                "opponentIds": [bob_id]
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let session_id = game["id"].as_str().unwrap().to_string();
    assert_eq!(game["status"], "active");
    assert_eq!(game["turnUserId"], alice_id.as_str());

    // Bob may not move first.
    let (status, _) = app
        .call(
            "POST",
            &format!("/api/v1/games/sessions/{session_id}/moves"),
            Some(&bob_token),
            Some(json!({ "move": { "cell": 0 } })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, after_first) = app
        .call(
            "POST",
            &format!("/api/v1/games/sessions/{session_id}/moves"),
            Some(&alice_token),
            Some(json!({ "move": { "cell": 0 }, "version": game["version"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(after_first["turnUserId"], bob_id.as_str());

    // Occupied cell and nonsense input are both refused.
    for payload in [
        json!({ "move": { "cell": 0 } }),
        json!({ "move": { "cell": 99 } }),
    ] {
        let (status, _) = app
            .call(
                "POST",
                &format!("/api/v1/games/sessions/{session_id}/moves"),
                Some(&bob_token),
                Some(payload),
            )
            .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    let mut last = after_first;
    for (token, cell) in [
        (&bob_token, 3),
        (&alice_token, 1),
        (&bob_token, 4),
        (&alice_token, 2),
    ] {
        let (status, response) = app
            .call(
                "POST",
                &format!("/api/v1/games/sessions/{session_id}/moves"),
                Some(token),
                Some(json!({ "move": { "cell": cell } })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "move {cell} rejected");
        last = response;
    }
    assert_eq!(last["status"], "finished");
    assert_eq!(last["winnerUserIds"][0], alice_id.as_str());

    // ---- full text search -------------------------------------------------
    let (status, results) = app
        .call(
            "GET",
            "/api/v1/search/messages?q=Hallo",
            Some(&bob_token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert!(!results["items"].as_array().unwrap().is_empty());

    // ---- profile update broadcasts ---------------------------------------
    let (status, profile) = app
        .call(
            "PATCH",
            "/api/v1/users/me",
            Some(&alice_token),
            Some(json!({
                "displayName": "Alice A.",
                "settings": { "theme": "dark", "notifications": { "previews": false } }
            })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(profile["displayName"], "Alice A.");
    assert_eq!(profile["settings"]["theme"], "dark");
    assert_eq!(profile["settings"]["notifications"]["previews"], false);
    // Untouched defaults survive a partial settings patch.
    assert_eq!(profile["settings"]["notifications"]["push"], true);

    app.state.pool.close().await;
}

fn base64_decode(value: &str) -> Vec<u8> {
    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    STANDARD.decode(value).expect("valid base64")
}
