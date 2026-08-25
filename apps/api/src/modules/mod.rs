//! Feature modules.
//!
//! A module owns its routes and (optionally) how its entities are embedded into
//! chat messages. The messenger is just the first module – calendar, polls and
//! mini-games are siblings. Adding an area of the app means one file here plus
//! one line in [`router`].

pub mod admin;
pub mod auth;
pub mod calendar;
pub mod conversations;
pub mod games;
pub mod media;
pub mod messages;
pub mod passkeys;
pub mod polls;
pub mod push;
pub mod stickers;
pub mod storage_check;
pub mod users;

use axum::Router;

use crate::state::AppState;

/// Registered modules, mounted under `/api/v1`.
pub fn router() -> Router<AppState> {
    Router::new()
        .merge(auth::router())
        .merge(admin::router())
        .merge(storage_check::router())
        .merge(passkeys::router())
        .merge(users::router())
        .merge(conversations::router())
        .merge(messages::router())
        .merge(media::router())
        .merge(stickers::router())
        .merge(calendar::router())
        .merge(polls::router())
        .merge(games::router())
        .merge(push::router())
}

pub const MODULE_KEYS: &[&str] = &[
    "auth",
    "admin",
    "passkeys",
    "users",
    "conversations",
    "messages",
    "media",
    "stickers",
    "calendar",
    "polls",
    "games",
    "push",
];

/// Distinguishes "field missing" from "field explicitly set to null" in PATCH
/// bodies: `None` = untouched, `Some(None)` = clear, `Some(Some(v))` = set.
pub fn double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: serde::Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    serde::Deserialize::deserialize(deserializer).map(Some)
}
