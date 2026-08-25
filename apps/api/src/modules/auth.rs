//! Registrierung, Login und Token-Rotation.

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::auth::password::{hash_password, random_token, sha256_hex, verify_password};
use crate::auth::{jwt, AuthUser};
use crate::config::RegistrationMode;
use crate::db::UserRow;
use crate::drossel::{regeln, Absender};
use crate::dto::AuthSession;
use crate::error::{AppError, AppResult};
use crate::services::users::{load_user, to_self_user_dto};
use crate::state::AppState;
use crate::validate::{check_password, normalise_username, Validator};

/// Immer derselbe Satz – er darf nicht verraten, welche Grenze gegriffen hat.
fn zu_schnell() -> AppError {
    AppError::too_many("Zu viele Versuche. Warte einen Moment und versuch es dann noch einmal.")
}

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/auth/register", post(register))
        .route("/auth/login", post(login))
        .route("/auth/refresh", post(refresh))
        .route("/auth/logout", post(logout))
        .route("/auth/me", get(me))
        .route("/auth/password", post(change_password))
        .route("/auth/calendar-token/rotate", post(rotate_calendar_token))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterInput {
    username: String,
    password: String,
    display_name: String,
    invite_code: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginInput {
    username: String,
    password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RefreshInput {
    refresh_token: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangePasswordInput {
    current_password: String,
    new_password: String,
}

pub(crate) async fn issue_session(state: &AppState, user: &UserRow) -> AppResult<AuthSession> {
    let access_token = jwt::encode(
        &user.id.to_string(),
        "access",
        &state.config.jwt_secret,
        state.config.access_token_ttl.as_secs() as i64,
    );
    let refresh_token = random_token(48);
    let expires_at = chrono::Utc::now()
        + chrono::Duration::seconds(state.config.refresh_token_ttl.as_secs() as i64);

    sqlx::query(
        "insert into refresh_tokens (id, user_id, token_hash, expires_at) values ($1, $2, $3, $4)",
    )
    .bind(Uuid::now_v7())
    .bind(user.id)
    .bind(sha256_hex(&refresh_token))
    .bind(expires_at)
    .execute(&state.pool)
    .await?;

    Ok(AuthSession {
        access_token,
        expires_in: state.config.access_token_ttl.as_secs() as i64,
        refresh_token,
        user: to_self_user_dto(user, &state.config),
    })
}

async fn register(
    State(state): State<AppState>,
    absender: Absender,
    Json(input): Json<RegisterInput>,
) -> AppResult<(StatusCode, Json<AuthSession>)> {
    // Ohne Bremse liesse sich ein Einladungscode durchprobieren – und mit ihm
    // steht die Tuer zur ganzen App offen.
    if !state
        .drossel
        .erlaubt(&format!("register:{absender}"), regeln::REGISTRIEREN)
    {
        return Err(zu_schnell());
    }

    match state.config.registration_mode {
        RegistrationMode::Closed => {
            return Err(AppError::forbidden("Registrierung ist deaktiviert"))
        }
        RegistrationMode::Invite => {
            let provided = input.invite_code.clone().unwrap_or_default();
            let from_env = state
                .config
                .invite_codes
                .iter()
                .any(|code| code == &provided);
            // Von Admins angelegte Codes stehen in der Datenbank; INVITE_CODES
            // bleibt als Notnagel bestehen, falls niemand mehr hineinkommt.
            if !from_env && !invite_code_is_valid(&state, &provided).await? {
                return Err(AppError::forbidden("Ungültiger Einladungscode"));
            }
        }
        RegistrationMode::Open => {}
    }

    let username = normalise_username(&input.username)?;
    check_password(&input.password)?;
    let display_name = input.display_name.trim().to_string();
    Validator::new()
        .length(
            "displayName",
            &display_name,
            1,
            crate::constants::DISPLAY_NAME_MAX,
        )
        .finish()?;

    let existing: Option<(Uuid,)> = sqlx::query_as("select id from users where username = $1")
        .bind(&username)
        .fetch_optional(&state.pool)
        .await?;
    if existing.is_some() {
        return Err(AppError::conflict("Benutzername ist bereits vergeben"));
    }

    let user = sqlx::query_as::<_, UserRow>(
        "insert into users (id, username, display_name, password_hash, calendar_token)
         values ($1, $2, $3, $4, $5)
         returning *",
    )
    .bind(Uuid::now_v7())
    .bind(&username)
    .bind(&display_name)
    .bind(hash_password(&input.password)?)
    .bind(random_token(24))
    .fetch_one(&state.pool)
    .await?;

    if state.config.registration_mode == RegistrationMode::Invite {
        redeem_invite_code(&state, &input.invite_code.unwrap_or_default(), user.id).await?;
    }

    Ok((
        StatusCode::CREATED,
        Json(issue_session(&state, &user).await?),
    ))
}

/// Prüft, ob ein von einem Admin angelegter Code noch eingelöst werden darf.
async fn invite_code_is_valid(state: &AppState, code: &str) -> AppResult<bool> {
    if code.is_empty() {
        return Ok(false);
    }
    let usable: Option<bool> = sqlx::query_scalar(
        "select true from invite_codes
          where code = $1
            and revoked_at is null
            and (expires_at is null or expires_at > now())
            and (max_uses is null or uses < max_uses)",
    )
    .bind(code)
    .fetch_optional(&state.pool)
    .await?;
    Ok(usable.unwrap_or(false))
}

/// Zählt die Einlösung. Das `where` wiederholt die Bedingungen, damit zwei
/// gleichzeitige Registrierungen ein Limit nicht gemeinsam überschreiten.
async fn redeem_invite_code(state: &AppState, code: &str, user_id: Uuid) -> AppResult<()> {
    if code.is_empty() {
        return Ok(());
    }
    let consumed = sqlx::query(
        "update invite_codes
            set uses = uses + 1
          where code = $1
            and revoked_at is null
            and (expires_at is null or expires_at > now())
            and (max_uses is null or uses < max_uses)",
    )
    .bind(code)
    .execute(&state.pool)
    .await?;

    // Kein Treffer heißt: der Code kam aus INVITE_CODES, nicht aus der Tabelle.
    if consumed.rows_affected() > 0 {
        sqlx::query("insert into invite_redemptions (code, user_id) values ($1, $2)")
            .bind(code)
            .bind(user_id)
            .execute(&state.pool)
            .await?;
    }
    Ok(())
}

async fn login(
    State(state): State<AppState>,
    absender: Absender,
    Json(input): Json<LoginInput>,
) -> AppResult<Json<AuthSession>> {
    let username = input.username.trim().to_lowercase();

    // Zwei Schlüssel, weil es zwei Angriffe gibt: von einer Adresse aus viele
    // Konten durchprobieren, und von vielen Adressen aus ein Konto. Beide
    // Zähler laufen, beide bremsen.
    let von = format!("login:ip:{absender}");
    let konto = format!("login:konto:{username}");
    if !state.drossel.erlaubt(&von, regeln::ANMELDEN_ADRESSE)
        || !state.drossel.erlaubt(&konto, regeln::ANMELDEN)
    {
        return Err(zu_schnell());
    }

    let user = sqlx::query_as::<_, UserRow>("select * from users where username = $1")
        .bind(&username)
        .fetch_optional(&state.pool)
        .await?;

    // Always run a verification so timing does not reveal existing accounts.
    let dummy = "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHR2YWx1ZQ$3S1WQ8f0Y2v9m2r0Q3l0m4tZ7d1s8n0p2q4r6t8u0w2";
    let valid = match &user {
        Some(user) => verify_password(&input.password, &user.password_hash),
        None => {
            let _ = verify_password(&input.password, dummy);
            false
        }
    };

    let Some(user) = user.filter(|_| valid) else {
        return Err(AppError::unauthorized(
            "Benutzername oder Passwort ist falsch",
        ));
    };

    // Wer sich zweimal vertippt und dann richtig liegt, faengt bei null an.
    // Sonst zaehlt die Bremse die Fehlversuche eines ganzen Tages zusammen.
    state.drossel.zuruecksetzen(&von);
    state.drossel.zuruecksetzen(&konto);

    let _ = sqlx::query("update users set last_seen_at = now() where id = $1")
        .bind(user.id)
        .execute(&state.pool)
        .await;
    let _ = sqlx::query("delete from refresh_tokens where expires_at < now() - interval '7 days'")
        .execute(&state.pool)
        .await;

    Ok(Json(issue_session(&state, &user).await?))
}

async fn refresh(
    State(state): State<AppState>,
    absender: Absender,
    Json(input): Json<RefreshInput>,
) -> AppResult<Json<AuthSession>> {
    if !state
        .drossel
        .erlaubt(&format!("refresh:{absender}"), regeln::ERNEUERN)
    {
        return Err(zu_schnell());
    }
    let token = input
        .refresh_token
        .ok_or_else(|| AppError::unauthorized("Kein Refresh-Token"))?;
    let hash = sha256_hex(&token);

    let row = sqlx::query_as::<_, crate::db::RefreshTokenRow>(
        "select id, user_id, token_hash, expires_at, revoked_at
         from refresh_tokens where token_hash = $1",
    )
    .bind(&hash)
    .fetch_optional(&state.pool)
    .await?;

    let Some(row) = row else {
        return Err(AppError::unauthorized(
            "Sitzung abgelaufen, bitte neu anmelden",
        ));
    };
    if row.revoked_at.is_some() || row.expires_at <= chrono::Utc::now() {
        return Err(AppError::unauthorized(
            "Sitzung abgelaufen, bitte neu anmelden",
        ));
    }

    // Rotation: the presented token is burned before a new pair is issued.
    sqlx::query("update refresh_tokens set revoked_at = now() where id = $1")
        .bind(row.id)
        .execute(&state.pool)
        .await?;

    let user = load_user(&state.pool, row.user_id).await?;
    Ok(Json(issue_session(&state, &user).await?))
}

async fn logout(
    State(state): State<AppState>,
    Json(input): Json<RefreshInput>,
) -> AppResult<StatusCode> {
    if let Some(token) = input.refresh_token {
        sqlx::query("update refresh_tokens set revoked_at = now() where token_hash = $1")
            .bind(sha256_hex(&token))
            .execute(&state.pool)
            .await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn me(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<crate::dto::SelfUserDto>> {
    // Gibt es das Konto nicht mehr, ist der Token wertlos – und das muss auch
    // so heissen. „Nicht gefunden“ liest der Client als Stoerung und bleibt
    // angemeldet; nach einer Kontoloeschung auf einem anderen Geraet stuende
    // hier weiter eine Oberflaeche voller Daten, die es nicht mehr gibt.
    let row = load_user(&state.pool, user.id())
        .await
        .map_err(|_| AppError::unauthorized("Dieses Konto gibt es nicht mehr."))?;
    Ok(Json(to_self_user_dto(&row, &state.config)))
}

async fn change_password(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<ChangePasswordInput>,
) -> AppResult<StatusCode> {
    // Angemeldet, aber ein bequemer Weg, das alte Passwort zu erraten – etwa
    // an einem Geraet, das jemand kurz unbeaufsichtigt liess.
    if !state
        .drossel
        .erlaubt(&format!("pw:{}", user.id()), regeln::PASSWORT)
    {
        return Err(zu_schnell());
    }
    let row = load_user(&state.pool, user.id()).await?;
    if !verify_password(&input.current_password, &row.password_hash) {
        return Err(AppError::unauthorized("Aktuelles Passwort ist falsch"));
    }
    check_password(&input.new_password)?;

    sqlx::query("update users set password_hash = $1, updated_at = now() where id = $2")
        .bind(hash_password(&input.new_password)?)
        .bind(row.id)
        .execute(&state.pool)
        .await?;
    // Every other device has to sign in again.
    sqlx::query(
        "update refresh_tokens set revoked_at = now() where user_id = $1 and revoked_at is null",
    )
    .bind(row.id)
    .execute(&state.pool)
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

async fn rotate_calendar_token(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<serde_json::Value>> {
    let token = random_token(24);
    sqlx::query("update users set calendar_token = $1 where id = $2")
        .bind(&token)
        .bind(user.id())
        .execute(&state.pool)
        .await?;
    Ok(Json(json!({ "calendarToken": token })))
}
