//! Sticker-Pakete und einzelne Sticker.

use std::collections::{HashMap, HashSet};

use async_trait::async_trait;
use uuid::Uuid;

use crate::config::Config;
use crate::db::{AttachmentRow, MessageRow, StickerPackRow, StickerRow};
use crate::dto::{StickerDto, StickerPackDto};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

use super::expanders::{metadata_id, referenced_ids, Expansion, MessageExpander};

pub fn to_sticker_dto(row: &StickerRow, pack_name: &str, config: &Config) -> StickerDto {
    StickerDto {
        id: row.id,
        pack_id: row.pack_id,
        pack_name: pack_name.to_string(),
        url: config.media_url(&row.attachment_id),
        emoji: row.emoji.clone(),
        width: row.width,
        height: row.height,
        created_at: row.created_at,
    }
}

pub fn to_pack_dto(
    pack: &StickerPackRow,
    stickers: &[StickerRow],
    installed: bool,
    config: &Config,
) -> StickerPackDto {
    let mut sorted: Vec<&StickerRow> = stickers.iter().collect();
    sorted.sort_by_key(|sticker| sticker.position);
    let cover = pack
        .cover_sticker_id
        .and_then(|id| sorted.iter().find(|sticker| sticker.id == id).copied())
        .or_else(|| sorted.first().copied());

    StickerPackDto {
        id: pack.id,
        name: pack.name.clone(),
        owner_id: pack.owner_id,
        cover_url: cover.map(|sticker| config.media_url(&sticker.attachment_id)),
        is_public: pack.is_public,
        installed,
        sticker_count: sorted.len(),
        stickers: sorted
            .iter()
            .map(|sticker| to_sticker_dto(sticker, &pack.name, config))
            .collect(),
        created_at: pack.created_at,
    }
}

pub async fn load_pack_dtos(
    state: &AppState,
    pack_ids: &[Uuid],
    viewer_id: Uuid,
) -> AppResult<HashMap<Uuid, StickerPackDto>> {
    if pack_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let packs =
        sqlx::query_as::<_, StickerPackRow>("select * from sticker_packs where id = any($1)")
            .bind(pack_ids)
            .fetch_all(&state.pool)
            .await?;
    let stickers = sqlx::query_as::<_, StickerRow>(
        "select * from stickers where pack_id = any($1) order by position asc",
    )
    .bind(pack_ids)
    .fetch_all(&state.pool)
    .await?;
    let installs: HashSet<Uuid> = sqlx::query_as::<_, (Uuid,)>(
        "select pack_id from sticker_pack_installs where user_id = $1 and pack_id = any($2)",
    )
    .bind(viewer_id)
    .bind(pack_ids)
    .fetch_all(&state.pool)
    .await?
    .into_iter()
    .map(|(id,)| id)
    .collect();

    let mut by_pack: HashMap<Uuid, Vec<StickerRow>> = HashMap::new();
    for sticker in stickers {
        by_pack.entry(sticker.pack_id).or_default().push(sticker);
    }

    Ok(packs
        .into_iter()
        .map(|pack| {
            let stickers = by_pack.remove(&pack.id).unwrap_or_default();
            let installed = installs.contains(&pack.id);
            (
                pack.id,
                to_pack_dto(&pack, &stickers, installed, &state.config),
            )
        })
        .collect())
}

pub async fn load_pack_dto(
    state: &AppState,
    pack_id: Uuid,
    viewer_id: Uuid,
) -> AppResult<StickerPackDto> {
    load_pack_dtos(state, &[pack_id], viewer_id)
        .await?
        .remove(&pack_id)
        .ok_or_else(|| AppError::not_found("Sticker-Paket nicht gefunden"))
}

pub async fn require_pack(state: &AppState, pack_id: Uuid) -> AppResult<StickerPackRow> {
    sqlx::query_as::<_, StickerPackRow>("select * from sticker_packs where id = $1")
        .bind(pack_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| AppError::not_found("Sticker-Paket nicht gefunden"))
}

/// Attachments backing a sticker must never be reused as chat attachments.
pub async fn claim_attachment(state: &AppState, attachment_id: Uuid) -> AppResult<AttachmentRow> {
    sqlx::query_as::<_, AttachmentRow>(
        "update attachments set status = 'ready', kind = 'sticker'
         where id = $1 and message_id is null
         returning *",
    )
    .bind(attachment_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| AppError::not_found("Sticker-Datei nicht gefunden"))
}

/// Embeds the referenced sticker into every `sticker` message.
pub struct StickerExpander;

#[async_trait]
impl MessageExpander for StickerExpander {
    fn key(&self) -> &'static str {
        "stickers"
    }

    async fn expand(
        &self,
        state: &AppState,
        _viewer_id: Uuid,
        messages: &[MessageRow],
    ) -> AppResult<HashMap<Uuid, Expansion>> {
        let ids = referenced_ids(messages, "stickerId");
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let rows = sqlx::query_as::<_, (Uuid, Uuid, Uuid, Option<String>, i32, i32, chrono::DateTime<chrono::Utc>, String)>(
            "select s.id, s.pack_id, s.attachment_id, s.emoji, s.width, s.height, s.created_at, p.name
             from stickers s
             join sticker_packs p on p.id = s.pack_id
             where s.id = any($1)",
        )
        .bind(&ids)
        .fetch_all(&state.pool)
        .await?;

        let stickers: HashMap<Uuid, StickerDto> = rows
            .into_iter()
            .map(
                |(id, pack_id, attachment_id, emoji, width, height, created_at, pack_name)| {
                    (
                        id,
                        StickerDto {
                            id,
                            pack_id,
                            pack_name,
                            url: state.config.media_url(&attachment_id),
                            emoji,
                            width,
                            height,
                            created_at,
                        },
                    )
                },
            )
            .collect();

        let mut result = HashMap::new();
        for message in messages {
            if let Some(sticker_id) = metadata_id(message, "stickerId") {
                if let Some(sticker) = stickers.get(&sticker_id) {
                    result.insert(
                        message.id,
                        Expansion {
                            sticker: Some(sticker.clone()),
                            ..Default::default()
                        },
                    );
                }
            }
        }
        Ok(result)
    }
}
