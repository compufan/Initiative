//! Ortssuche: Vorschläge für Adressen und Orte beim Tippen.
//!
//! # Warum über den eigenen Server
//!
//! Die Daten sind OpenStreetMap (ODbL, frei auch für kommerzielle Nutzung, mit
//! Namensnennung). Gesucht wird mit Photon (Apache-2.0), einer Volltextsuche,
//! die Teilwörter, Tippfehler und jede Reihenfolge der Angaben versteht. Die
//! Anfrage geht aber nie vom Gerät aus zum Suchdienst:
//!
//! - Der Suchdienst sieht nur die Adresse dieses Servers, nicht die der
//!   Mitglieder – und nicht, wer was sucht.
//! - Treffer lassen sich zwischenspeichern; wer „Willy“ tippt, belastet den
//!   Dienst für alle anderen nicht noch einmal.
//! - Die Bremse (`drossel`) und der Zwischenspeicher schützen den öffentlichen
//!   Dienst vor einem Konto, das in Schleife sucht.
//!
//! `GEO_URL` zeigt standardmässig auf den öffentlichen Photon-Dienst von
//! komoot (faire Nutzung, keine Kosten). Wer mehr Last hat, betreibt Photon
//! selbst und trägt dessen Adresse ein – Schnittstelle und Antwort bleiben
//! gleich. Leer lassen schaltet die Suche ab; die App fällt dann auf freie
//! Texteingabe zurück.
//!
//! # Die Reihenfolge der Angaben
//!
//! „Strasse Nummer, PLZ Ort“ und „PLZ Strasse Nummer“ sind dasselbe. Photon
//! gewichtet eine vorangestellte Postleitzahl schlecht, deshalb wird eine
//! fünfstellige Zahl aus der Anfrage genommen und nur zum SORTIEREN benutzt:
//! Treffer mit dieser (oder einer so beginnenden) Postleitzahl kommen zuerst.
//! Gesucht wird mit dem Rest, so dass Strasse und Nummer in beliebiger
//! Reihenfolge ankommen.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::auth::AuthUser;
use crate::drossel::regeln;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/orte/suche", get(suchen))
}

/// Wie lang eine Anfrage höchstens ist – länger ist kein Ort mehr.
const MAX_ANFRAGE: usize = 120;
/// Wie viele Vorschläge höchstens zurückgehen.
const MAX_TREFFER: usize = 8;
/// Wie viele Treffer beim Dienst geholt werden, damit das Sortieren etwas hat.
const HOLEN: usize = 20;
/// Wie lange ein Ergebnis im Zwischenspeicher bleibt.
const GUELTIG: Duration = Duration::from_secs(600);
/// Wie viele Anfragen der Zwischenspeicher hält, bevor er aufräumt.
const MAX_EINTRAEGE: usize = 500;
/// Wie lange der Dienst höchstens antworten darf, bevor die App ohne Vorschlag weitermacht.
const WARTEZEIT: Duration = Duration::from_secs(5);

