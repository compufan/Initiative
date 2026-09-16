//! Die kalte Ablage: eine Hetzner Storage Box über SFTP.
//!
//! # Warum überhaupt eine zweite Ablage
//!
//! Der Server hat 256 GB, und die App füllt sie mit Anhängen. Ist die Platte
//! voll, nimmt sie keine Datei mehr an – das trifft alle zugleich und lässt
//! sich nicht wegoptimieren, nur verschieben. Daneben liegt eine Storage Box:
//! deutlich langsamer, dafür gross und mit unbegrenztem Verkehr.
//!
//! # Warum SFTP und nicht WebDAV
//!
//! Beides kann die Box. Ausschlaggebend ist eine einzige Eigenschaft:
//! **bereichsweises Lesen**.
//!
//! Wer in einem Video vorspult, schickt `Range: bytes=…`. Bei SFTP ist das
//! eine Grundfunktion des Protokolls – `SSH_FXP_READ` nimmt Versatz und Länge
//! entgegen, und zwar seit 1998. Bei WebDAV hängt es daran, ob der Apache
//! dahinter Bereichsanfragen auf statische Dateien beantwortet; das ist
//! wahrscheinlich, aber nirgends von Hetzner zugesagt. Auf ein „wahrscheinlich"
//! kann man keine Videowiedergabe stellen.
//!
//! Dazu kommt: Der Tresor (`tresor.rs`) liest je Abruf ZWEIMAL – erst
//! sechsunddreissig Kopfbytes, dann den Blockbereich. Eine Ablage, die bei
//! jedem `read` die ganze Datei holte, lüde für diese sechsunddreissig Bytes
//! ein vollständiges Video herunter. Bereichsweises Lesen ist hier also nicht
//! Beiwerk, sondern Voraussetzung.
//!
//! Und der praktische Grund: Der Zugang ist bereits eingerichtet. Port 23,
//! Schlüsselanmeldung, nachweislich funktionierend. WebDAV müsste in der
//! Hetzner-Konsole erst freigeschaltet werden.
//!
//! # Eine Verbindung, viele Abrufe
//!
//! Eine Storage Box lässt nur eine Handvoll gleichzeitiger Verbindungen zu.
//! Deshalb hält dieser Treiber **eine** SSH-Verbindung und schickt alle
//! Anfragen darüber: SFTP nummeriert seine Anfragen selbst und kann viele
//! gleichzeitig offen haben. Eine Verbindung je Abruf wäre nicht nur am
//! Limit, sondern auch langsam – ein SSH-Handschlag kostet mehr als das
//! Lesen eines Videoausschnitts.
//!
//! Bricht sie ab, wird beim nächsten Zugriff neu verbunden. Das ist der
//! Normalfall und kein Fehler: Eine Verbindung, die eine Nacht lang ungenutzt
//! dasteht, wird von der Gegenseite geschlossen.
//!
//! # Was hier bewusst NICHT steht
//!
//! Kein `sshfs`, kein `davfs2`. Beide bräuchten im Container `SYS_ADMIN` und
//! `/dev/fuse` – ein Loch in der Abschottung für eine Bequemlichkeit, und
//! ihr Zwischenspeicher verhält sich bei Bereichszugriffen auf grosse Videos
//! schlecht.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use axum::body::Bytes;
use russh::client::{self, Handle};
use russh::keys::PrivateKeyWithHashAlg;
use russh_sftp::client::SftpSession;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{Mutex, Semaphore};
use tokio_util::io::ReaderStream;

use super::{ByteRange, DownloadOptions, ObjectStream, PresignedUpload, Storage};
use crate::config::SftpEinstellungen;
use crate::error::{AppError, AppResult};

/**
 * Wie viele Zugriffe gleichzeitig zur Box gehen.
 *
 * Nicht, weil SFTP nicht mehr könnte – über eine Verbindung laufen beliebig
 * viele Anfragen –, sondern weil die Gegenseite eine gemeinsam genutzte
 * Maschine ist. Acht gleichzeitige Leser sind für eine kalte Ablage reichlich;
 * wer als neunter kommt, wartet Millisekunden.
 */
