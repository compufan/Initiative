//! Cloudflare R2 / AWS S3 / MinIO – presigned URLs only, so media bytes never
//! travel through the API container.

use std::time::Duration;

use async_trait::async_trait;
use axum::body::Bytes;
use chrono::Utc;
use futures_util::TryStreamExt;
use rusty_s3::{Bucket, Credentials, S3Action, UrlStyle};
use url::Url;

use super::{ByteRange, DownloadOptions, ObjectStream, PresignedUpload, Storage};
use crate::config::{Config, StorageDriver};
use crate::error::{AppError, AppResult};

pub struct S3Storage {
    bucket: Bucket,
    credentials: Credentials,
    kind: &'static str,
    signed_url_ttl: Duration,
    public_base_url: Option<String>,
    http: reqwest::Client,
}

impl S3Storage {
    pub fn new(config: &Config) -> AppResult<Self> {
        let settings = config
            .s3
            .as_ref()
            .ok_or_else(|| AppError::config("S3-Konfiguration fehlt"))?;

        let endpoint = settings
            .endpoint
            .clone()
            .unwrap_or_else(|| format!("https://s3.{}.amazonaws.com", settings.region));
        let endpoint = Url::parse(&endpoint)
            .map_err(|error| AppError::config(format!("Ungültiger S3_ENDPOINT: {error}")))?;

        let style = if settings.path_style {
            UrlStyle::Path
        } else {
            UrlStyle::VirtualHost
        };
        let bucket = Bucket::new(
            endpoint,
            style,
            settings.bucket.clone(),
            settings.region.clone(),
        )
        .map_err(|error| AppError::config(format!("S3-Bucket ungültig: {error}")))?;

        Ok(Self {
            bucket,
            credentials: Credentials::new(
                settings.access_key_id.clone(),
                settings.secret_access_key.clone(),
            ),
            kind: if config.storage_driver == StorageDriver::R2 {
                "r2"
            } else {
                "s3"
            },
            signed_url_ttl: config.signed_url_ttl,
            public_base_url: settings.public_base_url.clone(),
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|error| AppError::config(format!("HTTP-Client: {error}")))?,
        })
    }
}

#[async_trait]
impl Storage for S3Storage {
    fn kind(&self) -> &'static str {
        self.kind
    }

    fn supports_presigned_upload(&self) -> bool {
        true
    }

    fn presign_upload(&self, key: &str, mime: &str) -> AppResult<PresignedUpload> {
        let action = self.bucket.put_object(Some(&self.credentials), key);
        // Content-Type is deliberately not part of the signature: the browser may
        // send it, but a mismatch must not break the upload.
        let url = action.sign(Duration::from_secs(900));
        Ok(PresignedUpload {
            url: url.to_string(),
            headers: vec![("content-type".to_string(), mime.to_string())],
            expires_at: Utc::now() + chrono::Duration::seconds(900),
        })
    }

    fn download_url(&self, key: &str, options: &DownloadOptions) -> AppResult<Option<String>> {
        if let Some(base) = &self.public_base_url {
            return Ok(Some(format!("{base}/{key}")));
        }
        let mut action = self.bucket.get_object(Some(&self.credentials), key);
        if let Some(mime) = &options.mime {
            action
                .query_mut()
                .insert("response-content-type", mime.clone());
        }
        if options.download {
            let name =
                super::sanitise_file_name(options.file_name.as_deref().unwrap_or("download"));
            action.query_mut().insert(
                "response-content-disposition",
                format!("attachment; filename=\"{name}\""),
            );
        }
        Ok(Some(action.sign(self.signed_url_ttl).to_string()))
    }

    async fn put(&self, key: &str, body: Bytes, mime: &str) -> AppResult<()> {
        let url = self
            .bucket
            .put_object(Some(&self.credentials), key)
            .sign(Duration::from_secs(300));
        let response = self
            .http
            .put(url)
            .header("content-type", mime)
            .body(body)
            .send()
            .await
            .map_err(|error| AppError::internal(format!("Upload zu S3 fehlgeschlagen: {error}")))?;
        if !response.status().is_success() {
            return Err(AppError::internal(format!(
                "Upload zu S3 fehlgeschlagen: HTTP {}",
                response.status()
            )));
        }
        Ok(())
    }

    /// Liest ein Objekt durch die API hindurch.
    ///
    /// Zum Anschauen ist das der falsche Weg – dafür gibt es `download_url`,
    /// und der Browser holt die Bytes direkt beim Speicher. Gebraucht wird es
    /// für den einen Fall, in dem die Umleitung nicht geht: Wer die Bildpunkte
    /// *lesen* will (bearbeiten, freistellen, einen Sticker sichern), schickt
    /// nach einer Umleitung auf eine fremde Herkunft `Origin: null` mit, und
    /// die CORS-Regel des Buckets greift nicht mehr.
    ///
    /// Hier war vorher `Ok(None)` – mit der Begründung, die API reiche nie
    /// Bytes durch. Das stimmte, bis es `/media/{id}/bytes` gab: Seitdem
    /// antwortete der Endpunkt mit R2 schlicht „Datei nicht gefunden“, und das
    /// Bearbeiten scheiterte in der Veröffentlichung, während es lokal lief.
    async fn read(&self, key: &str, range: Option<ByteRange>) -> AppResult<Option<ObjectStream>> {
        let url = self
            .bucket
            .get_object(Some(&self.credentials), key)
            .sign(self.signed_url_ttl);

        let mut anfrage = self.http.get(url);
        if let Some(range) = &range {
            anfrage = anfrage.header(
                "range",
                match range.end {
                    Some(ende) => format!("bytes={}-{}", range.start, ende),
                    None => format!("bytes={}-", range.start),
                },
            );
        }

        let antwort = anfrage
            .send()
            .await
            .map_err(|error| AppError::internal(format!("Lesen aus S3 fehlgeschlagen: {error}")))?;

        if antwort.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !antwort.status().is_success() {
            return Err(AppError::internal(format!(
                "Lesen aus S3 fehlgeschlagen: HTTP {}",
                antwort.status()
            )));
        }

        // Bei einer Teilantwort steht die Gesamtgrösse hinter dem Schrägstrich
        // in `Content-Range`; ohne Bereich ist `Content-Length` die Gesamtgrösse.
        let size = antwort.content_length();
        let total_size = antwort
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|wert| wert.to_str().ok())
            .and_then(|wert| wert.rsplit('/').next().map(str::to_string))
            .and_then(|gesamt| gesamt.parse::<u64>().ok())
            .or(size);
        let mime = antwort
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|wert| wert.to_str().ok())
            .map(str::to_string);

        let stream = antwort
            .bytes_stream()
            .map_err(|error| std::io::Error::other(error.to_string()));

        Ok(Some(ObjectStream {
            stream: Box::pin(stream),
            size,
            total_size,
            mime,
        }))
    }

    async fn delete(&self, key: &str) -> AppResult<()> {
        let url = self
            .bucket
            .delete_object(Some(&self.credentials), key)
            .sign(Duration::from_secs(300));
        let _ = self.http.delete(url).send().await;
        Ok(())
    }
}
