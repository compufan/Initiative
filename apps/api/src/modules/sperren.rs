//! Blockieren und Melden.
//!
//! # Blockieren
//!
//! Wer jemanden blockiert, bekommt von ihm im Direktchat nichts mehr
//! (`conversations::senden_erlaubt`), und der Blockierte sieht vom anderen
//! weder Bild noch „zuletzt online“, weder Präsenz noch Tippen
//! (`services::privatsphaere`). In der Personensuche tauchen beide füreinander
//! nicht mehr auf, und keiner kann den anderen neu anschreiben oder in eine
//! Gruppe holen. Gemeinsame Gruppen bleiben – dort entscheidet die Gruppe,
//! nicht einer allein.
//!
//! # Melden
//!
//! Eine Person oder eine Nachricht, mit Grund und Freitext. Die Verwaltung
//! sieht, was der Meldende in dem Augenblick sah (`nachricht_auszug`), statt
//! in fremde Chats hineinzusehen. Melden darf man nur, was man sehen darf –
//! sonst wäre die Meldung ein Weg, die Existenz fremder Nachrichten zu prüfen.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::auth::{AdminUser, AuthUser};
use crate::dto::{ListResult, UserDto};
use crate::error::{AppError, AppResult};
use crate::realtime::Event;
use crate::services::conversations::find_direct_conversation;
use crate::state::AppState;
use crate::validate::Validator;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/blockiert", get(blockiert))
        .route("/users/{id}/block", put(blockieren).delete(freigeben))
        .route("/meldungen", post(melden))
        .route("/admin/meldungen", get(meldungen))
        .route("/admin/meldungen/{id}", patch(meldung_bearbeiten))
}

pub const GRUENDE: &[&str] = &[
    "spam",
    "belaestigung",
    "unangemessen",
    "gewalt",
    "sonstiges",
];
pub const STATUS: &[&str] = &["offen", "in_bearbeitung", "erledigt", "abgewiesen"];
const FREITEXT_MAX: usize = 1000;

async fn blockiert(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<ListResult<UserDto>>> {
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "select blocked_id from user_blocks where blocker_id = $1 order by created_at desc",
    )
    .bind(user.id())
    .fetch_all(&state.pool)
    .await?;
    let profile =
        crate::services::users::load_users_by_ids(&state.pool, &ids, &state.config).await?;
    let mut liste: Vec<UserDto> = ids
        .iter()
        .filter_map(|id| profile.get(id).cloned())
        .collect();
    crate::services::privatsphaere::fuer_betrachter(
        &state.pool,
        user.id(),
        liste.iter_mut(),
        false,
    )
    .await?;
    Ok(Json(ListResult::new(liste)))
}

