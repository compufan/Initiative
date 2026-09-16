//! Miniaturbilder – auf dem Server gerechnet, einmal und dann abgelegt.
//!
//! # Warum es sie braucht
//!
//! Für ein Vorschaubild gab es bisher genau eine Quelle: die eingebettete
//! `previewDataUrl`. Die ist 160 Punkte lang, fährt in jeder Nachrichtenliste
//! mit und hat damit eine harte Obergrenze – sie darf nicht wachsen, ohne dass
//! jede Liste schwerer wird. In einer Kachelansicht auf einem Tablet reicht
//! sie nicht, und dort ist sie zugleich das ENDGÜLTIGE Bild: Anders als in der
//! Chatblase wird daneben nichts Schärferes nachgeladen.
//!
//! Die naheliegende Antwort – dann eben das Original laden – ist die falsche:
//! Ein Ordner mit vierzig Urlaubsfotos wären vierzig mal zwei Megabyte, für
//! Kacheln von 110 Punkten Kantenlänge.
//!
//! # Warum auf dem Server und nicht im Browser
//!
//! Weil der Browser dafür das Original holen müsste – genau das, was
//! eingespart werden soll. Hier liegt es ohnehin.
//!
//! # Was hier NICHT geht
//!
//! HEIC. Das ist das Format, in dem ein iPhone standardmässig fotografiert,
//! und es zu entschlüsseln braucht libheif (LGPL) und berührt Patente auf
//! HEVC. Beides passt nicht zu einer App, die kommerziell laufen soll. Ein
//! HEIC-Anhang bekommt hier eine Absage, und der Browser bleibt bei der
//! eingebetteten Vorschau – dieselbe Antwort wie für ein Video.
//!
//! Bewegte GIFs werden zum STANDBILD: Ein Miniaturbild ist ein Bild. Wer die
//! Bewegung sehen will, öffnet die Datei.

use image::{ImageFormat, ImageReader};
use std::io::Cursor;

use crate::error::{AppError, AppResult};

/// Die Kantenlängen, die es gibt.
///
/// Eine feste Liste und keine freie Zahl: Sonst legte ein einziger Aufrufer
/// mit `?kante=101`, `102`, `103` … tausend Fassungen desselben Bildes im
/// Speicher ab, und jede kostet Platz und einen Durchgang durch den
/// Bildwandler.
///
/// Drei Stufen decken, was es gibt: 160 für eine Zeile in einer Liste, 320 für
/// eine Kachel auf dem Telefon, 640 für eine Kachel auf einem Tablet oder ein
/// Telefon mit dreifacher Punktdichte.
pub const KANTEN: [u32; 3] = [160, 320, 640];

/// Die nächstgrössere angebotene Kante – kleiner wäre unscharf.
pub fn kante_waehlen(gewuenscht: u32) -> u32 {
    for kante in KANTEN {
        if gewuenscht <= kante {
            return kante;
        }
    }
    KANTEN[KANTEN.len() - 1]
}

/// Ob sich aus diesem Typ überhaupt ein Miniaturbild rechnen lässt.
pub fn wandelbar(mime: &str) -> bool {
    matches!(
        mime.split(';').next().unwrap_or("").trim(),
        "image/jpeg" | "image/png" | "image/webp" | "image/gif"
    )
}

/// Der Ablageschlüssel der Miniatur zu einem Original.
///
/// Neben dem Original und mit der Kante im Namen. Damit räumt das Löschen des
/// Originals sie nicht mit weg – das ist bewusst: Ein verwaistes Miniaturbild
/// von acht Kilobyte ist harmloser als ein Löschweg, der über eine Liste von
/// abgeleiteten Schlüsseln stolpert. Der Müllsammler findet sie am Namen.
pub fn schluessel(original: &str, kante: u32) -> String {
    format!("{original}.mini-{kante}.jpg")
}

/**
 * Wie gross ein Original höchstens sein darf, bevor es entschlüsselt wird.
 *
 * Ein PNG von wenigen Kilobyte kann 30 000 × 30 000 Punkte ankündigen; das
 * wären beim Entschlüsseln 3,6 Gigabyte. Das ist keine Spitzfindigkeit,
 * sondern der bekannteste Weg, einen Bilddienst umzuwerfen, und er kostet den
 * Angreifer nichts.
 *
 * 64 Megapunkte lassen jede Kamera durch, die es gibt (das ist mehr als
 * 8000 × 8000), und decken den Angriff ab.
 */
