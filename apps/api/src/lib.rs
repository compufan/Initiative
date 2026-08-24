//! Initiative API – modulare Plattform (Messenger, Kalender, Umfragen, Spiele).

pub mod app;
pub mod auth;
pub mod config;
pub mod constants;
pub mod db;
pub mod dto;
pub mod error;
pub mod games;
pub mod ical;
pub mod modules;
pub mod push;
pub mod realtime;
pub mod recurrence;
pub mod services;
pub mod state;
pub mod storage;
pub mod validate;

/// Embedded SQL migrations – they ship inside the binary, so a container never
/// needs the `migrations/` folder.
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");