async fn blockieren(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    if id == user.id() {
        return Err(AppError::bad_request("Sich selbst blockiert man nicht"));
    }
    crate::services::users::load_user(&state.pool, id).await?;
    sqlx::query(
        "insert into user_blocks (blocker_id, blocked_id) values ($1, $2)
         on conflict do nothing",
    )
    .bind(user.id())
    .bind(id)
    .execute(&state.pool)
    .await?;
    nach_aenderung_melden(&state, user.id(), id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn freigeben(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    sqlx::query("delete from user_blocks where blocker_id = $1 and blocked_id = $2")
        .bind(user.id())
        .bind(id)
        .execute(&state.pool)
        .await?;
    nach_aenderung_melden(&state, user.id(), id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Beide Seiten bekommen die neue Fassung: Der Blockierte das Profil ohne Bild
/// (bzw. nach der Freigabe wieder mit), beide den Direktchat, der jetzt
/// gesperrt oder offen ist.
async fn nach_aenderung_melden(state: &AppState, ich: Uuid, andere: Uuid) -> AppResult<()> {
    let zeile = crate::services::users::load_user(&state.pool, ich).await?;
    let mut profil = crate::services::users::to_user_dto(&zeile, &state.config);
    crate::services::privatsphaere::fuer_betrachter(
        &state.pool,
        andere,
        std::iter::once(&mut profil),
        false,
    )
    .await?;
    state
        .hub
        .publish(vec![andere], Event::user_updated(&profil))
        .await;
    if let Some(chat) = find_direct_conversation(&state.pool, ich, andere).await? {
        crate::services::conversations::broadcast_conversation(state, chat, None).await?;
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MeldungInput {
    user_id: Option<Uuid>,
    message_id: Option<Uuid>,
    grund: String,
    freitext: Option<String>,
}

async fn melden(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<MeldungInput>,
) -> AppResult<StatusCode> {
    let freitext = input
        .freitext
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string);
    Validator::new()
        .one_of("grund", &input.grund, GRUENDE)
        .length(
            "freitext",
            freitext.as_deref().unwrap_or_default(),
            0,
            FREITEXT_MAX,
        )
        .require(
            "userId",
            input.user_id.is_some() || input.message_id.is_some(),
            "Person oder Nachricht angeben",
        )
        .finish()?;
    // Dieselbe Bremse wie die Personensuche wäre zu locker: Melden schreibt.
    if !state.drossel.erlaubt(
        &format!("melden:{}", user.id()),
        crate::drossel::Regel::neu(20, std::time::Duration::from_secs(3600)),
    ) {
        return Err(AppError::too_many(
            "Zu viele Meldungen. Warte einen Moment.",
        ));
    }

    let (mut ziel, mut chat, mut auszug) = (input.user_id, None, None);
    if let Some(nachricht) = input.message_id {
        if !crate::services::verlauf::darf_nachricht_sehen(&state.pool, nachricht, user.id())
            .await?
        {
            return Err(AppError::not_found("Nachricht nicht gefunden"));
        }
        let zeile = crate::services::messages::require_message(&state.pool, nachricht).await?;
        ziel = ziel.or(zeile.sender_id);
        chat = Some(zeile.conversation_id);
        auszug = zeile
            .body
            .filter(|_| zeile.deleted_at.is_none())
            .map(|text| text.chars().take(2000).collect::<String>());
    }
    if let Some(ziel) = ziel {
        if ziel == user.id() {
            return Err(AppError::bad_request("Sich selbst meldet man nicht"));
        }
        crate::services::users::load_user(&state.pool, ziel).await?;
    }
    sqlx::query(
        "insert into reports (id, reporter_id, target_user_id, message_id, conversation_id,
                              grund, freitext, nachricht_auszug)
         values ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(Uuid::now_v7())
    .bind(user.id())
    .bind(ziel)
    .bind(input.message_id)
    .bind(chat)
    .bind(&input.grund)
    .bind(&freitext)
    .bind(&auszug)
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::CREATED)
}

#[derive(Debug, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
struct MeldungDto {
    id: Uuid,
    reporter_id: Option<Uuid>,
    reporter_name: Option<String>,
    target_user_id: Option<Uuid>,
    target_name: Option<String>,
    target_username: Option<String>,
    message_id: Option<Uuid>,
    conversation_id: Option<Uuid>,
    grund: String,
    freitext: Option<String>,
    nachricht_auszug: Option<String>,
    status: String,
    notiz: Option<String>,
    bearbeitet_von: Option<Uuid>,
    bearbeitet_at: Option<chrono::DateTime<chrono::Utc>>,
    created_at: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Deserialize)]
struct MeldungenQuery {
    status: Option<String>,
}

const MELDUNG_SPALTEN: &str = "r.id, r.reporter_id, ru.display_name as reporter_name,
    r.target_user_id, tu.display_name as target_name, tu.username as target_username,
    r.message_id, r.conversation_id, r.grund, r.freitext, r.nachricht_auszug, r.status,
    r.notiz, r.bearbeitet_von, r.bearbeitet_at, r.created_at";

async fn meldungen(
    State(state): State<AppState>,
    _admin: AdminUser,
    Query(query): Query<MeldungenQuery>,
) -> AppResult<Json<ListResult<MeldungDto>>> {
    if let Some(status) = &query.status {
        Validator::new().one_of("status", status, STATUS).finish()?;
    }
    let liste = sqlx::query_as::<_, MeldungDto>(&format!(
        "select {MELDUNG_SPALTEN}
           from reports r
           left join users ru on ru.id = r.reporter_id
           left join users tu on tu.id = r.target_user_id
          where ($1::text is null or r.status = $1)
          order by (r.status = 'offen') desc, r.created_at desc
          limit 200"
    ))
    .bind(&query.status)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(ListResult::new(liste)))
}

#[derive(Debug, Deserialize)]
struct BearbeitenInput {
    status: Option<String>,
    notiz: Option<String>,
}

async fn meldung_bearbeiten(
    State(state): State<AppState>,
    admin: AdminUser,
    Path(id): Path<Uuid>,
    Json(input): Json<BearbeitenInput>,
) -> AppResult<Json<MeldungDto>> {
    if let Some(status) = &input.status {
        Validator::new().one_of("status", status, STATUS).finish()?;
    }
    if let Some(notiz) = &input.notiz {
        Validator::new()
            .length("notiz", notiz, 0, FREITEXT_MAX)
            .finish()?;
    }
    let geaendert: Option<Uuid> = sqlx::query_scalar(
        "update reports set
           status = coalesce($2, status),
           notiz = coalesce($3, notiz),
           bearbeitet_von = $4,
           bearbeitet_at = now()
         where id = $1
         returning id",
    )
    .bind(id)
    .bind(&input.status)
    .bind(input.notiz.as_deref().map(str::trim))
    .bind(admin.id())
    .fetch_optional(&state.pool)
    .await?;
    if geaendert.is_none() {
        return Err(AppError::not_found("Meldung nicht gefunden"));
    }
    let meldung = sqlx::query_as::<_, MeldungDto>(&format!(
        "select {MELDUNG_SPALTEN}
           from reports r
           left join users ru on ru.id = r.reporter_id
           left join users tu on tu.id = r.target_user_id
          where r.id = $1"
    ))
    .bind(id)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(meldung))
}
