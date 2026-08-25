//! Anmelden mit Face ID, Fingerabdruck oder Geräte-PIN (WebAuthn/Passkeys).
//!
//! Der private Schlüssel bleibt im Gerät – in der Secure Enclave beim iPhone,
//! im Keystore bei Android. Der Server bekommt nur den öffentlichen Teil und
//! prüft damit die Signatur. Das ersetzt die Passworteingabe, ohne dass hier
//! ein zusätzliches Geheimnis liegt.
//!
//! Die Prüfung selbst übernimmt `webauthn-rs`; Signaturprüfung, COSE-Parsing
//! und Zählerstände sind nichts, was man selbst schreiben sollte.

use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;
use webauthn_rs::prelude::*;

use crate::auth::AuthUser;
use crate::db::UserRow;
use crate::drossel::{regeln, Absender};
use crate::dto::AuthSession;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// So lange darf zwischen Anfrage und Antwort des Geräts liegen.
const STATE_TTL_SECONDS: i64 = 300;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/passkeys", get(list))
        .route("/passkeys/{id}", axum::routing::delete(remove))
        .route("/passkeys/register/start", post(register_start))
        .route("/passkeys/register/finish", post(register_finish))
        .route("/passkeys/login/start", post(login_start))
        .route("/passkeys/login/finish", post(login_finish))
}

/// Baut die WebAuthn-Konfiguration aus der öffentlichen Adresse der App.
///
/// Die „Relying Party ID“ ist der nackte Hostname – ohne Schema und Port.
/// Passt sie nicht exakt zur Adresse im Browser, lehnt das Gerät ab.
fn webauthn(state: &AppState) -> AppResult<Webauthn> {
    let origin = Url::parse(&state.config.public_app_url).map_err(|error| {
        AppError::config(format!("PUBLIC_APP_URL ist keine gültige URL: {error}"))
    })?;
    let rp_id = origin
        .host_str()
        .ok_or_else(|| AppError::config("PUBLIC_APP_URL hat keinen Hostnamen"))?
        .to_string();

    WebauthnBuilder::new(&rp_id, &origin)
        .and_then(|builder| builder.rp_name("Initiative").build())
        .map_err(|error| AppError::config(format!("WebAuthn-Konfiguration: {error}")))
}

async fn store_state(
    state: &AppState,
    user_id: Option<Uuid>,
    purpose: &str,
    value: serde_json::Value,
) -> AppResult<Uuid> {
    // Beim Anlegen gleich aufraeumen. Abgeholt wird ein Zustand nur im
    // Erfolgsfall (`take_state`); jeder abgebrochene Versuch liesse sonst eine
    // Zeile zurueck, die nie wieder jemand anfasst.
    let _ = sqlx::query("delete from webauthn_states where expires_at < now()")
        .execute(&state.pool)
        .await;

    let id = Uuid::now_v7();
    sqlx::query(
        "insert into webauthn_states (id, user_id, purpose, state, expires_at)
         values ($1, $2, $3, $4, $5)",
    )
    .bind(id)
    .bind(user_id)
    .bind(purpose)
    .bind(value)
    .bind(Utc::now() + Duration::seconds(STATE_TTL_SECONDS))
    .execute(&state.pool)
    .await?;
    Ok(id)
}

