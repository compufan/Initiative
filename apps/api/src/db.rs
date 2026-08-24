//! Database rows, mirroring `migrations/0001_init.sql`.
//!
//! Queries are written by hand with `sqlx::query_as` (no compile-time macros), so
//! the project builds without a live database – important for CI and Docker.

use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::FromRow;
use uuid::Uuid;

#[derive(Debug, Clone, FromRow)]
pub struct UserRow {
    pub id: Uuid,
    pub username: String,
    pub display_name: String,
    pub bio: Option<String>,
    pub password_hash: String,
    pub avatar_attachment_id: Option<Uuid>,
    pub calendar_token: String,
    pub settings: Value,
    pub last_seen_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
pub struct RefreshTokenRow {
    pub id: Uuid,
    pub user_id: Uuid,
    pub token_hash: String,
    pub expires_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, FromRow)]
pub struct PushSubscriptionRow {
    pub id: Uuid,
    pub user_id: Uuid,
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

#[derive(Debug, Clone, FromRow)]
pub struct ConversationRow {
    pub id: Uuid,
    pub r#type: String,
    pub title: Option<String>,
    pub avatar_attachment_id: Option<Uuid>,
    pub created_by: Option<Uuid>,
    pub last_message_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
pub struct ConversationMemberRow {
    pub conversation_id: Uuid,
    pub user_id: Uuid,
    pub role: String,
    pub nickname: Option<String>,
    pub last_read_message_id: Option<Uuid>,
    pub muted_until: Option<DateTime<Utc>>,
    pub archived: bool,
    pub joined_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
pub struct MessageRow {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub sender_id: Option<Uuid>,
    pub r#type: String,
    pub body: Option<String>,
    pub reply_to_id: Option<Uuid>,
    pub metadata: Value,
    pub client_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub edited_at: Option<DateTime<Utc>>,
    pub deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, FromRow)]
pub struct AttachmentRow {
    pub id: Uuid,
    pub message_id: Option<Uuid>,
    pub uploader_id: Option<Uuid>,
    pub kind: String,
    pub mime: String,
    pub size: i64,
    pub file_name: Option<String>,
    pub storage_key: String,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub duration_ms: Option<i32>,
    pub waveform: Option<Value>,
    pub preview_data_url: Option<String>,
    pub status: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
pub struct ReactionRow {
    pub message_id: Uuid,
    pub user_id: Uuid,
    pub emoji: String,
}

#[derive(Debug, Clone, FromRow)]
pub struct StickerPackRow {
    pub id: Uuid,
    pub owner_id: Option<Uuid>,
    pub name: String,
    pub cover_sticker_id: Option<Uuid>,
    pub is_public: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
pub struct StickerRow {
    pub id: Uuid,
    pub pack_id: Uuid,
    pub attachment_id: Uuid,
    pub emoji: Option<String>,
    pub width: i32,
    pub height: i32,
    pub position: i32,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
pub struct PollRow {
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
    pub created_event_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
pub struct PollOptionRow {
    pub id: Uuid,
    pub poll_id: Uuid,
    pub label: Option<String>,
    pub starts_at: Option<DateTime<Utc>>,
    pub ends_at: Option<DateTime<Utc>>,
    pub position: i32,
    pub created_by: Option<Uuid>,
}

#[derive(Debug, Clone, FromRow)]
pub struct PollVoteRow {
    pub poll_id: Uuid,
    pub option_id: Uuid,
    pub user_id: Uuid,
    pub value: String,
    pub voted_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
pub struct CalendarEventRow {
    pub id: Uuid,
    pub conversation_id: Option<Uuid>,
    pub created_by: Option<Uuid>,
    pub message_id: Option<Uuid>,
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub all_day: bool,
    pub rrule: Option<String>,
    pub color: Option<String>,
    pub reminder_minutes: Value,
    pub source_poll_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, FromRow)]
pub struct EventAttendeeRow {
    pub event_id: Uuid,
    pub user_id: Uuid,
    pub status: String,
    pub responded_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, FromRow)]
pub struct GameSessionRow {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub message_id: Option<Uuid>,
    pub game_key: String,
    pub status: String,
    pub state: Value,
    pub players: Value,
    pub turn_user_id: Option<Uuid>,
    pub winner_user_ids: Value,
    pub version: i32,
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Reads a `jsonb` array of integers (reminder minutes).
pub fn json_to_i32_vec(value: &Value) -> Vec<i32> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_i64().map(|number| number as i32))
                .collect()
        })
        .unwrap_or_default()
}

/// Reads a `jsonb` array of floats (voice message waveform).
pub fn json_to_f32_vec(value: &Value) -> Vec<f32> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_f64().map(|number| number as f32))
                .collect()
        })
        .unwrap_or_default()
}

pub fn json_to_uuid_vec(value: &Value) -> Vec<Uuid> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .filter_map(|item| Uuid::parse_str(item).ok())
                .collect()
        })
        .unwrap_or_default()
}