#[derive(Debug, Deserialize)]
struct Anfrage {
    q: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Treffer {
    /// Was ins Feld „Ort“ kommt: eine Zeile in der Schreibweise des Landes.
    pub text: String,
    /// Die Hauptzeile des Vorschlags (Name oder Strasse mit Nummer).
    pub titel: String,
    /// Die Nebenzeile (Postleitzahl, Ort, Land).
    pub zeile: String,
    pub lat: f64,
    pub lon: f64,
    /// Ländercode in Grossbuchstaben, soweit bekannt.
    pub land: Option<String>,
}

#[derive(Debug, Serialize)]
struct Antwort {
    items: Vec<Treffer>,
    /// Die Quellenangabe, die die Oberfläche anzeigen muss (ODbL).
    quelle: &'static str,
}

const QUELLE: &str = "© OpenStreetMap-Mitwirkende";

async fn suchen(
    State(state): State<AppState>,
    user: AuthUser,
    Query(anfrage): Query<Anfrage>,
) -> AppResult<Json<Antwort>> {
    let q = anfrage.q.split_whitespace().collect::<Vec<_>>().join(" ");
    if q.chars().count() < 2 || state.config.geo_url.is_empty() {
        return Ok(Json(Antwort {
            items: Vec::new(),
            quelle: QUELLE,
        }));
    }
    if q.chars().count() > MAX_ANFRAGE {
        return Err(AppError::bad_request("Die Suche ist zu lang."));
    }
    let schluessel = suchschluessel(&q);
    if let Some(treffer) = zwischenspeicher_lesen(&schluessel) {
        return Ok(Json(Antwort {
            items: treffer,
            quelle: QUELLE,
        }));
    }
    if !state
        .drossel
        .erlaubt(&format!("orte:{}", user.id()), regeln::SUCHEN)
    {
        return Err(AppError::too_many(
            "Zu viele Suchanfragen. Warte einen Moment.",
        ));
    }

    let (rest, plz) = plz_herausloesen(&q);
    let mut suche = if rest.is_empty() { q.clone() } else { rest.clone() };
    // Eine Postleitzahl allein führt Photon nicht zur Strasse in DIESER Stadt:
    // „Willy-Brandt-Platz“ gibt es dutzendfach. Darum wird die Zahl erst zum
    // Ort aufgelöst und der Ort an die Suche gehängt.
    if let (Some(plz), false) = (plz.as_deref(), rest.is_empty()) {
        if let Some(stadt) = stadt_zur_plz(&state, plz).await {
            suche = format!("{rest} {stadt}");
        }
    }
    let roh = beim_dienst_fragen(&state, &suche).await?;
    let mut treffer = treffer_lesen(&roh);
    einordnen(&mut treffer, plz.as_deref(), &state.config.geo_bevorzugt);
    treffer.truncate(MAX_TREFFER);
    zwischenspeicher_schreiben(schluessel, treffer.clone());
    Ok(Json(Antwort {
        items: treffer,
        quelle: QUELLE,
    }))
}

async fn beim_dienst_fragen(state: &AppState, suche: &str) -> AppResult<Value> {
    let client = reqwest::Client::builder()
        .timeout(WARTEZEIT)
        .user_agent(format!("Initiative/{} (Ortssuche)", state.config.git_sha))
        .build()
        .map_err(|_| AppError::internal("Ortssuche nicht bereit"))?;
    let adresse = reqwest::Url::parse_with_params(
        &state.config.geo_url,
        &[("q", suche), ("lang", "de"), ("limit", &HOLEN.to_string())],
    )
    .map_err(|_| AppError::internal("GEO_URL ist keine Adresse"))?;
    let antwort = client
        .get(adresse)
        .send()
        .await
        .map_err(|fehler| {
            tracing::warn!(%fehler, "Ortssuche: Dienst nicht erreichbar");
            AppError::upstream("Die Ortssuche ist gerade nicht erreichbar.")
        })?;
    if !antwort.status().is_success() {
        tracing::warn!(status = %antwort.status(), "Ortssuche: Dienst lehnt ab");
        return Err(AppError::upstream(
            "Die Ortssuche ist gerade nicht erreichbar.",
        ));
    }
    antwort
        .json::<Value>()
        .await
        .map_err(|_| AppError::upstream("Die Ortssuche ist gerade nicht erreichbar."))
}

/// Der Ort zu einer Postleitzahl – aus dem Zwischenspeicher oder beim Dienst.
/// Wer nichts findet oder wen der Dienst im Stich lässt, sucht ohne Ort weiter.
async fn stadt_zur_plz(state: &AppState, plz: &str) -> Option<String> {
    let schluessel = plz_schluessel(plz);
    if let Some(treffer) = zwischenspeicher_lesen(&schluessel) {
        return treffer.into_iter().next().map(|t| t.titel);
    }
    let roh = beim_dienst_fragen(state, plz).await.ok()?;
    let stadt = stadt_aus_plz_antwort(&roh, plz, &state.config.geo_bevorzugt);
    let ablage = stadt
        .iter()
        .map(|s| Treffer {
            text: s.clone(),
            titel: s.clone(),
            zeile: String::new(),
            lat: 0.0,
            lon: 0.0,
            land: None,
        })
        .collect();
    zwischenspeicher_schreiben(schluessel, ablage);
    stadt
}

/// Aus der Antwort auf eine reine Postleitzahl den Ort lesen: der erste
/// Treffer, der diese Zahl trägt, einen Ort nennt und in einem bevorzugten
/// Land liegt (sonst irgendeiner – „12345“ gibt es in vielen Ländern).
pub fn stadt_aus_plz_antwort(roh: &Value, plz: &str, bevorzugt: &[String]) -> Option<String> {
    let merkmale = roh.get("features")?.as_array()?;
    let kandidaten: Vec<(String, String)> = merkmale
        .iter()
        .filter_map(|m| {
            let eigen = m.get("properties")?;
            // Der Eintrag für die Zahl selbst trägt sie als Namen, ein Ort in
            // dieser Zahl als `postcode`.
            let traegt = text_feld(eigen, "postcode").as_deref() == Some(plz)
                || text_feld(eigen, "name").as_deref() == Some(plz);
            if !traegt {
                return None;
            }
            let ort = text_feld(eigen, "city")
                .or_else(|| text_feld(eigen, "town"))
                .or_else(|| text_feld(eigen, "village"))
                .or_else(|| text_feld(eigen, "locality"))?;
            Some((text_feld(eigen, "countrycode").unwrap_or_default().to_uppercase(), ort))
        })
        .collect();
    kandidaten
        .iter()
        .find(|(land, _)| bevorzugt.contains(land))
        .or_else(|| kandidaten.first())
        .map(|(_, ort)| ort.clone())
}

/* ---------- Zwischenspeicher ---------- */

/// Schlüssel für eine getippte Anfrage.
///
/// Die Ortsauflösung einer Postleitzahl liegt im selben Speicher. Ohne eigenes
/// Präfix je Art wäre „plz:64283“ als Suchtext derselbe Schlüssel wie die
/// Auflösung von 64283: Wer das tippt, schriebe seine Treffer dort hinein,
/// und alle anderen bekämen daraus den „Ort“ zu dieser Postleitzahl.
fn suchschluessel(q: &str) -> String {
    format!("suche:{}", q.to_lowercase())
}

fn plz_schluessel(plz: &str) -> String {
    format!("plz:{plz}")
}

type Speicher = Mutex<HashMap<String, (Instant, Vec<Treffer>)>>;

fn speicher() -> &'static Speicher {
    static SPEICHER: OnceLock<Speicher> = OnceLock::new();
    SPEICHER.get_or_init(|| Mutex::new(HashMap::new()))
}

