pub mod bus;
pub mod hub;
pub mod ws;

use serde::Serialize;
use serde_json::{json, Value};

use crate::constants::PROTOCOL_VERSION;

/// One envelope for both directions. Unknown `type` values are ignored by
/// clients, so new modules can add their own events without breaking anyone.
#[derive(Debug, Clone, Serialize)]
pub struct Envelope {
    pub v: u8,
    pub r#type: String,
    pub ts: String,
    pub payload: Value,
}

#[derive(Debug, Clone)]
pub struct Event {
    pub r#type: &'static str,
    pub payload: Value,
}

impl Event {
    pub fn new(r#type: &'static str, payload: Value) -> Self {
        Self { r#type, payload }
    }

    pub fn envelope(&self) -> Envelope {
        Envelope {
            v: PROTOCOL_VERSION,
            r#type: self.r#type.to_string(),
            ts: chrono::Utc::now().to_rfc3339(),
            payload: self.payload.clone(),
        }
    }

    pub fn to_frame(&self) -> String {
        serde_json::to_string(&self.envelope()).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn message_new(message: &crate::dto::MessageDto) -> Self {
        Self::new("message.new", json!({ "message": message }))
    }

    pub fn message_updated(message: &crate::dto::MessageDto) -> Self {
        Self::new("message.updated", json!({ "message": message }))
    }

    pub fn message_deleted(conversation_id: uuid::Uuid, message_id: uuid::Uuid) -> Self {
        Self::new(
            "message.deleted",
            json!({ "conversationId": conversation_id, "messageId": message_id }),
        )
    }

    pub fn message_reactions(
        conversation_id: uuid::Uuid,
        message_id: uuid::Uuid,
        reactions: &[crate::dto::ReactionDto],
    ) -> Self {
        Self::new(
            "message.reactions",
            json!({
                "conversationId": conversation_id,
                "messageId": message_id,
                "reactions": reactions
            }),
        )
    }

    pub fn conversation_updated(conversation: &crate::dto::ConversationDto) -> Self {
        Self::new("conversation.updated", json!({ "conversation": conversation }))
    }

    pub fn conversation_removed(conversation_id: uuid::Uuid) -> Self {
        Self::new("conversation.removed", json!({ "conversationId": conversation_id }))
    }

    pub fn read_updated(
        conversation_id: uuid::Uuid,
        user_id: uuid::Uuid,
        last_read_message_id: uuid::Uuid,
    ) -> Self {
        Self::new(
            "read.updated",
            json!({
                "conversationId": conversation_id,
                "userId": user_id,
                "lastReadMessageId": last_read_message_id
            }),
        )
    }

    pub fn typing(conversation_id: uuid::Uuid, user_id: uuid::Uuid, until: String) -> Self {
        Self::new(
            "typing",
            json!({ "conversationId": conversation_id, "userId": user_id, "until": until }),
        )
    }

    pub fn presence(user_id: uuid::Uuid, online: bool) -> Self {
        Self::new(
            "presence",
            json!({
                "userId": user_id,
                "online": online,
                "lastSeenAt": chrono::Utc::now().to_rfc3339()
            }),
        )
    }

    pub fn poll_updated(poll: &crate::dto::PollDto) -> Self {
        Self::new("poll.updated", json!({ "poll": poll }))
    }

    pub fn event_updated(event: &crate::dto::CalendarEventDto) -> Self {
        Self::new("event.updated", json!({ "event": event }))
    }

    pub fn event_deleted(event_id: uuid::Uuid, conversation_id: Option<uuid::Uuid>) -> Self {
        Self::new(
            "event.deleted",
            json!({ "eventId": event_id, "conversationId": conversation_id }),
        )
    }

    pub fn game_updated(session: &crate::dto::GameSessionDto) -> Self {
        Self::new("game.updated", json!({ "session": session }))
    }

    pub fn user_updated(user: &crate::dto::UserDto) -> Self {
        Self::new("user.updated", json!({ "user": user }))
    }

    pub fn sync_hint(scope: &str, conversation_id: Option<uuid::Uuid>) -> Self {
        Self::new(
            "sync.hint",
            json!({ "scope": scope, "conversationId": conversation_id }),
        )
    }
}
