//! Verschlüsselung der abgelegten Dateien – eine Schicht vor dem Speicher.
//!
//! # Wogegen das hilft und wogegen nicht
//!
//! Diese Schicht ist **kein** Ende-zu-Ende-Verfahren. Der Server sieht jede
//! Datei im Klartext, während er sie ausliefert; er muss es, sonst könnte er
//! sie nicht ausliefern. Was hier verschlüsselt wird, sind die Bytes **im
//! Ruhezustand** – auf der Platte, im Objektspeicher, in der Sicherung.
//!
//! Konkret hilft das gegen:
//!
//! * **eine abhandengekommene Sicherung.** Der wahrscheinlichste Weg, auf dem
//!   Daten wirklich abfliessen. Sicherungen liegen woanders, laufen unbeachtet
//!   und werden selten so gut bewacht wie der Server selbst. Das
//!   Sicherungsskript nimmt den Schlüssel ausdrücklich **nicht** mit.
//! * **einen falsch freigegebenen Ordner.** Wenn der Upload-Ordner je über
//!   einen statischen Pfad im Netz landet, liegen dort Zufallsbytes.
//! * **einen fremd gelesenen Objektspeicher.** Wer den Bucket erwischt, hat
//!   nichts.
//!
//! Nicht hilft es gegen jemanden, der **root auf dem laufenden Server** hat:
//! Der liest den Schlüssel aus der Umgebung und ist fertig. Dagegen hilft nur
//! Plattenverschlüsselung (siehe `docs/SICHERHEIT.md`) und dass er gar nicht
//! erst hineinkommt.
//!
//! # Aufbau einer verschlüsselten Datei
//!
//! ```text
//! 0..6    "INIVLT"
//! 6       Fassung (1)
//! 7       reserviert (0)
//! 8..12   Blockgrösse in Klartextbytes, u32 big endian
//! 12..20  Klartextlänge der ganzen Datei, u64 big endian
//! 20..36  Salz, 16 zufällige Bytes je Datei
//! ------- danach Block für Block: Geheimtext + 16 Byte Prüfsumme
//! ```
//!
//! **Warum Blöcke und nicht am Stück?** Videos werden mit `Range` abgerufen –
//! der Browser springt in die Mitte und will von dort weiterlesen. Bei einer
//! am Stück verschlüsselten Datei müsste dafür alles davor entschlüsselt
//! werden; bei 200 MB wäre Vorspulen unbenutzbar. Mit Blöcken zu 64 KiB
//! entschlüsselt ein Sprung genau die Blöcke, die er berührt.
//!
//! **Warum je Datei ein eigener Schlüssel?** Der Zähler als Nonce ist nur dann
//! sicher, wenn dieselbe Schlüssel-Nonce-Kombination nie zweimal vorkommt. Mit
//! HKDF und 128 Bit Salz je Datei ist das gegeben, ohne dass irgendwo ein
//! Zähler über Neustarts hinweg gemerkt werden müsste.
//!
//! **Was ist mitgeprüft?** Der ganze Kopf steckt als zusätzliche Daten in jedem
//! Block. Damit lässt sich kein Block einer anderen Datei einsetzen (anderes
//! Salz), keiner umsortieren (Zähler) und die Datei nicht kürzen, ohne dass es
//! auffällt (die Klartextlänge steht im Kopf und ist mitsigniert).

use std::sync::Arc;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use async_trait::async_trait;
use axum::body::Bytes;
use bytes::BytesMut;
use futures_util::{stream, StreamExt};
use hkdf::Hkdf;
use sha2::Sha256;

use super::{ByteRange, ByteStream, DownloadOptions, ObjectStream, PresignedUpload, Storage};
use crate::error::{AppError, AppResult};

const MAGIE: &[u8; 6] = b"INIVLT";
const FASSUNG: u8 = 1;
pub(crate) const KOPF_LAENGE: usize = 36;
const PRUEFSUMME: usize = 16;
/// 64 KiB Klartext je Block. Gross genug, dass die Prüfsummen kaum ins Gewicht
/// fallen (0,02 %), klein genug, dass ein Sprung im Video wenig umsonst
/// entschlüsselt.
const BLOCK: usize = 64 * 1024;

