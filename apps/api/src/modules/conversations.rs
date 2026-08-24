//! Chats, Mitglieder und Lesestatus.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, patch, post};
use axum::{Json, Router};
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::dto::{ConversationDto, ListResult};
use crate::error::{AppError, AppResult};
use crate::realtime::Event;
use crate::services::conversations::{
    assert_can_moderate, assert_membership, broadcast_conversation, find_direct_conversation,
    load_conversation_dto, load_conversation_dtos, member_ids, require_conversation, ListOptions,
};
use crate::services::messages::{create_message, NewMessage};
use crate::state::AppState;
use crate::validate::Validator;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/conversations", get(list).post(create))
        .route("/conversations/{id}", get(by_id).patch(update))
        .route("/conversations/{id}/members", post(add_members))
        .route(
            "/conversations/{id}/members/{user_id}",
            patch(update_member).delete(remove_member),
        )
        .route("/conversations/{id}/read", post(mark_read))
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    archived: Option<String>,
}

async fn list(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<ListQuery>,
) -> AppResult<Json<ListResult<ConversationDto>>> {
    let archived = query.archived.as_deref() == Some("true");
    let items = load_conversation_dtos(
        &state,
        user.id(),
        ListOptions { ids: None, include_archived: archived },
    )
    .await?;
    let items = if archived {
        items.into_iter().filter(|item| item.archived).collect()
    } else {
        items
    };
    Ok(Json(ListResult::new(items)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateInput {
    #[serde(default = "default_type")]
    r#type: String,
    title: Option<String>,
    member_ids: Vec<Uuid>,
    avatar_attachment_id: Option<Uuid>,
}

fn default_type() -> String {
    "direct".to_string()
}

async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<CreateInput>,
) -> AppResult<(StatusCode, Json<ConversationDto>)> {
    Validator::new()
        .one_of("type", &input.r#type, crate::constants::CONVERSATION_TYPES)
        .require("memberIds", !input.member_ids.is_empty(), "mindestens ein Mitglied")
        .require(
            "memberIds",
            input.r#type != "direct" || input.member_ids.len() == 1,
            "Direktchats brauchen genau ein Gegenüber",
        )
        .finish()?;

    let mut members = input.member_ids.clone();
    members.push(user.id());
    members.sort();
    members.dedup();

    let known: Vec<(Uuid,)> = sqlx::query_as("select id from users where id = any($1)")
        .bind(&members)
        .fetch_all(&state.pool)
        .await?;
    if known.len() != members.len() {
        return Err(AppError::bad_request("Unbekannte Mitglieder"));
    }

    if input.r#type == "direct" {
        let counterpart = input.member_ids[0];
        if counterpart == user.id() {
            return Err(AppError::bad_request("Chat mit sich selbst ist nicht möglich"));
        }
        if let Some(existing) = find_direct_conversation(&state.pool, user.id(), counterpart).await?
        {
            let dto = load_conversation_dto(&state, user.id(), existing).await?;
            return Ok((StatusCode::OK, Json(dto)));
        }
    }

    let conversation_id = Uuid::now_v7();
    let title = if input.r#type == "group" {
        Some(
            input
                .title
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "Neue Gruppe".to_string()),
        )
    } else {
        None
    };

    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "insert into conversations (id, type, title, avatar_attachment_id, created_by)
         values ($1, $2, $3, $4, $5)",
    )
    .bind(conversation_id)
    .bind(&input.r#type)
    .bind(&title)
    .bind(input.avatar_attachment_id)
    .bind(user.id())
    .execute(&mut *tx)
    .await?;

    for member_id in &members {
        sqlx::query(
            "insert into conversation_members (conversation_id, user_id, role) values ($1, $2, $3)",
        )
        .bind(conversation_id)
        .bind(member_id)
        .bind(if *member_id == user.id() { "owner" } else { "member" })
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    if input.r#type == "group" {
        create_message(
            &state,
            NewMessage::system(conversation_id, user.id(), "conversation.created", Vec::new()),
        )
        .await?;
    }

    broadcast_conversation(&state, conversation_id, Some(members)).await?;
    let dto = load_conversation_dto(&state, user.id(), conversation_id).await?;
    Ok((StatusCode::CREATED, Json(dto)))
}

