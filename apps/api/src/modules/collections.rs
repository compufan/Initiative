//! Dateien & Sammlungen: Ordner, Inhalte und Rechte.
//!
//! Eine Sammlung ist ein Ordner. Ordner dürfen ineinander liegen, und in
//! jedem liegen Dateien – dieselben Anhänge, die auch im Chat verschickt
//! werden. Eine Datei landet in einer Sammlung, ohne noch einmal hochgeladen
//! zu werden; sie bekommt dort nur einen zweiten Platz.
//!
//! Wer was darf, entscheidet [`crate::services::permissions`]. Die Regeln
//! stehen dort einmal und werden hier nur noch angewandt.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::constants::{
    COLLECTION_DEPTH_MAX, COLLECTION_DESCRIPTION_MAX, COLLECTION_ITEM_NOTE_MAX,
    COLLECTION_ITEM_TITLE_MAX, COLLECTION_LEVELS, COLLECTION_MEMBER_LEVELS, COLLECTION_NAME_MAX,
};
use crate::db::{AttachmentRow, CollectionGrantRow, CollectionItemRow, CollectionRow};
use crate::dto::{CollectionDto, CollectionGrantDto, CollectionItemDto, ListResult};
use crate::error::{AppError, AppResult};
use crate::modules::double_option;
use crate::services::attachments::to_attachment_dto;
use crate::services::conversations::assert_membership;
use crate::services::permissions::{
    collection_level, item_level, require_collection, require_item, visible_collection_ids, Level,
};
use crate::state::AppState;
use crate::validate::{clean, Validator};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/collections", get(list).post(create))
        .route("/collections/{id}", get(by_id).patch(update).delete(remove))
        .route("/collections/{id}/items", get(items).post(add_item))
        .route(
            "/collections/{id}/items/{item_id}",
            axum::routing::patch(update_item).delete(remove_item),
        )
        .route("/collections/{id}/grants", get(grants).post(grant))
        .route("/collections/{id}/grants/{grant_id}", delete(revoke))
        .route("/collections/items/{item_id}/grants", post(grant_item))
}

/* ---------- Umwandeln ---------- */

