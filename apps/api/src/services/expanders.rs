//! Extension point: a feature module registers an expander so its entities are
//! embedded in every message payload without the messenger core knowing about
//! polls, events, games or stickers.

use std::collections::HashMap;
use std::sync::LazyLock;

use async_trait::async_trait;
use uuid::Uuid;

use crate::db::MessageRow;
use crate::dto::{CalendarEventDto, GameSessionDto, PollDto, StickerDto};
use crate::error::AppResult;
use crate::state::AppState;

#[derive(Debug, Default, Clone)]
pub struct Expansion {
    pub poll: Option<PollDto>,
    pub event: Option<CalendarEventDto>,
    pub game: Option<GameSessionDto>,
    pub sticker: Option<StickerDto>,
}

#[async_trait]
pub trait MessageExpander: Send + Sync {
    fn key(&self) -> &'static str;
    async fn expand(
        &self,
        state: &AppState,
        viewer_id: Uuid,
        messages: &[MessageRow],
    ) -> AppResult<HashMap<Uuid, Expansion>>;
}

/// Registered expanders. A new module adds one line here.
static EXPANDERS: LazyLock<Vec<Box<dyn MessageExpander>>> = LazyLock::new(|| {
    vec![
        Box::new(super::polls::PollExpander) as Box<dyn MessageExpander>,
        Box::new(super::calendar::EventExpander),
        Box::new(super::games::GameExpander),
        Box::new(super::stickers::StickerExpander),
    ]
});

/// Collects the ids referenced by `metadata.<key>` across a batch of messages.
pub fn referenced_ids(messages: &[MessageRow], key: &str) -> Vec<Uuid> {
    let mut ids: Vec<Uuid> = messages
        .iter()
        .filter_map(|message| message.metadata.get(key))
        .filter_map(|value| value.as_str())
        .filter_map(|value| Uuid::parse_str(value).ok())
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

pub fn metadata_id(message: &MessageRow, key: &str) -> Option<Uuid> {
    message
        .metadata
        .get(key)
        .and_then(|value| value.as_str())
        .and_then(|value| Uuid::parse_str(value).ok())
}

pub async fn run(
    state: &AppState,
    viewer_id: Uuid,
    messages: &[MessageRow],
) -> HashMap<Uuid, Expansion> {
    let mut merged: HashMap<Uuid, Expansion> = HashMap::new();
    if messages.is_empty() {
        return merged;
    }

    for expander in EXPANDERS.iter() {
        // A broken module must not take the whole chat down.
        match expander.expand(state, viewer_id, messages).await {
            Ok(result) => {
                for (message_id, expansion) in result {
                    let entry = merged.entry(message_id).or_default();
                    if expansion.poll.is_some() {
                        entry.poll = expansion.poll;
                    }
                    if expansion.event.is_some() {
                        entry.event = expansion.event;
                    }
                    if expansion.game.is_some() {
                        entry.game = expansion.game;
                    }
                    if expansion.sticker.is_some() {
                        entry.sticker = expansion.sticker;
                    }
                }
            }
            Err(error) => {
                tracing::warn!(expander = expander.key(), %error, "message expander failed");
            }
        }
    }
    merged
}