const PLAETZE: usize = 8;

/// Wie lange auf die Gegenseite gewartet wird, bevor aufgegeben wird.
const FRIST_S: u64 = 30;

pub struct SftpSpeicher {
    einstellungen: SftpEinstellungen,
    /// Die eine Verbindung. `None` heisst: noch nicht oder nicht mehr.
    verbindung: Mutex<Option<Arc<Verbindung>>>,
    plaetze: Arc<Semaphore>,
}

struct Verbindung {
    /*
     * Der Griff MUSS am Leben bleiben.
     *
     * Er hält die SSH-Verbindung; fällt er weg, schliesst russh sie, und die
     * SFTP-Sitzung darüber spricht ins Nichts. Das Feld wird nirgends
     * gelesen – es ist reine Lebensdauer, und genau deshalb steht es hier mit
     * Unterstrich statt zu fehlen.
     */
    _griff: Handle<Wachmann>,
    sftp: SftpSession,
}

/**
 * Die Prüfung des Serverschlüssels.
 *
 * # Warum das eine Entscheidung ist und keine Formalie
 *
 * `check_server_key` ist die Stelle, an der SSH gegen einen
 * Zwischenmann-Angriff schützt. Wer hier immer `true` zurückgibt, hat eine
 * verschlüsselte Verbindung zu irgendwem.
 *
 * Deshalb zwei Betriebsarten:
 *
 *   * **Fingerabdruck eingetragen** (`KALT_SFTP_FINGERABDRUCK`): Es wird
 *     verglichen, und nur der eine Schlüssel kommt durch. So gehört es sich.
 *   * **Nicht eingetragen**: Die Verbindung kommt zustande, und der
 *     Fingerabdruck wird beim ersten Mal ins Protokoll geschrieben – mit der
 *     Aufforderung, ihn einzutragen. Das ist schwächer und ausdrücklich als
 *     Übergang gedacht; ohne diesen Weg müsste man den Abdruck kennen, bevor
 *     man sich je verbunden hat.
 */
struct Wachmann {
    erwartet: Option<String>,
}

impl client::Handler for Wachmann {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        vorgezeigt: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        /*
         * Ein Zertifikat wird abgelehnt, und zwar ausdrücklich.
         *
         * Eine Storage Box weist sich mit einem Schlüssel aus, nicht mit
         * einem von einer Stelle unterschriebenen Zertifikat. Käme hier eines,
         * hiesse das entweder, dass jemand anderes am anderen Ende sitzt –
         * oder dass sich die Gegenseite grundlegend geändert hat. Beides
         * sollte auffallen und nicht durchgewinkt werden.
         */
        let russh::keys::PublicKeyOrCertificate::PublicKey {
            key: schluessel, ..
        } = vorgezeigt
        else {
            tracing::error!("Die Storage Box zeigt ein Zertifikat statt eines Schlüssels");
            return Ok(false);
        };
        let abdruck = schluessel
            .fingerprint(russh::keys::HashAlg::Sha256)
            .to_string();
        match &self.erwartet {
            Some(soll) => {
                let gleich = abdruck.trim() == soll.trim();
                if !gleich {
                    tracing::error!(
                        erwartet = %soll,
                        gefunden = %abdruck,
                        "Der Schlüssel der Storage Box stimmt nicht – Verbindung abgelehnt"
                    );
                }
                Ok(gleich)
            }
            None => {
                tracing::warn!(
                    fingerabdruck = %abdruck,
                    "Storage Box ohne eingetragenen Fingerabdruck verbunden. \
                     Trage ihn als KALT_SFTP_FINGERABDRUCK ein."
                );
                Ok(true)
            }
        }
    }
}