async fn by_id(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<ConversationDto>> {
    assert_membership(&state.pool, id, user.id()).await?;
    Ok(Json(load_conversation_dto(&state, user.id(), id).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInput {
    #[serde(default, deserialize_with = "super::double_option")]
    title: Option<Option<String>>,
    #[serde(default, deserialize_with = "super::double_option")]
    avatar_attachment_id: Option<Option<Uuid>>,
    #[serde(default, deserialize_with = "super::double_option")]
    muted_until: Option<Option<chrono::DateTime<chrono::Utc>>>,
    archived: Option<bool>,
}

async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<UpdateInput>,
) -> AppResult<Json<ConversationDto>> {
    let membership = assert_membership(&state.pool, id, user.id()).await?;

    if input.title.is_some() || input.avatar_attachment_id.is_some() {
        if membership.role == "member" {
            return Err(AppError::forbidden("Nur Admins dürfen den Chat ändern"));
        }
        sqlx::query(
            "update conversations set
               title = case when $2 then $3 else title end,
               avatar_attachment_id = case when $4 then $5 else avatar_attachment_id end,
               updated_at = now()
             where id = $1",
        )
        .bind(id)
        .bind(input.title.is_some())
        .bind(input.title.clone().flatten())
        .bind(input.avatar_attachment_id.is_some())
        .bind(input.avatar_attachment_id.flatten())
        .execute(&state.pool)
        .await?;
    }

    if input.muted_until.is_some() || input.archived.is_some() {
        sqlx::query(
            "update conversation_members set
               muted_until = case when $3 then $4 else muted_until end,
               archived = coalesce($5, archived)
             where conversation_id = $1 and user_id = $2",
        )
        .bind(id)
        .bind(user.id())
        .bind(input.muted_until.is_some())
        .bind(input.muted_until.flatten())
        .bind(input.archived)
        .execute(&state.pool)
        .await?;
    }

    broadcast_conversation(&state, id, None).await?;
    Ok(Json(load_conversation_dto(&state, user.id(), id).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddMembersInput {
    member_ids: Vec<Uuid>,
}

async fn add_members(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<AddMembersInput>,
) -> AppResult<Json<ConversationDto>> {
    assert_can_moderate(&state.pool, id, user.id()).await?;
    let conversation = require_conversation(&state.pool, id).await?;
    if conversation.r#type == "direct" {
        return Err(AppError::bad_request("Direktchats haben feste Mitglieder"));
    }

    let mut ids = input.member_ids.clone();
    ids.sort();
    ids.dedup();
    let known: Vec<(Uuid,)> = sqlx::query_as("select id from users where id = any($1)")
        .bind(&ids)
        .fetch_all(&state.pool)
        .await?;
    if known.len() != ids.len() {
        return Err(AppError::bad_request("Unbekannte Mitglieder"));
    }

    for member_id in &ids {
        sqlx::query(
            "insert into conversation_members (conversation_id, user_id)
             values ($1, $2) on conflict (conversation_id, user_id) do nothing",
        )
        .bind(id)
        .bind(member_id)
        .execute(&state.pool)
        .await?;
    }

    create_message(
        &state,
        NewMessage::system(id, user.id(), "members.added", ids),
    )
    .await?;
    broadcast_conversation(&state, id, None).await?;
    Ok(Json(load_conversation_dto(&state, user.id(), id).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateMemberInput {
    role: Option<String>,
    #[serde(default, deserialize_with = "super::double_option")]
    nickname: Option<Option<String>>,
}

async fn update_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, target_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<UpdateMemberInput>,
) -> AppResult<Json<ConversationDto>> {
    if input.role.is_some() || target_id != user.id() {
        assert_can_moderate(&state.pool, id, user.id()).await?;
    } else {
        assert_membership(&state.pool, id, user.id()).await?;
    }
    if let Some(role) = &input.role {
        Validator::new()
            .one_of("role", role, crate::constants::MEMBER_ROLES)
            .finish()?;
    }

    sqlx::query(
        "update conversation_members set
           role = coalesce($3, role),
           nickname = case when $4 then $5 else nickname end
         where conversation_id = $1 and user_id = $2",
    )
    .bind(id)
    .bind(target_id)
    .bind(&input.role)
    .bind(input.nickname.is_some())
    .bind(input.nickname.flatten())
    .execute(&state.pool)
    .await?;

    broadcast_conversation(&state, id, None).await?;
    Ok(Json(load_conversation_dto(&state, user.id(), id).await?))
}

async fn remove_member(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, target_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    if target_id != user.id() {
        assert_can_moderate(&state.pool, id, user.id()).await?;
    } else {
        assert_membership(&state.pool, id, user.id()).await?;
    }

    let before = member_ids(&state.pool, id).await?;
    sqlx::query("delete from conversation_members where conversation_id = $1 and user_id = $2")
        .bind(id)
        .bind(target_id)
        .execute(&state.pool)
        .await?;

    let kind = if target_id == user.id() { "member.left" } else { "member.removed" };
    create_message(&state, NewMessage::system(id, user.id(), kind, vec![target_id])).await?;

    state
        .hub
        .publish(vec![target_id], Event::conversation_removed(id))
        .await;
    let remaining: Vec<Uuid> = before.into_iter().filter(|member| *member != target_id).collect();
    broadcast_conversation(&state, id, Some(remaining)).await?;

    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarkReadInput {
    message_id: Uuid,
}

async fn mark_read(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<MarkReadInput>,
) -> AppResult<Json<serde_json::Value>> {
    assert_membership(&state.pool, id, user.id()).await?;
    sqlx::query(
        "update conversation_members set last_read_message_id = $3
         where conversation_id = $1 and user_id = $2
           and (last_read_message_id is null or last_read_message_id < $3)",
    )
    .bind(id)
    .bind(user.id())
    .bind(input.message_id)
    .execute(&state.pool)
    .await?;

    let members = member_ids(&state.pool, id).await?;
    state
        .hub
        .publish(members, Event::read_updated(id, user.id(), input.message_id))
        .await;
    Ok(Json(serde_json::json!({ "ok": true })))
}
