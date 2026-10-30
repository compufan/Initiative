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

use crate::error::AppResult;
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
        // Erst die Miniaturen, dann das Original: Scheitert eine Miniatur,
        // bleibt die Müllzeile stehen und der nächste Durchgang versucht
        // beides noch einmal. Andersherum fände niemand die Miniaturen mehr,
        // denn ihr Name ist nur vom Original abgeleitet.
        let ergebnis = match miniaturen_loeschen(storage, &schluessel).await {
            Ok(()) => storage.delete(&schluessel).await,
            Err(fehler) => Err(fehler),
        };
        match ergebnis {
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

/**
 * Endungen, aus denen nie ein Miniaturbild entsteht (`miniatur::wandelbar`
 * kennt nur Bilder). Für sie spart man sich vier Löschaufrufe je Datei – bei
 * einem Objektspeicher als warmer Ablage vier HTTP-Anfragen je gelöschtem
 * Video. Bewusst eine Ausschlussliste: Eine Datei mit unbekannter Endung
 * bekommt lieber vier überflüssige Löschversuche als eine liegengebliebene
 * Miniatur.
 */
const OHNE_MINIATUR: [&str; 11] = [
    "mp4", "webm", "mov", "weba", "ogg", "mp3", "m4a", "aac", "wav", "pdf", "mkv",
];

fn kann_miniaturen_haben(schluessel: &str) -> bool {
    match schluessel.rsplit_once('.') {
        Some((_, endung)) if !endung.contains('/') => {
            !OHNE_MINIATUR.contains(&endung.to_ascii_lowercase().as_str())
        }
        _ => true,
    }
}

/**
 * Die abgeleiteten Miniaturen (`<Schlüssel>.mini-<Kante>.jpg`) zu einem
 * gelöschten Original entfernen.
 *
 * # Warum hier
 *
 * Die Miniaturen haben keine eigene Zeile; sie entstehen erst beim ersten
 * Abruf und sind nur über den Namen mit dem Original verbunden. Alle
 * Löschwege (Nachricht, Gespräch, Konto) laufen über den Auslöser in
 * `storage_muell`, also trifft dieser eine Ort sie alle – auch das Kaskaden-
 * löschen und die ferne/wandernde Datei. Miniaturen liegen immer warm (die
 * Weiche behandelt sie so), darum ist die Ablage des Originals egal.
 *
 * Löschen ist idempotent: eine nie erzeugte Miniatur ist kein Fehler.
 */
pub async fn miniaturen_loeschen(storage: &Arc<dyn Storage>, original: &str) -> AppResult<()> {
    if !kann_miniaturen_haben(original) {
        return Ok(());
    }
    let mut erster_fehler = None;
    for kante in crate::services::miniatur::KANTEN {
        let name = crate::services::miniatur::schluessel(original, kante);
        if let Err(fehler) = storage.delete(&name).await {
            erster_fehler.get_or_insert(fehler);
        }
    }
    match erster_fehler {
        Some(fehler) => Err(fehler),
        None => Ok(()),
    }
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

#[cfg(test)]
mod tests {
    use super::kann_miniaturen_haben;

    #[test]
    fn videos_und_ton_haben_keine_miniaturen() {
        assert!(!kann_miniaturen_haben("video/2026/10/u/1-ab.MP4"));
        assert!(!kann_miniaturen_haben("audio/2026/10/u/1-ab.m4a"));
        assert!(kann_miniaturen_haben("image/2026/10/u/1-ab.webp"));
        assert!(kann_miniaturen_haben("image/2026/10/u/1-ab"));
        assert!(kann_miniaturen_haben("x.y/2026/ohne-endung"));
    }
}
