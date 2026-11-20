//! Was rund um eine Nachricht dazukam: Zustellung und Lesebestätigungen,
//! Weiterleiten, gespeicherte Nachrichten (Sternchen) und Entwürfe je Chat.
//!
//! Ein eigenes Untermodul von `messages`, damit der Nachrichten-Router nicht
//! noch länger wird – die Wege hängen trotzdem unter demselben Router.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post, put};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::constants::MESSAGE_BODY_MAX;
use crate::db::MessageRow;
use crate::dto::{ListResult, MessageDto};
use crate::error::{AppError, AppResult};
use crate::realtime::Event;
use crate::services::conversations::{assert_membership, get_membership};
use crate::services::messages::weiterleiten::{weiterleiten, Auftrag};
use crate::services::messages::zustellung::{
    nachrichteninfo, staende, zustellung_melden, Nachrichteninfo, Stand,
};
use crate::services::messages::{hydrate_messages, require_message};
use crate::state::AppState;
use crate::validate::Validator;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/messages/zugestellt", post(zugestellt))
        .route("/messages/{id}/info", get(info))
        .route("/messages/{id}/weiterleiten", post(weiterleiten_route))
        .route(
            "/messages/{id}/stern",
            put(stern_setzen).delete(stern_entfernen),
        )
        .route("/sterne", get(sterne))
        .route("/sterne/kennungen", get(stern_kennungen))
        .route("/conversations/{id}/staende", get(staende_route))
        .route("/conversations/{id}/entwurf", put(entwurf_setzen))
        .route("/entwuerfe", get(entwuerfe))
}

/* ---------- Zustellung und Lesebestätigungen ---------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ZustellEintrag {
    conversation_id: Uuid,
    message_id: Uuid,
}

#[derive(Debug, Deserialize)]
struct ZustellInput {
    eintraege: Vec<ZustellEintrag>,
}

/// Höchstens so viele Chats je Meldung – der Client bündelt ohnehin.
const ZUSTELL_MAX: usize = 100;

/**
 * „Bis hierhin angekommen“ – gebündelt für mehrere Chats.
 *
 * Der Client meldet nach dem Empfang (Echtzeit, Nachladen, Chatliste) je
 * Chat die neueste fremde Nachricht, gesammelt und gedrosselt. Was nicht
 * passt (kein Mitglied, fremde Nachricht), wird still übergangen: Die
 * Meldung ist eine Auskunft, kein Auftrag, und ein einzelner veralteter
 * Eintrag soll die übrigen nicht verwerfen.
 */
async fn zugestellt(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<ZustellInput>,
) -> AppResult<Json<serde_json::Value>> {
    Validator::new()
        .require(
            "eintraege",
            input.eintraege.len() <= ZUSTELL_MAX,
            "zu viele Einträge",
        )
        .finish()?;
    let mut vorgerueckt = 0;
    for eintrag in input.eintraege {
        if get_membership(&state.pool, eintrag.conversation_id, user.id())
            .await?
            .is_none()
        {
            continue;
        }
        if zustellung_melden(
            &state,
            eintrag.conversation_id,
            user.id(),
            eintrag.message_id,
        )
        .await?
        {
            vorgerueckt += 1;
        }
    }
    Ok(Json(json!({ "vorgerueckt": vorgerueckt })))
}

