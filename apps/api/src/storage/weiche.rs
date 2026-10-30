//! Zwei Ablagen, eine Schnittstelle.
//!
//! # Warum genau hier und nirgends sonst
//!
//! Die Frage „wo liegen die Bytes dieser Datei" liesse sich an vielen Stellen
//! beantworten. Die naheliegendste wäre `media.rs::serve`, denn dort liegt die
//! Anhangszeile mit ihrem Feld `ablage` schon vor – kein zusätzlicher Blick in
//! die Datenbank nötig.
//!
//! Sie ist trotzdem die falsche. `state.storage` wird an ZWÖLF Stellen
//! benutzt: beim Hochladen, beim Ausliefern, beim Herunterladen, beim
//! Miniaturbild, beim Aufräumen, bei der Speicherprüfung. Wer die Weiche dort
//! oben einbaut, muss jede einzelne anfassen und hat an jeder die Gelegenheit,
//! eine zu vergessen – und eine vergessene Stelle ist keine Fehlermeldung,
//! sondern eine Datei, die nicht gefunden wird.
//!
//! Hier unten gilt sie für alle zwölf, ohne dass eine davon etwas davon weiss.
//! Der Preis ist ein Nachschlagen je Zugriff; mit dem Index aus Migration 0019
//! kostet das den Bruchteil einer Millisekunde, und der Weg, den es
//! entscheidet, dauert danach Hunderte.
//!
//! # Unter dem Tresor, nicht darüber
//!
//! `create_storage` legt die Verschlüsselung um das Ergebnis dieser Weiche.
//! Damit wird genau einmal verschlüsselt, egal wo die Datei landet – und eine
//! Datei, die von warm nach kalt wandert, muss nicht umgeschlüsselt werden.
//! Sie wird Byte für Byte kopiert, so wie sie ist.
//!
//! # Was ohne Anhangszeile daherkommt
//!
//! Nicht jeder Schlüssel gehört zu einem Anhang:
//!
//!   * **Miniaturbilder** (`…/datei.webp.mini-320.jpg`). Sie sind klein und
//!     werden oft gebraucht – eine Kachelansicht fragt vierzig auf einmal ab.
//!     Sie bleiben warm, auch wenn ihr Original längst kalt liegt. Das ist der
//!     wichtigste Einzelfall: Ohne ihn würde aus einem ausgelagerten
//!     Urlaubsordner eine Ansicht, die vierzigmal über SFTP geht.
//!   * **Der Prüfschlüssel** der Speicherprüfung.
//!   * **Ein Schlüssel aus der Müllliste**, dessen Anhangszeile gerade
//!     gelöscht wurde – das ist ja der Anlass. Deshalb trägt `storage_muell`
//!     seit Migration 0019 die Ablage mit; ohne sie würde eine ausgelagerte
//!     Datei nie gelöscht und die kalte Ablage wüchse still weiter.
//!
//! Alles Unbekannte gilt als warm. Das ist die sichere Richtung: Eine warm
//! gesuchte Datei, die kalt liegt, wird nicht gefunden – eine kalt gesuchte,
//! die warm liegt, ebenso wenig. Aber neu angelegt wird immer warm, und
//! deshalb ist „unbekannt heisst warm" die Annahme, die stimmt.

use async_trait::async_trait;
use axum::body::Bytes;
use sqlx::PgPool;
use std::sync::Arc;

use super::{ByteRange, DownloadOptions, ObjectStream, PresignedUpload, Storage};
use crate::error::AppResult;

pub struct Weiche {
    warm: Arc<dyn Storage>,
    kalt: Arc<dyn Storage>,
    pool: PgPool,
}

impl Weiche {
    pub fn neu(warm: Arc<dyn Storage>, kalt: Arc<dyn Storage>, pool: PgPool) -> Self {
        Self { warm, kalt, pool }
    }

