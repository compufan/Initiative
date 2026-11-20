//! Die reinen Regeln der zweiten Welle Nachrichtenfunktionen – ohne Datenbank,
//! damit sie sich ohne Server prüfen lassen: Zeitfenster für Bearbeiten und
//! „Für alle löschen“, die Form von Erwähnungen, Standort, Kontaktkarte und
//! Link-Vorschau, die Stufen selbstlöschender Nachrichten.
//!
//! Was eine Datenbank braucht (ist die Person Mitglied, Admin, Kontakt; gehört
//! der Anhang dem Absender), prüft `modules::messages` danach. Hier fällt nur,
//! was schon an der Form scheitert.

use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use crate::constants::{
    BEARBEITEN_FENSTER_MIN, ERWAEHNUNGEN_MAX, LOESCHEN_FENSTER_STD, SELBSTLOESCHEN_STUFEN,
};

/// Darf eine Nachricht, geschrieben um `geschrieben`, jetzt noch bearbeitet werden?
pub fn bearbeiten_erlaubt(geschrieben: DateTime<Utc>, jetzt: DateTime<Utc>) -> bool {
    jetzt - geschrieben <= Duration::minutes(BEARBEITEN_FENSTER_MIN)
}

/// Darf eine Nachricht jetzt noch für alle gelöscht werden?
///
/// `moderiert`: Ein Admin einer Gruppe löscht als Aufsicht – ohne Frist. Eine
/// Beleidigung von vor drei Tagen muss sich entfernen lassen, auch wenn ihr
/// Absender es nicht mehr kann.
pub fn fuer_alle_loeschen_erlaubt(
    geschrieben: DateTime<Utc>,
    jetzt: DateTime<Utc>,
    moderiert: bool,
) -> bool {
    moderiert || jetzt - geschrieben <= Duration::hours(LOESCHEN_FENSTER_STD)
}

/// Ist das eine der festen Stufen selbstlöschender Nachrichten?
pub fn selbstloeschen_stufe_gueltig(sekunden: i32) -> bool {
    SELBSTLOESCHEN_STUFEN.contains(&sekunden)
}

/// Die erwähnten Personen aus `metadata.mentions` – ohne Doppelte, in der
/// Reihenfolge des Textes. Fehler, wenn die Form nicht stimmt oder es zu
/// viele sind.
pub fn erwaehnungen_lesen(metadata: &Value) -> Result<Vec<Uuid>, &'static str> {
    let Some(wert) = metadata.get("mentions") else {
        return Ok(Vec::new());
    };
    let Some(liste) = wert.as_array() else {
        return Err("Erwähnungen müssen eine Liste sein");
    };
    if liste.len() > ERWAEHNUNGEN_MAX {
        return Err("Zu viele Erwähnungen");
    }
    let mut ids: Vec<Uuid> = Vec::with_capacity(liste.len());
    for eintrag in liste {
        let id = eintrag
            .as_str()
            .and_then(|text| Uuid::parse_str(text).ok())
            .ok_or("Ungültige Erwähnung")?;
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    Ok(ids)
}

/// Grenzen eines geteilten Standorts.
pub const ADRESSE_MAX: usize = 300;
/// Die erlaubten Dauern einer Live-Freigabe in Minuten.
pub const LIVE_MINUTEN: &[i64] = &[15, 60];

/// Breite/Länge, Genauigkeit in Metern – geprüfte Zahlen.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Punkt {
    pub breite: f64,
    pub laenge: f64,
    pub genauigkeit: Option<f64>,
}

/// Liest einen Punkt aus `{ lat, lon, genauigkeit? }`.
pub fn punkt_lesen(wert: &Value) -> Result<Punkt, &'static str> {
    let zahl = |name: &str| wert.get(name).and_then(Value::as_f64);
    let (Some(breite), Some(laenge)) = (zahl("lat"), zahl("lon")) else {
        return Err("Standort braucht Breite und Länge");
    };
    if !(-90.0..=90.0).contains(&breite) || !(-180.0..=180.0).contains(&laenge) {
        return Err("Standort liegt ausserhalb der Erde");
    }
    let genauigkeit = match wert.get("genauigkeit") {
        None | Some(Value::Null) => None,
        Some(g) => match g.as_f64() {
            Some(m) if (0.0..=100_000.0).contains(&m) => Some(m),
            _ => return Err("Ungültige Genauigkeit"),
        },
    };
    Ok(Punkt {
        breite,
        laenge,
        genauigkeit,
    })
}

