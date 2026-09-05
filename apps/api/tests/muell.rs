//! Was gelöscht wird, muss auch aus dem Speicher verschwinden.
//!
//! Der Punkt dieses Tests ist nicht der eine offensichtliche Weg, sondern die
//! KASKADE: `attachments.message_id` trägt `on delete cascade`. Wer ein
//! Gespräch oder ein Konto löscht, räumt damit Anhangszeilen ab, ohne dass
//! irgendein Rust-Handler das je zu sehen bekommt. Genau deshalb schreibt ein
//! Auslöser in der Datenbank mit, statt dass der Handler aufräumt – und genau
//! das wird hier geprüft.

use std::sync::Arc;

use async_trait::async_trait;
use bytes::Bytes;
use uuid::Uuid;

use initiative_api::config::Config;
use initiative_api::state::AppState;
use initiative_api::storage::muell::aufraeumen;
use initiative_api::MIGRATOR;

async fn aufbauen() -> Option<AppState> {
    let url = std::env::var("TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .ok()?;
    std::env::set_var("DATABASE_URL", &url);
    std::env::set_var("NODE_ENV", "test");
    std::env::set_var("JWT_SECRET", "test-secret-value-at-least-16-characters");
    std::env::set_var("REALTIME_BUS", "memory");
    std::env::set_var("STORAGE_DRIVER", "local");
    std::env::set_var("LOCAL_STORAGE_DIR", "./.data/test-muell");
    let state = AppState::new(Config::from_env().expect("config"))
        .await
        .expect("state");
    MIGRATOR.run(&state.pool).await.expect("migrations");
    Some(state)
}

/// Legt eine Nachricht mit einem Anhang an – und die Datei dazu.
async fn anhang_anlegen(state: &AppState, schluessel: &str) -> (Uuid, Uuid) {
    let simple = Uuid::now_v7().simple().to_string();
    let suffix = &simple[simple.len() - 10..];

    let nutzer = Uuid::now_v7();
    sqlx::query(
        "insert into users (id, username, display_name, password_hash, calendar_token)
         values ($1, $2, $3, 'x', $4)",
    )
    .bind(nutzer)
    .bind(format!("muell{suffix}"))
    .bind("Müll Test")
    .bind(Uuid::now_v7().simple().to_string())
    .execute(&state.pool)
    .await
    .expect("nutzer");

    let chat = Uuid::now_v7();
    sqlx::query("insert into conversations (id, type, created_by) values ($1, 'group', $2)")
        .bind(chat)
        .bind(nutzer)
        .execute(&state.pool)
        .await
        .expect("chat");

    let nachricht = Uuid::now_v7();
    sqlx::query(
        "insert into messages (id, conversation_id, sender_id, body) values ($1, $2, $3, 'hallo')",
    )
    .bind(nachricht)
    .bind(chat)
    .bind(nutzer)
    .execute(&state.pool)
    .await
    .expect("nachricht");

    sqlx::query(
        "insert into attachments (id, message_id, uploader_id, kind, mime, storage_key, status)
         values ($1, $2, $3, 'image', 'image/png', $4, 'ready')",
    )
    .bind(Uuid::now_v7())
    .bind(nachricht)
    .bind(nutzer)
    .bind(schluessel)
    .execute(&state.pool)
    .await
    .expect("anhang");

    state
        .storage
        .put(schluessel, Bytes::from_static(b"nicht nichts"), "image/png")
        .await
        .expect("datei");

    (nachricht, chat)
}

async fn liegt_im_speicher(state: &AppState, schluessel: &str) -> bool {
    state
        .storage
        .read(schluessel, None)
        .await
        .expect("lesen")
        .is_some()
}

async fn steht_im_muell(state: &AppState, schluessel: &str) -> bool {
    let (anzahl,): (i64,) =
        sqlx::query_as("select count(*) from storage_muell where storage_key = $1")
            .bind(schluessel)
            .fetch_one(&state.pool)
            .await
            .expect("muell");
    anzahl > 0
}

/// Ein Speicher, der beim Löschen immer stolpert.
///
/// Der örtliche Speicher taugt dafür nicht: Sein `delete` verschluckt jeden
/// Fehler und meldet immer Erfolg (`let _ = fs::remove_file(path).await`).
/// Mit ihm liesse sich der Fall „Speicher antwortet nicht“ gar nicht
/// herstellen – ein Test dagegen wäre eine Behauptung ohne Deckung.
struct Stolperspeicher;

#[async_trait]
impl initiative_api::storage::Storage for Stolperspeicher {
    fn kind(&self) -> &'static str {
        "stolper"
    }
    fn supports_presigned_upload(&self) -> bool {
        false
    }
    fn presign_upload(
        &self,
        _key: &str,
        _mime: &str,
    ) -> initiative_api::error::AppResult<initiative_api::storage::PresignedUpload> {
        unreachable!("wird im Test nicht gebraucht")
    }
    fn download_url(
        &self,
        _key: &str,
        _options: &initiative_api::storage::DownloadOptions,
    ) -> initiative_api::error::AppResult<Option<String>> {
        Ok(None)
    }
    async fn put(
        &self,
        _key: &str,
        _body: Bytes,
        _mime: &str,
    ) -> initiative_api::error::AppResult<()> {
        Ok(())
    }
    async fn read(
        &self,
        _key: &str,
        _range: Option<initiative_api::storage::ByteRange>,
    ) -> initiative_api::error::AppResult<Option<initiative_api::storage::ObjectStream>> {
        Ok(None)
    }
    async fn delete(&self, _key: &str) -> initiative_api::error::AppResult<()> {
        Err(initiative_api::error::AppError::internal(
            "Speicher antwortet nicht",
        ))
    }
}

