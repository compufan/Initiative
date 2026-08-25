//! Admin-Modus: Einladungscodes verwalten und Mitglieder entfernen.
//!
//! Der Modus wird pro Konto mit einem Passwort freigeschaltet, das
//! ausschließlich serverseitig als `ADMIN_PASSWORD` liegt. Freigeschaltet wird
//! damit die Spalte `users.is_admin` – der Status hängt also an der Datenbank
//! und nicht an einem Schalter im Browser, den man einfach umlegen könnte.

use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::auth::{AdminUser, AuthUser};
use crate::drossel::regeln;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/admin/status", get(status))
        .route("/admin/unlock", post(unlock))
        .route("/admin/lock", post(lock))
        .route("/admin/invites", get(list_invites).post(create_invite))
        .route(
            "/admin/invites/{code}",
            axum::routing::delete(revoke_invite),
        )
        .route("/admin/members", get(list_members))
        .route("/admin/members/{id}", axum::routing::delete(remove_member))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AdminStatus {
    /// Ob überhaupt ein Admin-Passwort hinterlegt ist.
    available: bool,
    is_admin: bool,
}

async fn status(State(state): State<AppState>, user: AuthUser) -> AppResult<Json<AdminStatus>> {
    let is_admin: bool = sqlx::query_scalar("select is_admin from users where id = $1")
        .bind(user.id())
        .fetch_optional(&state.pool)
        .await?
        .unwrap_or(false);

    Ok(Json(AdminStatus {
        available: state.config.admin_password.is_some(),
        is_admin,
    }))
}

#[derive(Deserialize)]
struct UnlockInput {
    password: String,
}

async fn unlock(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<UnlockInput>,
) -> AppResult<Json<AdminStatus>> {
    // Ohne Bremse darf jedes angemeldete Konto das Admin-Passwort unbegrenzt
    // durchprobieren - und die Mindestlaenge sind acht Zeichen. Ein Treffer
    // ist Vollzugriff: Konten loeschen, Einladungscodes anlegen. Das war die
    // gefaehrlichste offene Stelle der ganzen API.
    if !state
        .drossel
        .erlaubt(&format!("admin:{}", user.id()), regeln::ADMIN)
    {
        return Err(AppError::too_many(
            "Zu viele Versuche. Warte einen Moment und versuch es dann noch einmal.",
        ));
    }

    let Some(expected) = state.config.admin_password.as_deref() else {
        return Err(AppError::forbidden(
            "Es ist kein Admin-Passwort hinterlegt (ADMIN_PASSWORD).",
        ));
    };

    // Konstante Laufzeit, damit sich das Passwort nicht zeichenweise erraten lässt.
    if !crate::auth::jwt::constant_time_eq(input.password.as_bytes(), expected.as_bytes()) {
        tracing::warn!(user_id = %user.id(), "failed admin unlock attempt");
        return Err(AppError::forbidden("Falsches Passwort"));
    }

    // Richtig geraten heisst: kein Verdacht mehr. Sonst bremst der Zaehler den
    // Admin selbst aus, der sich einmal vertippt hat.
    state.drossel.zuruecksetzen(&format!("admin:{}", user.id()));

    sqlx::query("update users set is_admin = true, updated_at = now() where id = $1")
        .bind(user.id())
        .execute(&state.pool)
        .await?;

    tracing::info!(user_id = %user.id(), "admin mode unlocked");
    Ok(Json(AdminStatus {
        available: true,
        is_admin: true,
    }))
}

