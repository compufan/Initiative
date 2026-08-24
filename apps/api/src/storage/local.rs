//! Disk backed storage for development and single-container self-hosting.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use axum::body::Bytes;
use futures_util::TryStreamExt;
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

use super::{ByteRange, DownloadOptions, ObjectStream, PresignedUpload, Storage};
use crate::error::{AppError, AppResult};

pub struct LocalStorage {
    root: PathBuf,
}

impl LocalStorage {
    pub fn new(root: &str) -> Self {
        Self {
            root: PathBuf::from(root),
        }
    }

    /// Resolves a key inside the storage root, refusing traversal attempts.
    fn path_for(&self, key: &str) -> AppResult<PathBuf> {
        if key.contains("..") || key.starts_with('/') || key.contains('\\') {
            return Err(AppError::bad_request("Ungültiger Speicherpfad"));
        }
        let mut path = self.root.clone();
        for segment in key.split('/') {
            if segment.is_empty() || segment == "." {
                continue;
            }
            path.push(segment);
        }
        Ok(path)
    }
}

#[async_trait]
impl Storage for LocalStorage {
    fn kind(&self) -> &'static str {
        "local"
    }

    fn supports_presigned_upload(&self) -> bool {
        false
    }

    fn presign_upload(&self, _key: &str, _mime: &str) -> AppResult<PresignedUpload> {
        Err(AppError::internal(
            "Lokaler Speicher unterstützt keine presigned Uploads",
        ))
    }

    fn download_url(&self, _key: &str, _options: &DownloadOptions) -> AppResult<Option<String>> {
        // `None` → the media route streams the file itself.
        Ok(None)
    }

    async fn put(&self, key: &str, body: Bytes, _mime: &str) -> AppResult<()> {
        let path = self.path_for(key)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await?;
        }
        fs::write(&path, &body).await?;
        Ok(())
    }

    async fn read(&self, key: &str, range: Option<ByteRange>) -> AppResult<Option<ObjectStream>> {
        let path = self.path_for(key)?;
        let metadata = match fs::metadata(&path).await {
            Ok(metadata) => metadata,
            Err(_) => return Ok(None),
        };
        let total = metadata.len();
        let mut file = match fs::File::open(&path).await {
            Ok(file) => file,
            Err(_) => return Ok(None),
        };

        let (size, stream): (u64, super::ByteStream) = match range {
            Some(range) => {
                let start = range.start.min(total.saturating_sub(1));
                let end = range
                    .end
                    .unwrap_or(total.saturating_sub(1))
                    .min(total.saturating_sub(1));
                let length = end.saturating_sub(start) + 1;
                file.seek(std::io::SeekFrom::Start(start)).await?;
                let limited = file.take(length);
                (
                    length,
                    Box::pin(ReaderStream::new(limited).map_ok(Bytes::from)),
                )
            }
            None => (total, Box::pin(ReaderStream::new(file).map_ok(Bytes::from))),
        };

        Ok(Some(ObjectStream {
            stream,
            size: Some(size),
            total_size: Some(total),
            mime: guess_mime(&path),
        }))
    }

    async fn delete(&self, key: &str) -> AppResult<()> {
        let path = self.path_for(key)?;
        let _ = fs::remove_file(path).await;
        Ok(())
    }
}

fn guess_mime(path: &Path) -> Option<String> {
    mime_guess::from_path(path)
        .first()
        .map(|mime| mime.to_string())
}