/// Gelesen- und Zustellstände aller Mitglieder, wie ich sie sehen darf.
async fn staende_route(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<ListResult<Stand>>> {
    assert_membership(&state.pool, id, user.id()).await?;
    Ok(Json(ListResult::new(
        staende(&state.pool, id, user.id()).await?,
    )))
}

/// „Gelesen von / Zugestellt an“ – nur für eigene Nachrichten.
async fn info(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<Nachrichteninfo>> {
    let row = require_message(&state.pool, id).await?;
    assert_membership(&state.pool, row.conversation_id, user.id()).await?;
    if row.sender_id != Some(user.id()) {
        // Wer bei fremden Nachrichten nachsehen könnte, wer sie schon
        // gelesen hat, wüsste mehr über die anderen als ihr Absender zeigt.
        return Err(AppError::forbidden(
            "Die Nachrichteninfo gibt es nur für eigene Nachrichten",
        ));
    }
    Ok(Json(
        nachrichteninfo(&state.pool, id, row.conversation_id, user.id()).await?,
    ))
}

/* ---------- Weiterleiten ---------- */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WeiterleitenInput {
    conversation_ids: Vec<Uuid>,
    #[serde(default = "standard_herkunft")]
    herkunft: bool,
    client_id: Option<String>,
}

fn standard_herkunft() -> bool {
    true
}

async fn weiterleiten_route(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<WeiterleitenInput>,
) -> AppResult<(StatusCode, Json<ListResult<MessageDto>>)> {
    if let Some(client_id) = input.client_id.as_deref() {
        // Dieselbe Regel wie beim Senden: Der Doppelpunkt gehört dem Server.
        Validator::new()
            .length(
                "clientId",
                client_id,
                1,
                crate::constants::MESSAGE_CLIENT_ID_MAX,
            )
            .require(
                "clientId",
                !client_id.contains(':'),
                "ungültiger Wiederholungsschlüssel",
            )
            .finish()?;
    }
    let nachrichten = weiterleiten(
        &state,
        user.id(),
        Auftrag {
            message_id: id,
            ziele: input.conversation_ids,
            herkunft: input.herkunft,
            client_id: input.client_id,
        },
    )
    .await?;
    Ok((StatusCode::CREATED, Json(ListResult::new(nachrichten))))
}

/* ---------- Gespeicherte Nachrichten ---------- */

/// Sieht diese Person diese Nachricht (Mitglied, Grenze, nicht gelöscht, nicht
/// für sich verborgen)? Dieselbe Bedingung steht in der Liste als SQL.
const STERN_SICHTBAR: &str = "join conversation_members cm
       on cm.conversation_id = m.conversation_id and cm.user_id = $1
     where m.deleted_at is null
       and (cm.sieht_ab is null or m.created_at >= cm.sieht_ab)
       and not exists (select 1 from message_hidden h
                        where h.message_id = m.id and h.user_id = $1)";

async fn sichtbar_fuer(state: &AppState, message_id: Uuid, user_id: Uuid) -> AppResult<bool> {
    Ok(sqlx::query_scalar(&format!(
        "select exists (select 1 from messages m {STERN_SICHTBAR} and m.id = $2)"
    ))
    .bind(user_id)
    .bind(message_id)
    .fetch_one(&state.pool)
    .await?)
}

async fn stern_melden(state: &AppState, user_id: Uuid, row: &MessageRow, gesetzt: bool) {
    // Nur an mich: Sterne sieht niemand sonst. Die anderen Geräte führen
    // so ihre Markierung nach.
    state
        .hub
        .publish(
            vec![user_id],
            Event::new(
                "star.updated",
                json!({
                    "conversationId": row.conversation_id,
                    "messageId": row.id,
                    "starred": gesetzt,
                }),
            ),
        )
        .await;
}

async fn stern_setzen(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let row = require_message(&state.pool, id).await?;
    if !sichtbar_fuer(&state, id, user.id()).await? {
        return Err(AppError::not_found("Nachricht nicht gefunden"));
    }
    if crate::services::messages::ist_einmal(&row.metadata) {
        return Err(AppError::bad_request(
            "Einmal ansehbare Fotos und Videos lassen sich nicht speichern",
        ));
    }
    let neu = sqlx::query(
        "insert into message_stars (user_id, message_id) values ($1, $2)
         on conflict do nothing",
    )
    .bind(user.id())
    .bind(id)
    .execute(&state.pool)
    .await?
    .rows_affected()
        > 0;
    // Ein Neuversuch meldet nichts – es hat sich nichts geändert.
    if neu {
        stern_melden(&state, user.id(), &row, true).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn stern_entfernen(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let row = require_message(&state.pool, id).await?;
    let weg = sqlx::query("delete from message_stars where user_id = $1 and message_id = $2")
        .bind(user.id())
        .bind(id)
        .execute(&state.pool)
        .await?
        .rows_affected()
        > 0;
    if weg {
        stern_melden(&state, user.id(), &row, false).await;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct SterneQuery {
    before: Option<Uuid>,
    limit: Option<i64>,
}

/// Die gespeicherten Nachrichten, zuletzt gespeicherte zuerst.
///
/// Gefiltert wird in SQL, nicht danach: Eine Seite, aus der hinterher
/// Unsichtbares fällt, sähe für den Client aus wie das Ende der Liste (siehe
/// `list_messages`). Unsichtbar wird ein Stern, wenn die Nachricht gelöscht
/// oder für mich verborgen ist oder ich den Chat verlassen habe.
async fn sterne(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<SterneQuery>,
) -> AppResult<Json<ListResult<MessageDto>>> {
    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let rows = sqlx::query_as::<_, MessageRow>(&format!(
        "select m.* from message_stars s
           join messages m on m.id = s.message_id
           {STERN_SICHTBAR}
            and s.user_id = $1
            and ($2::uuid is null or (s.created_at, s.message_id) < (
                  select created_at, message_id from message_stars
                   where user_id = $1 and message_id = $2))
          order by s.created_at desc, s.message_id desc
          limit $3"
    ))
    .bind(user.id())
    .bind(query.before)
    .bind(limit)
    .fetch_all(&state.pool)
    .await?;
    let next = if rows.len() as i64 == limit {
        rows.last().map(|row| row.id.to_string())
    } else {
        None
    };
    let items = hydrate_messages(&state, rows, user.id()).await?;
    Ok(Json(ListResult::paged(items, next)))
}

/// Nur die Kennungen – damit die Blasen ihr Sternchen zeigen, ohne die ganze
/// Liste zu laden.
async fn stern_kennungen(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<ListResult<Uuid>>> {
    let ids: Vec<Uuid> = sqlx::query_scalar(&format!(
        "select m.id from message_stars s
           join messages m on m.id = s.message_id
           {STERN_SICHTBAR}
            and s.user_id = $1
          order by s.created_at desc
          limit 5000"
    ))
    .bind(user.id())
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(ListResult::new(ids)))
}

/* ---------- Entwürfe ---------- */

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct Entwurf {
    pub conversation_id: Uuid,
    pub text: Option<String>,
    pub reply_to_id: Option<Uuid>,
    pub updated_at: Option<DateTime<Utc>>,
}

async fn entwuerfe(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<ListResult<Entwurf>>> {
    let items = sqlx::query_as::<_, Entwurf>(
        "select conversation_id, draft as text, draft_reply_to_id as reply_to_id,
                draft_updated_at as updated_at
           from conversation_members
          where user_id = $1 and draft is not null",
    )
    .bind(user.id())
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(ListResult::new(items)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EntwurfInput {
    text: Option<String>,
    reply_to_id: Option<Uuid>,
    /// Wann das Gerät den Entwurf geschrieben hat. Der neueste gewinnt.
    stand: DateTime<Utc>,
}

/**
 * Den Entwurf eines Chats setzen (leerer Text: löschen).
 *
 * # Konfliktregel
 *
 * Der neueste Stand gewinnt: Ein Gerät, das offline weitergetippt hat und
 * spät meldet, überschreibt keinen neueren Entwurf eines anderen Geräts.
 * „Neu“ misst die Uhr des schreibenden Geräts; damit eine vorgehende Uhr
 * nicht auf Dauer gewinnt, wird ihr Stand auf die Serverzeit gekappt.
 *
 * Die Antwort ist der Entwurf, wie er danach gilt – auch wenn dieser Stand
 * verloren hat. So übernimmt das Gerät den gewinnenden.
 */
async fn entwurf_setzen(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<EntwurfInput>,
) -> AppResult<Json<serde_json::Value>> {
    assert_membership(&state.pool, id, user.id()).await?;
    let text = input
        .text
        .as_deref()
        .filter(|text| !text.trim().is_empty())
        .map(str::to_string);
    Validator::new()
        .require(
            "text",
            text.as_ref().map(|t| t.chars().count()).unwrap_or(0) <= MESSAGE_BODY_MAX,
            "Entwurf ist zu lang",
        )
        .finish()?;
    // Ein Antwortbezug nur auf etwas, das in diesem Chat liegt und das ich
    // sehen darf – sonst stünde über den Entwurf eine fremde Kennung im Feld.
    let reply_to_id = match (input.reply_to_id, text.is_some()) {
        (Some(antwort), true) => {
            let passt = crate::services::verlauf::darf_nachricht_sehen(
                &state.pool,
                antwort,
                user.id(),
            )
            .await?
                && sqlx::query_scalar::<_, bool>(
                    "select exists (select 1 from messages where id = $1 and conversation_id = $2)",
                )
                .bind(antwort)
                .bind(id)
                .fetch_one(&state.pool)
                .await?;
            passt.then_some(antwort)
        }
        _ => None,
    };
    let uebernommen = sqlx::query(
        "update conversation_members
            set draft = $3, draft_reply_to_id = $4, draft_updated_at = least($5, now())
          where conversation_id = $1 and user_id = $2
            and (draft_updated_at is null or draft_updated_at < least($5, now()))",
    )
    .bind(id)
    .bind(user.id())
    .bind(&text)
    .bind(reply_to_id)
    .bind(input.stand)
    .execute(&state.pool)
    .await?
    .rows_affected()
        > 0;
    let jetzt = entwurf_laden(&state, id, user.id()).await?;
    if uebernommen {
        entwurf_melden(&state, user.id(), &jetzt).await;
    }
    Ok(Json(
        json!({ "entwurf": jetzt, "uebernommen": uebernommen }),
    ))
}

async fn entwurf_laden(
    state: &AppState,
    conversation_id: Uuid,
    user_id: Uuid,
) -> AppResult<Entwurf> {
    Ok(sqlx::query_as::<_, Entwurf>(
        "select conversation_id, draft as text, draft_reply_to_id as reply_to_id,
                draft_updated_at as updated_at
           from conversation_members
          where conversation_id = $1 and user_id = $2",
    )
    .bind(conversation_id)
    .bind(user_id)
    .fetch_one(&state.pool)
    .await?)
}

async fn entwurf_melden(state: &AppState, user_id: Uuid, entwurf: &Entwurf) {
    state
        .hub
        .publish(
            vec![user_id],
            Event::new("draft.updated", json!({ "draft": entwurf })),
        )
        .await;
}

/// Nach dem Senden ist der Entwurf erledigt – auf allen Geräten.
///
/// Nur ein Entwurf, der älter ist als diese Nachricht: Hat ein anderes Gerät
/// inzwischen etwas Neues getippt, bleibt das stehen.
pub async fn entwurf_nach_senden(state: &AppState, conversation_id: Uuid, user_id: Uuid) {
    let geleert = sqlx::query(
        "update conversation_members
            set draft = null, draft_reply_to_id = null, draft_updated_at = now()
          where conversation_id = $1 and user_id = $2 and draft is not null
            and (draft_updated_at is null or draft_updated_at <= now())",
    )
    .bind(conversation_id)
    .bind(user_id)
    .execute(&state.pool)
    .await;
    match geleert {
        Ok(ergebnis) if ergebnis.rows_affected() > 0 => {
            if let Ok(entwurf) = entwurf_laden(state, conversation_id, user_id).await {
                entwurf_melden(state, user_id, &entwurf).await;
            }
        }
        Ok(_) => {}
        Err(fehler) => tracing::warn!(%fehler, "Entwurf nach dem Senden nicht geleert"),
    }
}
