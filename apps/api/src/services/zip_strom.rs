//! Ein ZIP-Archiv im Strom schreiben – ohne Kompression, ohne neue Abhängigkeit.
//!
//! # Warum selbst geschrieben
//!
//! Der Chat-Export ist das einzige ZIP der App. Eine Bibliothek dafür brächte
//! Deflate, ZIP64, Verschlüsselung und Lesen mit – gebraucht wird nichts
//! davon: Fotos, Videos und Sprachnachrichten sind schon komprimiert, und
//! `chat.txt` ist klein. Gespeichert („stored“, Methode 0) ist das Format
//! überschaubar: lokaler Kopf, Bytes, Datenbeschreibung, am Ende das
//! Verzeichnis.
//!
//! # Warum mit Datenbeschreibung (Bit 3)
//!
//! Die Prüfsumme (CRC-32) einer Datei steht erst fest, wenn ihre Bytes durch
//! sind. Im Strom lässt sich der lokale Kopf aber nicht nachträglich
//! überschreiben. Bit 3 sagt dem Leser: Prüfsumme und Grössen stehen HINTER
//! den Bytes (und im Verzeichnis am Ende, das jeder übliche Entpacker liest).
//! So geht jede Datei genau einmal durch den Arbeitsspeicher – in Stücken.
//!
//! # Grenzen
//!
//! Kein ZIP64: höchstens 65 535 Einträge und 4 GiB je Datei und insgesamt.
//! Der Export bleibt mit seiner Bremse weit darunter (`services::anhaenge`).

use tokio::io::{AsyncWrite, AsyncWriteExt};

/// CRC-32 (IEEE 802.3, wie ZIP sie verlangt) – Tabelle zur Übersetzungszeit.
const CRC_TABELLE: [u32; 256] = {
    let mut tabelle = [0u32; 256];
    let mut i = 0;
    while i < 256 {
        let mut wert = i as u32;
        let mut bit = 0;
        while bit < 8 {
            wert = if wert & 1 != 0 {
                0xEDB8_8320 ^ (wert >> 1)
            } else {
                wert >> 1
            };
            bit += 1;
        }
        tabelle[i] = wert;
        i += 1;
    }
    tabelle
};

/// Laufende CRC-32 über beliebig viele Stücke.
#[derive(Debug, Clone, Copy)]
pub struct Crc32(u32);

impl Default for Crc32 {
    fn default() -> Self {
        Self(0xFFFF_FFFF)
    }
}

impl Crc32 {
    pub fn dazu(&mut self, daten: &[u8]) {
        let mut wert = self.0;
        for byte in daten {
            wert = CRC_TABELLE[((wert ^ u32::from(*byte)) & 0xFF) as usize] ^ (wert >> 8);
        }
        self.0 = wert;
    }

    pub fn ergebnis(self) -> u32 {
        self.0 ^ 0xFFFF_FFFF
    }
}

/// Höchstgrösse ohne ZIP64 – für Dateien und das ganze Archiv.
pub const ZIP_GRENZE: u64 = 0xFFFF_FFFF;
/// Höchstzahl der Einträge ohne ZIP64.
pub const EINTRAEGE_MAX: usize = 0xFFFF;

#[derive(Debug)]
struct Eintrag {
    name: Vec<u8>,
    crc: u32,
    groesse: u32,
    versatz: u32,
    zeit: u16,
    datum: u16,
}

/// Zeit und Datum im DOS-Format (lokale Zeit des Exports; ZIP kennt keine Zone).
pub fn dos_zeit(zeit: chrono::NaiveDateTime) -> (u16, u16) {
    use chrono::{Datelike, Timelike};
    let jahr = zeit.year().clamp(1980, 2107) as u16;
    let datum = ((jahr - 1980) << 9) | ((zeit.month() as u16) << 5) | zeit.day() as u16;
    let uhr =
        ((zeit.hour() as u16) << 11) | ((zeit.minute() as u16) << 5) | (zeit.second() as u16 / 2);
    (uhr, datum)
}

