//! Storage abstraction.
//!
//! `r2`/`s3` hand out presigned URLs so large media never passes through the API
//! container; `local` keeps files on disk for development and single-server
//! self-hosting. A new backend only has to implement [`Storage`].

pub mod local;
pub mod muell;
pub mod s3;
pub mod sftp;
pub mod tresor;
pub mod weiche;

use std::pin::Pin;
use std::sync::Arc;

use async_trait::async_trait;
use axum::body::Bytes;
use chrono::{DateTime, Utc};
use futures_util::Stream;

use crate::config::{Config, KaltTreiber, StorageDriver};
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

/**
 * Der Speicher, den dieser Prozess benutzt – genau einer, in drei Schichten.
 *
 * Von innen nach aussen:
 *
 *   1. **Der Treiber**: Platte oder S3. Er kennt nur Schlüssel und Bytes.
 *   2. **Die Weiche** (falls eine kalte Ablage eingerichtet ist): Sie
 *      entscheidet je Schlüssel, ob warm oder kalt gelesen wird. Geschrieben
 *      wird immer warm.
 *   3. **Der Tresor** (falls ein Schlüssel gesetzt ist): Er verschlüsselt.
 *
 * Die Reihenfolge ist keine Geschmacksfrage. Der Tresor gehört NACH AUSSEN,
 * weil sonst zweimal verschlüsselt würde – einmal je Ablage – und eine Datei
 * beim Umzug von warm nach kalt umgeschlüsselt werden müsste. So wandert sie
 * Byte für Byte, wie sie ist.
 *
 * `pool` wird nur von der Weiche gebraucht. Er steht trotzdem in der
 * Signatur und nicht hinter einem `Option`: Eine Funktion, die ihre
 * Abhängigkeit je nach Einstellung verlangt oder nicht, lädt dazu ein, sie
 * beim nächsten Umbau zu vergessen.
 */
/**
 * Was beim Anlegen des Speichers herauskommt.
 *
 * `aussen` ist das, was der ganze Rest der App benutzt – mit Tresor, mit
 * Weiche, fertig.
 *
 * `warm` und `kalt` sind die ROHEN Treiber daneben, und sie stehen nur für
 * eine einzige Aufgabe hier: den Umzug. Eine Datei, die von warm nach kalt
 * wandert, soll Byte für Byte kopiert werden – durch den Tresor gelesen und
 * wieder hineingeschrieben würde sie entschlüsselt und neu verschlüsselt,
 * ohne dass sich am Ergebnis etwas ändert ausser der Rechenzeit. Und durch
 * die Weiche gelesen käme sie gar nicht an: Die schickt jeden Schreibvorgang
 * nach warm, also auch den, der nach kalt soll.
 */
pub struct Speicher {
    pub aussen: Arc<dyn Storage>,
    pub warm: Arc<dyn Storage>,
    pub kalt: Option<Arc<dyn Storage>>,
}

pub fn create_storage(config: &Config, pool: &sqlx::PgPool) -> AppResult<Speicher> {
    let warm: Arc<dyn Storage> = match config.storage_driver {
        StorageDriver::Local => Arc::new(local::LocalStorage::new(&config.local_storage_dir)),
        StorageDriver::R2 | StorageDriver::S3 => Arc::new(s3::S3Storage::new(config)?),
    };
    let kalt = kalte_ablage(config)?;

    let mit_weiche: Arc<dyn Storage> = match &kalt {
        Some(kalt) => Arc::new(weiche::Weiche::neu(
            warm.clone(),
            kalt.clone(),
            pool.clone(),
        )),
        None => warm.clone(),
    };

    // Ist ein Schlüssel gesetzt, kommt der Tresor davor und alles Neue wird
    // verschlüsselt abgelegt. Ohne Schlüssel bleibt alles wie bisher – das
    // Einschalten soll eine Zeile in der Umgebung sein, kein Umbau.
    let aussen: Arc<dyn Storage> = match config.media_key {
        Some(schluessel) => Arc::new(tresor::Tresor::neu(mit_weiche, schluessel)),
        None => mit_weiche,
    };
    Ok(Speicher { aussen, warm, kalt })
}

/// Die kalte Ablage – oder `None`, wenn keine eingerichtet ist.
fn kalte_ablage(config: &Config) -> AppResult<Option<Arc<dyn Storage>>> {
    match config.kalt_treiber {
        KaltTreiber::Aus => Ok(None),
        KaltTreiber::Lokal => Ok(Some(Arc::new(local::LocalStorage::new(
            &config.kalt_lokal_dir,
        )))),
        KaltTreiber::Sftp => {
            let Some(einstellungen) = config.kalt_sftp.clone() else {
                return Err(crate::error::AppError::config(
                    "KALT_TREIBER=sftp, aber KALT_SFTP_WIRT fehlt",
                ));
            };
            if einstellungen.benutzer.is_empty() {
                return Err(crate::error::AppError::config(
                    "KALT_TREIBER=sftp, aber KALT_SFTP_BENUTZER fehlt",
                ));
            }
            Ok(Some(Arc::new(sftp::SftpSpeicher::neu(einstellungen))))
        }
        /*
         * Der S3-Weg als kalte Ablage ist bewusst noch nicht verdrahtet:
         * `S3Storage::new` liest EINEN Satz Zugangsdaten aus der Umgebung,
         * und für zwei Eimer bräuchte es zwei. Das ist ein kleiner Umbau, aber
         * einer – und eine halb verdrahtete Einstellung, die stillschweigend
         * denselben Eimer für warm und kalt nimmt, wäre schlimmer als eine,
         * die ehrlich sagt, dass sie noch nicht da ist.
         */
        KaltTreiber::S3 => Err(crate::error::AppError::config(
            "KALT_TREIBER=s3 ist noch nicht eingebaut – nimm sftp",
        )),
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
