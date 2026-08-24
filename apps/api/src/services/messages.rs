//! Message assembly and the single entry point for putting a message into a chat.

use std::collections::HashMap;

use serde_json::{json, Value};
use sqlx::PgPool;
use uuid::Uuid;

use crate::db::{AttachmentRow, MessageRow, ReactionRow};
use crate::dto::{MessageDto, MessageSnippet, ReactionDto};
use crate::error::{AppError, AppResult};
use crate::realtime::Event;
use crate::state::AppState;

pub fn to_reaction_dtos(rows: &[ReactionRow]) -> Vec<ReactionDto> {
    let mut grouped: HashMap<String, Vec<Uuid>> = HashMap::new();
    for row in rows {
        grouped.entry(row.emoji.clone()).or_default().push(row.user_id);
    }
    let mut reactions: Vec<ReactionDto> = grouped
        .into_iter()
        .map(|(emoji, user_ids)| ReactionDto { emoji, user_ids })
        .collect();
    reactions.sort_by(|a, b| {
        b.user_ids
            .len()
            .cmp(&a.user_ids.len())
            .then_with(|| a.emoji.cmp(&b.emoji))
    });
    reactions
}

fn base_dto(row: &MessageRow) -> MessageDto {
    let deleted = row.deleted_at.is_some();
    MessageDto {
        id: row.id,
        conversation_id: row.conversation_id,
        sender_id: row.sender_id,
        r#type: row.r#type.clone(),
        body: if deleted { None } else { row.body.clone() },
        attachments: Vec::new(),
        reply_to_id: row.reply_to_id,
        reply_to: None,
        metadata: if deleted { json!({}) } else { row.metadata.clone() },
        reactions: Vec::new(),
        client_id: row.client_id.clone(),
        created_at: row.created_at,
        edited_at: row.edited_at,
        deleted_at: row.deleted_at,
        poll: None,
        event: None,
        game: None,
        sticker: None,
    }
}

/// Loads attachments, reactions, reply previews and module expansions in bulk.
pub async fn hydrate_messages(
    state: &AppState,
    rows: Vec<MessageRow>,
    viewer_id: Uuid,
) -> AppResult<Vec<MessageDto>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let ids: Vec<Uuid> = rows.iter().map(|row| row.id).collect();
    let mut reply_ids: Vec<Uuid> = rows.iter().filter_map(|row| row.reply_to_id).collect();
    reply_ids.sort();
    reply_ids.dedup();

    let attachments =
        super::attachments::load_by_message_ids(&state.pool, &ids, &state.config).await?;

    let reaction_rows =
        sqlx::query_as::<_, ReactionRow>("select * from reactions where message_id = any($1)")
            .bind(&ids)
            .fetch_all(&state.pool)
            .await?;
    let mut reactions_by_message: HashMap<Uuid, Vec<ReactionRow>> = HashMap::new();
    for row in reaction_rows {
        reactions_by_message.entry(row.message_id).or_default().push(row);
    }

    let mut replies: HashMap<Uuid, MessageSnippet> = HashMap::new();
    if !reply_ids.is_empty() {
        let reply_rows =
            sqlx::query_as::<_, MessageRow>("select * from messages where id = any($1)")
                .bind(&reply_ids)
                .fetch_all(&state.pool)
                .await?;
        let reply_row_ids: Vec<Uuid> = reply_rows.iter().map(|row| row.id).collect();
        let kinds = sqlx::query_as::<_, AttachmentRow>(
            "select distinct on (message_id) * from attachments where message_id = any($1)",
        )
        .bind(&reply_row_ids)
        .fetch_all(&state.pool)
        .await?;
        let mut kind_by_message: HashMap<Uuid, String> = HashMap::new();
        for row in kinds {
            if let Some(message_id) = row.message_id {
                kind_by_message.entry(message_id).or_insert(row.kind);
            }
        }
        for row in reply_rows {
            replies.insert(
                row.id,
                MessageSnippet {
                    id: row.id,
                    sender_id: row.sender_id,
                    r#type: row.r#type.clone(),
                    body: if row.deleted_at.is_some() { None } else { row.body.clone() },
                    attachment_kind: kind_by_message.get(&row.id).cloned(),
                    deleted_at: row.deleted_at,
                },
            );
        }
    }

    let mut expansions = super::expanders::run(state, viewer_id, &rows).await;
    let mut attachments = attachments;

    Ok(rows
        .into_iter()
        .map(|row| {
            let mut dto = base_dto(&row);
            if row.deleted_at.is_none() {
                dto.attachments = attachments.remove(&row.id).unwrap_or_default();
                if let Some(expansion) = expansions.remove(&row.id) {
                    dto.poll = expansion.poll;
                    dto.event = expansion.event;
                    dto.game = expansion.game;
                    dto.sticker = expansion.sticker;
                }
            }
            dto.reply_to = row.reply_to_id.and_then(|id| replies.get(&id).cloned());
            dto.reactions = reactions_by_message
                .remove(&row.id)
                .map(|rows| to_reaction_dtos(&rows))
                .unwrap_or_default();
            dto
        })
        .collect())
}

pub async fn load_message(
    state: &AppState,
    message_id: Uuid,
    viewer_id: Uuid,
) -> AppResult<Option<MessageDto>> {
    let rows = sqlx::query_as::<_, MessageRow>("select * from messages where id = $1")
        .bind(message_id)
        .fetch_all(&state.pool)
        .await?;
    Ok(hydrate_messages(state, rows, viewer_id).await?.into_iter().next())
}