/// Prüft `metadata.standort` beim Senden und bringt es in die gespeicherte
/// Form: Bei „live“ wird aus der gewünschten Dauer (`live.minuten`) ein fester
/// Endzeitpunkt (`live.bis`) – den setzt der Server, nicht der Client, damit
/// niemand eine Freigabe „bis 2099“ in einen Chat legt.
pub fn standort_annehmen(wert: &Value, jetzt: DateTime<Utc>) -> Result<Value, &'static str> {
    let Some(felder) = wert.as_object() else {
        return Err("Standort muss ein Objekt sein");
    };
    for schluessel in felder.keys() {
        if !["lat", "lon", "genauigkeit", "adresse", "live"].contains(&schluessel.as_str()) {
            return Err("Unbekannte Angabe im Standort");
        }
    }
    let punkt = punkt_lesen(wert)?;
    let mut aus = Map::new();
    aus.insert("lat".into(), json!(punkt.breite));
    aus.insert("lon".into(), json!(punkt.laenge));
    if let Some(g) = punkt.genauigkeit {
        aus.insert("genauigkeit".into(), json!(g));
    }
    match felder.get("adresse") {
        None | Some(Value::Null) => {}
        Some(Value::String(adresse)) => {
            let adresse = adresse.trim();
            if adresse.chars().count() > ADRESSE_MAX {
                return Err("Adresse ist zu lang");
            }
            if !adresse.is_empty() {
                aus.insert("adresse".into(), json!(adresse));
            }
        }
        Some(_) => return Err("Adresse muss Text sein"),
    }
    match felder.get("live") {
        None | Some(Value::Null) => {}
        Some(live) => {
            let minuten = live
                .get("minuten")
                .and_then(Value::as_i64)
                .filter(|m| LIVE_MINUTEN.contains(m))
                .ok_or("Live-Standort geht 15 oder 60 Minuten")?;
            aus.insert(
                "live".into(),
                json!({
                    "minuten": minuten,
                    "bis": jetzt + Duration::minutes(minuten),
                    "aktualisiert": jetzt,
                }),
            );
        }
    }
    Ok(Value::Object(aus))
}

/// Läuft eine Live-Freigabe noch?
pub fn live_laeuft(standort: &Value, jetzt: DateTime<Utc>) -> bool {
    standort
        .get("live")
        .and_then(|live| live.get("bis"))
        .and_then(Value::as_str)
        .and_then(|bis| DateTime::parse_from_rfc3339(bis).ok())
        .is_some_and(|bis| bis.with_timezone(&Utc) > jetzt)
        && standort
            .get("live")
            .and_then(|live| live.get("beendet"))
            .is_none()
}

/// Grenzen einer Link-Vorschau. Sie steht in `metadata` und damit in jeder
/// Chatliste; mehr als eine Zeile Titel und zwei Zeilen Text braucht keine.
pub const VORSCHAU_TITEL_MAX: usize = 200;
pub const VORSCHAU_TEXT_MAX: usize = 300;
pub const VORSCHAU_SEITE_MAX: usize = 100;
pub const VORSCHAU_URL_MAX: usize = 2048;

/// Prüft `metadata.linkVorschau` beim Senden.
///
/// Die Adresse muss im Text stehen: Eine Vorschau für einen anderen Link als
/// den, den man sieht, wäre eine Täuschung („Bank“ in der Karte, Betrüger im
/// Link). Ein Bild gibt es nur als Kennung eines eigenen Anhangs (den der
/// Server beim Abruf abgelegt hat) – nie als fremde Adresse, sonst lüde jeder
/// Empfänger beim Öffnen des Chats von einem fremden Server, und der erführe,
/// wer wann mitliest.
pub fn link_vorschau_pruefen(
    wert: &Value,
    body: Option<&str>,
) -> Result<Option<Uuid>, &'static str> {
    let Some(felder) = wert.as_object() else {
        return Err("Link-Vorschau muss ein Objekt sein");
    };
    for schluessel in felder.keys() {
        if !["url", "titel", "beschreibung", "seite", "bildId"].contains(&schluessel.as_str()) {
            return Err("Unbekannte Angabe in der Link-Vorschau");
        }
    }
    let url = felder
        .get("url")
        .and_then(Value::as_str)
        .ok_or("Link-Vorschau braucht eine Adresse")?;
    if url.len() > VORSCHAU_URL_MAX || !(url.starts_with("https://") || url.starts_with("http://"))
    {
        return Err("Ungültige Adresse in der Link-Vorschau");
    }
    if !body.is_some_and(|text| text.contains(url)) {
        return Err("Die Link-Vorschau gehört zu einem Link im Text");
    }
    let text_ok = |name: &str, max: usize| match felder.get(name) {
        None | Some(Value::Null) => true,
        Some(Value::String(t)) => t.chars().count() <= max,
        Some(_) => false,
    };
    if !text_ok("titel", VORSCHAU_TITEL_MAX)
        || !text_ok("beschreibung", VORSCHAU_TEXT_MAX)
        || !text_ok("seite", VORSCHAU_SEITE_MAX)
    {
        return Err("Link-Vorschau ist zu lang");
    }
    match felder.get("bildId") {
        None | Some(Value::Null) => Ok(None),
        Some(id) => id
            .as_str()
            .and_then(|t| Uuid::parse_str(t).ok())
            .map(Some)
            .ok_or("Ungültiges Vorschaubild"),
    }
}