const PUNKTE_MAX: u64 = 64 * 1024 * 1024;

/**
 * Aus den Bytes eines Bildes ein JPEG der gewünschten Kantenlänge.
 *
 * Läuft im Aufrufer in `spawn_blocking`: Entschlüsseln und Verkleinern sind
 * reine Rechenarbeit und blockieren sonst einen Faden der Laufzeit, auf dem
 * jede andere Anfrage wartet.
 */
pub fn rechnen(bytes: &[u8], kante: u32) -> AppResult<Vec<u8>> {
    let mut leser = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|_| AppError::bad_request("Das Bild liess sich nicht lesen"))?;
    let mut grenzen = image::Limits::default();
    // `image` rechnet die Fläche selbst nicht nach; die Kanten einzeln zu
    // begrenzen tut es.
    let kantenmax = (PUNKTE_MAX as f64).sqrt() as u32;
    grenzen.max_image_width = Some(kantenmax);
    grenzen.max_image_height = Some(kantenmax);
    grenzen.max_alloc = Some(PUNKTE_MAX * 4);
    leser.limits(grenzen);

    let bild = leser
        .decode()
        .map_err(|_| AppError::bad_request("Das Bild liess sich nicht entschlüsseln"))?;

    /*
     * `thumbnail` und nicht `resize`.
     *
     * Der Unterschied ist die Zeit: `thumbnail` verkleinert erst grob in
     * Zweierschritten und filtert nur den letzten. Bei zwölf Megapunkten auf
     * 320 sind das Sekundenbruchteile statt Sekunden – und das Ergebnis ist
     * für ein Miniaturbild nicht zu unterscheiden.
     *
     * Beide erhalten das Seitenverhältnis: `kante` ist die LÄNGERE Kante,
     * nicht ein Ziel, in das hineingequetscht wird.
     */
    /*
     * Und nur, wenn es wirklich KLEINER wird.
     *
     * `thumbnail` rechnet auch nach oben – nachgemessen: Ein Sticker von 96
     * Punkten kam als 320 heraus. Das ist die schlechteste Kombination, die es
     * gibt: mehr Bytes und weniger zu sehen, weil dazwischen interpoliert
     * wurde.
     */
    let klein = if bild.width() <= kante && bild.height() <= kante {
        bild
    } else {
        bild.thumbnail(kante, kante)
    };

    let mut raus = Vec::new();
    /*
     * JPEG mit Güte 82 und nicht WebP.
     *
     * WebP wäre bei gleicher Güte rund ein Drittel kleiner – der reine
     * Kodierer in `image` beherrscht aber nur die VERLUSTFREIE Fassung, und
     * die ist für ein Foto grösser als JPEG. Ein verlustbehafteter
     * WebP-Kodierer hiesse libwebp dazuzubinden, und dafür ist der Gewinn zu
     * klein.
     */
    klein
        .into_rgb8()
        .write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
            &mut raus, 82,
        ))
        .map_err(|_| AppError::internal("Das Miniaturbild liess sich nicht schreiben"))?;
    let _ = ImageFormat::Jpeg;
    Ok(raus)
}

#[cfg(test)]
mod tests {
    use super::*;

    /**
     * Ein PNG bauen, damit die Prüfung nicht an einer Datei im Verzeichnis hängt.
     *
     * `unruhig` macht ein Bild, das sich schlecht packen lässt – so wie ein
     * Foto. Ein glatter Verlauf packt auf ein Zwanzigstel, und ein Vergleich
     * „Miniatur gegen Original" wäre damit geschönt in die falsche Richtung:
     * Das Original wäre unrealistisch klein.
     */
    fn png_unruhig(breite: u32, hoehe: u32, unruhig: bool) -> Vec<u8> {
        let mut bild = image::RgbImage::new(breite, hoehe);
        for (x, y, punkt) in bild.enumerate_pixels_mut() {
            *punkt = if unruhig {
                image::Rgb([
                    ((x * 7 + y * 13) % 256) as u8,
                    ((x * 29 + y * 3) % 256) as u8,
                    ((x * 5 + y * 31) % 256) as u8,
                ])
            } else {
                image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
            };
        }
        let mut raus = Vec::new();
        image::DynamicImage::ImageRgb8(bild)
            .write_to(&mut Cursor::new(&mut raus), ImageFormat::Png)
            .expect("PNG");
        raus
    }