fn to_collection_dto(row: CollectionRow, my_level: Level, item_count: i64) -> CollectionDto {
    CollectionDto {
        id: row.id,
        parent_id: row.parent_id,
        conversation_id: row.conversation_id,
        name: row.name,
        description: row.description,
        color: row.color,
        member_level: row.member_level,
        created_by: row.created_by,
        my_level: my_level.as_str().to_string(),
        item_count,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

fn to_grant_dto(row: CollectionGrantRow) -> CollectionGrantDto {
    CollectionGrantDto {
        id: row.id,
        collection_id: row.collection_id,
        item_id: row.item_id,
        user_id: row.user_id,
        conversation_id: row.conversation_id,
        level: row.level,
        granted_by: row.granted_by,
        created_at: row.created_at,
    }
}

async fn load_collection(state: &AppState, id: Uuid) -> AppResult<CollectionRow> {
    sqlx::query_as::<_, CollectionRow>(
        "select * from collections where id = $1 and deleted_at is null",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::not_found("Sammlung nicht gefunden"))
}

/* ---------- Sammlungen ---------- */

/// Alle Sammlungen, die diese Person mindestens ansehen darf – als flache
/// Liste. Den Baum baut die App daraus selbst; so kommt jede Sammlung genau
/// einmal über die Leitung, auch wenn sie an mehreren Stellen sichtbar ist.
async fn list(
    State(state): State<AppState>,
    user: AuthUser,
) -> AppResult<Json<ListResult<CollectionDto>>> {
    let ids = visible_collection_ids(&state.pool, user.id()).await?;
    if ids.is_empty() {
        return Ok(Json(ListResult::new(Vec::new())));
    }

    let rows = sqlx::query_as::<_, CollectionRow>(
        "select * from collections
          where id = any($1) and deleted_at is null
          order by name asc",
    )
    .bind(&ids)
    .fetch_all(&state.pool)
    .await?;

    // Die Zählung in einer Abfrage statt einer je Ordner.
    let counts: Vec<(Uuid, i64)> = sqlx::query_as(
        "select collection_id, count(*)
           from collection_items
          where collection_id = any($1) and deleted_at is null
          group by collection_id",
    )
    .bind(&ids)
    .fetch_all(&state.pool)
    .await?;

    let mut items = Vec::with_capacity(rows.len());
    for row in rows {
        let level = collection_level(&state.pool, row.id, user.id()).await?;
        let count = counts
            .iter()
            .find(|(id, _)| *id == row.id)
            .map(|(_, n)| *n)
            .unwrap_or(0);
        items.push(to_collection_dto(row, level, count));
    }
    Ok(Json(ListResult::new(items)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateInput {
    name: String,
    parent_id: Option<Uuid>,
    conversation_id: Option<Uuid>,
    description: Option<String>,
    color: Option<String>,
    member_level: Option<String>,
}

async fn create(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<CreateInput>,
) -> AppResult<(StatusCode, Json<CollectionDto>)> {
    let name = input.name.trim().to_string();
    let member_level = input.member_level.unwrap_or_else(|| "edit".to_string());
    Validator::new()
        .length("name", &name, 1, COLLECTION_NAME_MAX)
        .one_of("memberLevel", &member_level, COLLECTION_MEMBER_LEVELS)
        .finish()?;
    if let Some(description) = input.description.as_deref() {
        Validator::new()
            .length("description", description, 0, COLLECTION_DESCRIPTION_MAX)
            .finish()?;
    }

    // Wer einen Unterordner anlegt, muss im Elternordner ändern dürfen –
    // sonst könnte man sich über einen Unterordner in fremde Sammlungen
    // einnisten.
    if let Some(parent_id) = input.parent_id {
        require_collection(&state.pool, parent_id, user.id(), Level::Edit).await?;
        if depth_of(&state, parent_id).await? + 1 > COLLECTION_DEPTH_MAX {
            return Err(AppError::bad_request(format!(
                "Mehr als {COLLECTION_DEPTH_MAX} Ebenen sind nicht vorgesehen"
            )));
        }
    }
    if let Some(conversation_id) = input.conversation_id {
        assert_membership(&state.pool, conversation_id, user.id()).await?;
    }

    let id = Uuid::now_v7();
    let row = sqlx::query_as::<_, CollectionRow>(
        "insert into collections
           (id, parent_id, conversation_id, name, description, color, member_level, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         returning *",
    )
    .bind(id)
    .bind(input.parent_id)
    .bind(input.conversation_id)
    .bind(&name)
    .bind(clean(input.description))
    .bind(clean(input.color))
    .bind(&member_level)
    .bind(user.id())
    .fetch_one(&state.pool)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(to_collection_dto(row, Level::Own, 0)),
    ))
}

async fn by_id(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<CollectionDto>> {
    let level = require_collection(&state.pool, id, user.id(), Level::View).await?;
    let row = load_collection(&state, id).await?;
    let count: i64 = sqlx::query_scalar(
        "select count(*) from collection_items where collection_id = $1 and deleted_at is null",
    )
    .bind(id)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(to_collection_dto(row, level, count)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInput {
    name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    description: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    color: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    parent_id: Option<Option<Uuid>>,
    member_level: Option<String>,
}

async fn update(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<UpdateInput>,
) -> AppResult<Json<CollectionDto>> {
    let level = require_collection(&state.pool, id, user.id(), Level::Edit).await?;

    if let Some(name) = input.name.as_deref() {
        Validator::new()
            .length("name", name.trim(), 1, COLLECTION_NAME_MAX)
            .finish()?;
    }
    // Wer nur ändern darf, darf nicht die Grundregel für alle im Chat kippen.
    if input.member_level.is_some() && !level.allows(Level::Own) {
        return Err(AppError::forbidden(
            "Die Rechte für alle im Chat darf nur ändern, wem die Sammlung gehört",
        ));
    }
    if let Some(member_level) = input.member_level.as_deref() {
        Validator::new()
            .one_of("memberLevel", member_level, COLLECTION_MEMBER_LEVELS)
            .finish()?;
    }

    if let Some(parent) = input.parent_id {
        match parent {
            Some(parent_id) => {
                if parent_id == id {
                    return Err(AppError::bad_request(
                        "Eine Sammlung kann nicht in sich selbst liegen",
                    ));
                }
                require_collection(&state.pool, parent_id, user.id(), Level::Edit).await?;
                // Sonst könnte ein Ordner unter einen eigenen Nachfahren
                // rutschen – der Zweig wäre danach von nirgends mehr
                // erreichbar und die Rechte-Abfrage liefe im Kreis.
                if is_descendant(&state, parent_id, id).await? {
                    return Err(AppError::bad_request(
                        "Eine Sammlung kann nicht in einen ihrer eigenen Unterordner",
                    ));
                }
                if depth_of(&state, parent_id).await? + 1 > COLLECTION_DEPTH_MAX {
                    return Err(AppError::bad_request(format!(
                        "Mehr als {COLLECTION_DEPTH_MAX} Ebenen sind nicht vorgesehen"
                    )));
                }
            }
            None => {
                // Nach ganz oben schieben heisst, sie aus der geerbten
                // Zuständigkeit zu lösen – das ist eine Besitzerfrage.
                if !level.allows(Level::Own) {
                    return Err(AppError::forbidden(
                        "Nach ganz oben verschieben darf nur, wem die Sammlung gehört",
                    ));
                }
            }
        }
    }

    let row = sqlx::query_as::<_, CollectionRow>(
        "update collections set
           name         = coalesce($2, name),
           description  = case when $3 then $4 else description end,
           color        = case when $5 then $6 else color end,
           parent_id    = case when $7 then $8 else parent_id end,
           member_level = coalesce($9, member_level),
           updated_at   = now()
         where id = $1 and deleted_at is null
         returning *",
    )
    .bind(id)
    .bind(input.name.map(|value| value.trim().to_string()))
    .bind(input.description.is_some())
    .bind(input.description.flatten())
    .bind(input.color.is_some())
    .bind(input.color.flatten())
    .bind(input.parent_id.is_some())
    .bind(input.parent_id.flatten())
    .bind(input.member_level)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::not_found("Sammlung nicht gefunden"))?;

    let count: i64 = sqlx::query_scalar(
        "select count(*) from collection_items where collection_id = $1 and deleted_at is null",
    )
    .bind(id)
    .fetch_one(&state.pool)
    .await?;
    Ok(Json(to_collection_dto(row, level, count)))
}

async fn remove(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    require_collection(&state.pool, id, user.id(), Level::Own).await?;
    // Nur markieren, nicht wegwerfen: die Dateien selbst liegen weiterhin im
    // Chat, und ein versehentliches Löschen soll nicht den Anhang mitreissen.
    sqlx::query("update collections set deleted_at = now(), updated_at = now() where id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Wie viele Ebenen über dieser Sammlung liegen.
async fn depth_of(state: &AppState, id: Uuid) -> AppResult<i32> {
    let depth: i32 = sqlx::query_scalar(
        "
with recursive kette as (
  select id, parent_id, 1 as tiefe from collections where id = $1 and deleted_at is null
  union all
  select c.id, c.parent_id, k.tiefe + 1
    from collections c join kette k on c.id = k.parent_id
   where c.deleted_at is null
)
select coalesce(max(tiefe), 0)::int from kette",
    )
    .bind(id)
    .fetch_one(&state.pool)
    .await?;
    Ok(depth)
}

/// Liegt `candidate` irgendwo unterhalb von `ancestor`?
async fn is_descendant(state: &AppState, candidate: Uuid, ancestor: Uuid) -> AppResult<bool> {
    let found: bool = sqlx::query_scalar(
        "
with recursive kette as (
  select id, parent_id from collections where id = $1 and deleted_at is null
  union all
  select c.id, c.parent_id
    from collections c join kette k on c.id = k.parent_id
   where c.deleted_at is null
)
select exists (select 1 from kette where id = $2)",
    )
    .bind(candidate)
    .bind(ancestor)
    .fetch_one(&state.pool)
    .await?;
    Ok(found)
}

/* ---------- Dateien in einer Sammlung ---------- */

async fn items(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<ListResult<CollectionItemDto>>> {
    let level = require_collection(&state.pool, id, user.id(), Level::View).await?;

    let rows = sqlx::query_as::<_, CollectionItemRow>(
        "select * from collection_items
          where collection_id = $1 and deleted_at is null
          order by sort_key asc, created_at asc",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?;

    // Die Anhaenge in einer zweiten Abfrage statt einer je Datei.
    let attachment_ids: Vec<Uuid> = rows.iter().map(|row| row.attachment_id).collect();
    let attachments =
        sqlx::query_as::<_, AttachmentRow>("select * from attachments where id = any($1)")
            .bind(&attachment_ids)
            .fetch_all(&state.pool)
            .await?;

    let mut items = Vec::with_capacity(rows.len());
    for item in rows {
        let Some(attachment) = attachments.iter().find(|a| a.id == item.attachment_id) else {
            // Der Anhang wurde geloescht, die Zeile haengt in der Luft.
            continue;
        };
        // Eine einzelne Datei kann mehr erlauben als der Ordner – etwa weil
        // sie jemandem gehört, der ihn selbst nur ansehen darf.
        let eigen = item_level(&state.pool, item.id, user.id()).await?;
        let my_level = if eigen.rank() > level.rank() {
            eigen
        } else {
            level
        };
        items.push(CollectionItemDto {
            id: item.id,
            collection_id: item.collection_id,
            added_by: item.added_by,
            title: item.title,
            note: item.note,
            message_id: item.message_id,
            sort_key: item.sort_key,
            my_level: my_level.as_str().to_string(),
            attachment: to_attachment_dto(attachment, &state.config),
            created_at: item.created_at,
            updated_at: item.updated_at,
        });
    }
    Ok(Json(ListResult::new(items)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddItemInput {
    attachment_id: Uuid,
    title: Option<String>,
    note: Option<String>,
    /// Aus welcher Nachricht die Datei stammt – für den Rücksprung in den Chat.
    message_id: Option<Uuid>,
}

async fn add_item(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<AddItemInput>,
) -> AppResult<(StatusCode, Json<CollectionItemDto>)> {
    require_collection(&state.pool, id, user.id(), Level::Edit).await?;

    if let Some(title) = input.title.as_deref() {
        Validator::new()
            .length("title", title, 0, COLLECTION_ITEM_TITLE_MAX)
            .finish()?;
    }
    if let Some(note) = input.note.as_deref() {
        Validator::new()
            .length("note", note, 0, COLLECTION_ITEM_NOTE_MAX)
            .finish()?;
    }

    let attachment = sqlx::query_as::<_, AttachmentRow>(
        "select * from attachments where id = $1 and status = 'ready'",
    )
    .bind(input.attachment_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::not_found("Datei nicht gefunden oder noch nicht fertig"))?;

    // Man darf nur ablegen, was man auch sehen darf: entweder selbst
    // hochgeladen oder in einem Chat, in dem man ist.
    assert_may_use_attachment(&state, &attachment, user.id()).await?;

    let next_sort: i32 = sqlx::query_scalar(
        "select coalesce(max(sort_key), 0) + 1 from collection_items where collection_id = $1",
    )
    .bind(id)
    .fetch_one(&state.pool)
    .await?;

    let item_id = Uuid::now_v7();
    // Dieselbe Datei zweimal abzulegen ist kein Fehler, sondern ein Versehen –
    // die vorhandene Zeile wird wiederbelebt statt eine zweite anzulegen.
    let item = sqlx::query_as::<_, CollectionItemRow>(
        "insert into collection_items
           (id, collection_id, attachment_id, added_by, title, note, message_id, sort_key)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (collection_id, attachment_id) where deleted_at is null
         do update set deleted_at = null,
                       title      = coalesce(excluded.title, collection_items.title),
                       note       = coalesce(excluded.note, collection_items.note),
                       updated_at = now()
         returning *",
    )
    .bind(item_id)
    .bind(id)
    .bind(input.attachment_id)
    .bind(user.id())
    .bind(clean(input.title))
    .bind(clean(input.note))
    .bind(input.message_id)
    .bind(next_sort)
    .fetch_one(&state.pool)
    .await?;

    Ok((
        StatusCode::CREATED,
        Json(CollectionItemDto {
            id: item.id,
            collection_id: item.collection_id,
            added_by: item.added_by,
            title: item.title,
            note: item.note,
            message_id: item.message_id,
            sort_key: item.sort_key,
            // Wer sie hinzugefuegt hat, darf sie auch wieder entfernen.
            my_level: Level::Own.as_str().to_string(),
            attachment: to_attachment_dto(&attachment, &state.config),
            created_at: item.created_at,
            updated_at: item.updated_at,
        }),
    ))
}

/// Darf diese Person diesen Anhang überhaupt verwenden?
///
/// Ohne diese Prüfung könnte jemand mit einer geratenen Kennung fremde
/// Dateien in die eigene Sammlung holen und darüber ansehen.
async fn assert_may_use_attachment(
    state: &AppState,
    attachment: &AttachmentRow,
    user_id: Uuid,
) -> AppResult<()> {
    if attachment.uploader_id == Some(user_id) {
        return Ok(());
    }
    if let Some(message_id) = attachment.message_id {
        let erlaubt: bool = sqlx::query_scalar(
            "select exists (
               select 1 from messages m
                 join conversation_members cm on cm.conversation_id = m.conversation_id
                where m.id = $1 and cm.user_id = $2
             )",
        )
        .bind(message_id)
        .bind(user_id)
        .fetch_one(&state.pool)
        .await?;
        if erlaubt {
            return Ok(());
        }
    }
    // Schon irgendwo abgelegt, wo die Person hindarf – dann auch hier.
    let sichtbar = visible_collection_ids(&state.pool, user_id).await?;
    if !sichtbar.is_empty() {
        let erlaubt: bool = sqlx::query_scalar(
            "select exists (
               select 1 from collection_items
                where attachment_id = $1 and collection_id = any($2) and deleted_at is null
             )",
        )
        .bind(attachment.id)
        .bind(&sichtbar)
        .fetch_one(&state.pool)
        .await?;
        if erlaubt {
            return Ok(());
        }
    }
    Err(AppError::forbidden(
        "Auf diese Datei hast du keinen Zugriff",
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateItemInput {
    #[serde(default, deserialize_with = "double_option")]
    title: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    note: Option<Option<String>>,
    sort_key: Option<i32>,
    /// In einen anderen Ordner verschieben.
    collection_id: Option<Uuid>,
}

async fn update_item(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, item_id)): Path<(Uuid, Uuid)>,
    Json(input): Json<UpdateItemInput>,
) -> AppResult<Json<serde_json::Value>> {
    require_collection(&state.pool, id, user.id(), Level::View).await?;
    require_item(&state.pool, item_id, user.id(), Level::Edit).await?;
    if let Some(ziel) = input.collection_id {
        require_collection(&state.pool, ziel, user.id(), Level::Edit).await?;
    }

    sqlx::query(
        "update collection_items set
           title         = case when $3 then $4 else title end,
           note          = case when $5 then $6 else note end,
           sort_key      = coalesce($7, sort_key),
           collection_id = coalesce($8, collection_id),
           updated_at    = now()
         where id = $1 and collection_id = $2 and deleted_at is null",
    )
    .bind(item_id)
    .bind(id)
    .bind(input.title.is_some())
    .bind(input.title.flatten())
    .bind(input.note.is_some())
    .bind(input.note.flatten())
    .bind(input.sort_key)
    .bind(input.collection_id)
    .execute(&state.pool)
    .await?;

    Ok(Json(json!({ "ok": true })))
}

async fn remove_item(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, item_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    require_item(&state.pool, item_id, user.id(), Level::Edit).await?;
    sqlx::query(
        "update collection_items set deleted_at = now(), updated_at = now()
          where id = $1 and collection_id = $2",
    )
    .bind(item_id)
    .bind(id)
    .execute(&state.pool)
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

/* ---------- Rechte ---------- */

async fn grants(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<Json<ListResult<CollectionGrantDto>>> {
    require_collection(&state.pool, id, user.id(), Level::View).await?;
    let rows = sqlx::query_as::<_, CollectionGrantRow>(
        "select g.* from collection_grants g
          left join collection_items i on i.id = g.item_id
          where g.collection_id = $1 or i.collection_id = $1
          order by g.created_at asc",
    )
    .bind(id)
    .fetch_all(&state.pool)
    .await?;
    Ok(Json(ListResult::new(
        rows.into_iter().map(to_grant_dto).collect(),
    )))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GrantInput {
    user_id: Option<Uuid>,
    conversation_id: Option<Uuid>,
    level: String,
}

async fn grant(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<GrantInput>,
) -> AppResult<(StatusCode, Json<CollectionGrantDto>)> {
    require_collection(&state.pool, id, user.id(), Level::Own).await?;
    let row = write_grant(&state, Some(id), None, input, user.id()).await?;
    Ok((StatusCode::CREATED, Json(to_grant_dto(row))))
}

async fn grant_item(
    State(state): State<AppState>,
    user: AuthUser,
    Path(item_id): Path<Uuid>,
    Json(input): Json<GrantInput>,
) -> AppResult<(StatusCode, Json<CollectionGrantDto>)> {
    require_item(&state.pool, item_id, user.id(), Level::Own).await?;
    let row = write_grant(&state, None, Some(item_id), input, user.id()).await?;
    Ok((StatusCode::CREATED, Json(to_grant_dto(row))))
}

async fn write_grant(
    state: &AppState,
    collection_id: Option<Uuid>,
    item_id: Option<Uuid>,
    input: GrantInput,
    granted_by: Uuid,
) -> AppResult<CollectionGrantRow> {
    Validator::new()
        .one_of("level", &input.level, COLLECTION_LEVELS)
        .require(
            "userId",
            input.user_id.is_some() != input.conversation_id.is_some(),
            "Entweder eine Person oder ein Chat – nicht beides",
        )
        .finish()?;

    // Rechte an einen Chat vergeben darf nur, wer selbst darin ist. Sonst
    // liesse sich eine fremde Gruppe unbemerkt mit Dateien versorgen.
    if let Some(conversation_id) = input.conversation_id {
        assert_membership(&state.pool, conversation_id, granted_by).await?;
    }

    let sql = if collection_id.is_some() {
        "insert into collection_grants (id, collection_id, user_id, conversation_id, level, granted_by)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (collection_id, user_id) where collection_id is not null and user_id is not null
         do update set level = excluded.level, granted_by = excluded.granted_by
         returning *"
    } else {
        "insert into collection_grants (id, item_id, user_id, conversation_id, level, granted_by)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (item_id, user_id) where item_id is not null and user_id is not null
         do update set level = excluded.level, granted_by = excluded.granted_by
         returning *"
    };

    let row = sqlx::query_as::<_, CollectionGrantRow>(sql)
        .bind(Uuid::now_v7())
        .bind(collection_id.or(item_id))
        .bind(input.user_id)
        .bind(input.conversation_id)
        .bind(&input.level)
        .bind(granted_by)
        .fetch_one(&state.pool)
        .await?;
    Ok(row)
}

async fn revoke(
    State(state): State<AppState>,
    user: AuthUser,
    Path((id, grant_id)): Path<(Uuid, Uuid)>,
) -> AppResult<StatusCode> {
    require_collection(&state.pool, id, user.id(), Level::Own).await?;
    sqlx::query(
        "delete from collection_grants g
          using collection_items i
          where g.id = $1
            and (g.collection_id = $2 or (g.item_id = i.id and i.collection_id = $2))",
    )
    .bind(grant_id)
    .bind(id)
    .execute(&state.pool)
    .await?;
    // Rechte an der Sammlung selbst haben keinen Eintrag in collection_items,
    // deshalb noch der einfache Fall.
    sqlx::query("delete from collection_grants where id = $1 and collection_id = $2")
        .bind(grant_id)
        .bind(id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
