//! Sticker-Pakete und selbst erstellte Sticker.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::constants::{STICKERS_PER_PACK_MAX, STICKER_PACK_NAME_MAX};
use crate::db::{StickerPackRow, StickerRow};
use crate::dto::{ListResult, StickerPackDto};
use crate::error::{AppError, AppResult};
use crate::services::stickers::{claim_attachment, load_pack_dto, load_pack_dtos, require_pack};
use crate::state::AppState;
use crate::validate::Validator;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/stickers/packs", get(list_packs).post(create_pack))
        .route("/stickers/discover", get(discover))
        .route(
            "/stickers/packs/{id}",
            get(pack_by_id).patch(update_pack).delete(delete_pack),
        )
        .route("/stickers/packs/{id}/stickers", post(add_sticker))
        .route(
            "/stickers/packs/{id}/stickers/{sticker_id}",
            axum::routing::delete(remove_sticker),
        )
        .route(
            "/stickers/packs/{id}/install",
            post(install).delete(uninstall),
        )
}

async fn load_many(
    state: &AppState,
    ids: Vec<Uuid>,
    viewer: Uuid,
) -> AppResult<Json<ListResult<StickerPackDto>>> {
    let packs = load_pack_dtos(state, &ids, viewer).await?;
    let items = ids.into_iter().filter_map(|id| packs.get(&id).cloned()).collect();
    Ok(Json(ListResult::new(items)))
}