    fn png(breite: u32, hoehe: u32) -> Vec<u8> {
        png_unruhig(breite, hoehe, false)
    }

    #[test]
    fn die_laengere_kante_gibt_das_mass() {
        // Ein Querformat behält sein Verhältnis; die 320 gelten der LANGEN
        // Kante. Ein Miniaturbild, das quetscht, wäre schlimmer als keines.
        let quelle = png(800, 400);
        let mini = rechnen(&quelle, 320).expect("Miniatur");
        let gelesen = image::load_from_memory(&mini).expect("lesbar");
        assert_eq!(gelesen.width(), 320);
        assert_eq!(gelesen.height(), 160);
    }

    #[test]
    fn ein_hochformat_ebenso() {
        let mini = rechnen(&png(400, 800), 320).expect("Miniatur");
        let gelesen = image::load_from_memory(&mini).expect("lesbar");
        assert_eq!(gelesen.width(), 160);
        assert_eq!(gelesen.height(), 320);
    }

    #[test]
    fn ein_kleines_bild_wird_nicht_aufgeblasen() {
        // Sonst käme aus einem Sticker von 96 Punkten ein weichgezeichnetes
        // Bild von 320 – mehr Bytes und weniger zu sehen.
        let mini = rechnen(&png(96, 96), 320).expect("Miniatur");
        let gelesen = image::load_from_memory(&mini).expect("lesbar");
        assert_eq!(gelesen.width(), 96);
        assert_eq!(gelesen.height(), 96);
    }

    #[test]
    fn eine_kachel_kostet_ein_paar_kilobyte_und_kein_megabyte() {
        /*
         * Der eigentliche Zweck, und deshalb eine ABSOLUTE Schranke.
         *
         * Ein Verhältnis zum Original sagt hier wenig: Wie gross das Original
         * ist, hängt am Motiv. Was zählt, ist, was ein Ordner mit vierzig
         * Kacheln über Mobilfunk kostet. Bei 60 kB je Kachel sind das 2,4 MB
         * statt achtzig – und darum geht es.
         */
        let quelle = png_unruhig(2000, 1500, true);
        let mini = rechnen(&quelle, 320).expect("Miniatur");
        assert!(
            mini.len() < 60_000,
            "die Kachel ist zu schwer: {} Bytes",
            mini.len()
        );
        assert!(
            mini.len() * 4 < quelle.len(),
            "die Miniatur spart zu wenig: {} statt {}",
            mini.len(),
            quelle.len()
        );
    }

    #[test]
    fn unfug_wird_abgelehnt_und_stuerzt_nicht_ab() {
        assert!(rechnen(b"das ist kein Bild", 320).is_err());
        assert!(rechnen(&[], 320).is_err());
    }

    #[test]
    fn die_kante_kommt_aus_der_liste() {
        assert_eq!(kante_waehlen(1), 160);
        assert_eq!(kante_waehlen(160), 160);
        assert_eq!(kante_waehlen(161), 320);
        assert_eq!(kante_waehlen(640), 640);
        // Und darüber wird nicht aufgeblasen – die grösste Stufe gilt.
        assert_eq!(kante_waehlen(4000), 640);
    }

    #[test]
    fn nur_was_sich_wirklich_lesen_laesst() {
        for gut in ["image/jpeg", "image/png", "image/webp", "image/gif"] {
            assert!(wandelbar(gut), "{gut}");
        }
        /*
         * HEIC steht ausdrücklich NICHT darin, obwohl ein iPhone so
         * fotografiert: Dafür bräuchte es libheif (LGPL) und HEVC-Patente.
         */
        for schlecht in [
            "image/heic",
            "image/avif",
            "video/mp4",
            "application/pdf",
            "",
        ] {
            assert!(!wandelbar(schlecht), "{schlecht}");
        }
        // Ein Anhang aus dem Browser trägt oft noch einen Zusatz.
        assert!(wandelbar("image/jpeg; charset=binary"));
    }

    #[test]
    fn der_schluessel_liegt_neben_dem_original() {
        assert_eq!(
            schluessel("image/2026/09/abc/123-xy.webp", 320),
            "image/2026/09/abc/123-xy.webp.mini-320.jpg"
        );
        // Verschiedene Kanten sind verschiedene Dateien – sonst überschriebe
        // die eine die andere.
        assert_ne!(schluessel("a", 160), schluessel("a", 320));
    }
}