async fn lock(State(state): State<AppState>, user: AuthUser) -> AppResult<Json<AdminStatus>> {
    sqlx::query("update users set is_admin = false, updated_at = now() where id = $1")
        .bind(user.id())
        .execute(&state.pool)
        .await?;

    Ok(Json(AdminStatus {
        available: state.config.admin_password.is_some(),
        is_admin: false,
    }))
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct InviteDto {
    code: String,
    note: Option<String>,
    max_uses: Option<i32>,
    uses: i32,
    expires_at: Option<DateTime<Utc>>,
    revoked_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

async fn list_invites(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> AppResult<Json<Vec<InviteDto>>> {
    let rows = sqlx::query_as::<_, InviteDto>(
        "select code, note, max_uses, uses, expires_at, revoked_at, created_at
           from invite_codes
          order by created_at desc
          limit 200",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateInviteInput {
    /// Wofür der Code gedacht ist – reine Gedächtnisstütze.
    note: Option<String>,
    /// Wie oft er eingelöst werden darf. `None` = unbegrenzt.
    max_uses: Option<i32>,
    /// Gültig bis. `None` = unbegrenzt.
    expires_at: Option<DateTime<Utc>>,
}

/// Erzeugt einen gut vorlesbaren Code – keine leicht verwechselbaren Zeichen.
fn generate_code() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let raw = crate::auth::password::random_token(32);
    let mut code = String::with_capacity(14);
    for (index, byte) in raw.as_bytes().iter().take(12).enumerate() {
        if index > 0 && index % 4 == 0 {
            code.push('-');
        }
        code.push(ALPHABET[*byte as usize % ALPHABET.len()] as char);
    }
    code
}

async fn create_invite(
    State(state): State<AppState>,
    admin: AdminUser,
    Json(input): Json<CreateInviteInput>,
) -> AppResult<Json<InviteDto>> {
    if input.max_uses.is_some_and(|value| value < 1) {
        return Err(AppError::bad_request(
            "max_uses muss mindestens 1 sein oder weggelassen werden",
        ));
    }

    let row = sqlx::query_as::<_, InviteDto>(
        "insert into invite_codes (code, note, created_by, max_uses, expires_at)
         values ($1, $2, $3, $4, $5)
         returning code, note, max_uses, uses, expires_at, revoked_at, created_at",
    )
    .bind(generate_code())
    .bind(
        input
            .note
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty()),
    )
    .bind(admin.id())
    .bind(input.max_uses)
    .bind(input.expires_at)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(row))
}

async fn revoke_invite(
    State(state): State<AppState>,
    _admin: AdminUser,
    Path(code): Path<String>,
) -> AppResult<Json<serde_json::Value>> {
    let result = sqlx::query(
        "update invite_codes set revoked_at = now() where code = $1 and revoked_at is null",
    )
    .bind(&code)
    .execute(&state.pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(AppError::not_found("Code nicht gefunden"));
    }
    Ok(Json(json!({ "revoked": true })))
}

#[derive(Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct MemberDto {
    id: Uuid,
    username: String,
    display_name: String,
    is_admin: bool,
    last_seen_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
}

async fn list_members(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> AppResult<Json<Vec<MemberDto>>> {
    let rows = sqlx::query_as::<_, MemberDto>(
        "select id, username, display_name, is_admin, last_seen_at, created_at
           from users
          order by created_at asc",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(rows))
}

async fn remove_member(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<serde_json::Value>> {
    if id == admin.id() {
        return Err(AppError::bad_request(
            "Das eigene Konto lässt sich hier nicht entfernen.",
        ));
    }

    // Den letzten verbliebenen Admin zu entfernen würde die Verwaltung
    // aussperren – dann käme man nur noch über die Datenbank wieder hinein.
    let target_is_admin: Option<bool> =
        sqlx::query_scalar("select is_admin from users where id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?;
    let Some(target_is_admin) = target_is_admin else {
        return Err(AppError::not_found("Konto nicht gefunden"));
    };
    if target_is_admin {
        let admins: i64 = sqlx::query_scalar("select count(*) from users where is_admin")
            .fetch_one(&state.pool)
            .await?;
        if admins <= 1 {
            return Err(AppError::bad_request(
                "Das ist das letzte Konto mit Adminrechten.",
            ));
        }
    }

    sqlx::query("delete from users where id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?;

    tracing::info!(by = %admin.id(), removed = %id, "member removed");
    Ok(Json(json!({ "removed": true })))
}

#[cfg(test)]
mod tests {
    use super::generate_code;

    #[test]
    fn codes_are_readable_and_unique() {
        let a = generate_code();
        let b = generate_code();
        assert_ne!(a, b, "zwei Codes duerfen nicht gleich sein");
        assert_eq!(a.len(), 14, "12 Zeichen plus zwei Trenner");
        assert_eq!(a.matches('-').count(), 2);
        // Keine leicht verwechselbaren Zeichen (0/O, 1/I).
        for forbidden in ['0', 'O', '1', 'I'] {
            assert!(
                !a.contains(forbidden),
                "Code {a} enthaelt verwechselbares Zeichen {forbidden}"
            );
        }
    }
}
