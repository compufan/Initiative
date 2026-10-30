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
    erlaubt_bei_mit(belegt, GRENZE_NORMAL, GRENZE_HOCH)
}

/// Dasselbe mit eigenen Grenzen – 256 GB sind kein Naturgesetz, und wer eine
/// grössere Platte hat, will die Schwelle woanders.
pub fn erlaubt_bei_mit(belegt: i64, grenze: i64, grenze_hoch: i64) -> Erlaubt {
    if belegt >= grenze_hoch {
        Erlaubt::Alles
    } else if belegt >= grenze {
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
    reihenfolge_mit(kandidaten, belegt, jetzt, GRENZE_NORMAL, GRENZE_HOCH)
}

/// Dasselbe mit eigenen Grenzen.
pub fn reihenfolge_mit(
    kandidaten: &[Kandidat],
    belegt: i64,
    jetzt: DateTime<Utc>,
    grenze: i64,
    grenze_hoch: i64,
) -> Vec<Kandidat> {
    let erlaubt = erlaubt_bei_mit(belegt, grenze, grenze_hoch);
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
    auswahl_mit(kandidaten, belegt, ziel, jetzt, GRENZE_NORMAL, GRENZE_HOCH)
}

/// Dasselbe mit eigenen Grenzen.
pub fn auswahl_mit(
    kandidaten: &[Kandidat],
    belegt: i64,
    ziel: i64,
    jetzt: DateTime<Utc>,
    grenze: i64,
    grenze_hoch: i64,
) -> Vec<Kandidat> {
    let geordnet = reihenfolge_mit(kandidaten, belegt, jetzt, grenze, grenze_hoch);
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

/* ==========================================================================
 * Der Dienst, der die Dateien wirklich bewegt.
 * ========================================================================== */

use futures_util::StreamExt;
use sqlx::PgPool;
use std::sync::Arc;

use crate::config::Config;
use crate::storage::Storage;

/**
 * Wie viel unter der Grenze aufgehört wird.
 *
 * Wer genau bis zur Grenze auslagert, ist beim nächsten Upload wieder darüber,
 * und der Dienst läuft dauernd. Fünf Gigabyte Abstand heissen: Er läuft selten
 * und richtet dann etwas aus.
 */
const ABSTAND: i64 = 5 * 1024 * 1024 * 1024;

/// Wie viele Dateien ein Durchgang höchstens bewegt.
///
/// Nicht, weil mehr nicht ginge, sondern weil ein Durchgang ein Ende haben
/// soll: Jede Datei belegt während des Umzugs ihre Grösse im Arbeitsspeicher,
/// und ein Dienst, der eine Stunde lang läuft, lässt sich nicht beenden.
const STAPEL: usize = 20;

/// Wie oft nachgesehen wird, ob etwas zu tun ist.
const TAKT_S: u64 = 900;

/// Was ein Durchgang ausgerichtet hat.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Bilanz {
    pub bewegt: usize,
    pub bytes: i64,
    pub gescheitert: usize,
    /// Der Durchgang wurde abgebrochen, weil die kalte Ablage nicht antwortet.
    pub kalt_gestoert: bool,
}

/// Wie viel app-eigene Daten gerade auf dem Server liegen.
///
/// Gezählt werden ausschliesslich Anhänge, und nur die, die wirklich lokal
/// liegen. Das ist die Zahl, die der Anwender meint, wenn er „Daten im
/// Zusammenhang mit der App" sagt: Nachrichten sind Text in einer Datenbank
/// und gegen ein einziges Video ein Rundungsfehler.
///
/// `quelle_id is null` zählt nur Originale. Eine in einen Chat weitergegebene
/// Datei ist eine zweite Zeile auf denselben Bytes (Migration 0020) – sie
/// mitzuzählen hiesse, ein dreimal geteiltes Video für vier Videos zu halten
/// und Platz freizuräumen, den es gar nicht gibt.
pub async fn belegt(pool: &PgPool) -> i64 {
    /*
     * Das `::bigint` ist kein Schmuck.
     *
     * `sum()` über eine `bigint`-Spalte gibt in Postgres `numeric` zurück,
     * nicht `bigint` – damit eine Summe über viele grosse Zahlen nicht
     * überläuft. Wer das Ergebnis als `i64` abholt, bekommt keinen falschen
     * Wert, sondern einen Dekodierfehler.
     *
     * Und genau das war hier der Fehler, den ein Test gefunden hat: Der
     * Fehler wurde mit `.ok()` verschluckt, die Funktion meldete pflichtschuldig
     * null belegte Bytes – und ein Server, der laut Auskunft leer ist, lagert
     * nie etwas aus. Die ganze Schwelle wäre tot gewesen, ohne eine einzige
     * Fehlermeldung. Nur Dateien auf „niedrig" wären gewandert, weil die an
     * der Schwelle vorbeigehen.
     *
     * Deshalb steht hier jetzt eine Umwandlung in der Abfrage UND ein
     * Protokolleintrag statt eines stillen Rückfalls. Null Bytes belegt ist
     * eine Aussage, die man sich verdienen muss.
     */
    match sqlx::query_scalar::<_, i64>(
        "select coalesce(sum(size), 0)::bigint from attachments
          where ablage = 'lokal' and status = 'ready' and quelle_id is null",
    )
    .fetch_one(pool)
    .await
    {
        Ok(summe) => summe,
        Err(fehler) => {
            tracing::error!(%fehler, "Füllstand nicht lesbar – es wird nichts ausgelagert");
            0
        }
    }
}

/// Die Kandidaten, die bei diesem Füllstand überhaupt in Frage kommen.
async fn kandidaten(pool: &PgPool, erlaubt: Erlaubt) -> Vec<Kandidat> {
    let prioritaeten: &[&str] = match erlaubt {
        Erlaubt::NurNiedrig => &["niedrig"],
        Erlaubt::BisNormal => &["niedrig", "normal"],
        Erlaubt::Alles => &["niedrig", "normal", "hoch"],
    };
    /*
     * Nur Anhänge, und nur fertige. Ein Upload, der noch läuft, darf nicht
     * unter den Händen weggezogen werden.
     *
     * Die Obergrenze ist grosszügig: Gewogen wird hinterher in Rust, und wer
     * nur die hundert grössten holte, übersähe die tausend alten kleinen, die
     * zusammen mehr ausmachen.
     */
    sqlx::query_as::<_, (uuid::Uuid, i64, chrono::DateTime<Utc>, String)>(
        "select id, size, created_at, prioritaet
           from attachments
          where ablage = 'lokal' and status = 'ready' and size > 0
            and quelle_id is null
            and prioritaet = any($1)
          order by created_at asc
          limit 5000",
    )
    .bind(prioritaeten)
    .fetch_all(pool)
    .await
    .unwrap_or_default()
    .into_iter()
    .map(|(id, groesse, angelegt, prioritaet)| Kandidat {
        id,
        groesse,
        angelegt,
        prioritaet: Prioritaet::aus(&prioritaet),
    })
    .collect()
}

/**
 * Ein Umzug, der nicht zustande kam.
 *
 * `kalt` unterscheidet „die Box macht Ärger" (Verbindung, Zeitüberschreitung,
 * voll, falsche Grösse drüben) von „diese eine Datei ist das Problem" (liegt
 * lokal gar nicht da). Nur das Erste soll den Durchgang abbrechen und den
 * Dienst eine Weile ruhen lassen: Zwanzig Dateien nacheinander gegen eine
 * Box laufen zu lassen, die nicht antwortet, hiesse zwanzigmal die Frist
 * abzuwarten – bei dreissig Sekunden zehn Minuten Nichtstun.
 */
struct Fehlschlag {
    text: String,
    kalt: bool,
}

impl Fehlschlag {
    fn lokal(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            kalt: false,
        }
    }
    fn kalt(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            kalt: true,
        }
    }
}