pub struct Tresor {
    innen: Arc<dyn Storage>,
    hauptschluessel: [u8; 32],
}

impl Tresor {
    pub fn neu(innen: Arc<dyn Storage>, hauptschluessel: [u8; 32]) -> Self {
        Self {
            innen,
            hauptschluessel,
        }
    }

    /// Je Datei ein eigener Schlüssel, abgeleitet aus Hauptschlüssel und Salz.
    fn dateischluessel(&self, salz: &[u8]) -> AppResult<Aes256Gcm> {
        let hkdf = Hkdf::<Sha256>::new(Some(salz), &self.hauptschluessel);
        let mut abgeleitet = [0u8; 32];
        hkdf.expand(b"initiative-datei-v1", &mut abgeleitet)
            .map_err(|_| AppError::internal("Schlüsselableitung fehlgeschlagen"))?;
        Aes256Gcm::new_from_slice(&abgeleitet)
            .map_err(|_| AppError::internal("Ungültiger abgeleiteter Schlüssel"))
    }
}

fn nonce_fuer(index: u64) -> Nonce<aes_gcm::aes::cipher::consts::U12> {
    let mut bytes = [0u8; 12];
    bytes[4..].copy_from_slice(&index.to_be_bytes());
    *Nonce::from_slice(&bytes)
}

/// Liest den Kopf einer verschlüsselten Datei; `None`, wenn es keiner ist.
pub(crate) fn kopf_lesen(bytes: &[u8]) -> Option<Kopf> {
    if bytes.len() < KOPF_LAENGE || &bytes[0..6] != MAGIE || bytes[6] != FASSUNG {
        return None;
    }
    let block = u32::from_be_bytes(bytes[8..12].try_into().ok()?) as usize;
    // Ein Block von 0 wäre eine Endlosschleife beim Lesen, ein absurd grosser
    // eine Einladung, Speicher anzufordern, den es nicht gibt.
    if block == 0 || block > 8 * 1024 * 1024 {
        return None;
    }
    Some(Kopf {
        block,
        klartextlaenge: u64::from_be_bytes(bytes[12..20].try_into().ok()?),
        roh: bytes[..KOPF_LAENGE].to_vec(),
    })
}

#[derive(Debug, Clone)]
pub(crate) struct Kopf {
    pub block: usize,
    pub klartextlaenge: u64,
    /// Der Kopf im Original – er geht als mitgeprüfte Zusatzdaten in jeden
    /// Block ein.
    pub roh: Vec<u8>,
}

impl Kopf {
    fn rahmen(&self) -> usize {
        self.block + PRUEFSUMME
    }

    /// Wo im Geheimtext der Block mit dieser Nummer anfängt.
    fn versatz(&self, index: u64) -> u64 {
        KOPF_LAENGE as u64 + index * self.rahmen() as u64
    }
}

/// Verschlüsselt einen ganzen Puffer. Uploads liegen ohnehin am Stück im
/// Speicher – der Weg hinein braucht kein Strömen.
pub(crate) fn verschluesseln(
    schluessel: &Aes256Gcm,
    salz: &[u8; 16],
    klartext: &[u8],
) -> AppResult<Vec<u8>> {
    let mut kopf = Vec::with_capacity(KOPF_LAENGE);
    kopf.extend_from_slice(MAGIE);
    kopf.push(FASSUNG);
    kopf.push(0);
    kopf.extend_from_slice(&(BLOCK as u32).to_be_bytes());
    kopf.extend_from_slice(&(klartext.len() as u64).to_be_bytes());
    kopf.extend_from_slice(salz);
    debug_assert_eq!(kopf.len(), KOPF_LAENGE);

    let bloecke = klartext.len().div_ceil(BLOCK);
    let mut aus = Vec::with_capacity(KOPF_LAENGE + klartext.len() + bloecke * PRUEFSUMME);
    aus.extend_from_slice(&kopf);

    for (index, stueck) in klartext.chunks(BLOCK).enumerate() {
        let geheim = schluessel
            .encrypt(
                &nonce_fuer(index as u64),
                Payload {
                    msg: stueck,
                    aad: &kopf,
                },
            )
            .map_err(|_| AppError::internal("Verschlüsseln fehlgeschlagen"))?;
        aus.extend_from_slice(&geheim);
    }
    Ok(aus)
}