/// Schreibt ein ZIP in `ziel`, Datei für Datei.
pub struct ZipStrom<W> {
    ziel: W,
    versatz: u64,
    eintraege: Vec<Eintrag>,
    offen: Option<(Eintrag, Crc32, u64)>,
}

fn zu_gross() -> std::io::Error {
    std::io::Error::other("ZIP ohne ZIP64: höchstens 4 GiB und 65 535 Einträge")
}

impl<W: AsyncWrite + Unpin> ZipStrom<W> {
    pub fn neu(ziel: W) -> Self {
        Self {
            ziel,
            versatz: 0,
            eintraege: Vec::new(),
            offen: None,
        }
    }

    /// Wie viele Bytes schon geschrieben sind.
    pub fn geschrieben(&self) -> u64 {
        self.versatz
    }

    async fn roh(&mut self, daten: &[u8]) -> std::io::Result<()> {
        self.ziel.write_all(daten).await?;
        self.versatz += daten.len() as u64;
        if self.versatz > ZIP_GRENZE {
            return Err(zu_gross());
        }
        Ok(())
    }

    /// Eine neue Datei beginnen. `name` mit `/` als Trenner, UTF-8.
    pub async fn datei_beginnen(
        &mut self,
        name: &str,
        zeit: chrono::NaiveDateTime,
    ) -> std::io::Result<()> {
        if self.offen.is_some() {
            self.datei_beenden().await?;
        }
        if self.eintraege.len() >= EINTRAEGE_MAX {
            return Err(zu_gross());
        }
        let (uhr, datum) = dos_zeit(zeit);
        let eintrag = Eintrag {
            name: name.as_bytes().to_vec(),
            crc: 0,
            groesse: 0,
            versatz: u32::try_from(self.versatz).map_err(|_| zu_gross())?,
            zeit: uhr,
            datum,
        };
        let mut kopf = Vec::with_capacity(30 + eintrag.name.len());
        kopf.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        kopf.extend_from_slice(&20u16.to_le_bytes()); // Version 2.0
                                                      // Bit 3: Prüfsumme/Grössen folgen; Bit 11: Name in UTF-8.
        kopf.extend_from_slice(&((1u16 << 3) | (1u16 << 11)).to_le_bytes());
        kopf.extend_from_slice(&0u16.to_le_bytes()); // gespeichert
        kopf.extend_from_slice(&uhr.to_le_bytes());
        kopf.extend_from_slice(&datum.to_le_bytes());
        kopf.extend_from_slice(&0u32.to_le_bytes()); // CRC folgt
        kopf.extend_from_slice(&0u32.to_le_bytes()); // Grösse folgt
        kopf.extend_from_slice(&0u32.to_le_bytes());
        kopf.extend_from_slice(&(eintrag.name.len() as u16).to_le_bytes());
        kopf.extend_from_slice(&0u16.to_le_bytes());
        kopf.extend_from_slice(&eintrag.name);
        self.roh(&kopf).await?;
        self.offen = Some((eintrag, Crc32::default(), 0));
        Ok(())
    }

    /// Bytes an die offene Datei anhängen.
    pub async fn schreiben(&mut self, daten: &[u8]) -> std::io::Result<()> {
        let Some((_, crc, groesse)) = self.offen.as_mut() else {
            return Err(std::io::Error::other("Keine Datei offen"));
        };
        crc.dazu(daten);
        *groesse += daten.len() as u64;
        if *groesse > ZIP_GRENZE {
            return Err(zu_gross());
        }
        self.roh(daten).await
    }

    /// Die offene Datei abschliessen (Datenbeschreibung).
    pub async fn datei_beenden(&mut self) -> std::io::Result<()> {
        let Some((mut eintrag, crc, groesse)) = self.offen.take() else {
            return Ok(());
        };
        eintrag.crc = crc.ergebnis();
        eintrag.groesse = u32::try_from(groesse).map_err(|_| zu_gross())?;
        let mut beschreibung = Vec::with_capacity(16);
        beschreibung.extend_from_slice(&0x0807_4b50u32.to_le_bytes());
        beschreibung.extend_from_slice(&eintrag.crc.to_le_bytes());
        beschreibung.extend_from_slice(&eintrag.groesse.to_le_bytes());
        beschreibung.extend_from_slice(&eintrag.groesse.to_le_bytes());
        self.roh(&beschreibung).await?;
        self.eintraege.push(eintrag);
        Ok(())
    }

