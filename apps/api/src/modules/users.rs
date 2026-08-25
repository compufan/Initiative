//! Profile, Suche und Einstellungen.

use axum::extract::{Path, Query, State};
use axum::routing::{get, patch};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::db::UserRow;
use crate::dto::{ListResult, SelfUserDto, UserDto};
use crate::error::{AppError, AppResult};
use crate::realtime::Event;
use crate::services::users::{
    contacts_of, load_user, merge_settings, to_self_user_dto, to_user_dto,
};
use crate::state::AppState;
use crate::validate::{clean, Validator};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/users", get(search))
        .route("/users/batch", get(batch))
        .route("/users/me", patch(update_me))
        .route("/users/{id}", get(by_id))
}

#[derive(Debug, Deserialize)]
struct SearchQuery {
    q: String,
    limit: Option<i64>,
}

async fn search(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<SearchQuery>,
) -> AppResult<Json<ListResult<UserDto>>> {
    let needle = query.q.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Json(ListResult::new(Vec::new())));
    }
    let pattern = format!("%{needle}%");
    let rows = sqlx::query_as::<_, UserRow>(
        "select * from users
         where id <> $1 and (lower(username) like $2 or lower(display_name) like $2)
         order by case when lower(username) = $3 then 0 else 1 end, display_name asc
         limit $4",
    )
    .bind(user.id())
    .bind(&pattern)
    .bind(&needle)
    .bind(query.limit.unwrap_or(20).clamp(1, 50))
    .fetch_all(&state.pool)
    .await?;

    Ok(Json(ListResult::new(
        rows.iter()
            .map(|row| to_user_dto(row, &state.config))
            .collect(),
    )))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchQuery {
    /// Kennungen, durch Komma getrennt.
    ids: String,
}

/// Mehrere Personen auf einmal nachschlagen.
///
/// Vorher holte die Oberflaeche jeden Namen einzeln: Eine Ausgabenliste mit
/// acht Beteiligten waren acht Anfragen, und weil sie nacheinander durch
/// dieselbe Verbindung mussten, war die Liste spuerbar lange ohne Namen. Die
/// Antwort ist immer dieselbe Handvoll Leute – das ist eine Anfrage wert,
/// nicht acht.
///
/// Gedeckelt, damit eine geratene Adresse nicht die ganze Benutzertabelle
/// ausliest.
async fn batch(
    State(state): State<AppState>,
    _user: AuthUser,
    Query(query): Query<BatchQuery>,
) -> AppResult<Json<ListResult<UserDto>>> {
    let ids: Vec<Uuid> = query
        .ids
        .split(',')
        .filter_map(|teil| Uuid::parse_str(teil.trim()).ok())
        .take(200)
        .collect();
    if ids.is_empty() {
        return Ok(Json(ListResult::new(Vec::new())));
    }

    let rows = sqlx::query_as::<_, UserRow>("select * from users where id = any($1)")
        .bind(&ids)
        .fetch_all(&state.pool)
        .await?;

    Ok(Json(ListResult::new(
        rows.iter()
            .map(|row| to_user_dto(row, &state.config))
            .collect(),
    )))
}

async fn by_id(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<UserDto>> {
    let row = load_user(&state.pool, id).await?;
    Ok(Json(to_user_dto(&row, &state.config)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProfileInput {
    display_name: Option<String>,
    #[serde(default, deserialize_with = "crate::modules::double_option")]
    bio: Option<Option<String>>,
    #[serde(default, deserialize_with = "crate::modules::double_option")]
    avatar_attachment_id: Option<Option<Uuid>>,
    settings: Option<Value>,
}

async fn update_me(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<UpdateProfileInput>,
) -> AppResult<Json<SelfUserDto>> {
    let current = load_user(&state.pool, user.id()).await?;

    let display_name = clean(input.display_name);
    if let Some(name) = &display_name {
        Validator::new()
            .length("displayName", name, 1, crate::constants::DISPLAY_NAME_MAX)
            .finish()?;
    }
    if let Some(Some(bio)) = &input.bio {
        Validator::new()
            .length("bio", bio, 0, crate::constants::BIO_MAX)
            .finish()?;
    }

    let settings = match input.settings {
        Some(patch) => {
            let mut merged = merge_settings(&current.settings);
            if let (Some(target), Some(source)) = (merged.as_object_mut(), patch.as_object()) {
                for (key, value) in source {
                    if key == "notifications" || key == "modules" {
                        if let (Some(existing), Some(incoming)) = (
                            target.get_mut(key).and_then(Value::as_object_mut),
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
            Some(merged)
        }
        None => None,
    };

    let updated = sqlx::query_as::<_, UserRow>(
        "update users set
           display_name = coalesce($2, display_name),
           bio = case when $3 then $4 else bio end,
           avatar_attachment_id = case when $5 then $6 else avatar_attachment_id end,
           settings = coalesce($7, settings),
           updated_at = now()
         where id = $1
         returning *",
    )
    .bind(user.id())
    .bind(&display_name)
    .bind(input.bio.is_some())
    .bind(input.bio.clone().flatten())
    .bind(input.avatar_attachment_id.is_some())
    .bind(input.avatar_attachment_id.flatten())
    .bind(&settings)
    .fetch_one(&state.pool)
    .await
    .map_err(|error| match error {
        sqlx::Error::RowNotFound => AppError::not_found("Benutzer nicht gefunden"),
        other => AppError::from(other),
    })?;

    // Everyone sharing a chat sees the new profile instantly.
    let contacts = contacts_of(&state.pool, user.id()).await?;
    let dto = to_user_dto(&updated, &state.config);
    state.hub.publish(contacts, Event::user_updated(&dto)).await;

    Ok(Json(to_self_user_dto(&updated, &state.config)))
}