/// Ob die kalte Ablage nach dem letzten Durchgang als erreichbar gilt.
/// Beginnt als `true` – wer nichts weiss, nimmt das Beste an.
static KALT_GEHT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

/// Weckruf an den Dienst: Platz wird gebraucht, nicht erst in einer Viertelstunde.
static WECKEN: tokio::sync::Notify = tokio::sync::Notify::const_new();

/// Der Dienst soll sofort einen Durchgang machen (er rechnet den Bedarf selbst aus).
pub fn wecken() {
    WECKEN.notify_one();
}

/// Den Erreichbarkeits-Vermerk von aussen setzen (Tests, Betriebshilfe).
pub fn kalt_erreichbar_setzen(geht: bool) {
    KALT_GEHT.store(geht, std::sync::atomic::Ordering::Relaxed);
}

/// Hat die kalte Ablage zuletzt geantwortet? (`false` nach einem gescheiterten
/// Durchgang, bis ein späterer wieder durchkommt.)
pub fn kalt_erreichbar() -> bool {
    KALT_GEHT.load(std::sync::atomic::Ordering::Relaxed)
}

/// Wie viel sich im Notfall auslagern liesse: alle fertigen, warmen Originale.
/// (Dieselbe Summe wie der Füllstand – ohne Rücksicht auf die Klassen; die
/// bestimmen nur die REIHENFOLGE, nicht ob eine volle Platte Uploads abweist.)
pub async fn auslagerbar(pool: &PgPool) -> i64 {
    belegt(pool).await
}

