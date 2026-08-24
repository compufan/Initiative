//! Conversation membership, permissions and the viewer-specific chat list.

use std::collections::HashMap;

use sqlx::PgPool;
use uuid::Uuid;

use crate::db::{ConversationMemberRow, ConversationRow, MessageRow};
use crate::dto::{ConversationDto, ConversationMemberDto, UserDto};
use crate::error::{AppError, AppResult};
use crate::realtime::Event;
use crate::state::AppState;

pub async fn require_conversation(pool: &PgPool, id: Uuid) -> AppResult<ConversationRow> {
    sqlx::query_as::<_, ConversationRow>("select * from conversations where id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::not_found("Chat nicht gefunden"))
}

pub async fn get_membership(
    pool: &PgPool,
    conversation_id: Uuid,
    user_id: Uuid,
) -> AppResult<Option<ConversationMemberRow>> {
    Ok(sqlx::query_as::<_, ConversationMemberRow>(
        "select * from conversation_members where conversation_id = $1 and user_id = $2",
    )
    .bind(conversation_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await?)
}

pub async fn assert_membership(
    pool: &PgPool,
    conversation_id: Uuid,
    user_id: Uuid,
) -> AppResult<ConversationMemberRow> {
    get_membership(pool, conversation_id, user_id)
        .await?
        .ok_or_else(|| AppError::forbidden("Du bist kein Mitglied dieses Chats"))
}

pub async fn assert_can_moderate(
    pool: &PgPool,
    conversation_id: Uuid,
    user_id: Uuid,
) -> AppResult<ConversationMemberRow> {
    let membership = assert_membership(pool, conversation_id, user_id).await?;
    if membership.role == "member" {
        return Err(AppError::forbidden("Nur Admins dürfen das ändern"));
    }
    Ok(membership)
}

pub async fn member_ids(pool: &PgPool, conversation_id: Uuid) -> AppResult<Vec<Uuid>> {
    let rows: Vec<(Uuid,)> =
        sqlx::query_as("select user_id from conversation_members where conversation_id = $1")
            .bind(conversation_id)
            .fetch_all(pool)
            .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

pub async fn touch_conversation(pool: &PgPool, conversation_id: Uuid) -> AppResult<()> {
    sqlx::query(
        "update conversations set last_message_at = now(), updated_at = now() where id = $1",
    )
    .bind(conversation_id)
    .execute(pool)
    .await?;
    Ok(())
}

#[derive(Debug, Default, Clone)]
pub struct ListOptions {
    pub ids: Option<Vec<Uuid>>,
    pub include_archived: bool,
}

#[derive(sqlx::FromRow)]
struct ConversationListRow {
    id: Uuid,
    r#type: String,
    title: Option<String>,
    avatar_attachment_id: Option<Uuid>,
    created_by: Option<Uuid>,
    created_at: chrono::DateTime<chrono::Utc>,
    updated_at: chrono::DateTime<chrono::Utc>,
    archived: bool,
    muted_until: Option<chrono::DateTime<chrono::Utc>>,
}

/// Assembles the chat list in a fixed number of queries, regardless of size.
pub async fn load_conversation_dtos(
    state: &AppState,
    viewer_id: Uuid,
    options: ListOptions,
) -> AppResult<Vec<ConversationDto>> {
    let rows = sqlx::query_as::<_, ConversationListRow>(
        "select c.id, c.type, c.title, c.avatar_attachment_id, c.created_by, c.created_at,
                c.updated_at, cm.archived, cm.muted_until
         from conversations c
         join conversation_members cm on cm.conversation_id = c.id and cm.user_id = $1
         where ($2::uuid[] is null or c.id = any($2))
           and ($3 or cm.archived = false)
         order by coalesce(c.last_message_at, c.created_at) desc
         limit 300",
    )
    .bind(viewer_id)
    .bind(options.ids.as_deref())
    .bind(options.include_archived)
    .fetch_all(&state.pool)
    .await?;

    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let conversation_ids: Vec<Uuid> = rows.iter().map(|row| row.id).collect();

    let member_rows = sqlx::query_as::<_, ConversationMemberRow>(
        "select * from conversation_members where conversation_id = any($1) order by joined_at asc",
    )
    .bind(&conversation_ids)
    .fetch_all(&state.pool)
    .await?;

    let last_message_rows = sqlx::query_as::<_, MessageRow>(
        "select distinct on (conversation_id) *
         from messages
         where conversation_id = any($1) and deleted_at is null
         order by conversation_id, id desc",
    )
    .bind(&conversation_ids)
    .fetch_all(&state.pool)
    .await?;

    let unread_rows: Vec<(Uuid, i64)> = sqlx::query_as(
        "select cm.conversation_id, count(m.id)::bigint
         from conversation_members cm
         join messages m
           on m.conversation_id = cm.conversation_id
          and m.deleted_at is null
          and (m.sender_id is null or m.sender_id <> cm.user_id)
          and (cm.last_read_message_id is null or m.id > cm.last_read_message_id)
         where cm.user_id = $1 and cm.conversation_id = any($2)
         group by cm.conversation_id",
    )
    .bind(viewer_id)
    .bind(&conversation_ids)
    .fetch_all(&state.pool)
    .await?;

    let user_ids: Vec<Uuid> = member_rows.iter().map(|row| row.user_id).collect();
    let users = super::users::load_users_by_ids(&state.pool, &user_ids, &state.config).await?;
    let last_messages =
        super::messages::hydrate_messages(state, last_message_rows, viewer_id).await?;

    let mut members_by_conversation: HashMap<Uuid, Vec<ConversationMemberDto>> = HashMap::new();
    for row in member_rows {
        members_by_conversation
            .entry(row.conversation_id)
            .or_default()
            .push(ConversationMemberDto {
                user_id: row.user_id,
                role: row.role.clone(),
                joined_at: row.joined_at,
                nickname: row.nickname.clone(),
                last_read_message_id: row.last_read_message_id,
                user: users
                    .get(&row.user_id)
                    .cloned()
                    .unwrap_or_else(|| unknown_user(row.user_id)),
            });
    }

    let mut last_by_conversation: HashMap<Uuid, crate::dto::MessageDto> = HashMap::new();
    for message in last_messages {
        last_by_conversation.insert(message.conversation_id, message);
    }
    let unread_by_conversation: HashMap<Uuid, i64> = unread_rows.into_iter().collect();

    Ok(rows
        .into_iter()
        .map(|row| ConversationDto {
            avatar_url: row
                .avatar_attachment_id
                .map(|id| state.config.media_url(&id)),
            members: members_by_conversation.remove(&row.id).unwrap_or_default(),
            last_message: last_by_conversation.remove(&row.id),
            unread_count: unread_by_conversation.get(&row.id).copied().unwrap_or(0),
            id: row.id,
            r#type: row.r#type,
            title: row.title,
            created_by: row.created_by,
            created_at: row.created_at,
            updated_at: row.updated_at,
            muted_until: row.muted_until,
            archived: row.archived,
        })
        .collect())
}

fn unknown_user(user_id: Uuid) -> UserDto {
    UserDto {
        id: user_id,
        username: "unbekannt".to_string(),
        display_name: "Unbekannt".to_string(),
        avatar_url: None,
        bio: None,
        accent: "#78716c".to_string(),
        last_seen_at: None,
        created_at: chrono::DateTime::UNIX_EPOCH,
    }
}

pub async fn load_conversation_dto(
    state: &AppState,
    viewer_id: Uuid,
    conversation_id: Uuid,
) -> AppResult<ConversationDto> {
    load_conversation_dtos(
        state,
        viewer_id,
        ListOptions {
            ids: Some(vec![conversation_id]),
            include_archived: true,
        },
    )
    .await?
    .into_iter()
    .next()
    .ok_or_else(|| AppError::not_found("Chat nicht gefunden"))
}

/// Conversation payloads are viewer specific, so every member gets their own copy.
pub async fn broadcast_conversation(
    state: &AppState,
    conversation_id: Uuid,
    targets: Option<Vec<Uuid>>,
) -> AppResult<()> {
    let targets = match targets {
        Some(ids) => ids,
        None => member_ids(&state.pool, conversation_id).await?,
    };
    for user_id in targets {
        if let Ok(conversation) = load_conversation_dto(state, user_id, conversation_id).await {
            state
                .hub
                .publish(vec![user_id], Event::conversation_updated(&conversation))
                .await;
        }
    }
    Ok(())
}

/// Existing 1:1 chat between two users, if any.
pub async fn find_direct_conversation(
    pool: &PgPool,
    user_a: Uuid,
    user_b: Uuid,
) -> AppResult<Option<Uuid>> {
    let row: Option<(Uuid,)> = sqlx::query_as(
        "select c.id
         from conversations c
         join conversation_members a on a.conversation_id = c.id and a.user_id = $1
         join conversation_members b on b.conversation_id = c.id and b.user_id = $2
         where c.type = 'direct'
         limit 1",
    )
    .bind(user_a)
    .bind(user_b)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(id,)| id))
}