impl SftpSpeicher {
    pub fn neu(einstellungen: SftpEinstellungen) -> Self {
        Self {
            einstellungen,
            verbindung: Mutex::new(None),
            plaetze: Arc::new(Semaphore::new(PLAETZE)),
        }
    }

    /// Der Pfad auf der Box – mit demselben Riegel wie bei der lokalen Ablage.
    fn pfad_fuer(&self, schluessel: &str) -> AppResult<String> {
        if schluessel.contains("..") || schluessel.starts_with('/') || schluessel.contains('\\') {
            return Err(AppError::bad_request("Ungültiger Speicherpfad"));
        }
        let mut pfad = PathBuf::from(self.einstellungen.pfad.trim_end_matches('/'));
        for stueck in schluessel.split('/') {
            if stueck.is_empty() || stueck == "." {
                continue;
            }
            pfad.push(stueck);
        }
        Ok(pfad.to_string_lossy().replace('\\', "/"))
    }

    /// Die Verbindung – die vorhandene oder eine neue.
    async fn sitzung(&self) -> AppResult<Arc<Verbindung>> {
        {
            let da = self.verbindung.lock().await;
            if let Some(v) = da.as_ref() {
                /*
                 * Kurz nachfassen, ob sie noch steht. Eine tote Verbindung
                 * merkt man sonst erst am halb ausgelieferten Video – und
                 * dann hat der Abspieler schon abgebrochen.
                 */
                if v.sftp.canonicalize(".").await.is_ok() {
                    return Ok(v.clone());
                }
                tracing::info!("Verbindung zur Storage Box war tot – es wird neu verbunden");
            }
        }
        let neu = Arc::new(self.verbinden().await?);
        let mut da = self.verbindung.lock().await;
        *da = Some(neu.clone());
        Ok(neu)
    }

    async fn verbinden(&self) -> AppResult<Verbindung> {
        let e = &self.einstellungen;
        let schluessel = tokio::fs::read_to_string(&e.schluesseldatei)
            .await
            .map_err(|fehler| {
                AppError::internal(format!(
                    "Der SSH-Schlüssel {} liess sich nicht lesen: {fehler}",
                    e.schluesseldatei
                ))
            })?;
        let privat = russh::keys::decode_secret_key(&schluessel, None)
            .map_err(|fehler| AppError::internal(format!("SSH-Schlüssel unbrauchbar: {fehler}")))?;

        let konfig = Arc::new(client::Config {
            inactivity_timeout: Some(std::time::Duration::from_secs(300)),
            ..Default::default()
        });
        let wachmann = Wachmann {
            erwartet: e.fingerabdruck.clone(),
        };
        let mut griff = tokio::time::timeout(
            std::time::Duration::from_secs(FRIST_S),
            client::connect(konfig, (e.wirt.as_str(), e.hafen), wachmann),
        )
        .await
        .map_err(|_| AppError::internal("Die Storage Box antwortet nicht"))?
        .map_err(|fehler| AppError::internal(format!("Storage Box nicht erreichbar: {fehler}")))?;

        /*
         * `PrivateKeyWithHashAlg` mit `None`: Welcher Signaturalgorithmus
         * benutzt wird, handelt russh mit der Gegenseite aus. Ihn hier fest
         * zu setzen hiesse zu raten, was die Box kann – und eine Box, die
         * rsa-sha2-512 will, während hier rsa-sha1 steht, lehnt wortlos ab.
         */
        let angemeldet = griff
            .authenticate_publickey(
                &e.benutzer,
                PrivateKeyWithHashAlg::new(Arc::new(privat), None),
            )
            .await
            .map_err(|fehler| AppError::internal(format!("Anmeldung abgelehnt: {fehler}")))?;
        if !angemeldet.success() {
            return Err(AppError::internal(
                "Die Storage Box hat den SSH-Schlüssel nicht angenommen",
            ));
        }

        let kanal = griff
            .channel_open_session()
            .await
            .map_err(|fehler| AppError::internal(format!("Kein SSH-Kanal: {fehler}")))?;
        kanal
            .request_subsystem(true, "sftp")
            .await
            .map_err(|fehler| AppError::internal(format!("Kein SFTP auf der Box: {fehler}")))?;
        let sftp = SftpSession::new(kanal.into_stream())
            .await
            .map_err(|fehler| AppError::internal(format!("SFTP nicht gestartet: {fehler}")))?;
        sftp.set_timeout(FRIST_S);

        tracing::info!(wirt = %e.wirt, hafen = e.hafen, "Mit der Storage Box verbunden");
        Ok(Verbindung {
            _griff: griff,
            sftp,
        })
    }

