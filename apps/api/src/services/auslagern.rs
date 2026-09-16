//! Welche Datei als nächste auf die kalte Ablage wandert – und welche nie.
//!
//! # Das Problem
//!
//! Der Server hat 256 GB, und die App füllt sie. Ein Video von 200 MB kostet
//! dort genauso viel Platz wie eine Textnachricht von 200 Byte eine Million
//! Mal – nur dass es DAS Video ist, das den Platz wegnimmt. Wenn die Platte
//! voll ist, nimmt die App keine Datei mehr an, und das trifft alle.
//!
//! Daneben liegt eine Storage Box: langsamer, dafür gross. Die Frage ist also
//! nicht OB ausgelagert wird, sondern WAS zuerst.
//!
//! # Was hier NICHT gewogen wird
//!
//! Textnachrichten. Sie stehen in der Datenbank, nicht im Dateispeicher, und
//! sie sind gemessen an einem einzigen Video ein Rundungsfehler. Ausgelagert
//! werden ausschliesslich Anhänge.
//!
//! # Die drei Klassen, und warum Klassen statt einer Zahl
//!
//! Die Priorität ist KEIN Faktor in einer Formel, sondern eine Klasse davor:
//!
//!   * **Niedrig** – wandert sofort, ohne auf irgendeine Grenze zu warten. Wer
//!     das setzt, sagt: „Das darf langsam sein." Eine Formel, in der „niedrig"
//!     nur ein grosser Faktor wäre, hielte so eine Datei zurück, solange die
//!     Platte leer genug ist – und das ist das Gegenteil der Aussage.
//!   * **Normal** – wandert ab der ersten Grenze, in der Reihenfolge des
//!     Gewichts.
//!   * **Hoch** – wandert erst ab der zweiten Grenze, und auch dann nur, wenn
//!     nichts Normales mehr da ist. Als Faktor gerechnet käme irgendwann eine
//!     sehr grosse, sehr alte Datei mit hoher Priorität vor einer kleinen,
//!     neuen mit normaler – und dann hiesse „hoch" nichts mehr.
//!
//! Klassen sagen also etwas, das eine Formel nicht sagen kann: ein Verbot.
//!
//! # Das Gewicht innerhalb einer Klasse
//!
//! Gesucht ist nicht „die grösste Datei" und nicht „die älteste", sondern die,
//! bei der der Tausch am besten aufgeht: viel Platz gewonnen, wenig Wartezeit
//! verursacht.
//!
//!   * Gewonnener Platz ist die **Grösse**.
//!   * Verursachte Wartezeit fällt nur an, wenn jemand die Datei wirklich
//!     öffnet – und das hängt am **Alter**. Ein Foto von gestern sieht sich
//!     die halbe Gruppe an; eines von vor zwei Jahren niemand.
//!
//! Also:
//!
//! ```text
//! Gewicht = Grösse × (1 − 2^(−Alter in Tagen / 30))
//! ```
//!
//! Der hintere Teil ist die Wahrscheinlichkeit, dass die Datei NICHT mehr
//! gebraucht wird; mit dreissig Tagen Halbwertszeit. Damit gilt:
//!
//!   * ein 100-MB-Video von gestern: 100 × 0,02 = 2 → bleibt
//!   * dasselbe Video nach drei Monaten: 100 × 0,88 = 88 → geht
//!   * ein 1-MB-Foto nach drei Monaten: 0,88 → bleibt (es bringt ja nichts)
//!
//! Genau das ist gemeint, wenn beides zählen soll: „die grössten" UND „ältere
//! zuerst". Eine Summe der beiden täte es nicht – dort führte eine Zahl die
//! andere vor, je nachdem, in welchen Einheiten man misst.

use chrono::{DateTime, Utc};
use uuid::Uuid;

/// Wie wichtig eine Datei ihrem Besitzer ist.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prioritaet {
    Niedrig,
    Normal,
    Hoch,
}

impl Prioritaet {
    pub fn aus(text: &str) -> Self {
        match text {
            "niedrig" => Prioritaet::Niedrig,
            "hoch" => Prioritaet::Hoch,
            _ => Prioritaet::Normal,
        }
    }