/// Baut aus dem Geheimtext-Strom einen Klartext-Strom.
///
/// `ueberspringen` und `rest` schneiden den angeforderten Bereich aus den
/// Blöcken heraus: Ein `Range` fängt selten genau auf einer Blockgrenze an.
fn entschluesseln_strom(
    innen: ByteStream,
    schluessel: Aes256Gcm,
    kopf: Kopf,
    erster_block: u64,
    ueberspringen: u64,
    rest: u64,
) -> ByteStream {
    struct Lage {
        innen: ByteStream,
        puffer: BytesMut,
        quelle_leer: bool,
        index: u64,
        ueberspringen: u64,
        rest: u64,
        schluessel: Aes256Gcm,
        kopf: Kopf,
    }

    let lage = Lage {
        innen,
        puffer: BytesMut::new(),
        quelle_leer: false,
        index: erster_block,
        ueberspringen,
        rest,
        schluessel,
        kopf,
    };

    Box::pin(stream::unfold(lage, |mut lage| async move {
        loop {
            if lage.rest == 0 {
                return None;
            }
            let rahmen = lage.kopf.rahmen();
            while lage.puffer.len() < rahmen && !lage.quelle_leer {
                match lage.innen.next().await {
                    Some(Ok(bytes)) => lage.puffer.extend_from_slice(&bytes),
                    Some(Err(fehler)) => return Some((Err(fehler), lage)),
                    None => lage.quelle_leer = true,
                }
            }
            let nehmen = rahmen.min(lage.puffer.len());
            if nehmen <= PRUEFSUMME {
                // Es fehlen Bytes, obwohl der Kopf mehr verspricht: gekürzte
                // oder beschädigte Datei. Das darf kein halbes Bild werden.
                return Some((
                    Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "verschlüsselte Datei ist unvollständig",
                    )),
                    lage,
                ));
            }
            let block = lage.puffer.split_to(nehmen);
            let klar = match lage.schluessel.decrypt(
                &nonce_fuer(lage.index),
                Payload {
                    msg: &block,
                    aad: &lage.kopf.roh,
                },
            ) {
                Ok(klar) => klar,
                Err(_) => {
                    return Some((
                        Err(std::io::Error::other(
                            "verschlüsselte Datei liess sich nicht prüfen",
                        )),
                        lage,
                    ))
                }
            };
            lage.index += 1;

            let mut klar = Bytes::from(klar);
            let weg = (lage.ueberspringen as usize).min(klar.len());
            if weg > 0 {
                klar = klar.slice(weg..);
                lage.ueberspringen -= weg as u64;
            }
            if klar.len() as u64 > lage.rest {
                klar = klar.slice(..lage.rest as usize);
            }
            lage.rest -= klar.len() as u64;
            if klar.is_empty() {
                continue;
            }
            return Some((Ok(klar), lage));
        }
    }))
}

