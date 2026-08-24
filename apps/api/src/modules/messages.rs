//! Nachrichten, Reaktionen und Volltextsuche.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, put};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::constants::{MESSAGE_BODY_MAX, MESSAGE_PAGE_SIZE, MESSAGE_PAGE_SIZE_MAX, MESSAGE_TYPES};
use crate::db::{MessageRow, ReactionRow};
use crate::dto::{ListResult, MessageDto};
use crate::error::{AppError, AppResult};
use crate::realtime::Event;
use crate::services::conversations::{assert_membership, member_ids};
use crate::services::messages::{
    create_message, hydrate_messages, load_message, publish_message_update, require_message,
    to_reaction_dtos, NewMessage,
};
use crate::state::AppState;
use crate::validate::Validator;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/conversations/{id}/messages",
            get(list_messages).post(send_message),
        )
        .route("/messages/{id}", get(by_id).patch(edit).delete(remove))
        .route(
            "/messages/{id}/reactions",
            put(add_reaction).delete(remove_reaction),
        )
        .route("/search/messages", get(search))
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    limit: Option<i64>,
    before: Option<Uuid>,
    after: Option<Uuid>,
}

async fn list_messages(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(query): Query<ListQuery>,
) -> AppResult<Json<ListResult<MessageDto>>> {
    assert_membership(&state.pool, id, user.id()).await?;
    let limit = query.limit.unwrap_or(MESSAGE_PAGE_SIZE).clamp(1, MESSAGE_PAGE_SIZE_MAX);

    // `after` walks forward (catching up), everything else walks backwards.
    let rows = if let Some(after) = query.after {
        sqlx::query_as::<_, MessageRow>(
            "select * from messages where conversation_id = $1 and id > $2 order by id asc limit $3",
        )
        .bind(id)
        .bind(after)
        .bind(limit)
        .fetch_all(&state.pool)
        .await?
    } else {
        let mut rows = sqlx::query_as::<_, MessageRow>(
            "select * from messages
             where conversation_id = $1 and ($2::uuid is null or id < $2)
             order by id desc limit $3",
        )
        .bind(id)
        .bind(query.before)
        .bind(limit)
        .fetch_all(&state.pool)
        .await?;
        rows.reverse();
        rows
    };

    let complete_page = rows.len() as i64 == limit;
    let next_cursor = if query.after.is_none() && complete_page {
        rows.first().map(|row| row.id.to_string())
    } else {
        None
    };

    let items = hydrate_messages(&state, rows, user.id()).await?;
    Ok(Json(ListResult::paged(items, next_cursor)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SendInput {
    #[serde(default = "default_message_type")]
    r#type: String,
    body: Option<String>,
    #[serde(default)]
    attachment_ids: Vec<Uuid>,
    reply_to_id: Option<Uuid>,
    client_id: Option<String>,
    metadata: Option<Value>,
}

fn default_message_type() -> String {
    "text".to_string()
}

async fn send_message(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<SendInput>,
) -> AppResult<(StatusCode, Json<MessageDto>)> {
    assert_membership(&state.pool, id, user.id()).await?;

    let metadata = input.metadata.unwrap_or_else(|| json!({}));
    let has_entity = ["stickerId", "pollId", "eventId", "gameSessionId"]
        .iter()
        .any(|key| metadata.get(*key).is_some());
    let body = input
        .body
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    Validator::new()
        .one_of("type", &input.r#type, MESSAGE_TYPES)
        .require("type", input.r#type != "system", "Systemnachrichten können nicht gesendet werden")
        .require(
            "body",
            body.is_some() || !input.attachment_ids.is_empty() || has_entity,
            "Nachricht braucht Text, Anhang oder Bezug",
        )
        .require(
            "body",
            body.as_ref().map(|value| value.chars().count()).unwrap_or(0) <= MESSAGE_BODY_MAX,
            "Nachricht ist zu lang",
        )
        .require(
            "attachmentIds",
            input.attachment_ids.len() <= crate::constants::ATTACHMENTS_PER_MESSAGE,
            "zu viele Anhänge",
        )
        .finish()?;

    let message = create_message(
        &state,
        NewMessage {
            conversation_id: id,
            sender_id: Some(user.id()),
            r#type: input.r#type,
            body,
            attachment_ids: input.attachment_ids,
            reply_to_id: input.reply_to_id,
            client_id: input.client_id,
            metadata,
            silent: false,
        },
    )
    .await?;

    Ok((StatusCode::CREATED, Json(message)))
}

async fn by_id(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<MessageDto>> {
    let row = require_message(&state.pool, id).await?;
    assert_membership(&state.pool, row.conversation_id, user.id()).await?;
    load_message(&state, id, user.id())
        .await?
        .map(Json)
        .ok_or_else(|| AppError::not_found("Nachricht nicht gefunden"))
}

#[derive(Debug, Deserialize)]
struct EditInput {
    body: String,
}

async fn edit(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<EditInput>,
) -> AppResult<Json<MessageDto>> {
    let row = require_message(&state.pool, id).await?;
    if row.sender_id != Some(user.id()) {
        return Err(AppError::forbidden("Nur eigene Nachrichten können bearbeitet werden"));
    }
    if row.deleted_at.is_some() {
        return Err(AppError::bad_request("Gelöschte Nachrichten können nicht bearbeitet werden"));
    }
    if row.r#type != "text" {
        return Err(AppError::bad_request("Nur Textnachrichten können bearbeitet werden"));
    }
    let body = input.body.trim().to_string();
    Validator::new()
        .length("body", &body, 1, MESSAGE_BODY_MAX)
        .finish()?;

    let updated = sqlx::query_as::<_, MessageRow>(
        "update messages set body = $2, edited_at = now() where id = $1 returning *",
    )
    .bind(id)
    .bind(&body)
    .fetch_one(&state.pool)
    .await?;

    let message = hydrate_messages(&state, vec![updated], user.id())
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::internal("Nachricht konnte nicht geladen werden"))?;
    publish_message_update(&state, &message).await?;
    Ok(Json(message))
}

async fn remove(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let row = require_message(&state.pool, id).await?;
    let membership = assert_membership(&state.pool, row.conversation_id, user.id()).await?;
    if row.sender_id != Some(user.id()) && membership.role == "member" {
        return Err(AppError::forbidden("Nur eigene Nachrichten können gelöscht werden"));
    }

    sqlx::query(
        "update messages set deleted_at = now(), body = null, metadata = '{}'::jsonb where id = $1",
    )
    .bind(id)
    .execute(&state.pool)
    .await?;
    sqlx::query("delete from attachments where message_id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?;

    let members = member_ids(&state.pool, row.conversation_id).await?;
    state
        .hub
        .publish(members, Event::message_deleted(row.conversation_id, id))
        .await;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
struct ReactionInput {
    emoji: String,
}

async fn publish_reactions(
    state: &AppState,
    message_id: Uuid,
    conversation_id: Uuid,
) -> AppResult<Json<Value>> {
    let rows = sqlx::query_as::<_, ReactionRow>("select * from reactions where message_id = $1")
        .bind(message_id)
        .fetch_all(&state.pool)
        .await?;
    let reactions = to_reaction_dtos(&rows);
    let members = member_ids(&state.pool, conversation_id).await?;
    state
        .hub
        .publish(
            members,
            Event::message_reactions(conversation_id, message_id, &reactions),
        )
        .await;
    Ok(Json(json!({ "reactions": reactions })))
}

async fn add_reaction(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<ReactionInput>,
) -> AppResult<Json<Value>> {
    let row = require_message(&state.pool, id).await?;
    assert_membership(&state.pool, row.conversation_id, user.id()).await?;
    let emoji = input.emoji.trim().to_string();
    Validator::new().length("emoji", &emoji, 1, 16).finish()?;

    sqlx::query(
        "insert into reactions (message_id, user_id, emoji) values ($1, $2, $3)
         on conflict (message_id, user_id, emoji) do nothing",
    )
    .bind(id)
    .bind(user.id())
    .bind(&emoji)
    .execute(&state.pool)
    .await?;

    publish_reactions(&state, id, row.conversation_id).await
}

async fn remove_reaction(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Query(input): Query<ReactionInput>,
) -> AppResult<Json<Value>> {
    let row = require_message(&state.pool, id).await?;
    assert_membership(&state.pool, row.conversation_id, user.id()).await?;

    sqlx::query("delete from reactions where message_id = $1 and user_id = $2 and emoji = $3")
        .bind(id)
        .bind(user.id())
        .bind(input.emoji.trim())
        .execute(&state.pool)
        .await?;

    publish_reactions(&state, id, row.conversation_id).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchQuery {
    q: String,
    conversation_id: Option<Uuid>,
    limit: Option<i64>,
}

async fn search(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<SearchQuery>,
) -> AppResult<Json<ListResult<MessageDto>>> {
    let needle = query.q.trim();
    if needle.chars().count() < 2 {
        return Ok(Json(ListResult::new(Vec::new())));
    }

    let rows = sqlx::query_as::<_, MessageRow>(
        "select m.*
         from messages m
         join conversation_members cm
           on cm.conversation_id = m.conversation_id and cm.user_id = $1
         where m.deleted_at is null
           and to_tsvector('simple', coalesce(m.body, '')) @@ websearch_to_tsquery('simple', $2)
           and ($3::uuid is null or m.conversation_id = $3)
         order by m.id desc
         limit $4",
    )
    .bind(user.id())
    .bind(needle)
    .bind(query.conversation_id)
    .bind(query.limit.unwrap_or(30).clamp(1, 50))
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(ListResult::new(
        hydrate_messages(&state, rows, user.id()).await?,
    )))
}