    pub fn als_text(self) -> &'static str {
        match self {
            Prioritaet::Niedrig => "niedrig",
            Prioritaet::Normal => "normal",
            Prioritaet::Hoch => "hoch",
        }
    }
}

/// Ab wann ausgelagert wird – in Bytes.
///
/// Hundert Gigabyte von zweihundertsechsundfünfzig. Der Abstand ist Absicht:
/// Auslagern braucht Zeit (lesen, hinüberschreiben, prüfen, löschen), und wer
/// erst bei 250 anfängt, hat bei 256 noch nicht genug weggeschafft. Ausserdem
/// liegen auf derselben Platte Datenbank, Sicherungen und das System.
pub const GRENZE_NORMAL: i64 = 100 * 1024 * 1024 * 1024;

/// Ab wann auch Dateien mit hoher Priorität drankommen.
pub const GRENZE_HOCH: i64 = 120 * 1024 * 1024 * 1024;

/// Wie schnell die Wahrscheinlichkeit fällt, dass eine Datei noch gebraucht wird.
pub const HALBWERTSZEIT_TAGE: f64 = 30.0;

/// Eine Datei, wie die Auslagerung sie sieht.
#[derive(Debug, Clone)]
pub struct Kandidat {
    pub id: Uuid,
    pub groesse: i64,
    pub angelegt: DateTime<Utc>,
    pub prioritaet: Prioritaet,
}

/**
 * Das Gewicht einer Datei – je höher, desto eher wandert sie.
 *
 * `jetzt` wird hereingereicht und nicht hier geholt: Eine Funktion, die selbst
 * auf die Uhr sieht, lässt sich nicht prüfen.
 */
pub fn gewicht(kandidat: &Kandidat, jetzt: DateTime<Utc>) -> f64 {
    let tage = (jetzt - kandidat.angelegt).num_seconds().max(0) as f64 / 86_400.0;
    let noch_gebraucht = (-tage / HALBWERTSZEIT_TAGE).exp2();
    kandidat.groesse as f64 * (1.0 - noch_gebraucht)
}

/// Was bei diesem Füllstand überhaupt ausgelagert werden darf.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Erlaubt {
    /// Nur, was ausdrücklich als unwichtig markiert ist.
    NurNiedrig,
    /// Niedrig und normal.
    BisNormal,
    /// Alles, auch Wichtiges.
    Alles,
}

/**
 * Was bei diesem Füllstand drankommt.
 *
 * Unter der ersten Grenze wandert trotzdem etwas: alles, was jemand
 * ausdrücklich auf „niedrig" gestellt hat. Das ist kein Sonderfall, sondern
 * die Bedeutung dieser Einstellung – sie heisst „dieses Bild braucht auf dem
 * schnellen Speicher keinen Platz", und darauf zu warten, dass die Platte
 * volläuft, wäre eine merkwürdige Art, dem nachzukommen.
 */
pub fn erlaubt_bei(belegt: i64) -> Erlaubt {
    if belegt >= GRENZE_HOCH {
        Erlaubt::Alles
    } else if belegt >= GRENZE_NORMAL {
        Erlaubt::BisNormal
    } else {
        Erlaubt::NurNiedrig
    }
}

/**
 * Die Reihenfolge, in der ausgelagert wird.
 *
 * Erst nach Klasse (niedrig vor normal vor hoch), innerhalb der Klasse nach
 * Gewicht. Was bei diesem Füllstand nicht drankommt, steht gar nicht erst in
 * der Liste.
 *
 * Zurück kommen die Kandidaten in der Reihenfolge, in der sie wandern sollen.
 */