/// Own packs plus everything the user installed.
async fn list_packs(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<ListResult<StickerPackDto>>> {
    let ids: Vec<Uuid> = sqlx::query_as::<_, (Uuid,)>(
        "select p.id from sticker_packs p
         left join sticker_pack_installs i on i.pack_id = p.id and i.user_id = $1
         where p.owner_id = $1 or i.user_id is not null
         order by p.created_at asc",
    )
    .bind(user.id())
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .map(|(id,)| id)
    .collect();

    load_many(&state, ids, user.id()).await
}

#[derive(Debug, Deserialize)]
struct DiscoverQuery {
    q: Option<String>,
}

async fn discover(
    State(state): State<AppState>,
    user: AuthUser,
    Query(query): Query<DiscoverQuery>,
) -> AppResult<Json<ListResult<StickerPackDto>>> {
    let pattern = query
        .q
        .as_deref()
        .map(|value| format!("%{}%", value.trim().to_lowercase()));

    let ids: Vec<Uuid> = sqlx::query_as::<_, (Uuid,)>(
        "select p.id from sticker_packs p
         where p.is_public = true and (p.owner_id is null or p.owner_id <> $1)
           and ($2::text is null or lower(p.name) like $2)
         order by p.updated_at desc
         limit 50",
    )
    .bind(user.id())
    .bind(pattern)
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .map(|(id,)| id)
    .collect();

    load_many(&state, ids, user.id()).await
}

async fn readable_pack(state: &AppState, id: Uuid, viewer: Uuid) -> AppResult<StickerPackRow> {
    let pack = require_pack(state, id).await?;
    if !pack.is_public && pack.owner_id != Some(viewer) {
        return Err(AppError::forbidden("Dieses Paket ist privat"));
    }
    Ok(pack)
}

async fn own_pack(state: &AppState, id: Uuid, viewer: Uuid) -> AppResult<StickerPackRow> {
    let pack = require_pack(state, id).await?;
    if pack.owner_id != Some(viewer) {
        return Err(AppError::forbidden("Das ist nicht dein Sticker-Paket"));
    }
    Ok(pack)
}

async fn pack_by_id(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<StickerPackDto>> {
    readable_pack(&state, id, user.id()).await?;
    Ok(Json(load_pack_dto(&state, id, user.id()).await?))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreatePackInput {
    name: String,
    #[serde(default)]
    is_public: bool,
}

async fn create_pack(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<CreatePackInput>,
) -> AppResult<(StatusCode, Json<StickerPackDto>)> {
    let name = input.name.trim().to_string();
    Validator::new()
        .length("name", &name, 1, STICKER_PACK_NAME_MAX)
        .finish()?;

    let pack_id = Uuid::now_v7();
    sqlx::query("insert into sticker_packs (id, owner_id, name, is_public) values ($1, $2, $3, $4)")
        .bind(pack_id)
        .bind(user.id())
        .bind(&name)
        .bind(input.is_public)
        .execute(&state.pool)
        .await?;
    // The owner always has their own packs on the keyboard.
    sqlx::query(
        "insert into sticker_pack_installs (pack_id, user_id) values ($1, $2)
         on conflict (pack_id, user_id) do nothing",
    )
    .bind(pack_id)
    .bind(user.id())
    .execute(&state.pool)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(load_pack_dto(&state, pack_id, user.id()).await?),
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdatePackInput {
    name: Option<String>,
    is_public: Option<bool>,
    #[serde(default, deserialize_with = "super::double_option")]
    cover_sticker_id: Option<Option<Uuid>>,
}

async fn update_pack(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<UpdatePackInput>,
) -> AppResult<Json<StickerPackDto>> {
    own_pack(&state, id, user.id()).await?;

    let name = input.name.map(|value| value.trim().to_string());
    if let Some(name) = &name {
        Validator::new()
            .length("name", name, 1, STICKER_PACK_NAME_MAX)
            .finish()?;
    }
    if let Some(Some(cover)) = input.cover_sticker_id {
        let owned: Option<(Uuid,)> =
            sqlx::query_as("select id from stickers where id = $1 and pack_id = $2")
                .bind(cover)
                .bind(id)
                .fetch_optional(&state.pool)
                .await?;
        if owned.is_none() {
            return Err(AppError::bad_request("Sticker gehört nicht zu diesem Paket"));
        }
    }

    sqlx::query(
        "update sticker_packs set
           name = coalesce($2, name),
           is_public = coalesce($3, is_public),
           cover_sticker_id = case when $4 then $5 else cover_sticker_id end,
           updated_at = now()
         where id = $1",
    )
    .bind(id)
    .bind(name)
    .bind(input.is_public)
    .bind(input.cover_sticker_id.is_some())
    .bind(input.cover_sticker_id.flatten())
    .execute(&state.pool)
    .await?;

    Ok(Json(load_pack_dto(&state, id, user.id()).await?))
}

async fn delete_pack(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    own_pack(&state, id, user.id()).await?;
    sqlx::query("delete from sticker_packs where id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddStickerInput {
    attachment_id: Uuid,
    emoji: Option<String>,
}

async fn add_sticker(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<AddStickerInput>,
) -> AppResult<(StatusCode, Json<StickerPackDto>)> {
    own_pack(&state, id, user.id()).await?;

    let (count,): (i64,) = sqlx::query_as("select count(*)::bigint from stickers where pack_id = $1")
        .bind(id)
        .fetch_one(&state.pool)
        .await?;
    if count >= STICKERS_PER_PACK_MAX {
        return Err(AppError::bad_request(format!(
            "Ein Paket fasst maximal {STICKERS_PER_PACK_MAX} Sticker"
        )));
    }

    let owner: Option<(Option<Uuid>,)> =
        sqlx::query_as("select uploader_id from attachments where id = $1")
            .bind(input.attachment_id)
            .fetch_optional(&state.pool)
            .await?;
    match owner {
        Some((Some(uploader),)) if uploader == user.id() => {}
        _ => return Err(AppError::forbidden("Sticker-Datei gehört dir nicht")),
    }

    let attachment = claim_attachment(&state, input.attachment_id).await?;
    sqlx::query(
        "insert into stickers (id, pack_id, attachment_id, emoji, width, height, position)
         values ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(Uuid::now_v7())
    .bind(id)
    .bind(attachment.id)
    .bind(input.emoji.as_deref().map(str::trim).filter(|value| !value.is_empty()))
    .bind(attachment.width.unwrap_or(512))
    .bind(attachment.height.unwrap_or(512))
    .bind(count as i32)
    .execute(&state.pool)
    .await?;
    sqlx::query("update sticker_packs set updated_at = now() where id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?;

    Ok((
        StatusCode::CREATED,
        Json(load_pack_dto(&state, id, user.id()).await?),
    ))
}

async fn remove_sticker(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, sticker_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    own_pack(&state, id, user.id()).await?;
    let removed = sqlx::query_as::<_, StickerRow>(
        "delete from stickers where id = $1 and pack_id = $2 returning *",
    )
    .bind(sticker_id)
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;

    if let Some(sticker) = removed {
        sqlx::query("delete from attachments where id = $1")
            .bind(sticker.attachment_id)
            .execute(&state.pool)
            .await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn install(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<StickerPackDto>> {
    readable_pack(&state, id, user.id()).await?;
    sqlx::query(
        "insert into sticker_pack_installs (pack_id, user_id) values ($1, $2)
         on conflict (pack_id, user_id) do nothing",
    )
    .bind(id)
    .bind(user.id())
    .execute(&state.pool)
    .await?;
    Ok(Json(load_pack_dto(&state, id, user.id()).await?))
}

async fn uninstall(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    sqlx::query("delete from sticker_pack_installs where pack_id = $1 and user_id = $2")
        .bind(id)
        .bind(user.id())
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
