//! Sticker-Pakete und selbst erstellte Sticker.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::constants::{STICKERS_PER_PACK_MAX, STICKER_PACK_NAME_MAX, TON_MAX_MS};
use crate::db::{StickerPackRow, StickerRow};
use crate::dto::{ListResult, StickerPackDto};
use crate::error::{AppError, AppResult};
use crate::services::stickers::{
    claim_attachment, claim_ton_attachment, load_pack_dto, load_pack_dtos, require_pack,
};
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
        /*
         * Ton nachtraeglich anhaengen oder wegnehmen.
         *
         * Eine eigene Route und kein Feld am Sticker-Anlegen allein: Der Ton
         * ist optional, und wer einen vorhandenen Sticker vertonen will, soll
         * ihn nicht loeschen und neu bauen muessen.
         */
        .route(
            "/stickers/packs/{id}/stickers/{sticker_id}/ton",
            axum::routing::put(setze_ton).delete(entferne_ton),
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
    let items = ids
        .into_iter()
        .filter_map(|id| packs.get(&id).cloned())
        .collect();
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
    sqlx::query(
        "insert into sticker_packs (id, owner_id, name, is_public) values ($1, $2, $3, $4)",
    )
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
            return Err(AppError::bad_request(
                "Sticker gehört nicht zu diesem Paket",
            ));
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

    /*
     * Erst die Anhaenge einsammeln, dann das Paket loeschen.
     *
     * `sticker_packs` kaskadiert auf `stickers`, aber NICHT auf
     * `attachments` – die Dateien blieben also liegen, und der Speicher-Muell
     * wird ausschliesslich vom Loesch-Ausloeser auf `attachments` gespeist
     * (Migration 0013). Das war schon vor der Tonspur eine Luecke; mit ihr
     * waeren es doppelt so viele Waisen.
     */
    let anhaenge: Vec<(Uuid,)> = sqlx::query_as(
        "select attachment_id from stickers where pack_id = $1
         union
         select ton_attachment_id from stickers
          where pack_id = $1 and ton_attachment_id is not null",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?;

    sqlx::query("delete from sticker_packs where id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    if !anhaenge.is_empty() {
        sqlx::query("delete from attachments where id = any($1)")
            .bind(anhaenge.into_iter().map(|(id,)| id).collect::<Vec<Uuid>>())
            .execute(&state.pool)
            .await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddStickerInput {
    attachment_id: Uuid,
    emoji: Option<String>,
    /// Optionale Tonspur, gleich beim Anlegen.
    ton_attachment_id: Option<Uuid>,
    ton_dauer_ms: Option<i32>,
}

async fn add_sticker(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<AddStickerInput>,
) -> AppResult<(StatusCode, Json<StickerPackDto>)> {
    own_pack(&state, id, user.id()).await?;

    let (count,): (i64,) =
        sqlx::query_as("select count(*)::bigint from stickers where pack_id = $1")
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

    /*
     * Die Tonspur wird ERST geholt, wenn das Bild schon steht.
     *
     * Reihenfolge ist hier keine Geschmacksfrage: Scheitert der Ton, ist ein
     * Sticker ohne Ton immer noch ein Sticker. Andersherum laege eine
     * Tondatei ohne Sticker herum, und niemand wuesste, wozu sie gehoert.
     */
    let ton = match input.ton_attachment_id {
        Some(ton_id) => Some(ton_besitz_pruefen(&state, ton_id, user.id()).await?),
        None => None,
    };

    sqlx::query(
        "insert into stickers
             (id, pack_id, attachment_id, ton_attachment_id, ton_dauer_ms,
              emoji, width, height, position)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(Uuid::now_v7())
    .bind(id)
    .bind(attachment.id)
    .bind(ton.as_ref().map(|zeile| zeile.id))
    .bind(ton_dauer(input.ton_dauer_ms))
    .bind(
        input
            .emoji
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty()),
    )
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
        // BEIDE Anhaenge. Der Ton haengt an `set null` und wuerde sonst als
        // Waise liegenbleiben – und der Speicher-Muell wird ausschliesslich
        // vom Loesch-Ausloeser auf `attachments` gespeist (Migration 0013).
        sqlx::query("delete from attachments where id = any($1)")
            .bind(
                [Some(sticker.attachment_id), sticker.ton_attachment_id]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<Uuid>>(),
            )
            .execute(&state.pool)
            .await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetzeTonInput {
    attachment_id: Uuid,
    dauer_ms: Option<i32>,
}

/**
 * Pruefen, dass eine Tondatei dem Anfragenden gehoert und noch frei ist.
 *
 * Dieselbe Pruefung wie beim Bild, und aus demselben Grund: Ohne sie koennte
 * jemand die Kennung einer fremden Datei einsetzen und sie damit an seinen
 * eigenen Sticker haengen – und ueber `zugriff.rs` fuer alle sichtbar machen,
 * die dieses Paket sehen.
 */
async fn ton_besitz_pruefen(
    state: &AppState,
    ton_id: Uuid,
    user_id: Uuid,
) -> AppResult<crate::db::AttachmentRow> {
    let besitzer: Option<(Option<Uuid>,)> =
        sqlx::query_as("select uploader_id from attachments where id = $1")
            .bind(ton_id)
            .fetch_optional(&state.pool)
            .await?;
    match besitzer {
        Some((Some(uploader),)) if uploader == user_id => {}
        _ => return Err(AppError::forbidden("Tondatei gehoert dir nicht")),
    }
    /*
     * Und dass sie nicht schon an einem anderen Sticker haengt.
     *
     * `claim_ton_attachment` prueft nur `message_id is null` – ein Anhang,
     * der bereits an einem Sticker haengt, kaeme damit durch. Zwei Sticker
     * mit derselben Tondatei sind an sich harmlos; der Tag, an dem einer von
     * beiden geloescht wird, ist es nicht: Dann verstummt auch der andere.
     */
    let schon_vergeben: bool = sqlx::query_scalar(
        "select exists (select 1 from stickers where ton_attachment_id = $1)",
    )
    .bind(ton_id)
    .fetch_one(&state.pool)
    .await?;
    if schon_vergeben {
        return Err(AppError::bad_request(
            "Diese Tondatei haengt schon an einem Sticker.",
        ));
    }
    claim_ton_attachment(state, ton_id).await
}

/// Die Dauer in einen Bereich klemmen, den ein Sticker haben darf.
fn ton_dauer(roh: Option<i32>) -> Option<i32> {
    roh.map(|ms| ms.clamp(0, TON_MAX_MS))
}

async fn setze_ton(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, sticker_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<SetzeTonInput>,
) -> AppResult<Json<StickerPackDto>> {
    own_pack(&state, id, user.id()).await?;
    let ton = ton_besitz_pruefen(&state, input.attachment_id, user.id()).await?;

    /*
     * Ein etwaiger alter Ton wird eingesammelt, BEVOR die Spalte umgesetzt
     * wird – danach ist er nicht mehr zu finden und bliebe als Waise liegen.
     */
    /*
     * Der ALTE Ton kommt aus einem CTE, nicht aus einer Unterabfrage im
     * `returning`.
     *
     * Eine Unterabfrage dort laese zwar auch den Stand von vor der Aenderung
     * – aber nur, weil Postgres innerhalb einer Anweisung einen festen
     * Schnappschuss benutzt. Das ist wahr und trotzdem der falsche Grund,
     * sich darauf zu verlassen: Wer die Zeile spaeter liest, muss diese Regel
     * kennen, um sie zu verstehen. Ein CTE wird sichtbar EINMAL gerechnet.
     */
    let alt: Option<(Option<Uuid>,)> = sqlx::query_as(
        "with vorher as (
             select ton_attachment_id from stickers where id = $1 and pack_id = $2
         )
         update stickers set ton_attachment_id = $3, ton_dauer_ms = $4
          where id = $1 and pack_id = $2
          returning (select ton_attachment_id from vorher)",
    )
    .bind(sticker_id)
    .bind(id)
    .bind(ton.id)
    .bind(ton_dauer(input.dauer_ms))
    .fetch_optional(&state.pool)
    .await?;
    let Some((alter_ton,)) = alt else {
        return Err(AppError::not_found("Sticker nicht gefunden"));
    };
    if let Some(alter_ton) = alter_ton.filter(|vorher| *vorher != ton.id) {
        sqlx::query("delete from attachments where id = $1")
            .bind(alter_ton)
            .execute(&state.pool)
            .await?;
    }

    Ok(Json(load_pack_dto(&state, id, user.id()).await?))
}

async fn entferne_ton(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, sticker_id)): Path<(Uuid, Uuid)>,
) -> AppResult<Json<StickerPackDto>> {
    own_pack(&state, id, user.id()).await?;
    let alt: Option<(Option<Uuid>,)> = sqlx::query_as(
        "with vorher as (
             select ton_attachment_id from stickers where id = $1 and pack_id = $2
         )
         update stickers set ton_attachment_id = null, ton_dauer_ms = null
          where id = $1 and pack_id = $2
          returning (select ton_attachment_id from vorher)",
    )
    .bind(sticker_id)
    .bind(id)
    .fetch_optional(&state.pool)
    .await?;
    let Some((alter_ton,)) = alt else {
        return Err(AppError::not_found("Sticker nicht gefunden"));
    };
    if let Some(alter_ton) = alter_ton {
        sqlx::query("delete from attachments where id = $1")
            .bind(alter_ton)
            .execute(&state.pool)
            .await?;
    }
    Ok(Json(load_pack_dto(&state, id, user.id()).await?))
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