/// Wie viel Luft über die Reserve hinaus frei sein soll, wenn Uploads laufen:
/// Platz für noch einen grossen Upload, ohne dass der erst einen Umzug abwarten muss.
const PLATZ_PUFFER: i64 = 8 * 1024 * 1024 * 1024;

/**
 * Wie viele Bytes die warme Platte JETZT zusätzlich frei haben müsste.
 *
 * Das ist die zweite, davon unabhängige Schwelle: `belegt` zählt nur fertige
 * Anhänge, aber auf derselben Platte liegen die Teildateien offener Uploads
 * (bis 4 GiB je Datei, mehrere gleichzeitig), die Datenbank und Sicherungen.
 * Bei 256 GB und 100 GB Schwelle bleiben 156 GB für all das – drei, vier
 * Gruppen mit je mehreren Videos im Aufwärtsstrom reichen, und die Platte ist
 * voll, OHNE dass `belegt` je an die Schwelle kam.
 *
 * `ziel = Reserve + noch ausstehende Upload-Bytes + Puffer`; was an freiem
 * Platz darunter liegt, ist der Bedarf. Nur bei lokaler warmer Ablage – ein
 * Objektspeicher hat dieses Problem nicht.
 */
pub async fn platzbedarf(pool: &PgPool, config: &Config) -> i64 {
    if config.storage_driver != crate::config::StorageDriver::Local {
        return 0;
    }
    let Some(frei) =
        crate::modules::stuecke::frei_auf_platte(std::path::Path::new(&config.upload_teile_dir))
    else {
        return 0;
    };
    let ausstehend = crate::modules::stuecke::ausstehende_bytes(pool).await;
    let ziel = config
        .upload_platte_reserve_bytes
        .saturating_add(ausstehend)
        .saturating_add(PLATZ_PUFFER);
    ziel.saturating_sub(frei as i64).max(0)
}

/// Mehr als das wird nicht in den Arbeitsspeicher geladen, wenn die warme
/// Ablage keinen lokalen Pfad hat (Objektspeicher). Darüber lieber eine klare
/// Absage im Protokoll als ein Prozess, den das Betriebssystem beendet.
const SPEICHER_WEG_MAX: i64 = 512 * 1024 * 1024;

