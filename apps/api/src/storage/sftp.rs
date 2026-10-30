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
 * Wie viele LESER gleichzeitig an der Box hängen.
 *
 * Nicht, weil SFTP nicht mehr könnte – über eine Verbindung laufen beliebig
 * viele Anfragen –, sondern weil die Gegenseite eine gemeinsam genutzte
 * Maschine ist.
 *
 * Lesen und Schreiben haben getrennte Vorräte (siehe `SCHREIB_PLAETZE`):
 * Ein Leser hält seinen Platz, solange sein Strom offen ist – und ein
 * Abspieler, der pausiert, lässt die Antwort stundenlang offen stehen. Mit
 * EINEM gemeinsamen Vorrat genügten acht pausierte Videos, und weder ein
 * Umzug noch ein Löschen käme je wieder durch.
 */
const PLAETZE: usize = 16;

/// Plätze für Schreiben, Umbenennen und Löschen – getrennt von den Lesern, damit
/// pausierte Abspieler den Auslagerungsdienst und das Aufräumen nicht aushungern.
const SCHREIB_PLAETZE: usize = 4;

/// Wie lange auf die Gegenseite gewartet wird, bevor aufgegeben wird.
const FRIST_S: u64 = 30;

/// Wie lange auf einen freien Platz gewartet wird, bevor der Aufruf eine klare
/// Absage bekommt, statt ewig in der Schlange zu hängen.
const PLATZ_FRIST_S: u64 = 60;

/**
 * Endung einer Datei, die gerade erst übertragen wird.
 *
 * Geschrieben wird NIE direkt unter den Endnamen: Ein Abbruch mitten in vier
 * Gigabyte liesse sonst unter dem richtigen Namen eine halbe Datei liegen,
 * die für `read` genauso aussieht wie eine ganze. Erst wenn Grösse und
 * Inhalt stimmen, wird umbenannt.
 */
const TEIL: &str = ".teil";

/// Wie viel vom Anfang und vom Ende eines liegengebliebenen Teilstücks gegen
/// die Quelle verglichen wird, bevor an ihm weitergeschrieben wird.
const PROBE_BYTES: u64 = 64 * 1024;

/// Fortgesetzt wird erst ab dieser Grösse des Teilstücks – darunter kostet das
/// Prüfen mehr, als das Neuschreiben spart. Zugleich die Rundung: Es wird ab
/// der letzten vollen Mebibyte davor fortgesetzt, weil das letzte Paket eines
/// abgerissenen Schreibens unvollständig angekommen sein kann.
const FORTSETZEN_AB: u64 = 8 * 1024 * 1024;
const MIB: u64 = 1024 * 1024;