pub fn reihenfolge(kandidaten: &[Kandidat], belegt: i64, jetzt: DateTime<Utc>) -> Vec<Kandidat> {
    let erlaubt = erlaubt_bei(belegt);
    let klasse = |p: Prioritaet| match p {
        Prioritaet::Niedrig => 0u8,
        Prioritaet::Normal => 1,
        Prioritaet::Hoch => 2,
    };
    let darf = |p: Prioritaet| match (erlaubt, p) {
        (_, Prioritaet::Niedrig) => true,
        (Erlaubt::NurNiedrig, _) => false,
        (Erlaubt::BisNormal, Prioritaet::Normal) => true,
        (Erlaubt::BisNormal, Prioritaet::Hoch) => false,
        (Erlaubt::Alles, _) => true,
    };

    let mut liste: Vec<Kandidat> = kandidaten
        .iter()
        .filter(|k| darf(k.prioritaet) && k.groesse > 0)
        .cloned()
        .collect();
    liste.sort_by(|a, b| {
        klasse(a.prioritaet)
            .cmp(&klasse(b.prioritaet))
            .then_with(|| {
                gewicht(b, jetzt)
                    .partial_cmp(&gewicht(a, jetzt))
                    .unwrap_or(std::cmp::Ordering::Equal)
                    // Bei gleichem Gewicht die ältere zuerst – damit die
                    // Reihenfolge überhaupt eine ist und nicht von der
                    // Datenbankabfrage abhängt.
                    .then_with(|| a.angelegt.cmp(&b.angelegt))
                    .then_with(|| a.id.cmp(&b.id))
            })
    });
    liste
}

/**
 * So viele Kandidaten, wie nötig sind, um wieder unter das Ziel zu kommen.
 *
 * `ziel` liegt bewusst UNTER der Grenze: Wer genau bis zur Grenze auslagert,
 * ist beim nächsten Upload wieder darüber und der Dienst läuft dauernd. Ein
 * Abstand von ein paar Gigabyte heisst, dass er selten läuft und dann etwas
 * ausrichtet.
 */