    /**
     * Liegt dieser Schlüssel kalt?
     *
     * Gefragt wird an zwei Stellen, und die zweite ist der Grund, warum das
     * nicht einfach eine Abfrage ist: Beim Löschen gibt es die Anhangszeile
     * nicht mehr, der Schlüssel steht dann nur noch in der Müllliste. Wer nur
     * `attachments` fragt, hält jede gelöschte Datei für warm und lässt ihre
     * kalte Fassung liegen – für immer.
     */
    async fn lage(&self, schluessel: &str) -> Lage {
        /*
         * Miniaturen liegen immer warm, egal wo ihr Original liegt – sie
         * werden von `media.rs` über `put` geschrieben, und das geht
         * ausschliesslich nach warm. Ohne diese Abkürzung kostet jedes
         * Aufräumen einer Miniatur zwei Datenbankabfragen und einen
         * SFTP-Umlauf ins Leere (Lage „unbekannt" löscht in beiden Ablagen).
         */
        if ist_miniatur(schluessel) {
            return Lage::Warm;
        }
        let aus_anhang: Option<(String,)> =
            sqlx::query_as("select ablage from attachments where storage_key = $1 limit 1")
                .bind(schluessel)
                .fetch_optional(&self.pool)
                .await
                .unwrap_or(None);
        if let Some((ablage,)) = aus_anhang {
            /*
             * `wandert` wird GELESEN wie warm – aber GELÖSCHT wie unklar.
             *
             * Das ist der Zustand während des Umzugs: Die Datei ist vielleicht
             * schon drüben, aber die lokale Fassung steht noch. Wer sie in
             * diesem Fenster abruft, soll die schnelle bekommen – und vor
             * allem soll er überhaupt etwas bekommen.
             *
             * Beim Löschen dagegen darf die ferne Fassung (bei einem Video von
             * Gigabytes: das halbe Teilstück) nicht übersehen werden. Wird die
             * Nachricht mitten im Umzug gelöscht, steht in der Müllliste
             * `wandert`; als „warm" behandelt, bliebe das Objekt auf der Box
             * für immer liegen.
             */
            return match ablage.as_str() {
                "fern" => Lage::Kalt,
                "wandert" => Lage::Wandert,
                _ => Lage::Warm,
            };
        }
        let aus_muell: Option<(String,)> =
            sqlx::query_as("select ablage from storage_muell where storage_key = $1 limit 1")
                .bind(schluessel)
                .fetch_optional(&self.pool)
                .await
                .unwrap_or(None);
        match aus_muell {
            Some((ablage,)) if ablage == "fern" => Lage::Kalt,
            Some((ablage,)) if ablage == "wandert" => Lage::Wandert,
            Some(_) => Lage::Warm,
            /*
             * Weder Anhang noch Müllzeile: ein Miniaturbild, der Prüfschlüssel
             * der Speicherprüfung – oder eine Datei aus einer Zeit vor der
             * Müllliste. Gelesen wird dann warm (dort liegt sie fast sicher),
             * gelöscht aber in BEIDEN. Die zwei Fälle brauchen verschiedene
             * Antworten, und deshalb gibt es hier drei Zustände und nicht
             * zwei.
             */
            None => Lage::Unbekannt,
        }
    }

    async fn fuer(&self, schluessel: &str) -> &Arc<dyn Storage> {
        match self.lage(schluessel).await {
            Lage::Kalt => &self.kalt,
            _ => &self.warm,
        }
    }
}

/// Ist das der Schlüssel einer abgeleiteten Miniatur (`….mini-<Kante>.jpg`)?
fn ist_miniatur(schluessel: &str) -> bool {
    schluessel
        .rsplit_once(".mini-")
        .is_some_and(|(_, rest)| {
            rest.strip_suffix(".jpg")
                .is_some_and(|k| !k.is_empty() && k.bytes().all(|b| b.is_ascii_digit()))
        })
}

/// Wo eine Datei liegt – oder dass es niemand weiss.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lage {
    Warm,
    Kalt,
    /// Mitten im Umzug: lesen wie warm, löschen in beiden.
    Wandert,
    Unbekannt,
}

