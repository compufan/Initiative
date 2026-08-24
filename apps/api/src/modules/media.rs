//! Uploads, Auslieferung und Streaming von Medien.

use axum::body::Body;
use axum::extract::{Multipart, Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::auth::AuthUser;
use crate::constants::{allowed_mime, max_upload_bytes, ATTACHMENT_KINDS, PREVIEW_DATA_URL_MAX};
use crate::db::AttachmentRow;
use crate::dto::AttachmentDto;
use crate::error::{AppError, AppResult};
use crate::services::attachments::{load_attachment, to_attachment_dto};
use crate::state::AppState;
use crate::storage::{extension_for, sanitise_file_name, storage_key_for, ByteRange, DownloadOptions};
use crate::validate::Validator;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/media/uploads", post(create_upload))
        .route("/media/uploads/{id}/data", post(upload_data))
        .route("/media/uploads/{id}/complete", post(complete_upload))
        .route("/media/{id}", get(deliver).delete(remove))
        .route("/media/{id}/download", get(download))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateUploadInput {
    kind: String,
    mime: String,
    size: i64,
    file_name: Option<String>,
}

async fn create_upload(
    State(state): State<AppState>,
    user: AuthUser,
    Json(input): Json<CreateUploadInput>,
) -> AppResult<(StatusCode, Json<serde_json::Value>)> {
    Validator::new()
        .one_of("kind", &input.kind, ATTACHMENT_KINDS)
        .require("size", input.size > 0, "Dateigröße fehlt")
        .finish()?;

    let allowed = allowed_mime(&input.kind);
    let normalised = input.mime.split(';').next().unwrap_or("").trim().to_lowercase();
    if !allowed.is_empty() && !allowed.contains(&normalised.as_str()) {
        return Err(AppError::unsupported_media(format!(
            "{} ist für {} nicht erlaubt",
            input.mime, input.kind
        )));
    }
    let limit = max_upload_bytes(&input.kind);
    if input.size > limit {
        return Err(AppError::too_large(format!(
            "Maximal {} MB für {}",
            limit / 1024 / 1024,
            input.kind
        )));
    }

    let file_name = input
        .file_name
        .as_deref()
        .map(sanitise_file_name)
        .filter(|value| !value.is_empty());
    let extension = extension_for(file_name.as_deref(), &input.mime);
    let storage_key = storage_key_for(&input.kind, &user.id(), &extension);
    let attachment_id = Uuid::now_v7();

    sqlx::query(
        "insert into attachments (id, uploader_id, kind, mime, size, file_name, storage_key, status)
         values ($1, $2, $3, $4, $5, $6, $7, 'pending')",
    )
    .bind(attachment_id)
    .bind(user.id())
    .bind(&input.kind)
    .bind(&input.mime)
    .bind(input.size)
    .bind(&file_name)
    .bind(&storage_key)
    .execute(&state.pool)
    .await?;

    // Opportunistic housekeeping keeps abandoned uploads from piling up.
    let pool = state.pool.clone();
    tokio::spawn(async move {
        let _ = sqlx::query(
            "delete from attachments
             where status = 'pending' and message_id is null
               and created_at < now() - interval '24 hours'",
        )
        .execute(&pool)
        .await;
    });

    let body = if state.storage.supports_presigned_upload() {
        let target = state.storage.presign_upload(&storage_key, &input.mime)?;
        json!({
            "attachmentId": attachment_id,
            "strategy": "presigned",
            "uploadUrl": target.url,
            "headers": target.headers.into_iter().collect::<std::collections::HashMap<_, _>>(),
            "expiresAt": target.expires_at,
        })
    } else {
        json!({
            "attachmentId": attachment_id,
            "strategy": "direct",
            "uploadUrl": format!(
                "{}/api/v1/media/uploads/{}/data",
                state.config.public_api_url, attachment_id
            ),
            "headers": {},
            "expiresAt": chrono::Utc::now() + chrono::Duration::hours(1),
        })
    };

    Ok((StatusCode::CREATED, Json(body)))
}

async fn require_own(state: &AppState, id: Uuid, user_id: Uuid) -> AppResult<AttachmentRow> {
    let attachment = load_attachment(&state.pool, id).await?;
    if attachment.uploader_id != Some(user_id) {
        return Err(AppError::forbidden("Fremder Upload"));
    }
    Ok(attachment)
}

async fn upload_data(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    mut multipart: Multipart,
) -> AppResult<Json<AttachmentDto>> {
    let attachment = require_own(&state, id, user.id()).await?;
    if attachment.message_id.is_some() {
        return Err(AppError::bad_request("Upload wurde bereits abgeschlossen"));
    }

    let limit = max_upload_bytes(&attachment.kind);
    let mut stored = false;
    let mut original_name: Option<String> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|error| AppError::bad_request(format!("Upload fehlgeschlagen: {error}")))?
    {
        if field.name() != Some("file") {
            continue;
        }
        original_name = field.file_name().map(sanitise_file_name);
        let bytes = field
            .bytes()
            .await
            .map_err(|error| AppError::bad_request(format!("Upload fehlgeschlagen: {error}")))?;
        if bytes.len() as i64 > limit {
            state.storage.delete(&attachment.storage_key).await.ok();
            sqlx::query("delete from attachments where id = $1")
                .bind(id)
                .execute(&state.pool)
                .await?;
            return Err(AppError::too_large("Datei überschreitet das Upload-Limit"));
        }
        state
            .storage
            .put(&attachment.storage_key, bytes.clone(), &attachment.mime)
            .await?;
        sqlx::query("update attachments set size = $2 where id = $1")
            .bind(id)
            .bind(bytes.len() as i64)
            .execute(&state.pool)
            .await?;
        stored = true;
        break;
    }

    if !stored {
        return Err(AppError::bad_request("Es wurde keine Datei übertragen"));
    }

    let row = sqlx::query_as::<_, AttachmentRow>(
        "update attachments set status = 'ready', file_name = coalesce(file_name, $2)
         where id = $1 returning *",
    )
    .bind(id)
    .bind(original_name)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(to_attachment_dto(&row, &state.config)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteUploadInput {
    width: Option<i32>,
    height: Option<i32>,
    duration_ms: Option<i32>,
    waveform: Option<Vec<f32>>,
    preview_data_url: Option<String>,
}

async fn complete_upload(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
    Json(input): Json<CompleteUploadInput>,
) -> AppResult<Json<AttachmentDto>> {
    require_own(&state, id, user.id()).await?;

    if let Some(preview) = &input.preview_data_url {
        if preview.len() > PREVIEW_DATA_URL_MAX {
            return Err(AppError::bad_request("Vorschaubild ist zu groß"));
        }
        if !preview.starts_with("data:") {
            return Err(AppError::bad_request("Vorschaubild muss eine data-URL sein"));
        }
    }

    let row = sqlx::query_as::<_, AttachmentRow>(
        "update attachments set
           status = 'ready',
           width = coalesce($2, width),
           height = coalesce($3, height),
           duration_ms = coalesce($4, duration_ms),
           waveform = coalesce($5, waveform),
           preview_data_url = coalesce($6, preview_data_url)
         where id = $1
         returning *",
    )
    .bind(id)
    .bind(input.width)
    .bind(input.height)
    .bind(input.duration_ms)
    .bind(input.waveform.map(|values| serde_json::json!(values)))
    .bind(input.preview_data_url)
    .fetch_one(&state.pool)
    .await?;

    Ok(Json(to_attachment_dto(&row, &state.config)))
}

fn parse_range(header: Option<&str>, total: Option<u64>) -> Option<ByteRange> {
    let value = header?.strip_prefix("bytes=")?;
    let (start_raw, end_raw) = value.split_once('-')?;
    let end = end_raw.trim().parse::<u64>().ok();
    match start_raw.trim().parse::<u64>() {
        Ok(start) => Some(ByteRange { start, end }),
        // Suffix range ("bytes=-500") is only answerable with a known size.
        Err(_) => match (end, total) {
            (Some(length), Some(total)) => Some(ByteRange {
                start: total.saturating_sub(length),
                end: None,
            }),
            _ => None,
        },
    }
}

/// Delivery. The attachment id is a UUID v7 with 74 random bits and acts as a
/// capability URL, so `<img>`, `<video>` and the service-worker cache work
/// without an Authorization header.
async fn serve(state: AppState, id: Uuid, headers: HeaderMap, as_download: bool) -> AppResult<Response> {
    let attachment = load_attachment(&state.pool, id).await?;
    let options = DownloadOptions {
        file_name: attachment.file_name.clone(),
        mime: Some(attachment.mime.clone()),
        download: as_download,
    };

    if let Some(url) = state.storage.download_url(&attachment.storage_key, &options)? {
        // R2/S3 serve the bytes directly – the API never proxies media.
        return Ok((
            [(header::CACHE_CONTROL, "private, max-age=60")],
            Redirect::temporary(&url),
        )
            .into_response());
    }

    let range_header = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    let total = if range_header.is_some() {
        state
            .storage
            .read(&attachment.storage_key, None)
            .await?
            .and_then(|object| object.total_size)
    } else {
        None
    };
    let range = parse_range(range_header.as_deref(), total);

    let object = state
        .storage
        .read(&attachment.storage_key, range)
        .await?
        .ok_or_else(|| AppError::not_found("Datei nicht gefunden"))?;

    let mut response = Response::builder()
        .header(
            header::CONTENT_TYPE,
            object.mime.clone().unwrap_or_else(|| attachment.mime.clone()),
        )
        .header(header::CACHE_CONTROL, "private, max-age=31536000, immutable")
        .header(header::ACCEPT_RANGES, "bytes")
        .header("x-content-type-options", "nosniff");

    if as_download {
        let name = sanitise_file_name(attachment.file_name.as_deref().unwrap_or("datei"));
        response = response.header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"{name}\""),
        );
    }

    let response = match (range, object.total_size) {
        (Some(range), Some(total)) => {
            let end = range.end.unwrap_or(total.saturating_sub(1)).min(total.saturating_sub(1));
            response
                .status(StatusCode::PARTIAL_CONTENT)
                .header(
                    header::CONTENT_RANGE,
                    format!("bytes {}-{}/{}", range.start, end, total),
                )
                .header(
                    header::CONTENT_LENGTH,
                    object.size.unwrap_or(end - range.start + 1).to_string(),
                )
        }
        _ => match object.size {
            Some(size) => response.header(header::CONTENT_LENGTH, size.to_string()),
            None => response,
        },
    };

    response
        .body(Body::from_stream(object.stream))
        .map_err(|error| AppError::internal(error.to_string()))
}

async fn deliver(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> AppResult<Response> {
    serve(state, id, headers, false).await
}

async fn download(
    State(state): State<AppState>,
    Path(id): Path<Uuid>,
    headers: HeaderMap,
) -> AppResult<Response> {
    serve(state, id, headers, true).await
}

async fn remove(
    State(state): State<AppState>,
    user: AuthUser,
    Path(id): Path<Uuid>,
) -> AppResult<StatusCode> {
    let attachment = require_own(&state, id, user.id()).await?;
    if attachment.message_id.is_some() {
        return Err(AppError::forbidden(
            "Bereits gesendete Anhänge können nicht gelöscht werden",
        ));
    }
    state.storage.delete(&attachment.storage_key).await.ok();
    sqlx::query("delete from attachments where id = $1")
        .bind(id)
        .execute(&state.pool)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}