/// Die Kennung aus `metadata.kontakt` (`{ userId }`).
pub fn kontakt_lesen(wert: &Value) -> Result<Uuid, &'static str> {
    let passt = wert.as_object().is_some_and(|f| f.len() == 1);
    wert.get("userId")
        .and_then(Value::as_str)
        .and_then(|t| Uuid::parse_str(t).ok())
        .filter(|_| passt)
        .ok_or("Ungültige Kontaktkarte")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn um(minuten: i64) -> DateTime<Utc> {
        DateTime::<Utc>::UNIX_EPOCH + Duration::minutes(minuten)
    }

    #[test]
    fn bearbeiten_geht_fuenfzehn_minuten() {
        assert!(bearbeiten_erlaubt(um(0), um(0)));
        assert!(bearbeiten_erlaubt(um(0), um(15)));
        assert!(!bearbeiten_erlaubt(um(0), um(16)));
    }

    #[test]
    fn loeschen_fuer_alle_achtundvierzig_stunden_ausser_moderation() {
        assert!(fuer_alle_loeschen_erlaubt(um(0), um(48 * 60), false));
        assert!(!fuer_alle_loeschen_erlaubt(um(0), um(48 * 60 + 1), false));
        assert!(fuer_alle_loeschen_erlaubt(um(0), um(480 * 60), true));
    }

    #[test]
    fn nur_feste_stufen() {
        assert!(selbstloeschen_stufe_gueltig(86_400));
        assert!(selbstloeschen_stufe_gueltig(7_776_000));
        assert!(!selbstloeschen_stufe_gueltig(3));
        assert!(!selbstloeschen_stufe_gueltig(0));
    }

    #[test]
    fn erwaehnungen_ohne_doppelte_und_begrenzt() {
        let a = Uuid::from_u128(1).to_string();
        let b = Uuid::from_u128(2).to_string();
        let ids = erwaehnungen_lesen(&json!({ "mentions": [a, b, a] })).unwrap();
        assert_eq!(ids, vec![Uuid::from_u128(1), Uuid::from_u128(2)]);
        assert!(erwaehnungen_lesen(&json!({})).unwrap().is_empty());
        assert!(erwaehnungen_lesen(&json!({ "mentions": "x" })).is_err());
        assert!(erwaehnungen_lesen(&json!({ "mentions": ["kein"] })).is_err());
        let viele: Vec<String> = (0..51).map(|i| Uuid::from_u128(i).to_string()).collect();
        assert!(erwaehnungen_lesen(&json!({ "mentions": viele })).is_err());
    }

    #[test]
    fn standort_wird_geprueft_und_live_bekommt_ein_festes_ende() {
        let jetzt = um(100);
        let s = standort_annehmen(
            &json!({ "lat": 52.5, "lon": 13.4, "genauigkeit": 12.0, "adresse": " Berlin " }),
            jetzt,
        )
        .unwrap();
        assert_eq!(s["adresse"], json!("Berlin"));
        assert!(s.get("live").is_none());
        let live = standort_annehmen(
            &json!({ "lat": 1.0, "lon": 2.0, "live": { "minuten": 15 } }),
            jetzt,
        )
        .unwrap();
        assert_eq!(live["live"]["bis"], json!(um(115)));
        assert!(live_laeuft(&live, um(114)));
        assert!(!live_laeuft(&live, um(115)));
        assert!(standort_annehmen(&json!({ "lat": 91.0, "lon": 0.0 }), jetzt).is_err());
        assert!(standort_annehmen(
            &json!({ "lat": 1.0, "lon": 2.0, "live": { "minuten": 600 } }),
            jetzt
        )
        .is_err());
        assert!(
            standort_annehmen(&json!({ "lat": 1.0, "lon": 2.0, "bis": "2099" }), jetzt).is_err()
        );
    }

    #[test]
    fn link_vorschau_nur_fuer_links_im_text_und_ohne_fremde_bilder() {
        let gut = json!({ "url": "https://example.org/a", "titel": "A" });
        assert_eq!(
            link_vorschau_pruefen(&gut, Some("siehe https://example.org/a")),
            Ok(None)
        );
        assert!(link_vorschau_pruefen(&gut, Some("anderer Text")).is_err());
        let fremdes_bild = json!({ "url": "https://example.org/a", "bild": "https://evil/x.png" });
        assert!(link_vorschau_pruefen(&fremdes_bild, Some("https://example.org/a")).is_err());
        let js = json!({ "url": "javascript:alert(1)" });
        assert!(link_vorschau_pruefen(&js, Some("javascript:alert(1)")).is_err());
        let mit_bild = json!({ "url": "https://example.org/a", "bildId": Uuid::from_u128(5) });
        assert_eq!(
            link_vorschau_pruefen(&mit_bild, Some("https://example.org/a")),
            Ok(Some(Uuid::from_u128(5)))
        );
    }

    #[test]
    fn kontaktkarte_nur_mit_kennung() {
        let id = Uuid::from_u128(9);
        assert_eq!(kontakt_lesen(&json!({ "userId": id })), Ok(id));
        assert!(kontakt_lesen(&json!({ "userId": id, "name": "x" })).is_err());
        assert!(kontakt_lesen(&json!({})).is_err());
    }
}