#[async_trait]
impl Storage for Tresor {
    fn kind(&self) -> &'static str {
        // In `/readyz`, im Startprotokoll und in der Speicher-Diagnose soll auf
        // einen Blick stehen, dass die Verschlüsselung an ist – ohne dass man
        // dabei aus den Augen verliert, wohin die Bytes eigentlich gehen.
        match self.innen.kind() {
            "local" => "local+verschluesselt",
            "r2" => "r2+verschluesselt",
            "s3" => "s3+verschluesselt",
            _ => "verschluesselt",
        }
    }

    /// Immer `false`. Ein vorsigniertes Ziel hiesse, der Browser lädt direkt
    /// in den Objektspeicher – dann käme dort Klartext an und diese Schicht
    /// wäre wirkungslos.
    fn supports_presigned_upload(&self) -> bool {
        false
    }

    fn presign_upload(&self, _key: &str, _mime: &str) -> AppResult<PresignedUpload> {
        Err(AppError::internal(
            "Bei eingeschalteter Verschlüsselung gibt es keine direkten Uploads",
        ))
    }

    /// Immer `None`. Eine Umleitung in den Objektspeicher lieferte Geheimtext
    /// aus; die Bytes müssen durch die API, weil nur sie den Schlüssel hat.
    fn download_url(&self, _key: &str, _options: &DownloadOptions) -> AppResult<Option<String>> {
        Ok(None)
    }

    async fn put(&self, key: &str, body: Bytes, mime: &str) -> AppResult<()> {
        let mut salz = [0u8; 16];
        salz.copy_from_slice(&crate::auth::password::random_bytes(16));
        let schluessel = self.dateischluessel(&salz)?;
        let geheim = verschluesseln(&schluessel, &salz, &body)?;
        self.innen.put(key, Bytes::from(geheim), mime).await
    }

    async fn read(&self, key: &str, range: Option<ByteRange>) -> AppResult<Option<ObjectStream>> {
        // Erst den Kopf holen – er sagt, wie lang der Klartext ist und wo die
        // Blöcke liegen.
        let kopf = {
            let vorschau = self
                .innen
                .read(
                    key,
                    Some(ByteRange {
                        start: 0,
                        end: Some(KOPF_LAENGE as u64 - 1),
                    }),
                )
                .await?;
            let Some(vorschau) = vorschau else {
                return Ok(None);
            };
            let mut roh = BytesMut::new();
            let mut strom = vorschau.stream;
            while let Some(stueck) = strom.next().await {
                roh.extend_from_slice(&stueck?);
                if roh.len() >= KOPF_LAENGE {
                    break;
                }
            }
            kopf_lesen(&roh)
        };

        // Kein Kopf? Dann liegt dort eine Datei aus der Zeit vor der
        // Verschlüsselung. Die wird unverändert durchgereicht – sonst wären
        // beim Einschalten schlagartig alle alten Bilder kaputt.
        let Some(kopf) = kopf else {
            return self.innen.read(key, range).await;
        };

        let gesamt = kopf.klartextlaenge;
        let (start, ende) = match range {
            Some(range) => {
                let start = range.start.min(gesamt.saturating_sub(1));
                let ende = range
                    .end
                    .unwrap_or(gesamt.saturating_sub(1))
                    .min(gesamt.saturating_sub(1));
                (start, ende)
            }
            None => (0, gesamt.saturating_sub(1)),
        };
        if gesamt == 0 {
            return Ok(Some(ObjectStream {
                stream: Box::pin(stream::empty()),
                size: Some(0),
                total_size: Some(0),
                mime: None,
            }));
        }
        let laenge = ende.saturating_sub(start) + 1;

        let erster = start / kopf.block as u64;
        let letzter = ende / kopf.block as u64;
        let innen_range = ByteRange {
            start: kopf.versatz(erster),
            end: Some(kopf.versatz(letzter + 1) - 1),
        };

        let salz: [u8; 16] = kopf.roh[20..36]
            .try_into()
            .map_err(|_| AppError::internal("Kopf der verschlüsselten Datei ist zu kurz"))?;
        let schluessel = self.dateischluessel(&salz)?;

        let Some(objekt) = self.innen.read(key, Some(innen_range)).await? else {
            return Ok(None);
        };
        let ueberspringen = start - erster * kopf.block as u64;

        Ok(Some(ObjectStream {
            stream: entschluesseln_strom(
                objekt.stream,
                schluessel,
                kopf,
                erster,
                ueberspringen,
                laenge,
            ),
            size: Some(laenge),
            total_size: Some(gesamt),
            mime: objekt.mime,
        }))
    }

    async fn delete(&self, key: &str) -> AppResult<()> {
        self.innen.delete(key).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::TryStreamExt;

    fn tresor() -> Tresor {
        let innen = Arc::new(super::super::local::LocalStorage::new(&format!(
            "./.data/tresor-test-{}",
            uuid::Uuid::now_v7().simple()
        )));
        Tresor::neu(innen, [7u8; 32])
    }

    async fn einsammeln(objekt: ObjectStream) -> Vec<u8> {
        objekt
            .stream
            .try_fold(Vec::new(), |mut alles, stueck| async move {
                alles.extend_from_slice(&stueck);
                Ok(alles)
            })
            .await
            .expect("Strom")
    }

    fn muster(laenge: usize) -> Vec<u8> {
        (0..laenge).map(|i| (i % 251) as u8).collect()
    }

    #[tokio::test]
    async fn was_hineingeht_kommt_wieder_heraus() {
        let tresor = tresor();
        for laenge in [0usize, 1, 100, BLOCK - 1, BLOCK, BLOCK + 1, 3 * BLOCK + 77] {
            let daten = muster(laenge);
            tresor
                .put(
                    "a/b.bin",
                    Bytes::from(daten.clone()),
                    "application/octet-stream",
                )
                .await
                .expect("put");
            let objekt = tresor
                .read("a/b.bin", None)
                .await
                .expect("read")
                .expect("da");
            assert_eq!(objekt.total_size, Some(laenge as u64), "Länge bei {laenge}");
            assert_eq!(einsammeln(objekt).await, daten, "Inhalt bei {laenge}");
        }
    }

    #[tokio::test]
    async fn auf_der_platte_steht_nichts_lesbares() {
        // Der eigentliche Zweck: Wer die Datei findet, soll nichts davon haben.
        let wurzel = format!("./.data/tresor-klar-{}", uuid::Uuid::now_v7().simple());
        let tresor = Tresor::neu(
            Arc::new(super::super::local::LocalStorage::new(&wurzel)),
            [3u8; 32],
        );
        let geheimnis = b"Kontostand 4200 Euro, Adresse Musterweg 1".to_vec();
        tresor
            .put("x/y.txt", Bytes::from(geheimnis.clone()), "text/plain")
            .await
            .expect("put");

        let roh = tokio::fs::read(format!("{wurzel}/x/y.txt"))
            .await
            .expect("Datei");
        assert!(
            !roh.windows(geheimnis.len()).any(|f| f == geheimnis),
            "der Klartext liegt unverändert auf der Platte"
        );
        assert!(
            !roh.windows(6).any(|f| f == b"Muster"),
            "auch Teile davon dürfen nicht auftauchen"
        );
    }

    #[tokio::test]
    async fn ein_bereich_mitten_in_der_datei_stimmt() {
        // Das ist der Fall, der beim Vorspulen im Video zählt: nicht bei 0
        // anfangen, nicht auf einer Blockgrenze aufhören.
        let tresor = tresor();
        let daten = muster(3 * BLOCK + 500);
        tresor
            .put("v/f.mp4", Bytes::from(daten.clone()), "video/mp4")
            .await
            .expect("put");

        for (start, ende) in [
            (0u64, 9u64),
            (1, 1),
            (BLOCK as u64 - 5, BLOCK as u64 + 5),
            (BLOCK as u64, 2 * BLOCK as u64 - 1),
            (2 * BLOCK as u64 + 13, 3 * BLOCK as u64 + 499),
            (3 * BLOCK as u64 + 499, 3 * BLOCK as u64 + 499),
        ] {
            let objekt = tresor
                .read(
                    "v/f.mp4",
                    Some(ByteRange {
                        start,
                        end: Some(ende),
                    }),
                )
                .await
                .expect("read")
                .expect("da");
            assert_eq!(objekt.total_size, Some(daten.len() as u64));
            assert_eq!(objekt.size, Some(ende - start + 1), "Länge {start}..{ende}");
            assert_eq!(
                einsammeln(objekt).await,
                &daten[start as usize..=ende as usize],
                "Inhalt {start}..{ende}"
            );
        }
    }

    #[tokio::test]
    async fn ein_offener_bereich_liest_bis_zum_ende() {
        let tresor = tresor();
        let daten = muster(BLOCK + 1000);
        tresor
            .put(
                "o/f.bin",
                Bytes::from(daten.clone()),
                "application/octet-stream",
            )
            .await
            .expect("put");
        let objekt = tresor
            .read(
                "o/f.bin",
                Some(ByteRange {
                    start: BLOCK as u64,
                    end: None,
                }),
            )
            .await
            .expect("read")
            .expect("da");
        assert_eq!(einsammeln(objekt).await, &daten[BLOCK..]);
    }

    #[tokio::test]
    async fn ein_falscher_schluessel_liefert_keinen_klartext() {
        let wurzel = format!("./.data/tresor-fremd-{}", uuid::Uuid::now_v7().simple());
        let innen = Arc::new(super::super::local::LocalStorage::new(&wurzel));
        let meins = Tresor::neu(innen.clone(), [1u8; 32]);
        meins
            .put(
                "g/h.bin",
                Bytes::from(muster(5000)),
                "application/octet-stream",
            )
            .await
            .expect("put");

        let fremd = Tresor::neu(innen, [2u8; 32]);
        let objekt = fremd
            .read("g/h.bin", None)
            .await
            .expect("read")
            .expect("da");
        let ergebnis = objekt
            .stream
            .try_fold(Vec::new(), |mut alles, stueck| async move {
                alles.extend_from_slice(&stueck);
                Ok(alles)
            })
            .await;
        assert!(
            ergebnis.is_err(),
            "mit fremdem Schlüssel darf nichts herauskommen"
        );
    }

    #[tokio::test]
    async fn eine_veraenderte_datei_faellt_auf() {
        // Ohne Prüfsumme könnte jemand mit Schreibrechten Bilder austauschen,
        // ohne den Schlüssel zu kennen.
        let wurzel = format!("./.data/tresor-kaputt-{}", uuid::Uuid::now_v7().simple());
        let tresor = Tresor::neu(
            Arc::new(super::super::local::LocalStorage::new(&wurzel)),
            [9u8; 32],
        );
        tresor
            .put(
                "k/l.bin",
                Bytes::from(muster(200)),
                "application/octet-stream",
            )
            .await
            .expect("put");

        let pfad = format!("{wurzel}/k/l.bin");
        let mut roh = tokio::fs::read(&pfad).await.expect("Datei");
        let mitte = roh.len() / 2;
        roh[mitte] ^= 0xff;
        tokio::fs::write(&pfad, &roh).await.expect("schreiben");

        let objekt = tresor
            .read("k/l.bin", None)
            .await
            .expect("read")
            .expect("da");
        let ergebnis = objekt
            .stream
            .try_fold(Vec::new(), |mut alles, stueck| async move {
                alles.extend_from_slice(&stueck);
                Ok(alles)
            })
            .await;
        assert!(ergebnis.is_err(), "die Änderung muss auffallen");
    }

    #[tokio::test]
    async fn alte_unverschluesselte_dateien_bleiben_lesbar() {
        // Beim Einschalten liegen im Ordner schon Bilder. Die müssen weiter
        // funktionieren, sonst ist der Umzug ein Datenverlust.
        let wurzel = format!("./.data/tresor-alt-{}", uuid::Uuid::now_v7().simple());
        let innen = Arc::new(super::super::local::LocalStorage::new(&wurzel));
        let alt = muster(4000);
        innen
            .put(
                "a/alt.bin",
                Bytes::from(alt.clone()),
                "application/octet-stream",
            )
            .await
            .expect("put");

        let tresor = Tresor::neu(innen, [5u8; 32]);
        let objekt = tresor
            .read("a/alt.bin", None)
            .await
            .expect("read")
            .expect("da");
        assert_eq!(einsammeln(objekt).await, alt);

        let teil = tresor
            .read(
                "a/alt.bin",
                Some(ByteRange {
                    start: 100,
                    end: Some(199),
                }),
            )
            .await
            .expect("read")
            .expect("da");
        assert_eq!(einsammeln(teil).await, &alt[100..=199]);
    }

    #[tokio::test]
    async fn zweimal_dieselbe_datei_ergibt_verschiedenen_geheimtext() {
        // Sonst verriete ein Vergleich, wer dasselbe Bild hochgeladen hat.
        let wurzel = format!("./.data/tresor-salz-{}", uuid::Uuid::now_v7().simple());
        let tresor = Tresor::neu(
            Arc::new(super::super::local::LocalStorage::new(&wurzel)),
            [4u8; 32],
        );
        let daten = muster(1000);
        tresor
            .put(
                "s/1.bin",
                Bytes::from(daten.clone()),
                "application/octet-stream",
            )
            .await
            .expect("put");
        tresor
            .put("s/2.bin", Bytes::from(daten), "application/octet-stream")
            .await
            .expect("put");
        let eins = tokio::fs::read(format!("{wurzel}/s/1.bin"))
            .await
            .expect("1");
        let zwei = tokio::fs::read(format!("{wurzel}/s/2.bin"))
            .await
            .expect("2");
        assert_ne!(eins, zwei);
    }
}