pub fn auswahl(
    kandidaten: &[Kandidat],
    belegt: i64,
    ziel: i64,
    jetzt: DateTime<Utc>,
) -> Vec<Kandidat> {
    let geordnet = reihenfolge(kandidaten, belegt, jetzt);
    let mut raus = Vec::new();
    let mut rest = belegt;
    for kandidat in geordnet {
        /*
         * „Niedrig" wandert immer, auch wenn das Ziel längst erreicht ist –
         * siehe `erlaubt_bei`. Alles andere hört auf, sobald genug Platz da
         * ist.
         */
        if rest <= ziel && kandidat.prioritaet != Prioritaet::Niedrig {
            break;
        }
        rest -= kandidat.groesse;
        raus.push(kandidat);
    }
    raus
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn jetzt() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-09-16T00:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    fn datei(groesse_mb: i64, alter_tage: i64, p: Prioritaet) -> Kandidat {
        Kandidat {
            id: Uuid::from_u128((groesse_mb as u128) << 64 | (alter_tage as u128) << 8 | p as u128),
            groesse: groesse_mb * 1024 * 1024,
            angelegt: jetzt() - Duration::days(alter_tage),
            prioritaet: p,
        }
    }

    #[test]
    fn ein_frisches_video_bleibt_liegen_ein_altes_nicht() {
        /*
         * Der Kern der Gewichtung. Beide Dateien sind gleich gross; nur das
         * Alter unterscheidet sie – und ein Foto von gestern sieht sich die
         * halbe Gruppe an, eines von vor drei Monaten niemand.
         */
        let frisch = datei(100, 1, Prioritaet::Normal);
        let alt = datei(100, 90, Prioritaet::Normal);
        assert!(
            gewicht(&alt, jetzt()) > gewicht(&frisch, jetzt()) * 10.0,
            "alt {} gegen frisch {}",
            gewicht(&alt, jetzt()),
            gewicht(&frisch, jetzt())
        );
    }

    #[test]
    fn ein_grosses_altes_video_geht_vor_einem_kleinen_alten_foto() {
        // Beide gleich alt: Dann entscheidet, was mehr Platz bringt.
        let video = datei(100, 90, Prioritaet::Normal);
        let foto = datei(2, 90, Prioritaet::Normal);
        assert!(gewicht(&video, jetzt()) > gewicht(&foto, jetzt()));
    }

    #[test]
    fn ein_grosses_frisches_video_geht_nicht_vor_einem_kleinen_alten_foto_wenn_es_neu_genug_ist() {
        /*
         * Die Probe darauf, dass die Grösse das Alter nicht einfach überfährt.
         * Ein Video von 100 MB von HEUTE bringt zwar viel Platz, wird aber
         * gerade angesehen; ein Foto von 2 MB von vor einem Jahr nicht.
         *
         * Gemessen: Das Video von einem Zehntel Tag wiegt 100 · (1 − 2^(−1/300))
         * ≈ 0,23 MB, das Foto 2 · (1 − 2^(−365/30)) ≈ 2,0 MB.
         */
        let video_heute = datei(100, 0, Prioritaet::Normal);
        let foto_alt = datei(2, 365, Prioritaet::Normal);
        assert!(
            gewicht(&foto_alt, jetzt()) > gewicht(&video_heute, jetzt()),
            "ein Video von heute wurde vor ein Foto von vor einem Jahr gestellt",
        );
    }

    #[test]
    fn niedrig_wandert_sofort_auch_bei_leerer_platte() {
        /*
         * Die Einstellung heisst „dieses Bild braucht auf dem schnellen
         * Speicher keinen Platz". Darauf zu warten, dass die Platte volläuft,
         * wäre eine merkwürdige Art, dem nachzukommen.
         */
        let liste = vec![
            datei(50, 200, Prioritaet::Normal),
            datei(1, 1, Prioritaet::Niedrig),
        ];
        let gewaehlt = auswahl(&liste, 5 * 1024 * 1024 * 1024, GRENZE_NORMAL, jetzt());
        assert_eq!(gewaehlt.len(), 1, "es sollte genau die niedrige wandern");
        assert_eq!(gewaehlt[0].prioritaet, Prioritaet::Niedrig);
    }

    #[test]
    fn hoch_bleibt_bis_zur_zweiten_grenze_liegen() {
        let liste = vec![
            datei(500, 300, Prioritaet::Hoch),
            datei(10, 300, Prioritaet::Normal),
        ];
        // Über der ersten Grenze: nur die normale, obwohl die hohe viel
        // schwerer wiegt.
        let bei_110 = reihenfolge(&liste, 110 * 1024 * 1024 * 1024, jetzt());
        assert_eq!(bei_110.len(), 1);
        assert_eq!(bei_110[0].prioritaet, Prioritaet::Normal);

        // Über der zweiten Grenze kommt sie dazu – aber HINTER der normalen,
        // egal wie schwer sie wiegt. Das ist der Unterschied zwischen einer
        // Klasse und einem Faktor.
        let bei_130 = reihenfolge(&liste, 130 * 1024 * 1024 * 1024, jetzt());
        assert_eq!(bei_130.len(), 2);
        assert_eq!(bei_130[0].prioritaet, Prioritaet::Normal);
        assert_eq!(bei_130[1].prioritaet, Prioritaet::Hoch);
    }

    #[test]
    fn niedrig_steht_immer_ganz_vorn() {
        let liste = vec![
            datei(1000, 900, Prioritaet::Normal),
            datei(1, 1, Prioritaet::Niedrig),
        ];
        let geordnet = reihenfolge(&liste, GRENZE_HOCH, jetzt());
        assert_eq!(
            geordnet[0].prioritaet,
            Prioritaet::Niedrig,
            "eine sehr schwere normale Datei hat sich vorgedrängt",
        );
    }

    #[test]
    fn es_wird_nur_so_viel_ausgelagert_wie_noetig() {
        /*
         * Sonst wanderte bei jedem Durchgang der halbe Speicher hinüber, und
         * die App wäre plötzlich überall langsam – für Platz, den niemand
         * braucht.
         */
        let liste: Vec<Kandidat> = (0..20)
            .map(|i| datei(1024, 100 + i, Prioritaet::Normal))
            .collect();
        let belegt = GRENZE_NORMAL + 3 * 1024 * 1024 * 1024;
        let gewaehlt = auswahl(&liste, belegt, GRENZE_NORMAL, jetzt());
        // Drei Gigabyte zu viel, Dateien zu einem Gigabyte: drei Stück.
        assert_eq!(gewaehlt.len(), 3, "{} statt 3 ausgewählt", gewaehlt.len());
    }

    #[test]
    fn unter_der_grenze_wandert_nichts_ausser_niedrig() {
        let liste = vec![
            datei(1000, 900, Prioritaet::Normal),
            datei(1000, 900, Prioritaet::Hoch),
        ];
        assert!(reihenfolge(&liste, 50 * 1024 * 1024 * 1024, jetzt()).is_empty());
    }

    #[test]
    fn die_reihenfolge_ist_bei_gleichstand_trotzdem_eine() {
        /*
         * Zwei Dateien, in jeder Hinsicht gleich. Ohne den letzten Vergleich
         * hinge die Reihenfolge daran, wie die Datenbank sie gerade zurückgibt
         * – und dann wäre ein Fehler in dieser Auswahl nicht nachstellbar.
         */
        let mut a = datei(10, 100, Prioritaet::Normal);
        let mut b = datei(10, 100, Prioritaet::Normal);
        a.id = Uuid::from_u128(1);
        b.id = Uuid::from_u128(2);
        let vorwaerts = reihenfolge(&[a.clone(), b.clone()], GRENZE_HOCH, jetzt());
        let rueckwaerts = reihenfolge(&[b, a], GRENZE_HOCH, jetzt());
        assert_eq!(
            vorwaerts.iter().map(|k| k.id).collect::<Vec<_>>(),
            rueckwaerts.iter().map(|k| k.id).collect::<Vec<_>>(),
        );
    }

    #[test]
    fn leere_dateien_stehen_nicht_in_der_liste() {
        // Sie bringen nichts und kosten einen Übertragungsversuch.
        let mut leer = datei(0, 500, Prioritaet::Normal);
        leer.groesse = 0;
        assert!(reihenfolge(&[leer], GRENZE_HOCH, jetzt()).is_empty());
    }

    #[test]
    fn die_grenzen_stehen_da_wo_sie_stehen_sollen() {
        assert_eq!(erlaubt_bei(0), Erlaubt::NurNiedrig);
        assert_eq!(erlaubt_bei(GRENZE_NORMAL - 1), Erlaubt::NurNiedrig);
        assert_eq!(erlaubt_bei(GRENZE_NORMAL), Erlaubt::BisNormal);
        assert_eq!(erlaubt_bei(GRENZE_HOCH - 1), Erlaubt::BisNormal);
        assert_eq!(erlaubt_bei(GRENZE_HOCH), Erlaubt::Alles);
        // Und die Zahlen selbst, damit sie nicht unbemerkt wandern.
        assert_eq!(GRENZE_NORMAL, 107_374_182_400);
        assert_eq!(GRENZE_HOCH, 128_849_018_880);
    }

    #[test]
    fn eine_datei_aus_der_zukunft_bringt_nichts_durcheinander() {
        // Uhren gehen falsch. Ein negatives Alter darf kein negatives Gewicht
        // ergeben – sonst stünde so eine Datei hinter allem anderen und die
        // Sortierung wäre an dieser Stelle zufällig.
        let zukunft = Kandidat {
            id: Uuid::from_u128(7),
            groesse: 1024,
            angelegt: jetzt() + Duration::days(5),
            prioritaet: Prioritaet::Normal,
        };
        assert_eq!(gewicht(&zukunft, jetzt()), 0.0);
    }

    #[test]
    fn die_texte_gehen_hin_und_zurueck() {
        for p in [Prioritaet::Niedrig, Prioritaet::Normal, Prioritaet::Hoch] {
            assert_eq!(Prioritaet::aus(p.als_text()), p);
        }
        // Unbekanntes fällt auf „normal" – eine Datei ohne gültige Angabe soll
        // weder sofort wandern noch für immer liegen bleiben.
        assert_eq!(Prioritaet::aus("unfug"), Prioritaet::Normal);
        assert_eq!(Prioritaet::aus(""), Prioritaet::Normal);
    }
}