    /// Die Ordner über einer Datei anlegen – so viele, wie fehlen.
    async fn ordner_sichern(&self, sftp: &SftpSession, pfad: &str) -> AppResult<()> {
        let Some((ordner, _)) = pfad.rsplit_once('/') else {
            return Ok(());
        };
        let mut bisher = String::new();
        for stueck in ordner.split('/') {
            if stueck.is_empty() {
                bisher.push('/');
                continue;
            }
            if !bisher.is_empty() && !bisher.ends_with('/') {
                bisher.push('/');
            }
            bisher.push_str(stueck);
            /*
             * Fehler beim Anlegen werden geschluckt, und das ist Absicht: Der
             * häufigste ist „gibt es schon". Ihn von „darf nicht" zu
             * unterscheiden hiesse, den Fehlercode der Gegenstelle zu deuten;
             * scheitert es wirklich, scheitert gleich darauf das Anlegen der
             * Datei – mit einer Meldung, die dann auch stimmt.
             */
            let _ = sftp.create_dir(bisher.clone()).await;
        }
        Ok(())
    }
}

#[async_trait]
impl Storage for SftpSpeicher {
    fn kind(&self) -> &'static str {
        "sftp"
    }

    fn supports_presigned_upload(&self) -> bool {
        false
    }

    fn presign_upload(&self, _key: &str, _mime: &str) -> AppResult<PresignedUpload> {
        Err(AppError::internal(
            "Die kalte Ablage nimmt keine Uploads direkt entgegen",
        ))
    }

    /**
     * Keine Umleitung.
     *
     * Eine Storage Box hat keine Adresse, die ein Browser abrufen könnte –
     * SFTP ist kein HTTP. Also streamt die API selbst. Das ist der Preis der
     * kalten Ablage und genau der, den sie kosten darf: längere Ladezeiten,
     * dafür Platz.
     */
    fn download_url(&self, _key: &str, _options: &DownloadOptions) -> AppResult<Option<String>> {
        Ok(None)
    }

    async fn put(&self, key: &str, body: Bytes, _mime: &str) -> AppResult<()> {
        let _platz = self
            .plaetze
            .acquire()
            .await
            .map_err(|_| AppError::internal("Die kalte Ablage nimmt gerade nichts entgegen"))?;
        let pfad = self.pfad_fuer(key)?;
        let v = self.sitzung().await?;
        self.ordner_sichern(&v.sftp, &pfad).await?;
        let mut datei = v
            .sftp
            .create(pfad.clone())
            .await
            .map_err(|fehler| AppError::internal(format!("Ablegen gescheitert: {fehler}")))?;
        datei
            .write_all(&body)
            .await
            .map_err(|fehler| AppError::internal(format!("Schreiben gescheitert: {fehler}")))?;
        /*
         * `shutdown` und nicht bloss fallen lassen: Es wartet darauf, dass
         * alles wirklich hinüber ist. Ohne das meldete diese Funktion Erfolg,
         * während die letzten Blöcke noch unterwegs sind – und der
         * Auslagerungsdienst löscht die lokale Fassung, bevor die ferne
         * vollständig ist.
         */
        datei
            .shutdown()
            .await
            .map_err(|fehler| AppError::internal(format!("Abschluss gescheitert: {fehler}")))?;
        Ok(())
    }

    async fn read(&self, key: &str, range: Option<ByteRange>) -> AppResult<Option<ObjectStream>> {
        /*
         * Der Platz wird hier genommen und NICHT beim Verlassen dieser
         * Funktion zurückgegeben: `read` liefert einen Strom, und der läuft
         * danach noch minutenlang. Wer hier freigäbe, zählte, wie viele
         * Abrufe BEGONNEN wurden, nicht, wie viele laufen – die Bremse wäre
         * wirkungslos. `forget` löst ihn vom Geltungsbereich, `Freigabe` gibt
         * ihn zurück, wenn der Strom wirklich zu Ende ist.
         */
        self.plaetze
            .acquire()
            .await
            .map_err(|_| AppError::internal("Die kalte Ablage antwortet gerade nicht"))?
            .forget();
        let pfad = self.pfad_fuer(key)?;
        let v = self.sitzung().await?;

        let mut datei = match v.sftp.open(pfad.clone()).await {
            Ok(datei) => datei,
            Err(_) => {
                self.plaetze.add_permits(1);
                // Nicht da ist kein Fehler – die Auslieferung macht daraus
                // eine 404, genau wie bei der lokalen Ablage.
                return Ok(None);
            }
        };

        let gesamt = datei
            .metadata()
            .await
            .ok()
            .and_then(|m| m.size)
            .unwrap_or(0);

        let (anfang, laenge) = match range {
            Some(bereich) => {
                let anfang = bereich.start.min(gesamt);
                let ende = bereich.end.map(|e| e.min(gesamt.saturating_sub(1)));
                let laenge = match ende {
                    Some(e) if e >= anfang => e - anfang + 1,
                    Some(_) => 0,
                    None => gesamt.saturating_sub(anfang),
                };
                (anfang, laenge)
            }
            None => (0, gesamt),
        };

        if anfang > 0 {
            datei
                .seek(std::io::SeekFrom::Start(anfang))
                .await
                .map_err(|fehler| {
                    AppError::internal(format!("Vorspulen in der kalten Ablage: {fehler}"))
                })?;
        }

        let strom = ReaderStream::new(Freigabe {
            innen: datei.take(laenge),
            plaetze: self.plaetze.clone(),
        });
        Ok(Some(ObjectStream {
            stream: Box::pin(strom),
            size: Some(laenge),
            total_size: Some(gesamt),
            mime: None,
        }))
    }

    async fn delete(&self, key: &str) -> AppResult<()> {
        let _platz = self
            .plaetze
            .acquire()
            .await
            .map_err(|_| AppError::internal("Die kalte Ablage antwortet gerade nicht"))?;
        let pfad = self.pfad_fuer(key)?;
        let v = self.sitzung().await?;
        // Eine Datei, die nicht da ist, gilt als gelöscht – sonst bliebe sie
        // für immer in der Müllliste stehen.
        let _ = v.sftp.remove_file(pfad).await;
        Ok(())
    }
}

/**
 * Gibt den Platz zurück, wenn der Strom zu Ende gelesen ist.
 *
 * Ohne das wäre die Bremse wirkungslos: `read` gibt den Strom sofort zurück,
 * die Übertragung läuft danach noch minutenlang. Wer den Platz beim Verlassen
 * von `read` freigäbe, zählte, wie viele Abrufe BEGONNEN wurden, nicht, wie
 * viele laufen.
 */
struct Freigabe<R> {
    innen: R,
    plaetze: Arc<Semaphore>,
}

impl<R: tokio::io::AsyncRead + Unpin> tokio::io::AsyncRead for Freigabe<R> {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let this = self.get_mut();
        std::pin::Pin::new(&mut this.innen).poll_read(cx, buf)
    }
}

impl<R> Drop for Freigabe<R> {
    fn drop(&mut self) {
        self.plaetze.add_permits(1);
    }
}