#[async_trait]
impl Storage for Weiche {
    fn kind(&self) -> &'static str {
        self.warm.kind()
    }

    /*
     * Hochgeladen wird immer warm – deshalb gelten hier die Eigenschaften der
     * warmen Ablage. Eine Datei kommt nie kalt zur Welt; sie wandert erst,
     * wenn der Auslagerungsdienst sie dazu bringt.
     */
    fn supports_presigned_upload(&self) -> bool {
        self.warm.supports_presigned_upload()
    }

    fn presign_upload(&self, key: &str, mime: &str) -> AppResult<PresignedUpload> {
        self.warm.presign_upload(key, mime)
    }

    /**
     * Die Umleitung ohne Blick in die Datenbank: immer `None`.
     *
     * `download_url` ist nicht asynchron und kann deshalb nicht fragen, wo
     * die Datei liegt. Früher wurde einfach die warme Ablage gefragt – bei
     * S3 warm und SFTP kalt gab das für eine ausgelagerte Datei eine
     * S3-Adresse, hinter der nichts liegt (404 im Browser). Wer eine Adresse
     * will, nimmt [`Storage::adresse`]; der sichere Rückfall ist „die API
     * streamt selbst".
     */
    fn download_url(&self, _key: &str, _options: &DownloadOptions) -> AppResult<Option<String>> {
        Ok(None)
    }

    /**
     * Die Umleitung – nur für Dateien, die nachweislich WARM liegen.
     *
     * Kalt (`fern`) und mitten im Umzug (`wandert`) gibt es keine Adresse:
     * Bei `wandert` steht die warme Fassung zwar noch, wird aber im
     * nächsten Augenblick gelöscht, und eine umgeleitete Anfrage fände dann
     * nichts mehr. Der Umweg über die API kostet dort nur Bandbreite.
     * Unbekanntes (kein Anhang, keine Müllzeile) gilt wie bisher als warm.
     */
    async fn adresse(&self, key: &str, options: &DownloadOptions) -> AppResult<Option<String>> {
        match self.lage(key).await {
            Lage::Warm | Lage::Unbekannt => self.warm.download_url(key, options),
            Lage::Kalt | Lage::Wandert => Ok(None),
        }
    }

    async fn put(&self, key: &str, body: Bytes, mime: &str) -> AppResult<()> {
        self.warm.put(key, body, mime).await
    }

    // Geschrieben wird immer warm – auch im Strom.
    async fn put_datei(&self, key: &str, pfad: &std::path::Path, mime: &str) -> AppResult<()> {
        self.warm.put_datei(key, pfad, mime).await
    }

    async fn uebernehmen(&self, key: &str, pfad: &std::path::Path, mime: &str) -> AppResult<()> {
        self.warm.uebernehmen(key, pfad, mime).await
    }

    async fn read(&self, key: &str, range: Option<ByteRange>) -> AppResult<Option<ObjectStream>> {
        let gewaehlt = self.fuer(key).await;
        match gewaehlt.read(key, range).await? {
            Some(strom) => Ok(Some(strom)),
            None => {
                /*
                 * Nicht gefunden – dann in der anderen Ablage nachsehen.
                 *
                 * Das ist kein Herumraten, sondern die Absicherung gegen das
                 * eine Fenster, das sich nicht schliessen lässt: Zwischen dem
                 * Hinüberschreiben und dem Umschreiben der Zeile steht die
                 * Datei kurz an beiden Orten oder – bei einem Absturz genau
                 * dazwischen – an dem, der gerade nicht eingetragen ist. Ein
                 * zweiter Blick kostet einen Umlauf und rettet die Datei.
                 */
                let anderer = if std::ptr::eq(Arc::as_ptr(gewaehlt), Arc::as_ptr(&self.warm)) {
                    &self.kalt
                } else {
                    &self.warm
                };
                anderer.read(key, range).await
            }
        }
    }

    /**
     * Löschen – warm immer, kalt nur wenn nötig oder unklar.
     *
     * Die einfachste Fassung wäre „beide, ohne zu fragen". Sie wäre auch
     * teuer: Jede gelöschte Nachricht mit Anhang zöge einen SFTP-Umlauf nach
     * sich, für eine Datei, die dort nie lag. In einem Chat, in dem viel
     * gelöscht wird, sind das Tausende Verbindungen ins Leere.
     *
     * Deshalb wird gefragt – und im Zweifel trotzdem beides gelöscht:
     *
     * **Kalt eingetragen**: beide. Die warme Fassung kann noch dastehen, wenn
     * der Umzug mitten drin abgebrochen ist.
     *
     * **Warm eingetragen**: nur warm. Dort lag sie, dort liegt sie.
     *
     * **Wandert**: beide. Das Hinüberschreiben läuft oder ist eben
     * gescheitert; ein Teil davon kann drüben liegen.
     *
     * **Unbekannt**: beide. Das ist der Fall, in dem niemand es weiss – und
     * eine Datei, die jemand gelöscht hat, muss weg sein, nicht „an einer von
     * zwei Stellen weg".
     *
     * Beide Ablagen behandeln „gibt es nicht" als Erfolg.
     */
    async fn delete(&self, key: &str) -> AppResult<()> {
        let lage = self.lage(key).await;
        let warm = self.warm.delete(key).await;
        if lage == Lage::Warm {
            return warm;
        }
        let kalt = self.kalt.delete(key).await;
        warm.and(kalt)
    }

    async fn kapazitaet(&self) -> Option<(u64, u64)> {
        self.warm.kapazitaet().await
    }
}

#[cfg(test)]
mod tests {
    use super::ist_miniatur;

    #[test]
    fn miniaturen_werden_am_namen_erkannt() {
        assert!(ist_miniatur("image/2026/08/u/1-ab.webp.mini-320.jpg"));
        assert!(ist_miniatur("a.mini-1280.jpg"));
        assert!(!ist_miniatur("image/2026/08/u/1-ab.webp"));
        assert!(!ist_miniatur("a.mini-.jpg"));
        assert!(!ist_miniatur("a.mini-12x.jpg"));
        assert!(!ist_miniatur("a.mini-320.jpg.teil"));
    }
}