/**
 * Eine Datei hinüberschaffen.
 *
 * # Die Reihenfolge ist der ganze Trick
 *
 * 1. `ablage = 'wandert'` – ab jetzt weiss jeder, dass hier etwas geschieht.
 *    Gelesen wird weiterhin die lokale Fassung; sie steht ja noch.
 * 2. Kopieren. Dauert bei einem Video Minuten.
 * 3. Nachmessen: Ist drüben wirklich alles angekommen?
 * 4. `ablage = 'fern'` – ab jetzt wird drüben gelesen.
 * 5. Erst danach die lokale Fassung löschen.
 *
 * Bricht es an irgendeiner Stelle ab, ist die Datei weiterhin erreichbar:
 * Bis Schritt 4 aus der lokalen Fassung, danach aus der fernen. Der einzige
 * Verlust ist Platz – eine Datei, die bei einem Absturz zwischen 4 und 5 an
 * beiden Orten liegt. Das ist die richtige Richtung: lieber doppelt als weg.
 *
 * # Im Strom, wo es geht
 *
 * Liegt die warme Fassung auf der Platte dieser Maschine (der Normalfall),
 * geht sie mit `Storage::put_datei` im Strom hinüber – ohne zweite lokale
 * Kopie und ohne die Datei je ganz im Arbeitsspeicher zu haben. Nur ein
 * warmer Speicher ohne lokalen Pfad (Objektspeicher als warme Ablage) nimmt
 * den Weg über den Arbeitsspeicher, und der ist auf `SPEICHER_WEG_MAX`
 * begrenzt.
 *
 * # Wird die Datei während des Umzugs gelöscht?
 *
 * Dann ist die Zeile weg, wenn der Umzug fertig wird, und die Müllliste hat
 * ihren Schlüssel schon (als `wandert`) abgearbeitet – BEVOR das Ferne
 * existierte. Ohne die Prüfung in `abschliessen` bliebe das Objekt auf der
 * Box für immer liegen.
 */
