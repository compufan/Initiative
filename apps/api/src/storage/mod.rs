//! Storage abstraction.
//!
//! `r2`/`s3` hand out presigned URLs so large media never passes through the API
//! container; `local` keeps files on disk for development and single-server
//! self-hosting. A new backend only has to implement [`Storage`].

pub mod local;
pub mod s3;
pub mod tresor;

use std::pin::Pin;
use std::sync::Arc;

use async_trait::async_trait;
use axum::body::Bytes;
use chrono::{DateTime, Utc};
use futures_util::Stream;

use crate::config::{Config, StorageDriver};
use crate::error::AppResult;

pub struct PresignedUpload {
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Copy)]
pub struct ByteRange {
    pub start: u64,
    /// Inclusive end offset; `None` reads to the end of the object.
    pub end: Option<u64>,
}

pub type ByteStream = Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send>>;

pub struct ObjectStream {
    pub stream: ByteStream,
    /// Length of this response (the range length when a range was requested).
    pub size: Option<u64>,
    /// Total object size, needed for `Content-Range`.
    pub total_size: Option<u64>,
    pub mime: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct DownloadOptions {
    pub file_name: Option<String>,
    pub mime: Option<String>,
    pub download: bool,
}

#[async_trait]
pub trait Storage: Send + Sync {
    fn kind(&self) -> &'static str;
    fn supports_presigned_upload(&self) -> bool;

    /// Presigned `PUT` target for the browser. Only called when
    /// [`Storage::supports_presigned_upload`] is true.
    fn presign_upload(&self, key: &str, mime: &str) -> AppResult<PresignedUpload>;

    /// Absolute URL the client can fetch, or `None` when the API has to stream
    /// the bytes itself.
    fn download_url(&self, key: &str, options: &DownloadOptions) -> AppResult<Option<String>>;

    async fn put(&self, key: &str, body: Bytes, mime: &str) -> AppResult<()>;
    async fn read(&self, key: &str, range: Option<ByteRange>) -> AppResult<Option<ObjectStream>>;
    async fn delete(&self, key: &str) -> AppResult<()>;
}

pub fn create_storage(config: &Config) -> AppResult<Arc<dyn Storage>> {
    let roh: Arc<dyn Storage> = match config.storage_driver {
        StorageDriver::Local => Arc::new(local::LocalStorage::new(&config.local_storage_dir)),
        StorageDriver::R2 | StorageDriver::S3 => Arc::new(s3::S3Storage::new(config)?),
    };
    // Ist ein Schlüssel gesetzt, kommt der Tresor davor und alles Neue wird
    // verschlüsselt abgelegt. Ohne Schlüssel bleibt alles wie bisher – das
    // Einschalten soll eine Zeile in der Umgebung sein, kein Umbau.
    match config.media_key {
        Some(schluessel) => Ok(Arc::new(tresor::Tresor::neu(roh, schluessel))),
        None => Ok(roh),
    }
}

/// `image/2026/08/<user>/<timestamp>-<random>.webp`
pub fn storage_key_for(kind: &str, owner_id: &uuid::Uuid, extension: &str) -> String {
    let now = Utc::now();
    let random = crate::auth::password::random_token(6);
    format!(
        "{kind}/{year}/{month:02}/{owner_id}/{stamp}-{random}{extension}",
        year = now.format("%Y"),
        month = now.format("%m"),
        stamp = now.timestamp_millis(),
    )
}

pub fn extension_for(file_name: Option<&str>, mime: &str) -> String {
    if let Some(name) = file_name {
        if let Some((_, extension)) = name.rsplit_once('.') {
            if extension.len() <= 8 && extension.chars().all(|c| c.is_ascii_alphanumeric()) {
                return format!(".{}", extension.to_ascii_lowercase());
            }
        }
    }
    match mime.split(';').next().unwrap_or("").trim() {
        "image/jpeg" => ".jpg",
        "image/png" => ".png",
        "image/webp" => ".webp",
        "image/gif" => ".gif",
        "image/avif" => ".avif",
        "video/mp4" => ".mp4",
        "video/webm" => ".webm",
        "video/quicktime" => ".mov",
        "audio/webm" => ".weba",
        "audio/ogg" => ".ogg",
        "audio/mpeg" => ".mp3",
        "audio/mp4" => ".m4a",
        "audio/aac" => ".aac",
        "audio/wav" => ".wav",
        "application/pdf" => ".pdf",
        _ => "",
    }
    .to_string()
}

/// Strips anything that could escape the target directory or a header.
pub fn sanitise_file_name(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '.' | '-' | '_' | ' '))
        .take(120)
        .collect()
}