fn zwischenspeicher_lesen(schluessel: &str) -> Option<Vec<Treffer>> {
    let karte = speicher().lock().ok()?;
    let (zeit, treffer) = karte.get(schluessel)?;
    (zeit.elapsed() < GUELTIG).then(|| treffer.clone())
}

fn zwischenspeicher_schreiben(schluessel: String, treffer: Vec<Treffer>) {
    let Ok(mut karte) = speicher().lock() else {
        return;
    };
    if karte.len() >= MAX_EINTRAEGE {
        // Erst das Abgelaufene, und wenn das nicht reicht, alles: Ein
        // Zwischenspeicher, der wächst, ist ein Speicherleck mit Namen.
        karte.retain(|_, (zeit, _)| zeit.elapsed() < GUELTIG);
        if karte.len() >= MAX_EINTRAEGE {
            karte.clear();
        }
    }
    karte.insert(schluessel, (Instant::now(), treffer));
}

/* ---------- Anfrage und Antwort verstehen ---------- */

/// Nimmt eine alleinstehende fünfstellige Zahl aus der Anfrage und liefert
/// den Rest und die Postleitzahl.
///
/// Kürzere Zahlen bleiben drin: „A 5“ und „B 462“ sind Strassen, „1“ ist eine
/// Hausnummer. Ebenso bleibt „Hauptstr 12345“ unberührt – zwei Wörter, das
/// zweite fünfstellig, ist eher eine grosse Hausnummer als „PLZ Strasse“ ohne
/// Strasse. Und eine einzelne Zahl ist die Anfrage selbst.
pub fn plz_herausloesen(q: &str) -> (String, Option<String>) {
    let wort: Vec<&str> = q.split(' ').collect();
    let ist_plz = |w: &str| w.len() == 5 && w.bytes().all(|b| b.is_ascii_digit());
    let Some(stelle) = wort.iter().position(|w| ist_plz(w.trim_matches(','))) else {
        return (q.to_string(), None);
    };
    // Eine einzige Zahl allein („64283“) ist die Anfrage selbst.
    if wort.len() == 1 {
        return (q.to_string(), None);
    }
    // Am Ende nach genau einem Wort: eher Hausnummer.
    if stelle == wort.len() - 1 && stelle == 1 {
        return (q.to_string(), None);
    }
    let plz = wort[stelle].trim_matches(',').to_string();
    let rest: Vec<&str> = wort
        .iter()
        .enumerate()
        .filter(|(i, _)| *i != stelle)
        .map(|(_, w)| *w)
        .collect();
    (rest.join(" ").trim_matches(',').trim().to_string(), Some(plz))
}

