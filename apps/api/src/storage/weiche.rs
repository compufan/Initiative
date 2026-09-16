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
        let aus_anhang: Option<(String,)> =
            sqlx::query_as("select ablage from attachments where storage_key = $1 limit 1")
                .bind(schluessel)
                .fetch_optional(&self.pool)
                .await
                .unwrap_or(None);
        if let Some((ablage,)) = aus_anhang {
            /*
             * `wandert` gilt als WARM.
             *
             * Das ist der Zustand während des Umzugs: Die Datei ist vielleicht
             * schon drüben, aber die lokale Fassung steht noch. Wer sie in
             * diesem Fenster abruft, soll die schnelle bekommen – und vor
             * allem soll er überhaupt etwas bekommen.
             */
            return if ablage == "fern" {
                Lage::Kalt
            } else {
                Lage::Warm
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

/// Wo eine Datei liegt – oder dass es niemand weiss.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Lage {
    Warm,
    Kalt,
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
     * Die Umleitung – und warum sie hier nicht fragt.
     *
     * `download_url` ist nicht asynchron, kann also nicht in die Datenbank
     * sehen. Das ist kein Mangel: Umleiten kann ohnehin nur eine Ablage mit
     * öffentlichen Adressen, und die kalte hat keine (SFTP ist kein HTTP).
     * Die warme zu fragen ist damit immer richtig – liegt die Datei kalt,
     * antwortet sie mit `None`, und die API streamt selbst. Genau das soll
     * dann auch geschehen.
     */
    fn download_url(&self, key: &str, options: &DownloadOptions) -> AppResult<Option<String>> {
        self.warm.download_url(key, options)
    }

    async fn put(&self, key: &str, body: Bytes, mime: &str) -> AppResult<()> {
        self.warm.put(key, body, mime).await
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
}