pub async fn require_message(pool: &PgPool, message_id: Uuid) -> AppResult<MessageRow> {
    sqlx::query_as::<_, MessageRow>("select * from messages where id = $1")
        .bind(message_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::not_found("Nachricht nicht gefunden"))
}

#[derive(Debug, Clone)]
pub struct NewMessage {
    pub conversation_id: Uuid,
    pub sender_id: Option<Uuid>,
    pub r#type: String,
    pub body: Option<String>,
    pub attachment_ids: Vec<Uuid>,
    pub reply_to_id: Option<Uuid>,
    pub client_id: Option<String>,
    pub metadata: Value,
    /// Skip push notifications – used for system messages.
    pub silent: bool,
}

impl NewMessage {
    pub fn text(conversation_id: Uuid, sender_id: Uuid, body: impl Into<String>) -> Self {
        Self {
            conversation_id,
            sender_id: Some(sender_id),
            r#type: "text".to_string(),
            body: Some(body.into()),
            attachment_ids: Vec::new(),
            reply_to_id: None,
            client_id: None,
            metadata: json!({}),
            silent: false,
        }
    }

    pub fn system(conversation_id: Uuid, actor_id: Uuid, kind: &str, targets: Vec<Uuid>) -> Self {
        Self {
            conversation_id,
            sender_id: Some(actor_id),
            r#type: "system".to_string(),
            body: None,
            attachment_ids: Vec::new(),
            reply_to_id: None,
            client_id: None,
            metadata: json!({
                "system": { "kind": kind, "actorId": actor_id, "targetIds": targets }
            }),
            silent: true,
        }
    }

    pub fn entity(conversation_id: Uuid, sender_id: Uuid, r#type: &str, key: &str, id: Uuid) -> Self {
        Self {
            conversation_id,
            sender_id: Some(sender_id),
            r#type: r#type.to_string(),
            body: None,
            attachment_ids: Vec::new(),
            reply_to_id: None,
            client_id: None,
            metadata: json!({ key: id }),
            silent: false,
        }
    }
}

/// Creates a message, broadcasts it and triggers push notifications.
///
/// Feature modules (polls, calendar, games …) call this so their cards behave
/// exactly like any other message.
pub async fn create_message(state: &AppState, input: NewMessage) -> AppResult<MessageDto> {
    let body = input
        .body
        .as_ref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    // Idempotency: a retried send returns the original message.
    if let (Some(client_id), Some(sender_id)) = (input.client_id.as_ref(), input.sender_id) {
        let existing = sqlx::query_as::<_, MessageRow>(
            "select * from messages
             where conversation_id = $1 and sender_id = $2 and client_id = $3
             limit 1",
        )
        .bind(input.conversation_id)
        .bind(sender_id)
        .bind(client_id)
        .fetch_optional(&state.pool)
        .await?;
        if let Some(row) = existing {
            let dto = hydrate_messages(state, vec![row], sender_id)
                .await?
                .into_iter()
                .next()
                .ok_or_else(|| AppError::internal("Nachricht konnte nicht geladen werden"))?;
            return Ok(dto);
        }
    }

    if let Some(reply_to_id) = input.reply_to_id {
        let exists: Option<(Uuid,)> =
            sqlx::query_as("select id from messages where id = $1 and conversation_id = $2")
                .bind(reply_to_id)
                .bind(input.conversation_id)
                .fetch_optional(&state.pool)
                .await?;
        if exists.is_none() {
            return Err(AppError::bad_request(
                "Antwort bezieht sich auf eine unbekannte Nachricht",
            ));
        }
    }

    let id = Uuid::now_v7();
    let row = sqlx::query_as::<_, MessageRow>(
        "insert into messages (id, conversation_id, sender_id, type, body, reply_to_id, metadata, client_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning *",
    )
    .bind(id)
    .bind(input.conversation_id)
    .bind(input.sender_id)
    .bind(&input.r#type)
    .bind(&body)
    .bind(input.reply_to_id)
    .bind(&input.metadata)
    .bind(&input.client_id)
    .fetch_one(&state.pool)
    .await?;

    if !input.attachment_ids.is_empty() {
        sqlx::query(
            "update attachments
             set message_id = $1, status = 'ready'
             where id = any($2) and message_id is null
               and ($3::uuid is null or uploader_id = $3)",
        )
        .bind(id)
        .bind(&input.attachment_ids)
        .bind(input.sender_id)
        .execute(&state.pool)
        .await?;
    }

    super::conversations::touch_conversation(&state.pool, input.conversation_id).await?;

    let viewer = input.sender_id.unwrap_or_else(Uuid::nil);
    let message = hydrate_messages(state, vec![row], viewer)
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| AppError::internal("Nachricht konnte nicht geladen werden"))?;

    let members = super::conversations::member_ids(&state.pool, input.conversation_id).await?;
    state.hub.publish(members.clone(), Event::message_new(&message)).await;

    if !input.silent {
        super::notify::notify_new_message(state, &message, &members).await;
    }
    Ok(message)
}

pub async fn publish_message_update(state: &AppState, message: &MessageDto) -> AppResult<()> {
    let members = super::conversations::member_ids(&state.pool, message.conversation_id).await?;
    state.hub.publish(members, Event::message_updated(message)).await;
    Ok(())
}

/// Refreshes the chat card that belongs to an entity (poll, event, game).
pub async fn republish_message(
    state: &AppState,
    message_id: Option<Uuid>,
    viewer_id: Uuid,
) -> AppResult<()> {
    let Some(message_id) = message_id else {
        return Ok(());
    };
    if let Some(message) = load_message(state, message_id, viewer_id).await? {
        publish_message_update(state, &message).await?;
    }
    Ok(())
}
