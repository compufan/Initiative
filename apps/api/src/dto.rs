//! API payloads. Field names are camelCase to match the PWA's TypeScript types
//! in `packages/shared` – that package mirrors this file for the client.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Serialize)]
pub struct ListResult<T> {
    pub items: Vec<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<Option<String>>,
}

impl<T> ListResult<T> {
    pub fn new(items: Vec<T>) -> Self {
        Self { items, next_cursor: None }
    }

    pub fn paged(items: Vec<T>, next_cursor: Option<String>) -> Self {
        Self { items, next_cursor: Some(next_cursor) }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserDto {
    pub id: Uuid,
    pub username: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
    pub bio: Option<String>,
    pub accent: String,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfUserDto {
    #[serde(flatten)]
    pub user: UserDto,
    pub calendar_token: String,
    pub settings: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub access_token: String,
    pub expires_in: i64,
    pub refresh_token: String,
    pub user: SelfUserDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentDto {
    pub id: Uuid,
    pub kind: String,
    pub mime: String,
    pub size: i64,
    pub file_name: Option<String>,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub duration_ms: Option<i32>,
    pub waveform: Option<Vec<f32>>,
    pub preview_data_url: Option<String>,
    pub url: String,
    pub status: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactionDto {
    pub emoji: String,
    pub user_ids: Vec<Uuid>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageSnippet {
    pub id: Uuid,
    pub sender_id: Option<Uuid>,
    pub r#type: String,
    pub body: Option<String>,
    pub attachment_kind: Option<String>,
    pub deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageDto {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub sender_id: Option<Uuid>,
    pub r#type: String,
    pub body: Option<String>,
    pub attachments: Vec<AttachmentDto>,
    pub reply_to_id: Option<Uuid>,
    pub reply_to: Option<MessageSnippet>,
    pub metadata: Value,
    pub reactions: Vec<ReactionDto>,
    pub client_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub edited_at: Option<DateTime<Utc>>,
    pub deleted_at: Option<DateTime<Utc>>,
    /// Entities embedded by feature modules (see `services::expanders`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub poll: Option<PollDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<CalendarEventDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub game: Option<GameSessionDto>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sticker: Option<StickerDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationMemberDto {
    pub user_id: Uuid,
    pub role: String,
    pub joined_at: DateTime<Utc>,
    pub nickname: Option<String>,
    pub last_read_message_id: Option<Uuid>,
    pub user: UserDto,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDto {
    pub id: Uuid,
    pub r#type: String,
    pub title: Option<String>,
    pub avatar_url: Option<String>,
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub members: Vec<ConversationMemberDto>,
    pub last_message: Option<MessageDto>,
    pub unread_count: i64,
    pub muted_until: Option<DateTime<Utc>>,
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StickerDto {
    pub id: Uuid,
    pub pack_id: Uuid,
    pub pack_name: String,
    pub url: String,
    pub emoji: Option<String>,
    pub width: i32,
    pub height: i32,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StickerPackDto {
    pub id: Uuid,
    pub name: String,
    pub owner_id: Option<Uuid>,
    pub cover_url: Option<String>,
    pub is_public: bool,
    pub installed: bool,
    pub sticker_count: usize,
    pub stickers: Vec<StickerDto>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PollOptionDto {
    pub id: Uuid,
    pub label: String,
    pub starts_at: Option<DateTime<Utc>>,
    pub ends_at: Option<DateTime<Utc>>,
    pub position: i32,
    pub created_by: Option<Uuid>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PollVoteDto {
    pub option_id: Uuid,
    pub user_id: Uuid,
    pub value: String,
    pub voted_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptionTally {
    pub yes: i64,
    pub maybe: i64,
    pub no: i64,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PollDto {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub message_id: Option<Uuid>,
    pub created_by: Option<Uuid>,
    pub kind: String,
    pub question: String,
    pub description: Option<String>,
    pub multiple: bool,
    pub anonymous: bool,
    pub allow_add_options: bool,
    pub closes_at: Option<DateTime<Utc>>,
    pub closed_at: Option<DateTime<Utc>>,
    pub options: Vec<PollOptionDto>,
    pub votes: Vec<PollVoteDto>,
    pub tally: HashMap<Uuid, OptionTally>,
    pub voter_count: usize,
    pub my_votes: Vec<PollVoteDto>,
    pub created_event_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventAttendeeDto {
    pub user_id: Uuid,
    pub status: String,
    pub responded_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEventDto {
    pub id: Uuid,
    pub conversation_id: Option<Uuid>,
    pub created_by: Option<Uuid>,
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub all_day: bool,
    pub rrule: Option<String>,
    pub color: Option<String>,
    pub source_poll_id: Option<Uuid>,
    pub attendees: Vec<EventAttendeeDto>,
    pub reminder_minutes: Vec<i32>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GamePlayerDto {
    pub user_id: Uuid,
    pub seat: i32,
    pub joined_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSessionDto {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub message_id: Option<Uuid>,
    pub game_key: String,
    pub status: String,
    pub players: Vec<GamePlayerDto>,
    pub state: Value,
    pub turn_user_id: Option<Uuid>,
    pub winner_user_ids: Vec<Uuid>,
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub version: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameInfoDto {
    pub key: String,
    pub name: String,
    pub description: String,
    pub emoji: String,
    pub min_players: usize,
    pub max_players: usize,
}

/// Payload delivered to the service worker. Keep it small (< 4 KB).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushPayload {
    pub title: String,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag: Option<String>,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<Uuid>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_id: Option<Uuid>,
    pub kind: String,
}
