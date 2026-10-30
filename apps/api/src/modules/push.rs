//! Web-Push-Abonnements für Benachrichtigungen.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::dto::PushPayload;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/push/public-key", get(public_key))
        .route("/push/subscriptions", post(subscribe).delete(unsubscribe))
        .route("/push/test", post(test))
}

async fn public_key(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(json!({
        "publicKey": state.push.public_key(),
        "enabled": state.push.enabled(),
    }))
}

#[derive(Debug, Deserialize)]
struct Keys {
    p256dh: String,
    auth: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscribeInput {
    endpoint: String,
    keys: Keys,
    user_agent: Option<String>,
}

async fn subscribe(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<SubscribeInput>,
) -> AppResult<(StatusCode, Json<serde_json::Value>)> {
    // Die Adresse bekommt später POST-Anfragen vom Server – siehe
    // `push::endpunkt_pruefen`, warum dort nicht jede stehen darf.
    crate::push::endpunkt_pruefen(&input.endpoint).map_err(AppError::bad_request)?;
    // Ein P-256-Schlüssel sind 87 Zeichen base64url, das Geheimnis 22. Die
    // Grenzen lassen Luft und halten trotzdem Megabytes aus der Tabelle.
    if input.keys.p256dh.len() > 200 || input.keys.auth.len() > 100 {
        return Err(AppError::bad_request("Push-Schlüssel ist zu lang"));
    }
    // Nach Zeichen kürzen, nicht nach Bytes: Ein Schnitt mitten in einem
    // Umlaut liess die Anfrage abstürzen.
    let user_agent: Option<String> = input
        .user_agent
        .as_deref()
        .map(|value| value.chars().take(300).collect());
    sqlx::query(
        "insert into push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (endpoint) do update
         set user_id = excluded.user_id,
             p256dh = excluded.p256dh,
             auth = excluded.auth,
             failure_count = 0",
    )
    .bind(Uuid::now_v7())
    .bind(user.id())
    .bind(&input.endpoint)
    .bind(&input.keys.p256dh)
    .bind(&input.keys.auth)
    .bind(user_agent)
    .execute(&state.pool)
    .await?;

    Ok((StatusCode::CREATED, Json(json!({ "ok": true }))))
}

#[derive(Debug, Deserialize)]
struct UnsubscribeInput {
    endpoint: String,
}

async fn unsubscribe(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<UnsubscribeInput>,
) -> AppResult<StatusCode> {
    sqlx::query("delete from push_subscriptions where user_id = $1 and endpoint = $2")
        .bind(user.id())
        .bind(&input.endpoint)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn test(State(state): State<AppState>, user: AuthUser) -> Json<serde_json::Value> {
    let delivered = state
        .push
        .send_to_users(
            &state.pool,
            &[user.id()],
            &PushPayload {
                title: "Initiative".to_string(),
                body: "Benachrichtigungen funktionieren 🎉".to_string(),
                tag: None,
                url: "/".to_string(),
                conversation_id: None,
                message_id: None,
                kind: "system".to_string(),
            },
        )
        .await;
    Json(json!({ "delivered": delivered }))
}
