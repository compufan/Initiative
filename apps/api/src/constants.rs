//! Shared limits and enumerations. The PWA validates against the same values
//! (`packages/shared/src/constants.ts`); the API is the authority.

pub const API_PREFIX: &str = "/api/v1";
pub const REALTIME_PATH: &str = "/ws";
pub const PROTOCOL_VERSION: u8 = 1;

pub const MESSAGE_TYPES: &[&str] = &[
    "text", "image", "video", "audio", "file", "sticker", "poll", "event", "game", "system",
];
pub const ATTACHMENT_KINDS: &[&str] = &["image", "video", "audio", "file", "sticker"];
pub const CONVERSATION_TYPES: &[&str] = &["direct", "group"];
pub const MEMBER_ROLES: &[&str] = &["owner", "admin", "member"];
pub const RSVP_STATUSES: &[&str] = &["yes", "no", "maybe", "pending"];
pub const POLL_KINDS: &[&str] = &["choice", "date"];
pub const VOTE_VALUES: &[&str] = &["yes", "no", "maybe"];
pub const GAME_STATUSES: &[&str] = &["open", "active", "finished", "aborted"];

pub const USERNAME_MIN: usize = 3;
pub const USERNAME_MAX: usize = 32;
pub const PASSWORD_MIN: usize = 8;
pub const PASSWORD_MAX: usize = 200;
pub const DISPLAY_NAME_MAX: usize = 64;
pub const BIO_MAX: usize = 280;
pub const MESSAGE_BODY_MAX: usize = 8000;
pub const CONVERSATION_TITLE_MAX: usize = 80;
pub const POLL_QUESTION_MAX: usize = 300;
pub const POLL_OPTION_MAX: usize = 120;
pub const POLL_OPTIONS_MAX: usize = 30;
pub const EVENT_TITLE_MAX: usize = 160;
pub const EVENT_DESCRIPTION_MAX: usize = 4000;
pub const STICKER_PACK_NAME_MAX: usize = 60;
pub const STICKERS_PER_PACK_MAX: i64 = 120;

pub const COLLECTION_NAME_MAX: usize = 120;
pub const COLLECTION_DESCRIPTION_MAX: usize = 2000;
pub const COLLECTION_ITEM_TITLE_MAX: usize = 200;
pub const COLLECTION_ITEM_NOTE_MAX: usize = 2000;
/// Wie tief Ordner ineinander liegen dürfen.
///
/// Nicht aus Prinzip begrenzt, sondern weil jede Ebene die Rechte-Abfrage
/// länger macht – und weil eine Sammlung sonst über einen Umweg ihr eigener
/// Elternordner werden könnte.
pub const COLLECTION_DEPTH_MAX: i32 = 8;
pub const COLLECTION_LEVELS: &[&str] = &["view", "edit", "own"];
pub const COLLECTION_MEMBER_LEVELS: &[&str] = &["none", "view", "edit"];
pub const ATTACHMENTS_PER_MESSAGE: usize = 10;
pub const MESSAGE_PAGE_SIZE: i64 = 50;
pub const MESSAGE_PAGE_SIZE_MAX: i64 = 100;
pub const PREVIEW_DATA_URL_MAX: usize = 32_000;

pub const TYPING_TTL_MS: i64 = 6000;
pub const HEARTBEAT_INTERVAL_SECS: u64 = 25;

/// Upload ceilings per attachment kind, in bytes.
pub fn max_upload_bytes(kind: &str) -> i64 {
    match kind {
        "image" => 25 * 1024 * 1024,
        "video" => 200 * 1024 * 1024,
        "audio" => 50 * 1024 * 1024,
        "sticker" => 2 * 1024 * 1024,
        _ => 100 * 1024 * 1024,
    }
}

/// Allowed MIME types per kind; an empty list means "anything" (`file`).
pub fn allowed_mime(kind: &str) -> &'static [&'static str] {
    match kind {
        "image" => &[
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/gif",
            "image/avif",
            "image/heic",
        ],
        "video" => &[
            "video/mp4",
            "video/webm",
            "video/quicktime",
            "video/x-matroska",
        ],
        "audio" => &[
            "audio/webm",
            "audio/ogg",
            "audio/mpeg",
            "audio/mp4",
            "audio/aac",
            "audio/wav",
        ],
        "sticker" => &["image/webp", "image/png"],
        _ => &[],
    }
}

const ACCENTS: [&str; 10] = [
    "#f97316", "#ef4444", "#ec4899", "#a855f7", "#6366f1", "#0ea5e9", "#14b8a6", "#22c55e",
    "#eab308", "#78716c",
];

/// Deterministic avatar colour. Must stay byte-for-byte compatible with
/// `accentFor` in `packages/shared/src/schemas/user.ts` so client and server
/// render the same placeholder.
pub fn accent_for(id: &str) -> &'static str {
    let mut hash: u32 = 0;
    for character in id.chars() {
        hash = hash.wrapping_mul(31).wrapping_add(character as u32);
    }
    ACCENTS[(hash as usize) % ACCENTS.len()]
}

/// One-line preview used in chat lists and push notifications.
pub fn message_preview(message_type: &str, body: Option<&str>, deleted: bool) -> String {
    if deleted {
        return "Nachricht gelöscht".to_string();
    }
    match message_type {
        "image" => "📷 Foto".to_string(),
        "video" => "🎬 Video".to_string(),
        "audio" => "🎤 Sprachnachricht".to_string(),
        "file" => "📎 Datei".to_string(),
        "sticker" => "🌟 Sticker".to_string(),
        "poll" => "📊 Umfrage".to_string(),
        "event" => "📅 Termin".to_string(),
        "game" => "🎮 Spiel".to_string(),
        _ => match body.map(str::trim) {
            Some(text) if !text.is_empty() => text.to_string(),
            _ => "Nachricht".to_string(),
        },
    }
}

pub fn truncate(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    let mut result: String = value.chars().take(max.saturating_sub(1)).collect();
    result.push('…');
    result
}