fn text_feld(eigen: &Value, name: &str) -> Option<String> {
    eigen
        .get(name)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Liest die Merkmale der GeoJSON-Antwort und baut daraus Vorschläge.
///
/// Doppelte (gleicher Text) fallen weg: Photon liefert eine Strasse oft
/// mehrfach, einmal je OSM-Objekt.
pub fn treffer_lesen(roh: &Value) -> Vec<Treffer> {
    let mut aus: Vec<Treffer> = Vec::new();
    let Some(merkmale) = roh.get("features").and_then(Value::as_array) else {
        return aus;
    };
    for merkmal in merkmale {
        let Some(eigen) = merkmal.get("properties") else {
            continue;
        };
        let koordinate = merkmal
            .pointer("/geometry/coordinates")
            .and_then(Value::as_array);
        let (Some(lon), Some(lat)) = (
            koordinate.and_then(|k| k.first()).and_then(Value::as_f64),
            koordinate.and_then(|k| k.get(1)).and_then(Value::as_f64),
        ) else {
            continue;
        };
        if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
            continue;
        }
        let name = text_feld(eigen, "name");
        let strasse = text_feld(eigen, "street");
        let nummer = text_feld(eigen, "housenumber");
        let plz = text_feld(eigen, "postcode");
        let ort = text_feld(eigen, "city")
            .or_else(|| text_feld(eigen, "town"))
            .or_else(|| text_feld(eigen, "village"))
            .or_else(|| text_feld(eigen, "locality"))
            .or_else(|| text_feld(eigen, "district"))
            .or_else(|| text_feld(eigen, "county"));
        let land = text_feld(eigen, "country");
        let kuerzel = text_feld(eigen, "countrycode").map(|c| c.to_uppercase());

        // Hauptzeile: der Name, sonst Strasse mit Nummer. Ein Name, der selbst
        // die Strasse ist („Willy-Brandt-Platz“), wiederholt sie nicht.
        let adresse = match (&strasse, &nummer) {
            (Some(s), Some(n)) => Some(format!("{s} {n}")),
            (Some(s), None) => Some(s.clone()),
            _ => None,
        };
        let titel = match (&name, &adresse) {
            (Some(n), _) => n.clone(),
            (None, Some(a)) => a.clone(),
            (None, None) => match &ort {
                Some(o) => o.clone(),
                None => continue,
            },
        };
        let mut teile: Vec<String> = vec![titel.clone()];
        if let Some(a) = &adresse {
            if name.as_deref() != strasse.as_deref() && *a != titel {
                teile.push(a.clone());
            }
        }
        let ort_zeile = match (&plz, &ort) {
            (Some(p), Some(o)) => Some(format!("{p} {o}")),
            (None, Some(o)) => Some(o.clone()),
            (Some(p), None) => Some(p.clone()),
            (None, None) => None,
        };
        let mut zeile_teile: Vec<String> = Vec::new();
        if let Some(a) = &adresse {
            if name.is_some() && name.as_deref() != strasse.as_deref() {
                zeile_teile.push(a.clone());
            }
        }
        if let Some(o) = &ort_zeile {
            if *o != titel {
                zeile_teile.push(o.clone());
            }
        }
        // Das Heimatland steht nicht dabei; fremde Länder schon.
        if let (Some(l), Some(k)) = (&land, &kuerzel) {
            if k != "DE" {
                zeile_teile.push(l.clone());
            }
        }
        if let Some(o) = &ort_zeile {
            if *o != titel {
                teile.push(o.clone());
            }
        }
        let text = teile.join(", ");
        if aus.iter().any(|t| t.text == text) {
            continue;
        }
        aus.push(Treffer {
            text,
            titel,
            zeile: zeile_teile.join(", "),
            lat,
            lon,
            land: kuerzel,
        });
    }
    aus
}

