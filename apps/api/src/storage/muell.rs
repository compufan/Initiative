//! Der Aufräumdienst für gelöschte Dateien.
//!
//! Die Datenbank schreibt beim Löschen eines Anhangs seinen Speicherschlüssel
//! in `storage_muell` (siehe Migration 0013). Hier wird diese Liste
//! abgearbeitet: Schlüssel holen, Datei wegräumen, Zeile entfernen.
//!
//! # Warum nicht im Handler
//!
//! Weil `attachments.message_id` `on delete cascade` trägt. Wer ein Gespräch
//! oder ein Konto löscht, räumt damit Anhangszeilen ab, ohne dass ein
//! Rust-Handler das je zu sehen bekommt. Ein Aufruf an den bekannten Stellen
//! liesse genau die Fälle liegen, bei denen am meisten Daten anfallen.
//!
//! # Warum ein eigener Faden und kein Aufruf am Ende der Anfrage
//!
//! Weil das Löschen einer Nachricht nicht davon abhängen darf, ob ein
//! Objektspeicher gerade antwortet. Eine Nachricht, die man nicht loswird,
//! weil S3 hakt, ist schlimmer als eine Datei, die eine Stunde länger liegt.

use std::sync::Arc;
use std::time::Duration;

use sqlx::PgPool;

use crate::storage::Storage;

/// Wie viele Schlüssel ein Durchgang anfasst.
///
/// Klein gehalten: Ein Durchgang soll die Datenbank nicht minutenlang
/// beschäftigen, und nach einem Massenlöschen kommt der nächste ohnehin
/// gleich hinterher.
const STAPEL: i64 = 200;

/// Ab wann ein Schlüssel als hoffnungslos gilt und nur noch selten drankommt.
const AUFGEBEN_AB: i32 = 10;

/// Ein Durchgang. Gibt zurück, wie viele Dateien wirklich weg sind.
pub async fn aufraeumen(pool: &PgPool, storage: &Arc<dyn Storage>) -> usize {
    let zeilen: Vec<(String, i32)> = match sqlx::query_as(
        "select storage_key, versuche from storage_muell
         where versuche < $1
         order by angelegt_at
         limit $2",
    )
    .bind(AUFGEBEN_AB)
    .bind(STAPEL)
    .fetch_all(pool)
    .await
    {
        Ok(zeilen) => zeilen,
        Err(fehler) => {
            tracing::warn!(%fehler, "Muellliste nicht lesbar");
            return 0;
        }
    };

    let mut weg = 0usize;
    for (schluessel, versuche) in zeilen {
        match storage.delete(&schluessel).await {
            Ok(()) => {
                // Erst wegräumen, dann austragen. Andersherum verlöre ein
                // Absturz dazwischen den Schlüssel und die Datei bliebe für
                // immer liegen.
                if let Err(fehler) = sqlx::query("delete from storage_muell where storage_key = $1")
                    .bind(&schluessel)
                    .execute(pool)
                    .await
                {
                    tracing::warn!(%fehler, "Muellzeile nicht austragbar");
                } else {
                    weg += 1;
                }
            }
            Err(fehler) => {
                let naechster = versuche + 1;
                if naechster >= AUFGEBEN_AB {
                    // Nach zehn Versuchen still weiterzuprobieren hiesse, den
                    // Fehler zu verstecken. Er gehoert ins Protokoll.
                    tracing::error!(
                        %fehler,
                        schluessel = %schluessel,
                        "Datei laesst sich nicht loeschen - bleibt im Speicher liegen"
                    );
                }
                let _ = sqlx::query(
                    "update storage_muell set versuche = $2, zuletzt_at = now()
                     where storage_key = $1",
                )
                .bind(&schluessel)
                .bind(naechster)
                .execute(pool)
                .await;
            }
        }
    }
    weg
}

/// Startet den Dienst. Läuft, solange der Server läuft.
pub fn starten(pool: PgPool, storage: Arc<dyn Storage>, takt: Duration) {
    tokio::spawn(async move {
        // Einmal gleich zu Beginn: Nach einem Neustart kann Arbeit von vor
        // dem Herunterfahren liegen geblieben sein.
        loop {
            let weg = aufraeumen(&pool, &storage).await;
            if weg > 0 {
                tracing::info!(anzahl = weg, "geloeschte Dateien weggeraeumt");
            }
            tokio::time::sleep(takt).await;
        }
    });
}
