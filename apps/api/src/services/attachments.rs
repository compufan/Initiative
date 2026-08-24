use std::collections::HashMap;

use sqlx::PgPool;
use uuid::Uuid;

use crate::config::Config;
use crate::db::{json_to_f32_vec, AttachmentRow};
use crate::dto::AttachmentDto;
use crate::error::{AppError, AppResult};

pub fn to_attachment_dto(row: &AttachmentRow, config: &Config) -> AttachmentDto {
    AttachmentDto {
        id: row.id,
        kind: row.kind.clone(),
        mime: row.mime.clone(),
        size: row.size,
        file_name: row.file_name.clone(),
        width: row.width,
        height: row.height,
        duration_ms: row.duration_ms,
        waveform: row.waveform.as_ref().map(json_to_f32_vec),
        preview_data_url: row.preview_data_url.clone(),
        url: config.media_url(&row.id),
        status: row.status.clone(),
        created_at: row.created_at,
    }
}

pub async fn load_by_message_ids(
    pool: &PgPool,
    message_ids: &[Uuid],
    config: &Config,
) -> AppResult<HashMap<Uuid, Vec<AttachmentDto>>> {
    let mut grouped: HashMap<Uuid, Vec<AttachmentDto>> = HashMap::new();
    if message_ids.is_empty() {
        return Ok(grouped);
    }
    let rows = sqlx::query_as::<_, AttachmentRow>(
        "select * from attachments where message_id = any($1) order by created_at asc",
    )
    .bind(message_ids)
    .fetch_all(pool)
    .await?;

    for row in rows {
        if let Some(message_id) = row.message_id {
            grouped
                .entry(message_id)
                .or_default()
                .push(to_attachment_dto(&row, config));
        }
    }
    Ok(grouped)
}

pub async fn load_attachment(pool: &PgPool, id: Uuid) -> AppResult<AttachmentRow> {
    sqlx::query_as::<_, AttachmentRow>("select * from attachments where id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::not_found("Datei nicht gefunden"))
}