/// Sortiert stabil: Postleitzahl-Treffer zuerst, dann bevorzugte Länder.
///
/// Stabil, damit innerhalb einer Gruppe die Reihenfolge des Dienstes gilt –
/// die kennt die Wichtigkeit der Orte besser, als wir sie schätzen könnten.
pub fn einordnen(treffer: &mut [Treffer], plz: Option<&str>, bevorzugt: &[String]) {
    let plz_treffer = |t: &Treffer| -> bool {
        match plz {
            Some(p) => t.text.contains(&format!(" {p}")) || t.text.contains(&format!(", {p}")),
            None => false,
        }
    };
    let land_rang = |t: &Treffer| -> usize {
        t.land
            .as_ref()
            .and_then(|l| bevorzugt.iter().position(|b| b == l))
            .unwrap_or(bevorzugt.len())
    };
    treffer.sort_by_key(|t| (!plz_treffer(t), land_rang(t)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn merkmal(eigen: Value, lon: f64, lat: f64) -> Value {
        json!({"type": "Feature", "properties": eigen, "geometry": {"type": "Point", "coordinates": [lon, lat]}})
    }

    #[test]
    fn eine_getippte_anfrage_trifft_nie_den_schluessel_einer_plz() {
        assert_ne!(suchschluessel("plz:64283"), plz_schluessel("64283"));
        assert_ne!(suchschluessel("64283"), plz_schluessel("64283"));
    }

    #[test]
    fn nimmt_die_plz_aus_jeder_stelle_der_anfrage() {
        assert_eq!(
            plz_herausloesen("64283 Willy-Brandt-Platz 1"),
            ("Willy-Brandt-Platz 1".into(), Some("64283".into()))
        );
        assert_eq!(
            plz_herausloesen("Willy-Brandt-Platz 1 64283 Darmstadt"),
            ("Willy-Brandt-Platz 1 Darmstadt".into(), Some("64283".into()))
        );
        assert_eq!(
            plz_herausloesen("Willy-Brandt-Platz 1, 64283"),
            ("Willy-Brandt-Platz 1".into(), Some("64283".into()))
        );
    }

    #[test]
    fn laesst_kurze_zahlen_und_die_einzelne_zahl_stehen() {
        assert_eq!(plz_herausloesen("64283"), ("64283".into(), None));
        assert_eq!(plz_herausloesen("Willy 1"), ("Willy 1".into(), None));
        assert_eq!(plz_herausloesen("B 462"), ("B 462".into(), None));
        // Ein Wort und fünf Ziffern: eher eine Hausnummer als eine Postleitzahl.
        assert_eq!(plz_herausloesen("Hauptstr 12345"), ("Hauptstr 12345".into(), None));
    }

    #[test]
    fn baut_aus_einem_platz_eine_zeile_im_deutschen_schema() {
        let roh = json!({"features": [merkmal(json!({
            "name": "Willy-Brandt-Platz", "street": "Willy-Brandt-Platz",
            "postcode": "64293", "city": "Darmstadt", "countrycode": "DE", "country": "Deutschland"
        }), 8.65, 49.876)]});
        let t = treffer_lesen(&roh);
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].text, "Willy-Brandt-Platz, 64293 Darmstadt");
        assert_eq!(t[0].titel, "Willy-Brandt-Platz");
        assert_eq!(t[0].zeile, "64293 Darmstadt");
    }

    #[test]
    fn nennt_bei_einem_ort_mit_strasse_beides_und_im_ausland_das_land() {
        let roh = json!({"features": [merkmal(json!({
            "name": "Hauptbahnhof", "street": "Willy-Brandt-Platz", "housenumber": "1",
            "postcode": "38102", "city": "Braunschweig", "countrycode": "DE"
        }), 10.5, 52.25), merkmal(json!({
            "name": "Willy Brandt Denkmal", "street": "Lewartowskiego",
            "postcode": "00-185", "city": "Warschau", "countrycode": "PL", "country": "Polen"
        }), 20.99, 52.24)]});
        let t = treffer_lesen(&roh);
        assert_eq!(
            t[0].text,
            "Hauptbahnhof, Willy-Brandt-Platz 1, 38102 Braunschweig"
        );
        assert_eq!(t[0].zeile, "Willy-Brandt-Platz 1, 38102 Braunschweig");
        assert!(t[1].zeile.ends_with("Polen"));
    }

    #[test]
    fn wirft_doppelte_und_kaputte_merkmale_weg() {
        let gleich = json!({"name": "Markt", "city": "Ulm", "countrycode": "DE"});
        let roh = json!({"features": [
            merkmal(gleich.clone(), 9.9, 48.4),
            merkmal(gleich, 9.91, 48.41),
            merkmal(json!({"city": "Ulm"}), 999.0, 48.4),
            json!({"properties": {"name": "Ohne Punkt"}}),
            json!({"unsinn": 1}),
        ]});
        assert_eq!(treffer_lesen(&roh).len(), 1);
        assert!(treffer_lesen(&json!("kein Objekt")).is_empty());
    }

    #[test]
    fn liest_den_ort_zur_postleitzahl_und_bevorzugt_das_eigene_land() {
        let roh = json!({"features": [
            merkmal(json!({"name": "64293", "city": "Jakarta", "countrycode": "ID"}), 106.0, -6.0),
            merkmal(json!({"postcode": "64293", "city": "Darmstadt", "countrycode": "DE"}), 8.6, 49.8),
            merkmal(json!({"postcode": "99999", "city": "Anderswo", "countrycode": "DE"}), 8.6, 49.8),
        ]});
        assert_eq!(
            stadt_aus_plz_antwort(&roh, "64293", &["DE".into()]),
            Some("Darmstadt".into())
        );
        assert_eq!(stadt_aus_plz_antwort(&roh, "00000", &["DE".into()]), None);
        assert_eq!(
            stadt_aus_plz_antwort(&roh, "64293", &["FR".into()]),
            Some("Jakarta".into())
        );
    }

    #[test]
    fn ordnet_die_plz_zuerst_und_dann_die_bevorzugten_laender() {
        let mut t = vec![
            Treffer { text: "A, 99999 X".into(), titel: "A".into(), zeile: "".into(), lat: 0.0, lon: 0.0, land: Some("PL".into()) },
            Treffer { text: "B, 11111 Y".into(), titel: "B".into(), zeile: "".into(), lat: 0.0, lon: 0.0, land: Some("DE".into()) },
            Treffer { text: "C, 64283 Darmstadt".into(), titel: "C".into(), zeile: "".into(), lat: 0.0, lon: 0.0, land: Some("DE".into()) },
        ];
        einordnen(&mut t, Some("64283"), &["DE".into()]);
        assert_eq!(
            t.iter().map(|x| x.titel.as_str()).collect::<Vec<_>>(),
            ["C", "B", "A"]
        );
    }
}
