use serde_json::{json, Value};
use sqlx::PgPool;
use std::collections::HashMap;
use uuid::Uuid;

use crate::config::Config;
use crate::constants::accent_for;
use crate::db::UserRow;
use crate::dto::{SelfUserDto, UserDto};
use crate::error::{AppError, AppResult};

pub fn to_user_dto(row: &UserRow, config: &Config) -> UserDto {
    UserDto {
        id: row.id,
        username: row.username.clone(),
        display_name: row.display_name.clone(),
        avatar_url: row.avatar_attachment_id.map(|id| config.media_url(&id)),
        bio: row.bio.clone(),
        accent: accent_for(&row.id.to_string()).to_string(),
        last_seen_at: row.last_seen_at,
        created_at: row.created_at,
    }
}

/// Fills in defaults for settings the client has never written.
pub fn merge_settings(stored: &Value) -> Value {
    let defaults = json!({
        "theme": "system",
        "locale": "de",
        "notifications": { "push": true, "sound": true, "previews": true },
        "modules": {}
    });
    let mut merged = defaults;
    if let (Some(target), Some(source)) = (merged.as_object_mut(), stored.as_object()) {
        for (key, value) in source {
            if key == "notifications" {
                if let (Some(existing), Some(incoming)) = (
                    target
                        .get_mut("notifications")
                        .and_then(Value::as_object_mut),
                    value.as_object(),
                ) {
                    for (inner_key, inner_value) in incoming {
                        existing.insert(inner_key.clone(), inner_value.clone());
                    }
                    continue;
                }
            }
            target.insert(key.clone(), value.clone());
        }
    }
    merged
}

pub fn to_self_user_dto(row: &UserRow, config: &Config) -> SelfUserDto {
    SelfUserDto {
        user: to_user_dto(row, config),
        calendar_token: row.calendar_token.clone(),
        settings: merge_settings(&row.settings),
    }
}

pub async fn load_user(pool: &PgPool, id: Uuid) -> AppResult<UserRow> {
    sqlx::query_as::<_, UserRow>("select * from users where id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::not_found("Benutzer nicht gefunden"))
}

pub async fn load_users_by_ids(
    pool: &PgPool,
    ids: &[Uuid],
    config: &Config,
) -> AppResult<HashMap<Uuid, UserDto>> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = sqlx::query_as::<_, UserRow>("select * from users where id = any($1)")
        .bind(ids)
        .fetch_all(pool)
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| (row.id, to_user_dto(&row, config)))
        .collect())
}

pub async fn touch_last_seen(pool: &PgPool, user_id: Uuid) {
    let _ = sqlx::query("update users set last_seen_at = now() where id = $1")
        .bind(user_id)
        .execute(pool)
        .await;
}

/// Everyone who shares at least one conversation with this user.
pub async fn contacts_of(pool: &PgPool, user_id: Uuid) -> AppResult<Vec<Uuid>> {
    let rows: Vec<(Uuid,)> = sqlx::query_as(
        "select distinct other.user_id
         from conversation_members mine
         join conversation_members other on other.conversation_id = mine.conversation_id
         where mine.user_id = $1 and other.user_id <> $1",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}