async fn umziehen(
    pool: &PgPool,
    warm: &Arc<dyn Storage>,
    kalt: &Arc<dyn Storage>,
    id: uuid::Uuid,
) -> Result<i64, Fehlschlag> {
    let db = |f: sqlx::Error| Fehlschlag::lokal(f.to_string());
    let zeile: Option<(String, i64, String)> = sqlx::query_as(
        "select storage_key, size, mime from attachments
          where id = $1 and ablage = 'lokal' and status = 'ready'",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(db)?;
    let Some((schluessel, groesse, mime)) = zeile else {
        // Zwischen Auswahl und Umzug gelöscht oder schon gewandert. Kein
        // Fehler, nur nichts zu tun.
        return Ok(0);
    };

    /*
     * Umgeschrieben wird nach SCHLÜSSEL, nicht nach Kennung.
     *
     * Seit Migration 0020 können mehrere Zeilen auf denselben Bytes liegen –
     * eine weitergegebene Datei ist dieselbe Datei. Bewegt würde sie trotzdem
     * nur einmal (`kandidaten` sieht nur Originale), aber WISSEN müssen es
     * alle: Eine Kopie, die weiter „lokal" behauptet, während die Bytes drüben
     * liegen, schickt die Weiche in die falsche Ablage.
     */
    sqlx::query(
        "update attachments set ablage = 'wandert'
          where storage_key = $1 and ablage = 'lokal'",
    )
    .bind(&schluessel)
    .execute(pool)
    .await
    .map_err(db)?;

    let zurueck = || async {
        let _ = sqlx::query(
            "update attachments set ablage = 'lokal' where storage_key = $1 and ablage = 'wandert'",
        )
        .bind(&schluessel)
        .execute(pool)
        .await;
    };

    if let Some(pfad) = warm.lokaler_pfad(&schluessel) {
        if tokio::fs::metadata(&pfad).await.is_err() {
            zurueck().await;
            return Err(Fehlschlag::lokal(format!(
                "{schluessel}: liegt gar nicht da"
            )));
        }
        if let Err(fehler) = kalt.put_datei(&schluessel, &pfad, &mime).await {
            zurueck().await;
            return Err(Fehlschlag::kalt(format!(
                "{schluessel}: Schreiben gescheitert – {fehler}"
            )));
        }
        let erwartet = tokio::fs::metadata(&pfad).await.map(|m| m.len()).ok();
        return abschliessen(pool, warm, kalt, &schluessel, erwartet, groesse, zurueck).await;
    }

    if groesse > SPEICHER_WEG_MAX {
        zurueck().await;
        return Err(Fehlschlag::lokal(format!(
            "{schluessel}: {groesse} Bytes sind zu gross für den Umzug über den Arbeitsspeicher \
             (die warme Ablage hat keinen lokalen Pfad)"
        )));
    }
    let Some(objekt) = warm
        .read(&schluessel, None)
        .await
        .map_err(|f| Fehlschlag::lokal(f.to_string()))?
    else {
        zurueck().await;
        return Err(Fehlschlag::lokal(format!(
            "{schluessel}: liegt gar nicht da"
        )));
    };
    let mut bytes = Vec::with_capacity(groesse.max(0) as usize);
    let mut strom = objekt.stream;
    while let Some(stueck) = strom.next().await {
        match stueck {
            Ok(daten) => bytes.extend_from_slice(&daten),
            Err(fehler) => {
                zurueck().await;
                return Err(Fehlschlag::lokal(format!(
                    "{schluessel}: Lesen abgebrochen – {fehler}"
                )));
            }
        }
    }
    let erwartet = Some(bytes.len() as u64);
    if let Err(fehler) = kalt
        .put(&schluessel, axum::body::Bytes::from(bytes), &mime)
        .await
    {
        zurueck().await;
        return Err(Fehlschlag::kalt(format!(
            "{schluessel}: Schreiben gescheitert – {fehler}"
        )));
    }
    abschliessen(pool, warm, kalt, &schluessel, erwartet, groesse, zurueck).await
}

/// Nachmessen, umschreiben, warm löschen – der gemeinsame Rest beider Wege.
async fn abschliessen<F, Fut>(
    pool: &PgPool,
    warm: &Arc<dyn Storage>,
    kalt: &Arc<dyn Storage>,
    schluessel: &str,
    erwartet: Option<u64>,
    groesse: i64,
    zurueck: F,
) -> Result<i64, Fehlschlag>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    /*
     * Nachmessen, bevor die lokale Fassung fällt.
     *
     * Ohne diese Prüfung genügt ein halb geschriebenes Video, und die Datei
     * ist weg – die kalte Fassung ist unvollständig, die warme gelöscht.
     * Gemessen wird, was wirklich dort liegt, und nicht, was wir glauben
     * geschrieben zu haben.
     *
     * Verglichen wird mit der Grösse der Bytes, die wirklich über die Leitung
     * gingen – bei eingeschaltetem Tresor also dem GEHEIMTEXT (Kopf und
     * Prüfsummen je Block machen ihn grösser als `attachments.size`).
     */
    let drueben = match kalt.read(schluessel, None).await {
        Ok(objekt) => objekt.and_then(|o| o.total_size),
        Err(fehler) => {
            zurueck().await;
            return Err(Fehlschlag::kalt(format!(
                "{schluessel}: Nachmessen drüben gescheitert – {fehler}"
            )));
        }
    };
    if erwartet.is_none() || drueben != erwartet {
        zurueck().await;
        return Err(Fehlschlag::kalt(format!(
            "{schluessel}: drüben liegen {drueben:?} statt {erwartet:?} Bytes"
        )));
    }
    let geschrieben = sqlx::query(
        "update attachments set ablage = 'fern', ausgelagert_at = now()
          where storage_key = $1",
    )
    .bind(schluessel)
    .execute(pool)
    .await
    .map_err(|f| Fehlschlag::lokal(f.to_string()))?
    .rows_affected();
    if geschrieben == 0 {
        /*
         * Die Zeile gibt es nicht mehr: Die Nachricht (oder das Konto) wurde
         * gelöscht, während die Datei unterwegs war. Die Müllliste hat ihren
         * Schlüssel längst bearbeitet – vor dem Ankommen drüben. Das Ferne
         * hier selbst entfernen; die lokale Fassung ebenfalls (falls die
         * Müllliste sie noch nicht erwischt hat).
         */
        tracing::info!(%schluessel, "Während des Umzugs gelöscht – ferne Fassung wird entfernt");
        let _ = kalt.delete(schluessel).await;
        let _ = warm.delete(schluessel).await;
        return Ok(0);
    }
    /*
     * Erst jetzt die lokale Fassung. Scheitert das, ist es kein Drama: Die
     * Datei ist erreichbar, sie belegt nur weiter Platz. Der nächste
     * Durchgang wählt sie nicht noch einmal (sie steht auf `fern`), also
     * bleibt dieser Rest liegen – sichtbar im Protokoll.
     */
    if let Err(fehler) = warm.delete(schluessel).await {
        tracing::warn!(%schluessel, %fehler, "Ausgelagert, aber die lokale Fassung blieb liegen");
    }
    Ok(groesse)
}