    /// Verzeichnis und Abschluss schreiben; gibt das Ziel zurück.
    pub async fn abschliessen(mut self) -> std::io::Result<W> {
        self.datei_beenden().await?;
        let anfang = u32::try_from(self.versatz).map_err(|_| zu_gross())?;
        let mut verzeichnis = Vec::new();
        for eintrag in &self.eintraege {
            verzeichnis.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            verzeichnis.extend_from_slice(&20u16.to_le_bytes()); // erstellt mit
            verzeichnis.extend_from_slice(&20u16.to_le_bytes()); // benötigt
            verzeichnis.extend_from_slice(&((1u16 << 3) | (1u16 << 11)).to_le_bytes());
            verzeichnis.extend_from_slice(&0u16.to_le_bytes());
            verzeichnis.extend_from_slice(&eintrag.zeit.to_le_bytes());
            verzeichnis.extend_from_slice(&eintrag.datum.to_le_bytes());
            verzeichnis.extend_from_slice(&eintrag.crc.to_le_bytes());
            verzeichnis.extend_from_slice(&eintrag.groesse.to_le_bytes());
            verzeichnis.extend_from_slice(&eintrag.groesse.to_le_bytes());
            verzeichnis.extend_from_slice(&(eintrag.name.len() as u16).to_le_bytes());
            verzeichnis.extend_from_slice(&0u16.to_le_bytes()); // Zusatz
            verzeichnis.extend_from_slice(&0u16.to_le_bytes()); // Kommentar
            verzeichnis.extend_from_slice(&0u16.to_le_bytes()); // Datenträger
            verzeichnis.extend_from_slice(&0u16.to_le_bytes()); // intern
            verzeichnis.extend_from_slice(&0u32.to_le_bytes()); // extern
            verzeichnis.extend_from_slice(&eintrag.versatz.to_le_bytes());
            verzeichnis.extend_from_slice(&eintrag.name);
        }
        let laenge = u32::try_from(verzeichnis.len()).map_err(|_| zu_gross())?;
        let anzahl = self.eintraege.len() as u16;
        verzeichnis.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        verzeichnis.extend_from_slice(&0u16.to_le_bytes());
        verzeichnis.extend_from_slice(&0u16.to_le_bytes());
        verzeichnis.extend_from_slice(&anzahl.to_le_bytes());
        verzeichnis.extend_from_slice(&anzahl.to_le_bytes());
        verzeichnis.extend_from_slice(&laenge.to_le_bytes());
        verzeichnis.extend_from_slice(&anfang.to_le_bytes());
        verzeichnis.extend_from_slice(&0u16.to_le_bytes());
        self.roh(&verzeichnis).await?;
        self.ziel.flush().await?;
        Ok(self.ziel)
    }
}