pub struct SftpSpeicher {
    einstellungen: SftpEinstellungen,
    /// Die eine Verbindung. `None` heisst: noch nicht oder nicht mehr.
    verbindung: Mutex<Option<Arc<Verbindung>>>,
    plaetze: Arc<Semaphore>,
    schreib_plaetze: Arc<Semaphore>,
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
    /// Wann sie zuletzt nachweislich antwortete – spart die Probe bei jedem
    /// Zugriff (siehe `sitzung`).
    zuletzt_ok: std::sync::Mutex<std::time::Instant>,
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
            schreib_plaetze: Arc::new(Semaphore::new(SCHREIB_PLAETZE)),
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
                 *
                 * Aber nicht bei JEDEM Zugriff: Die Probe kostet einen
                 * Umlauf unter dem Schloss, und eine Kachelansicht oder der
                 * Tresor (zwei Lesevorgänge je Abruf) machte daraus eine
                 * Warteschlange. Hat die Verbindung in den letzten zwanzig
                 * Sekunden etwas beantwortet, gilt sie als lebendig.
                 */
                let frisch = v
                    .zuletzt_ok
                    .lock()
                    .map(|t| t.elapsed() < std::time::Duration::from_secs(20))
                    .unwrap_or(false);
                if frisch {
                    return Ok(v.clone());
                }
                if v.sftp.canonicalize(".").await.is_ok() {
                    if let Ok(mut t) = v.zuletzt_ok.lock() {
                        *t = std::time::Instant::now();
                    }
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

    /// Eine Verbindung, die mitten in einer Übertragung riss, wegwerfen –
    /// der nächste Zugriff baut eine neue, statt erst die Probe abzuwarten.
    async fn verwerfen(&self, v: &Arc<Verbindung>) {
        let mut da = self.verbindung.lock().await;
        if da.as_ref().is_some_and(|aktuell| Arc::ptr_eq(aktuell, v)) {
            *da = None;
        }
    }

    async fn schreib_platz(&self) -> AppResult<tokio::sync::OwnedSemaphorePermit> {
        platz_holen(&self.schreib_plaetze).await
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
        /*
         * Mehr Anfragen gleichzeitig unterwegs als die Vorgabe (16).
         *
         * Eine Übertragung ist so schnell wie (Anfragen in der Luft × Paket)
         * / Laufzeit. Mit 16 × 32 KiB und 30 ms zur Box sind das gut 17 MB/s
         * – ein 4-GiB-Video bräuchte vier Minuten, wo die Leitung es in einer
         * hätte. 64 vervierfacht das und kostet zwei Mebibyte Puffer.
         */
        let sftp = SftpSession::new_with_config(
            kanal.into_stream(),
            russh_sftp::client::Config {
                max_concurrent_reads: 64,
                max_concurrent_writes: 64,
                request_timeout_secs: FRIST_S,
                ..Default::default()
            },
        )
        .await
        .map_err(|fehler| AppError::internal(format!("SFTP nicht gestartet: {fehler}")))?;
        sftp.set_timeout(FRIST_S);

        tracing::info!(wirt = %e.wirt, hafen = e.hafen, "Mit der Storage Box verbunden");
        Ok(Verbindung {
            _griff: griff,
            sftp,
            zuletzt_ok: std::sync::Mutex::new(std::time::Instant::now()),
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
        let _platz = self.schreib_platz().await?;
        let pfad = self.pfad_fuer(key)?;
        let teil = format!("{pfad}{TEIL}");
        let v = self.sitzung().await?;
        self.ordner_sichern(&v.sftp, &pfad).await?;
        let ergebnis =
            async {
                let mut datei = v.sftp.create(teil.clone()).await.map_err(|fehler| {
                    AppError::internal(format!("Ablegen gescheitert: {fehler}"))
                })?;
                datei.write_all(&body).await.map_err(|fehler| {
                    AppError::internal(format!("Schreiben gescheitert: {fehler}"))
                })?;
                /*
                 * `shutdown` und nicht bloss fallen lassen: Es wartet darauf, dass
                 * alles wirklich hinüber ist. Ohne das meldete diese Funktion
                 * Erfolg, während die letzten Blöcke noch unterwegs sind – und der
                 * Auslagerungsdienst löscht die lokale Fassung, bevor die ferne
                 * vollständig ist.
                 */
                datei.shutdown().await.map_err(|fehler| {
                    AppError::internal(format!("Abschluss gescheitert: {fehler}"))
                })
            }
            .await;
        if let Err(fehler) = ergebnis {
            self.verwerfen(&v).await;
            let _ = v.sftp.remove_file(teil).await;
            return Err(fehler);
        }
        self.fertigstellen(&v, &pfad, &teil, body.len() as u64)
            .await
    }

    /**
     * Wie `put`, aber im Strom von der Platte – ein ausgelagertes Video von
     * Gigabytes geht so hinüber, ohne je ganz im Arbeitsspeicher zu liegen.
     *
     * # Was bei einem Abbruch passiert
     *
     * Geschrieben wird nach `<Pfad>.teil`. Reisst die Verbindung nach drei
     * von vier Gigabyte, bleibt dieses Teilstück liegen – absichtlich: Der
     * nächste Versuch prüft Anfang und Ende des Teilstücks gegen die Quelle
     * und schreibt ab dort weiter, statt dreieinhalb Gigabyte noch einmal zu
     * schicken. Stimmt die Probe nicht (zum Beispiel weil ein Tresor die Datei
     * zwischendurch mit neuem Salz neu verschlüsselt hat), wird von vorn
     * geschrieben. Unter dem Endnamen erscheint die Datei erst, wenn die
     * Grösse drüben genau der Quelle entspricht.
     */
    async fn put_datei(&self, key: &str, quelle: &std::path::Path, _mime: &str) -> AppResult<()> {
        let _platz = self.schreib_platz().await?;
        let mut ein = tokio::fs::File::open(quelle).await?;
        let laenge = ein.metadata().await?.len();
        let pfad = self.pfad_fuer(key)?;
        let teil = format!("{pfad}{TEIL}");
        let v = self.sitzung().await?;
        self.ordner_sichern(&v.sftp, &pfad).await?;

        let start = fortsetzpunkt(&v.sftp, &mut ein, &teil, laenge).await;
        if start > 0 {
            tracing::info!(
                %key, bereits_mib = start / MIB, von_mib = laenge / MIB,
                "Übertragung zur Storage Box wird fortgesetzt"
            );
        }
        let ergebnis = async {
            use russh_sftp::protocol::OpenFlags;
            let flags = if start > 0 {
                OpenFlags::WRITE | OpenFlags::CREATE
            } else {
                OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE
            };
            let mut datei = v
                .sftp
                .open_with_flags(teil.clone(), flags)
                .await
                .map_err(|fehler| AppError::internal(format!("Ablegen gescheitert: {fehler}")))?;
            /*
             * IMMER an die Startstelle – auch bei 0. Die Probe in
             * `fortsetzpunkt` hat die Quelle verstellt, und ein Test gegen
             * einen echten Server fand es: Nach einer fehlgeschlagenen Probe
             * stand der Lesezeiger 64 KiB weit hinten, und die Datei kam
             * drüben um genau so viel zu kurz an.
             */
            ein.seek(std::io::SeekFrom::Start(start)).await?;
            if start > 0 {
                datei
                    .seek(std::io::SeekFrom::Start(start))
                    .await
                    .map_err(|fehler| {
                        AppError::internal(format!("Fortsetzen gescheitert: {fehler}"))
                    })?;
            }
            // Ein grosser Lesepuffer: `tokio::io::copy` nähme 8 KiB und
            // schickte damit Pakete, die weit unter dem liegen, was die
            // Leitung vertrüge.
            let mut gepuffert = tokio::io::BufReader::with_capacity(256 * 1024, ein);
            tokio::io::copy_buf(&mut gepuffert, &mut datei)
                .await
                .map_err(|fehler| AppError::internal(format!("Schreiben gescheitert: {fehler}")))?;
            // Siehe `put`: erst `shutdown` sagt, dass alles drüben ist.
            datei
                .shutdown()
                .await
                .map_err(|fehler| AppError::internal(format!("Abschluss gescheitert: {fehler}")))
        }
        .await;
        if let Err(fehler) = ergebnis {
            /*
             * Das Teilstück bleibt für den nächsten Versuch liegen. Die
             * Verbindung dagegen wird weggeworfen: Nach einem Abriss mitten im
             * Strom ist sie mit hoher Wahrscheinlichkeit tot, und die nächste
             * Probe würde erst nach der Frist merken, dass sie es ist.
             */
            self.verwerfen(&v).await;
            return Err(fehler);
        }
        self.fertigstellen(&v, &pfad, &teil, laenge).await
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
        platz_holen(&self.plaetze).await?.forget();
        let pfad = match self.pfad_fuer(key) {
            Ok(p) => p,
            Err(f) => {
                self.plaetze.add_permits(1);
                return Err(f);
            }
        };
        let v = match self.sitzung().await {
            Ok(v) => v,
            Err(f) => {
                self.plaetze.add_permits(1);
                return Err(f);
            }
        };

        let mut datei = match v.sftp.open(pfad.clone()).await {
            Ok(datei) => datei,
            Err(fehler) => {
                self.plaetze.add_permits(1);
                /*
                 * Nur „gibt es nicht" ist ein Nichts. Eine Zeitüberschreitung
                 * oder ein Verbindungsabriss ist KEIN 404: Der Abspieler
                 * würde eine Datei, die da ist, für gelöscht halten – und die
                 * Weiche suchte sie in der falschen Ablage weiter.
                 */
                if fehlt_wirklich(&v.sftp, &pfad, &fehler).await {
                    return Ok(None);
                }
                return Err(AppError::internal(format!(
                    "Die kalte Ablage antwortet nicht: {fehler}"
                )));
            }
        };

        /*
         * Die Grösse MUSS stimmen. Früher stand hier `unwrap_or(0)`: Ein
         * verlorenes `fstat` machte aus einem Video von 3 GiB eine leere
         * Antwort mit Status 200 – ohne Fehler, ohne Protokoll.
         */
        let gesamt = match datei.metadata().await {
            Ok(m) => match m.size {
                Some(g) => g,
                None => {
                    self.plaetze.add_permits(1);
                    return Err(AppError::internal("Die Box nennt keine Dateigrösse"));
                }
            },
            Err(fehler) => {
                self.plaetze.add_permits(1);
                return Err(AppError::internal(format!(
                    "Dateigrösse in der kalten Ablage nicht lesbar: {fehler}"
                )));
            }
        };

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
            if let Err(fehler) = datei.seek(std::io::SeekFrom::Start(anfang)).await {
                self.plaetze.add_permits(1);
                return Err(AppError::internal(format!(
                    "Vorspulen in der kalten Ablage: {fehler}"
                )));
            }
        }

        let strom = ReaderStream::with_capacity(
            Freigabe {
                innen: datei.take(laenge),
                plaetze: self.plaetze.clone(),
            },
            256 * 1024,
        );
        Ok(Some(ObjectStream {
            stream: Box::pin(strom),
            size: Some(laenge),
            total_size: Some(gesamt),
            mime: None,
        }))
    }

    /**
     * Löschen – die Datei UND ihr Teilstück.
     *
     * Ein Fehler ausser „gibt es nicht" wird gemeldet. Früher stand hier
     * `let _ =`: Eine Zeitüberschreitung galt als erledigt, die Müllzeile
     * wurde ausgetragen und das Objekt blieb für immer auf der Box – bei
     * einem Video von vier Gigabyte der teuerste Fehler dieses Treibers.
     */
    async fn delete(&self, key: &str) -> AppResult<()> {
        let _platz = self.schreib_platz().await?;
        let pfad = self.pfad_fuer(key)?;
        let v = self.sitzung().await?;
        let teil = format!("{pfad}{TEIL}");
        let a = entfernen(&v.sftp, &pfad).await;
        let b = entfernen(&v.sftp, &teil).await;
        a.and(b)
    }

    /// Wie viel Platz auf der Box ist – falls sie es sagt (`statvfs@openssh.com`).
    async fn kapazitaet(&self) -> Option<(u64, u64)> {
        let v = self.sitzung().await.ok()?;
        let wurzel = self.pfad_fuer("").ok()?;
        let s = v.sftp.fs_info(wurzel).await.ok()??;
        let einheit = s.fragment_size.max(1);
        Some((
            s.blocks_avail.saturating_mul(einheit),
            s.blocks.saturating_mul(einheit),
        ))
    }

    /**
     * Liegengebliebene Teilstücke (`….teil`) wegräumen, die seit `aelter_als`
     * nicht mehr angefasst wurden.
     *
     * Ein Teilstück bleibt nach einem Abbruch absichtlich stehen (Fortsetzen).
     * Gehört die Datei inzwischen zu einer gelöschten Nachricht oder wurde
     * der Umzug nie wiederholt, räumt sonst niemand es weg: Die Müllliste
     * kennt nur den Endnamen.
     */
    async fn teilreste_raeumen(&self, aelter_als: std::time::Duration) -> AppResult<usize> {
        let _platz = self.schreib_platz().await?;
        let v = self.sitzung().await?;
        let wurzel = self.pfad_fuer("")?;
        let grenze = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
            .saturating_sub(aelter_als.as_secs());
        let mut offen = vec![wurzel];
        let mut weg = 0usize;
        while let Some(ordner) = offen.pop() {
            let Ok(eintraege) = v.sftp.read_dir(ordner).await else {
                continue;
            };
            for e in eintraege {
                let m = e.metadata();
                if m.is_dir() || m.file_type().is_dir() {
                    offen.push(e.path());
                } else if e.file_name().ends_with(TEIL)
                    && u64::from(m.mtime.unwrap_or(u32::MAX)) < grenze
                    && v.sftp.remove_file(e.path()).await.is_ok()
                {
                    weg += 1;
                }
            }
        }
        Ok(weg)
    }
}

impl SftpSpeicher {
    /**
     * Teilstück zur Datei machen – nachmessen, dann umbenennen.
     *
     * Die Grösse drüben muss genau `erwartet` sein; sonst wird das Teilstück
     * VERWORFEN (nicht behalten): Hat es die falsche Länge, taugt es auch
     * nicht zum Fortsetzen. Umbenannt wird mit „erst den Zielnamen freimachen":
     * SFTP (Version 3) überschreibt beim Umbenennen nicht, und ein Rest unter
     * dem Endnamen soll den Umzug nicht für immer scheitern lassen.
     */
    async fn fertigstellen(
        &self,
        v: &Arc<Verbindung>,
        pfad: &str,
        teil: &str,
        erwartet: u64,
    ) -> AppResult<()> {
        let drueben = v
            .sftp
            .metadata(teil.to_string())
            .await
            .map_err(|fehler| AppError::internal(format!("Nachmessen gescheitert: {fehler}")))?
            .size;
        if drueben != Some(erwartet) {
            let _ = v.sftp.remove_file(teil.to_string()).await;
            return Err(AppError::internal(format!(
                "Auf der Box liegen {drueben:?} statt {erwartet} Bytes"
            )));
        }
        entfernen(&v.sftp, pfad).await?;
        v.sftp
            .rename(teil.to_string(), pfad.to_string())
            .await
            .map_err(|fehler| AppError::internal(format!("Umbenennen gescheitert: {fehler}")))
    }
}

/// Einen Platz holen – mit Frist, damit niemand ewig in der Schlange hängt.
async fn platz_holen(plaetze: &Arc<Semaphore>) -> AppResult<tokio::sync::OwnedSemaphorePermit> {
    match tokio::time::timeout(
        std::time::Duration::from_secs(PLATZ_FRIST_S),
        plaetze.clone().acquire_owned(),
    )
    .await
    {
        Ok(Ok(platz)) => Ok(platz),
        Ok(Err(_)) => Err(AppError::internal(
            "Die kalte Ablage nimmt gerade nichts entgegen",
        )),
        Err(_) => Err(AppError::internal(
            "Die kalte Ablage ist gerade ausgelastet – bitte gleich noch einmal",
        )),
    }
}

/// Ist der Fehler „die Datei gibt es nicht"? Auch Server, die dafür nur
/// „Failure" melden, werden erkannt: Dann entscheidet eine zweite Frage.
async fn fehlt_wirklich(
    sftp: &SftpSession,
    pfad: &str,
    fehler: &russh_sftp::client::error::Error,
) -> bool {
    use russh_sftp::client::error::Error as F;
    use russh_sftp::protocol::StatusCode;
    match fehler {
        F::Status(s) if s.status_code == StatusCode::NoSuchFile => true,
        F::Status(s) if s.status_code == StatusCode::Failure => {
            matches!(sftp.try_exists(pfad.to_string()).await, Ok(false))
        }
        _ => false,
    }
}

/// Datei löschen; „gibt es nicht" ist Erfolg, alles andere ein Fehler.
async fn entfernen(sftp: &SftpSession, pfad: &str) -> AppResult<()> {
    match sftp.remove_file(pfad.to_string()).await {
        Ok(()) => Ok(()),
        Err(fehler) => {
            if fehlt_wirklich(sftp, pfad, &fehler).await {
                Ok(())
            } else {
                Err(AppError::internal(format!(
                    "Löschen in der kalten Ablage gescheitert: {fehler}"
                )))
            }
        }
    }
}

/**
 * Ab welchem Byte ein liegengebliebenes Teilstück weitergeschrieben werden
 * darf – 0 heisst: von vorn.
 *
 * Geprüft wird nur das Billige: Länge plausibel, Anfang und Ende des
 * Teilstücks gleich der Quelle. Dazwischen ist nichts zu prüfen, weil SFTP
 * über EINE Verbindung in Reihenfolge schreibt – eine Lücke in der Mitte
 * könnte nur entstehen, wenn die Box selbst Daten verloren hätte, und die
 * Endprobe (Grösse drüben = Grösse der Quelle) fängt wenigstens jede
 * Längenabweichung.
 */
async fn fortsetzpunkt(
    sftp: &SftpSession,
    quelle: &mut tokio::fs::File,
    teil: &str,
    laenge: u64,
) -> u64 {
    let Ok(m) = sftp.metadata(teil.to_string()).await else {
        return 0;
    };
    let da = m.size.unwrap_or(0);
    if da < FORTSETZEN_AB || da > laenge {
        return 0;
    }
    let start = if da == laenge { da } else { da - da % MIB };
    let probe = PROBE_BYTES.min(start);
    for ab in [0, start - probe] {
        let Some(drueben) = remote_lesen(sftp, teil, ab, probe).await else {
            return 0;
        };
        let mut hier = vec![0u8; probe as usize];
        if quelle.seek(std::io::SeekFrom::Start(ab)).await.is_err()
            || quelle.read_exact(&mut hier).await.is_err()
            || hier != drueben
        {
            tracing::info!(
                stelle = ab,
                "Teilstück auf der Box passt nicht zur Quelle – es wird von vorn geschrieben"
            );
            return 0;
        }
    }
    start
}

async fn remote_lesen(sftp: &SftpSession, pfad: &str, ab: u64, laenge: u64) -> Option<Vec<u8>> {
    let mut datei = sftp.open(pfad.to_string()).await.ok()?;
    datei.seek(std::io::SeekFrom::Start(ab)).await.ok()?;
    let mut puffer = vec![0u8; laenge as usize];
    datei.read_exact(&mut puffer).await.ok()?;
    Some(puffer)
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