/// Wie viele Umzüge in Folge an der Box scheitern dürfen, bevor der Durchgang
/// aufgibt (und der Dienst eine Weile ruht).
const KALT_FEHLER_MAX: usize = 2;

/// Ein Durchgang.
pub async fn durchgang(
    pool: &PgPool,
    warm: &Arc<dyn Storage>,
    kalt: &Arc<dyn Storage>,
    grenze: i64,
    grenze_hoch: i64,
) -> Bilanz {
    durchgang_mit_bedarf(pool, warm, kalt, grenze, grenze_hoch, 0).await
}

/**
 * Ein Durchgang, der zusätzlich `bedarf` Bytes freimachen soll – unabhängig
 * vom Füllstand der Anhänge (siehe [`platzbedarf`]).
 *
 * Der Bedarf überstimmt die Klassen NICHT bei der Reihenfolge (niedrig vor
 * normal vor hoch, innerhalb nach Gewicht), wohl aber bei der Erlaubnis: Eine
 * physisch volle Platte nimmt keine Uploads mehr an, egal wie wichtig die
 * Dateien darauf sind.
 */
pub async fn durchgang_mit_bedarf(
    pool: &PgPool,
    warm: &Arc<dyn Storage>,
    kalt: &Arc<dyn Storage>,
    grenze: i64,
    grenze_hoch: i64,
    bedarf: i64,
) -> Bilanz {
    let belegt_jetzt = belegt(pool).await;
    let erlaubt = if bedarf > 0 {
        Erlaubt::Alles
    } else {
        erlaubt_bei_mit(belegt_jetzt, grenze, grenze_hoch)
    };
    let liste = kandidaten(pool, erlaubt).await;
    if liste.is_empty() {
        return Bilanz::default();
    }
    let ziel = (grenze - ABSTAND).max(0);
    let jetzt = Utc::now();
    let mut gewaehlt = auswahl_mit(&liste, belegt_jetzt, ziel, jetzt, grenze, grenze_hoch);
    if bedarf > 0 {
        // Der übliche Teil zählt schon mit; was darüber hinaus fehlt, kommt in
        // der Reihenfolge von „Alles" dazu.
        let schon: i64 = gewaehlt.iter().map(|k| k.groesse).sum();
        if schon < bedarf {
            let bereits: std::collections::HashSet<_> = gewaehlt.iter().map(|k| k.id).collect();
            let uebrig: Vec<Kandidat> = liste
                .iter()
                .filter(|k| !bereits.contains(&k.id))
                .cloned()
                .collect();
            let mut rest = bedarf - schon;
            for k in reihenfolge_mit(&uebrig, grenze_hoch, jetzt, grenze, grenze_hoch) {
                if rest <= 0 {
                    break;
                }
                rest -= k.groesse;
                gewaehlt.push(k);
            }
        }
    }

    let mut bilanz = Bilanz::default();
    let mut kalt_fehler_in_folge = 0usize;
    for kandidat in gewaehlt.into_iter().take(STAPEL) {
        match umziehen(pool, warm, kalt, kandidat.id).await {
            Ok(0) => {}
            Ok(bytes) => {
                bilanz.bewegt += 1;
                bilanz.bytes += bytes;
                kalt_fehler_in_folge = 0;
                KALT_GEHT.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            Err(fehler) => {
                bilanz.gescheitert += 1;
                tracing::warn!(fehler = %fehler.text, "Auslagern gescheitert");
                if fehler.kalt {
                    kalt_fehler_in_folge += 1;
                    if kalt_fehler_in_folge >= KALT_FEHLER_MAX {
                        KALT_GEHT.store(false, std::sync::atomic::Ordering::Relaxed);
                        bilanz.kalt_gestoert = true;
                        tracing::error!(
                            "Die kalte Ablage antwortet nicht – der Durchgang wird abgebrochen, \
                             nichts geht verloren (die Dateien liegen weiter warm)"
                        );
                        break;
                    }
                }
            }
        }
    }
    if bilanz.bewegt > 0 || bilanz.gescheitert > 0 {
        tracing::info!(
            bewegt = bilanz.bewegt,
            gigabyte = bilanz.bytes as f64 / 1_073_741_824.0,
            gescheitert = bilanz.gescheitert,
            "Auslagerung"
        );
    }
    bilanz
}

/// Wie lange ein liegengebliebenes Teilstück auf der Box bleiben darf, bevor
/// es als verwaist gilt: länger, als ein Umzug mit Wiederholungen dauert.
const TEILRESTE_ALTER: std::time::Duration = std::time::Duration::from_secs(3 * 24 * 3600);

/// Den Dienst starten. Gibt zurück, wie man ihn beendet.
pub fn starten(
    pool: PgPool,
    speicher: Arc<crate::storage::Speicher>,
    config: Arc<Config>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let Some(kalt) = speicher.kalt.clone() else {
            tracing::info!("Keine kalte Ablage eingerichtet – es wird nichts ausgelagert");
            return;
        };
        let grenze = config.kalt_grenze_gb * 1024 * 1024 * 1024;
        let grenze_hoch = config.kalt_grenze_hoch_gb * 1024 * 1024 * 1024;
        /*
         * Ein Augenblick Ruhe vor dem ersten Durchgang: Beim Start laufen
         * Migrationen und die ersten Anfragen, und ein Dienst, der genau dann
         * ein Video über SFTP schiebt, macht den Start langsam.
         */
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        let mut ruhe_s = 0u64;
        let mut letzte_aufraeumung =
            std::time::Instant::now() - std::time::Duration::from_secs(86_400);
        loop {
            let bedarf = platzbedarf(&pool, &config).await;
            let bilanz =
                durchgang_mit_bedarf(&pool, &speicher.warm, &kalt, grenze, grenze_hoch, bedarf)
                    .await;
            /*
             * Ruhe, wenn die Box nicht antwortet: 1, 2, 4 … bis 60 Minuten
             * statt alle fünfzehn Minuten neu gegen eine tote Gegenstelle zu
             * rennen (und dabei jedes Mal die Frist abzuwarten). Ein Weckruf
             * (Platz wird knapp) beendet die Ruhe NICHT vorzeitig – er würde
             * sonst genau das auslösen, was hier verhindert wird.
             */
            let warten = if bilanz.kalt_gestoert {
                ruhe_s = if ruhe_s == 0 {
                    60
                } else {
                    (ruhe_s * 2).min(3600)
                };
                ruhe_s
            } else {
                ruhe_s = 0;
                TAKT_S
            };
            if letzte_aufraeumung.elapsed() > std::time::Duration::from_secs(86_400)
                && !bilanz.kalt_gestoert
            {
                letzte_aufraeumung = std::time::Instant::now();
                match kalt.teilreste_raeumen(TEILRESTE_ALTER).await {
                    Ok(0) => {}
                    Ok(n) => {
                        tracing::info!(anzahl = n, "verwaiste Teilstücke auf der Box weggeräumt")
                    }
                    Err(fehler) => {
                        tracing::warn!(%fehler, "Teilstücke auf der Box nicht aufräumbar")
                    }
                }
            }
            if bilanz.kalt_gestoert {
                tokio::time::sleep(std::time::Duration::from_secs(warten)).await;
            } else {
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(warten)) => {}
                    _ = WECKEN.notified() => {}
                }
            }
        }
    })
}
