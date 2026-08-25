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
    /// `planning`, `confirmed` oder `cancelled` (`migrations/0005_events.sql`).
    pub status: String,
    /// Die Umfrage, mit der der Zeitpunkt gefunden wird.
    pub poll_id: Option<Uuid>,
    /// Die Sammlung mit den Dateien zu diesem Termin.
    pub collection_id: Option<Uuid>,
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

/// Ein Ordner in „Dateien & Sammlungen“ (`migrations/0004_collections.sql`).
#[derive(Debug, Clone, FromRow)]
pub struct CollectionRow {
    pub id: Uuid,
    pub parent_id: Option<Uuid>,
    pub conversation_id: Option<Uuid>,
    pub name: String,
    pub description: Option<String>,
    pub color: Option<String>,
    pub member_level: String,
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

/// Eine Datei in einer Sammlung.
#[derive(Debug, Clone, FromRow)]
pub struct CollectionItemRow {
    pub id: Uuid,
    pub collection_id: Uuid,
    pub attachment_id: Uuid,
    pub added_by: Option<Uuid>,
    pub title: Option<String>,
    pub note: Option<String>,
    pub message_id: Option<Uuid>,
    pub sort_key: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

/// Ein ausdrücklich vergebenes Recht an einer Sammlung oder einer Datei.
#[derive(Debug, Clone, FromRow)]
pub struct CollectionGrantRow {
    pub id: Uuid,
    pub collection_id: Option<Uuid>,
    pub item_id: Option<Uuid>,
    pub user_id: Option<Uuid>,
    pub conversation_id: Option<Uuid>,
    pub level: String,
    pub granted_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

/// Wo eine Umfrage überall auftaucht (`migrations/0005_events.sql`).
#[derive(Debug, Clone, FromRow)]
pub struct PollPlacementRow {
    pub id: Uuid,
    pub poll_id: Uuid,
    pub conversation_id: Uuid,
    pub message_id: Option<Uuid>,
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
}

/// Eine Notiz an einem Termin, mit eigenen Änderungsrechten.
#[derive(Debug, Clone, FromRow)]
pub struct EventNoteRow {
    pub id: Uuid,
    pub event_id: Uuid,
    pub author_id: Option<Uuid>,
    pub title: Option<String>,
    pub body: String,
    pub edit_scope: String,
    /// Wer Punkte hinzufuegen darf, und wer abhaken darf. Bei einer Liste
    /// sind das drei verschiedene Fragen – siehe Migration 0010.
    pub add_scope: String,
    pub check_scope: String,
    pub position: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

/// Ein Punkt in einer Notizliste.
#[derive(Debug, Clone, FromRow)]
pub struct EventNoteItemRow {
    pub id: Uuid,
    pub note_id: Uuid,
    pub text: String,
    pub position: i32,
    /// Wie viele muessen abhaken. 0 heisst: niemand muss.
    pub required_checks: i32,
    /// Schlaegt die Zahl: alle Eingeladenen, auch die von morgen.
    pub required_all: bool,
    pub created_by: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Ein Dokument an einem Termin.
#[derive(Debug, Clone, FromRow)]
pub struct EventAttachmentRow {
    pub id: Uuid,
    pub event_id: Uuid,
    pub attachment_id: Uuid,
    pub added_by: Option<Uuid>,
    pub title: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// Eine Ausgabe (`migrations/0006_expenses.sql`).
#[derive(Debug, Clone, FromRow)]
pub struct ExpenseRow {
    pub id: Uuid,
    pub conversation_id: Option<Uuid>,
    pub event_id: Option<Uuid>,
    pub created_by: Option<Uuid>,
    pub title: String,
    pub note: Option<String>,
    pub amount_cents: i64,
    pub currency: String,
    pub paid_by: Option<Uuid>,
    pub spent_at: DateTime<Utc>,
    pub visibility: String,
    pub settled_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, FromRow)]
pub struct ExpenseShareRow {
    pub expense_id: Uuid,
    pub user_id: Uuid,
    pub amount_cents: i64,
    pub settled_at: Option<DateTime<Utc>>,
    /// Wer abgehakt hat. Der Schuldner selbst meldet, der Auslegende
    /// bestaetigt - das ist nicht dasselbe und soll unterscheidbar bleiben.
    pub settled_by: Option<Uuid>,
    /// Gegenzeichnung der anderen Seite. Erst damit ist der Anteil
    /// abgeschlossen.
    pub confirmed_at: Option<DateTime<Utc>>,
    pub confirmed_by: Option<Uuid>,
}

/// Wie jemandem Geld zurueckgegeben werden kann.
#[derive(Debug, Clone, FromRow)]
pub struct PaymentProfileRow {
    pub user_id: Uuid,
    pub paypal_me: Option<String>,
    pub iban: Option<String>,
    pub bic: Option<String>,
    pub account_holder: Option<String>,
    pub note: Option<String>,
    pub updated_at: DateTime<Utc>,
}