/// Holt den Zwischenstand und löscht ihn dabei – jede Anfrage gilt genau einmal.
async fn take_state(
    state: &AppState,
    id: Uuid,
    purpose: &str,
) -> AppResult<(Option<Uuid>, serde_json::Value)> {
    let row: Option<(Option<Uuid>, serde_json::Value, DateTime<Utc>)> = sqlx::query_as(
        "delete from webauthn_states where id = $1 and purpose = $2
         returning user_id, state, expires_at",
    )
    .bind(id)
    .bind(purpose)
    .fetch_optional(&state.pool)
    .await?;

    let Some((user_id, value, expires_at)) = row else {
        return Err(AppError::bad_request(
            "Die Anfrage ist abgelaufen. Bitte noch einmal versuchen.",
        ));
    };
    if expires_at <= Utc::now() {
        return Err(AppError::bad_request(
            "Die Anfrage ist abgelaufen. Bitte noch einmal versuchen.",
        ));
    }
    Ok((user_id, value))
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct PasskeyDto {
    id: Uuid,
    label: String,
    last_used_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

async fn list(State(state): State<AppState>, user: AuthUser) -> AppResult<Json<Vec<PasskeyDto>>> {
    let rows = sqlx::query_as::<_, PasskeyDto>(
        "select id, label, last_used_at, created_at from passkeys
          where user_id = $1 order by created_at desc",
    )
    .bind(user.id())
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

async fn remove(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    let result = sqlx::query("delete from passkeys where id = $1 and user_id = $2")
        .bind(id)
        .bind(user.id())
        .execute(&state.pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(AppError::not_found("Nicht gefunden"));
    }
    Ok(Json(json!({ "removed": true })))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartResponse {
    /// Kennung, die bei „finish“ zurückkommen muss.
    request_id: Uuid,
    options: serde_json::Value,
}

async fn register_start(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<StartResponse>> {
    let webauthn = webauthn(&state)?;
    let account = sqlx::query_as::<_, UserRow>("select * from users where id = $1")
        .bind(user.id())
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::unauthorized("Konto nicht gefunden"))?;

    // Bereits hinterlegte Schlüssel ausschliessen, damit dasselbe Gerät nicht
    // zweimal registriert wird.
    let existing: Vec<String> =
        sqlx::query_scalar("select credential_id from passkeys where user_id = $1")
            .bind(user.id())
            .fetch_all(&state.pool)
            .await?;
    let exclude: Vec<CredentialID> = existing
        .iter()
        .filter_map(|id| URL_SAFE_NO_PAD.decode(id).ok())
        .map(CredentialID::from)
        .collect();

    let (options, registration) = webauthn
        .start_passkey_registration(
            account.id,
            &account.username,
            &account.display_name,
            Some(exclude),
        )
        .map_err(|error| AppError::internal(format!("WebAuthn: {error}")))?;

    let request_id = store_state(
        &state,
        Some(user.id()),
        "register",
        serde_json::to_value(&registration)
            .map_err(|error| AppError::internal(format!("WebAuthn-Zustand: {error}")))?,
    )
    .await?;

    Ok(Json(StartResponse {
        request_id,
        options: serde_json::to_value(&options)
            .map_err(|error| AppError::internal(format!("WebAuthn-Optionen: {error}")))?,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterFinishInput {
    request_id: Uuid,
    label: Option<String>,
    credential: RegisterPublicKeyCredential,
}

async fn register_finish(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<RegisterFinishInput>,
) -> AppResult<Json<PasskeyDto>> {
    let webauthn = webauthn(&state)?;
    let (owner, value) = take_state(&state, input.request_id, "register").await?;
    if owner != Some(user.id()) {
        return Err(AppError::forbidden("Anfrage gehört zu einem anderen Konto"));
    }

    let registration: PasskeyRegistration = serde_json::from_value(value)
        .map_err(|error| AppError::internal(format!("WebAuthn-Zustand: {error}")))?;

    let passkey = webauthn
        .finish_passkey_registration(&input.credential, &registration)
        .map_err(|error| AppError::bad_request(format!("Schlüssel abgelehnt: {error}")))?;

    let label = input
        .label
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Dieses Gerät".to_string());

    let row = sqlx::query_as::<_, PasskeyDto>(
        "insert into passkeys (id, user_id, credential_id, passkey, label)
         values ($1, $2, $3, $4, $5)
         returning id, label, last_used_at, created_at",
    )
    .bind(Uuid::now_v7())
    .bind(user.id())
    .bind(URL_SAFE_NO_PAD.encode(passkey.cred_id().as_ref()))
    .bind(
        serde_json::to_value(&passkey)
            .map_err(|error| AppError::internal(format!("Schlüssel: {error}")))?,
    )
    .bind(&label)
    .fetch_one(&state.pool)
    .await?;

    tracing::info!(user_id = %user.id(), "passkey registered");
    Ok(Json(row))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginStartInput {
    username: String,
}

async fn login_start(
    State(state): State<AppState>,
    absender: Absender,
    Json(input): Json<LoginStartInput>,
) -> AppResult<Json<StartResponse>> {
    // Jeder Aufruf legt - ohne Anmeldung - eine Zeile in `webauthn_states` an.
    // Ohne Bremse ist das eine Schleife, die die Tabelle flutet.
    if !state
        .drossel
        .erlaubt(&format!("passkey:{absender}"), regeln::PASSKEY)
    {
        return Err(AppError::too_many(
            "Zu viele Versuche. Warte einen Moment und versuch es dann noch einmal.",
        ));
    }
    let webauthn = webauthn(&state)?;
    let username = input.username.trim().to_lowercase();

    let rows: Vec<serde_json::Value> = sqlx::query_scalar(
        "select p.passkey from passkeys p
           join users u on u.id = p.user_id
          where u.username = $1",
    )
    .bind(&username)
    .fetch_all(&state.pool)
    .await?;

    // Kein Hinweis darauf, ob es das Konto gibt – sonst liesse sich damit die
    // Mitgliederliste abfragen.
    if rows.is_empty() {
        return Err(AppError::unauthorized(
            "Für diesen Namen ist kein Schlüssel hinterlegt.",
        ));
    }

    let passkeys: Vec<Passkey> = rows
        .into_iter()
        .filter_map(|value| serde_json::from_value(value).ok())
        .collect();

    let (options, authentication) = webauthn
        .start_passkey_authentication(&passkeys)
        .map_err(|error| AppError::internal(format!("WebAuthn: {error}")))?;

    let request_id = store_state(
        &state,
        None,
        "login",
        serde_json::to_value(&authentication)
            .map_err(|error| AppError::internal(format!("WebAuthn-Zustand: {error}")))?,
    )
    .await?;

    Ok(Json(StartResponse {
        request_id,
        options: serde_json::to_value(&options)
            .map_err(|error| AppError::internal(format!("WebAuthn-Optionen: {error}")))?,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginFinishInput {
    request_id: Uuid,
    credential: PublicKeyCredential,
}

async fn login_finish(
    State(state): State<AppState>,
    Json(input): Json<LoginFinishInput>,
) -> AppResult<Json<AuthSession>> {
    let webauthn = webauthn(&state)?;
    let (_, value) = take_state(&state, input.request_id, "login").await?;

    let authentication: PasskeyAuthentication = serde_json::from_value(value)
        .map_err(|error| AppError::internal(format!("WebAuthn-Zustand: {error}")))?;

    let result = webauthn
        .finish_passkey_authentication(&input.credential, &authentication)
        .map_err(|error| AppError::unauthorized(format!("Anmeldung abgelehnt: {error}")))?;

    let credential_id = URL_SAFE_NO_PAD.encode(result.cred_id().as_ref());
    let row: Option<(Uuid, serde_json::Value)> =
        sqlx::query_as("select id, passkey from passkeys where credential_id = $1")
            .bind(&credential_id)
            .fetch_optional(&state.pool)
            .await?;
    let Some((passkey_id, stored)) = row else {
        return Err(AppError::unauthorized(
            "Schlüssel ist nicht mehr hinterlegt",
        ));
    };

    // Zählerstand fortschreiben: Er verrät geklonte Geräte.
    if result.needs_update() {
        if let Ok(mut passkey) = serde_json::from_value::<Passkey>(stored) {
            passkey.update_credential(&result);
            if let Ok(value) = serde_json::to_value(&passkey) {
                let _ = sqlx::query("update passkeys set passkey = $2 where id = $1")
                    .bind(passkey_id)
                    .bind(value)
                    .execute(&state.pool)
                    .await;
            }
        }
    }

    let user = sqlx::query_as::<_, UserRow>(
        "select u.* from users u join passkeys p on p.user_id = u.id where p.id = $1",
    )
    .bind(passkey_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::unauthorized("Konto nicht gefunden"))?;

    let _ = sqlx::query("update passkeys set last_used_at = now() where id = $1")
        .bind(passkey_id)
        .execute(&state.pool)
        .await;
    let _ = sqlx::query("update users set last_seen_at = now() where id = $1")
        .bind(user.id)
        .execute(&state.pool)
        .await;

    tracing::info!(user_id = %user.id, "passkey login");
    Ok(Json(
        crate::modules::auth::issue_session(&state, &user).await?,
    ))
}