/*
 * ALLES in einem Test – mit Absicht.
 *
 * `aufraeumen` arbeitet die GEMEINSAME Liste `storage_muell` ab, nicht die
 * Zeilen eines bestimmten Tests. Liefen mehrere Tests nebeneinander, räumte
 * der eine die Datei des anderen weg, bevor der sie prüfen kann – und der
 * Fehlschlag sähe aus wie ein Fehler im Aufräumdienst. Genau das ist beim
 * Schreiben passiert: dieselben drei Prüfungen waren mal grün und mal rot,
 * je nachdem, wer zuerst drankam.
 */
#[tokio::test(flavor = "multi_thread")]
async fn geloeschtes_verschwindet_auch_aus_dem_speicher() {
    let Some(state) = aufbauen().await else {
        eprintln!("TEST_DATABASE_URL nicht gesetzt – übersprungen");
        return;
    };

    // ---- 1. Der gewöhnliche Weg: eine gelöschte Nachricht ----
    let schluessel = format!("test/{}.png", Uuid::now_v7());
    let (nachricht, _chat) = anhang_anlegen(&state, &schluessel).await;
    assert!(
        liegt_im_speicher(&state, &schluessel).await,
        "Datei fehlt schon vorher"
    );

    sqlx::query("delete from messages where id = $1")
        .bind(nachricht)
        .execute(&state.pool)
        .await
        .expect("loeschen");

    assert!(
        steht_im_muell(&state, &schluessel).await,
        "Schlüssel nicht vorgemerkt"
    );
    assert!(
        liegt_im_speicher(&state, &schluessel).await,
        "die Datei darf erst der Aufräumdienst wegräumen, nicht die Datenbank"
    );

    let weg = aufraeumen(&state.pool, &state.storage).await;
    assert!(weg >= 1, "nichts weggeräumt");
    assert!(
        !liegt_im_speicher(&state, &schluessel).await,
        "Datei liegt noch da"
    );
    assert!(
        !steht_im_muell(&state, &schluessel).await,
        "Zeile nicht ausgetragen"
    );

    // ---- 2. Der eigentliche Grund für den Auslöser: die Kaskade ----
    //
    // Hier wird das GESPRÄCH gelöscht. Nachrichten und Anhänge fallen über
    // zwei Kaskaden mit, ohne dass ein Handler beteiligt ist. Ein
    // `storage.delete` im Nachrichten-Handler hätte diesen Fall nie gesehen.
    let zweiter = format!("test/{}.png", Uuid::now_v7());
    let (_n2, chat) = anhang_anlegen(&state, &zweiter).await;
    sqlx::query("delete from conversations where id = $1")
        .bind(chat)
        .execute(&state.pool)
        .await
        .expect("chat loeschen");

    assert!(
        steht_im_muell(&state, &zweiter).await,
        "die Kaskade wurde nicht mitbekommen"
    );
    aufraeumen(&state.pool, &state.storage).await;
    assert!(
        !liegt_im_speicher(&state, &zweiter).await,
        "Datei liegt noch da"
    );

    // ---- 3. Ein hakender Speicher darf den Schlüssel nicht verlieren ----
    //
    // Sonst wäre die Datei für immer im Speicher und für niemanden mehr
    // auffindbar – ein stiller Datenrest, den keine Löschung je erwischt.
    let dritter = format!("test/haengt-{}.png", Uuid::now_v7());
    sqlx::query("insert into storage_muell (storage_key) values ($1)")
        .bind(&dritter)
        .execute(&state.pool)
        .await
        .expect("muell");

    let stolpert: Arc<dyn initiative_api::storage::Storage> = Arc::new(Stolperspeicher);
    let weg = aufraeumen(&state.pool, &stolpert).await;
    assert_eq!(weg, 0, "nichts durfte weggeräumt werden");

    let (versuche,): (i32,) =
        sqlx::query_as("select versuche from storage_muell where storage_key = $1")
            .bind(&dritter)
            .fetch_optional(&state.pool)
            .await
            .expect("abfrage")
            .unwrap_or((-1,));
    assert_eq!(
        versuche, 1,
        "der Schlüssel muss stehen bleiben und der Versuch gezählt werden"
    );

    // Aufräumen nach uns selbst.
    sqlx::query("delete from storage_muell where storage_key = $1")
        .bind(&dritter)
        .execute(&state.pool)
        .await
        .expect("aufraeumen");
}
