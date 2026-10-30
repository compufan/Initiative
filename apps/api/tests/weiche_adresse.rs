//! Warm S3, kalt SFTP: Die Weiche darf für kalt liegende Dateien keine
//! S3-Adresse herausgeben.
//!
//! Gebaut mit einer Attrappe als warmer Ablage, die IMMER eine Adresse
//! anbietet (wie ein S3-Eimer mit öffentlicher Domain) – so zeigt sich, ob
//! die Weiche sie für kalte Dateien zurückhält. Gebraucht wird nur die
//! Datenbank für die Zeile `attachments.ablage`.

use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use uuid::Uuid;

use initiative_api::config::Config;
use initiative_api::error::AppResult;
use initiative_api::state::AppState;
use initiative_api::storage::local::LocalStorage;
use initiative_api::storage::weiche::Weiche;
use initiative_api::storage::{
    ByteRange, DownloadOptions, ObjectStream, PresignedUpload, Storage,
};
use initiative_api::MIGRATOR;

/// Wie ein S3-Eimer mit öffentlicher Domain: jeder Schlüssel hat eine Adresse.
struct S3Attrappe;

#[async_trait]
impl Storage for S3Attrappe {
    fn kind(&self) -> &'static str {
        "s3-attrappe"
    }
    fn supports_presigned_upload(&self) -> bool {
        true
    }
    fn presign_upload(&self, _k: &str, _m: &str) -> AppResult<PresignedUpload> {
        unreachable!()
    }
    fn download_url(&self, key: &str, _o: &DownloadOptions) -> AppResult<Option<String>> {
        Ok(Some(format!("https://eimer.example/{key}")))
    }
    async fn put(&self, _k: &str, _b: Bytes, _m: &str) -> AppResult<()> {
        Ok(())
    }
    async fn read(&self, _k: &str, _r: Option<ByteRange>) -> AppResult<Option<ObjectStream>> {
        Ok(None)
    }
    async fn delete(&self, _k: &str) -> AppResult<()> {
        Ok(())
    }
}

async fn aufbauen() -> Option<AppState> {
    let url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;
    std::env::set_var("DATABASE_URL", &url);
    std::env::set_var("NODE_ENV", "test");
    std::env::set_var("JWT_SECRET", "test-secret-value-at-least-16-characters");
    std::env::set_var("REALTIME_BUS", "memory");
    std::env::set_var("STORAGE_DRIVER", "local");
    std::env::set_var("LOCAL_STORAGE_DIR", "./.data/test-weiche-adresse");
    let state = AppState::new(Config::from_env().expect("config"))
        .await
        .expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    Some(state)
}

#[tokio::test(flavor = "multi_thread")]
async fn kalte_dateien_bekommen_keine_s3_adresse() {
    let Some(state) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – übersprungen");
        return;
    };
    let kalt_dir = std::env::temp_dir().join(format!("weiche-adr-{}", Uuid::now_v7().simple()));
    let kalt: Arc<dyn Storage> = Arc::new(LocalStorage::new(kalt_dir.to_str().unwrap()));
    let weiche = Weiche::neu(Arc::new(S3Attrappe), kalt, state.pool.clone());
    let opt = DownloadOptions::default();

    let mut schluessel = Vec::new();
    for ablage in ["lokal", "fern", "wandert"] {
        let k = format!("video/2026/10/{}/{}.mp4", Uuid::now_v7(), ablage);
        sqlx::query(
            "insert into attachments (id, kind, mime, storage_key, status, ablage)
             values ($1, 'video', 'video/mp4', $2, 'ready', $3)",
        )
        .bind(Uuid::now_v7())
        .bind(&k)
        .bind(ablage)
        .execute(&state.pool)
        .await
        .expect("anhang");
        schluessel.push((ablage, k));
    }

    for (ablage, k) in &schluessel {
        let adresse = weiche.adresse(k, &opt).await.unwrap();
        match *ablage {
            "lokal" => assert_eq!(adresse, Some(format!("https://eimer.example/{k}"))),
            _ => assert_eq!(adresse, None, "{ablage}: es wurde eine S3-Adresse herausgegeben"),
        }
        // Der synchrone Weg kennt die Ablage nicht und liefert deshalb nie eine.
        assert_eq!(weiche.download_url(k, &opt).unwrap(), None);
    }
    // Ein Schlüssel ohne Zeile (Miniatur, Prüfdatei) gilt als warm.
    assert!(weiche
        .adresse("x/ohne-zeile.webp.mini-320.jpg", &opt)
        .await
        .unwrap()
        .is_some());

    for (_, k) in &schluessel {
        sqlx::query("delete from attachments where storage_key = $1")
            .bind(k)
            .execute(&state.pool)
            .await
            .unwrap();
        sqlx::query("delete from storage_muell where storage_key = $1")
            .bind(k)
            .execute(&state.pool)
            .await
            .unwrap();
    }
    let _ = std::fs::remove_dir_all(&kalt_dir);
}