/// Ein ZIP lesen – nur für Tests: (Name, Inhalt) je Eintrag, über das
/// Verzeichnis am Ende, mit Prüfung der CRC.
pub fn lesen(daten: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let u16_bei = |i: usize| -> Result<u16, String> {
        daten
            .get(i..i + 2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
            .ok_or_else(|| "zu kurz".to_string())
    };
    let u32_bei = |i: usize| -> Result<u32, String> {
        daten
            .get(i..i + 4)
            .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
            .ok_or_else(|| "zu kurz".to_string())
    };
    if daten.len() < 22 {
        return Err("kein Abschluss".into());
    }
    let ende = daten.len() - 22;
    if u32_bei(ende)? != 0x0605_4b50 {
        return Err("Abschluss fehlt".into());
    }
    let anzahl = u16_bei(ende + 10)? as usize;
    let mut zeiger = u32_bei(ende + 16)? as usize;
    let mut ergebnis = Vec::with_capacity(anzahl);
    for _ in 0..anzahl {
        if u32_bei(zeiger)? != 0x0201_4b50 {
            return Err("Verzeichniseintrag kaputt".into());
        }
        let crc = u32_bei(zeiger + 16)?;
        let groesse = u32_bei(zeiger + 24)? as usize;
        let name_laenge = u16_bei(zeiger + 28)? as usize;
        let zusatz = u16_bei(zeiger + 30)? as usize;
        let kommentar = u16_bei(zeiger + 32)? as usize;
        let versatz = u32_bei(zeiger + 42)? as usize;
        let name = String::from_utf8(
            daten
                .get(zeiger + 46..zeiger + 46 + name_laenge)
                .ok_or("Name fehlt")?
                .to_vec(),
        )
        .map_err(|_| "Name nicht UTF-8".to_string())?;
        if u32_bei(versatz)? != 0x0403_4b50 {
            return Err(format!("lokaler Kopf von {name} fehlt"));
        }
        let lokal_name = u16_bei(versatz + 26)? as usize;
        let lokal_zusatz = u16_bei(versatz + 28)? as usize;
        let anfang = versatz + 30 + lokal_name + lokal_zusatz;
        let inhalt = daten
            .get(anfang..anfang + groesse)
            .ok_or_else(|| format!("{name}: Inhalt abgeschnitten"))?
            .to_vec();
        let mut pruef = Crc32::default();
        pruef.dazu(&inhalt);
        if pruef.ergebnis() != crc {
            return Err(format!("{name}: CRC stimmt nicht"));
        }
        ergebnis.push((name, inhalt));
        zeiger += 46 + name_laenge + zusatz + kommentar;
    }
    Ok(ergebnis)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_stimmt_mit_dem_bekannten_pruefwert() {
        // Der Prüfwert aus jeder CRC-32-Beschreibung.
        let mut crc = Crc32::default();
        crc.dazu(b"123456789");
        assert_eq!(crc.ergebnis(), 0xCBF4_3926);
        // In Stücken gleich wie am Stück.
        let mut stueckweise = Crc32::default();
        stueckweise.dazu(b"1234");
        stueckweise.dazu(b"56789");
        assert_eq!(stueckweise.ergebnis(), 0xCBF4_3926);
    }

    #[test]
    fn dos_zeit_kodiert_datum_und_uhrzeit() {
        let zeit = chrono::NaiveDate::from_ymd_opt(2026, 11, 20)
            .unwrap()
            .and_hms_opt(14, 3, 10)
            .unwrap();
        let (uhr, datum) = dos_zeit(zeit);
        assert_eq!(datum >> 9, 46);
        assert_eq!((datum >> 5) & 0xF, 11);
        assert_eq!(datum & 0x1F, 20);
        assert_eq!(uhr >> 11, 14);
        assert_eq!((uhr >> 5) & 0x3F, 3);
        assert_eq!(uhr & 0x1F, 5);
    }

    #[tokio::test]
    async fn geschrieben_und_wieder_gelesen() {
        let zeit = chrono::NaiveDate::from_ymd_opt(2026, 1, 2)
            .unwrap()
            .and_hms_opt(3, 4, 6)
            .unwrap();
        let mut zip = ZipStrom::neu(Vec::new());
        zip.datei_beginnen("chat.txt", zeit).await.unwrap();
        zip.schreiben("Grüße\n".as_bytes()).await.unwrap();
        zip.schreiben(b"zweite Zeile\n").await.unwrap();
        zip.datei_beginnen("medien/0001-bild.png", zeit)
            .await
            .unwrap();
        zip.schreiben(&[0u8, 1, 2, 3, 255]).await.unwrap();
        zip.datei_beginnen("leer.txt", zeit).await.unwrap();
        let daten = zip.abschliessen().await.unwrap();
        let eintraege = lesen(&daten).unwrap();
        assert_eq!(eintraege.len(), 3);
        assert_eq!(eintraege[0].0, "chat.txt");
        assert_eq!(eintraege[0].1, "Grüße\nzweite Zeile\n".as_bytes());
        assert_eq!(eintraege[1].0, "medien/0001-bild.png");
        assert_eq!(eintraege[1].1, vec![0u8, 1, 2, 3, 255]);
        assert_eq!(eintraege[2].1, Vec::<u8>::new());
    }
}
