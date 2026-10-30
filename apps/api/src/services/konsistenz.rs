//! Abgleich zwischen der Datenbank und der Kaltablage (Storage Box).
//!
//! # Wozu
//!
//! Was `ablage = 'fern'` ist, liegt nur auf der Box. Dass die Datenbank und die
//! Box dasselbe erzählen, ist eine Annahme, die über Monate bröckelt: ein von
//! Hand gelöschtes Verzeichnis, eine Box, die aus einem Snapshot
//! zurückgespielt wurde, ein Umzug, der nach dem Hinüberschreiben abstürzte.
//! Dieser Abgleich zeigt es, BEVOR jemand ein Video öffnet und nichts findet.
//!
//! # Was gelesen wird – und was nicht
//!
//! Gelesen werden nur Verzeichnisse (Namen und Grössen), keine Dateien:
//! Zehntausende Objekte kosten so Minuten, nicht Stunden und nicht Terabytes
//! Verkehr. Lediglich eine kleine Stichprobe (Vorgabe 3 Dateien, je höchstens
//! 256 MiB) wird ganz gelesen und per SHA-256 mit `attachments.sha256`
//! verglichen (Migration 0035; nur Uploads in Stücken haben eine).
//!
//! # Befunde
//!
//!   * **fehlend**: Zeile sagt `fern`, drüben gibt es nichts. Die Datei ist
//!     verloren, falls sie nicht mehr warm liegt – das schlimmste Ergebnis.
//!   * **falsche Grösse**: drüben liegt etwas anderes als vermerkt (mit
//!     Tresor wird die Geheimtext-Länge erwartet; Dateien von vor dem
//!     Einschalten des Schlüssels sind Klartext und gelten auch).
//!   * **verwaist**: drüben liegt etwas, wozu es weder Zeile noch Müllzeile
//!     gibt. Kostet nur Platz.
//!   * **Rest eines Umzugs**: drüben liegt etwas, dessen Zeile `lokal` oder
//!     `wandert` sagt – ein abgebrochener Umzug. Harmlos, kostet Platz.
//!   * **Teilreste** (`*.teil`): abgebrochene Übertragungen; der Auslagerungsdienst
//!     räumt sie nach drei Tagen weg.
//!   * **Stichprobe**: SHA-256 stimmt nicht – Bitfehler oder falscher Inhalt.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde::Serialize;
use sqlx::PgPool;

use crate::error::AppResult;
use crate::storage::tresor::geheimtext_laenge;
use crate::storage::Storage;

/// Wie viele Beispiele je Befund in der Antwort stehen.
const BEISPIELE: usize = 10;

#[derive(Debug, Clone, Copy)]
pub struct Optionen {
    /// Wie viele Dateien ganz gelesen und per SHA-256 geprüft werden.
    pub stichprobe: usize,
    /// Grösste Datei, die dafür in Frage kommt.
    pub stichprobe_max_bytes: u64,
    /// Ist ein `MEDIA_KEY` gesetzt (Geheimtext-Länge erwartet)?
    pub mit_tresor: bool,
}

impl Default for Optionen {
    fn default() -> Self {
        Self {
            stichprobe: 3,
            stichprobe_max_bytes: 256 * 1024 * 1024,
            mit_tresor: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Befund {
    pub anzahl: usize,
    /// Die ersten paar Schlüssel bzw. Beschreibungen.
    pub beispiele: Vec<String>,
}

impl Befund {
    fn dazu(&mut self, text: impl FnOnce() -> String) {
        self.anzahl += 1;
        if self.beispiele.len() < BEISPIELE {
            self.beispiele.push(text());
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Bericht {
    /// Anhangszeilen (je Schlüssel einmal) mit `ablage = 'fern'`.
    pub zeilen_fern: usize,
    /// Objekte, die auf der Box liegen (ohne Teilreste und Selbsttest).
    pub objekte_box: usize,
    pub fehlend: Befund,
    pub falsche_groesse: Befund,
    pub verwaist: Befund,
    pub rest_von_umzug: Befund,
    pub teilreste: Befund,
    pub stichprobe_geprueft: usize,
    pub stichprobe_abweichend: Befund,
    pub stichprobe_nicht_lesbar: Befund,
    /// Wie lange das Auflisten gedauert hat.
    pub auflisten_ms: u128,
    /// Wie lange die Stichprobe gedauert hat (inkl. Lesen).
    pub stichprobe_ms: u128,
    pub stichprobe_bytes: u64,
}

impl Bericht {
    /// Alles in Ordnung? Teilreste und Reste eines Umzugs zählen nicht als Fehler.
    pub fn in_ordnung(&self) -> bool {
        self.fehlend.anzahl == 0
            && self.falsche_groesse.anzahl == 0
            && self.verwaist.anzahl == 0
            && self.stichprobe_abweichend.anzahl == 0
            && self.stichprobe_nicht_lesbar.anzahl == 0
    }
}

/**
 * Den Abgleich ausführen.
 *
 * `kalt`: die ROHE kalte Ablage (ohne Weiche und Tresor) für das Auflisten.
 * `lesen`: der Speicher, wie ihn die App benutzt (Weiche + Tresor) für die
 * Stichprobe, damit Klartext herauskommt.
 *
 * Gibt `Ok(None)` zurück, wenn die Ablage das Auflisten nicht kann.
 */
pub async fn pruefen(
    pool: &PgPool,
    kalt: &Arc<dyn Storage>,
    lesen: &Arc<dyn Storage>,
    opt: Optionen,
) -> AppResult<Option<Bericht>> {
    let t = std::time::Instant::now();
    let Some(objekte) = kalt.auflisten().await? else {
        return Ok(None);
    };
    let mut bericht = Bericht {
        auflisten_ms: t.elapsed().as_millis(),
        ..Default::default()
    };

    // Was auf der Box liegt: Schlüssel -> Grösse. Teilreste und der Prüfdatei-
    // Ordner der Admin-Probe zählen nicht als Objekte.
    let mut box_: HashMap<String, u64> = HashMap::new();
    for o in objekte {
        if o.key.ends_with(".teil") {
            bericht.teilreste.dazu(|| o.key.clone());
        } else if !o.key.starts_with("_selbsttest/") {
            box_.insert(o.key, o.size);
        }
    }
    bericht.objekte_box = box_.len();

    // Was die Datenbank für fern hält (je Schlüssel einmal – weitergegebene
    // Dateien teilen sich ihre Bytes).
    let fern: Vec<(String, i64)> = sqlx::query_as(
        "select distinct on (storage_key) storage_key, size
           from attachments where ablage = 'fern' order by storage_key, created_at",
    )
    .fetch_all(pool)
    .await?;
    bericht.zeilen_fern = fern.len();
    let fern_schluessel: HashSet<&str> = fern.iter().map(|(k, _)| k.as_str()).collect();

    for (schluessel, groesse) in &fern {
        match box_.get(schluessel) {
            None => bericht.fehlend.dazu(|| schluessel.clone()),
            Some(drueben) => {
                let klar = *groesse as u64;
                let passt = *drueben == klar || (opt.mit_tresor && *drueben == geheimtext_laenge(klar));
                if !passt {
                    bericht.falsche_groesse.dazu(|| {
                        format!("{schluessel}: drüben {drueben} Bytes, erwartet {klar}{}", if opt.mit_tresor {
                            format!(" (verschlüsselt {})", geheimtext_laenge(klar))
                        } else {
                            String::new()
                        })
                    });
                }
            }
        }
    }

    // Objekte ohne `fern`-Zeile: verwaist oder Rest eines Umzugs?
    let ohne_zeile: Vec<String> = box_
        .keys()
        .filter(|k| !fern_schluessel.contains(k.as_str()))
        .cloned()
        .collect();
    let mut bekannt: HashMap<String, String> = HashMap::new();
    for stapel in ohne_zeile.chunks(5000) {
        let zeilen: Vec<(String, String)> =
            sqlx::query_as("select storage_key, ablage from attachments where storage_key = any($1)")
                .bind(stapel)
                .fetch_all(pool)
                .await?;
        bekannt.extend(zeilen);
        // Was in der Müllliste steht, wird gleich weggeräumt – kein Befund.
        let muell: Vec<(String,)> =
            sqlx::query_as("select storage_key from storage_muell where storage_key = any($1)")
                .bind(stapel)
                .fetch_all(pool)
                .await?;
        for (k,) in muell {
            bekannt.entry(k).or_insert_with(|| "muell".into());
        }
    }
    for k in &ohne_zeile {
        // Miniaturen liegen warm und kommen drüben nicht vor; falls doch, gehören
        // sie zum Original.
        match bekannt.get(k).map(String::as_str) {
            None => bericht.verwaist.dazu(|| k.clone()),
            Some("muell") => {}
            Some(ablage) => bericht.rest_von_umzug.dazu(|| format!("{k} (Zeile: {ablage})")),
        }
    }

    // Stichprobe: ganz lesen, SHA-256 vergleichen.
    if opt.stichprobe > 0 {
        let t = std::time::Instant::now();
        let proben: Vec<(String, String)> = sqlx::query_as(
            "select storage_key, sha256 from (
               select distinct on (storage_key) storage_key, sha256
                 from attachments
                where ablage = 'fern' and sha256 is not null and size > 0 and size <= $1
                order by storage_key, created_at) t
              order by random() limit $2",
        )
        .bind(opt.stichprobe_max_bytes as i64)
        .bind(opt.stichprobe as i64)
        .fetch_all(pool)
        .await?;
        for (schluessel, soll) in proben {
            // Fehlende Dateien sind schon gemeldet.
            if !box_.contains_key(&schluessel) {
                continue;
            }
            match lesen.read(&schluessel, None).await {
                Ok(Some(objekt)) => match crate::services::auslagern::strom_sha256(objekt.stream).await {
                    Ok(ist) => {
                        bericht.stichprobe_bytes += objekt.total_size.unwrap_or(0);
                        bericht.stichprobe_geprueft += 1;
                        if ist != soll {
                            bericht
                                .stichprobe_abweichend
                                .dazu(|| format!("{schluessel}: SHA-256 {ist}, erwartet {soll}"));
                        }
                    }
                    Err(fehler) => bericht
                        .stichprobe_nicht_lesbar
                        .dazu(|| format!("{schluessel}: {fehler}")),
                },
                Ok(None) => bericht
                    .stichprobe_nicht_lesbar
                    .dazu(|| format!("{schluessel}: nicht gefunden")),
                Err(fehler) => bericht
                    .stichprobe_nicht_lesbar
                    .dazu(|| format!("{schluessel}: {fehler}")),
            }
        }
        bericht.stichprobe_ms = t.elapsed().as_millis();
    }
    Ok(Some(bericht))
}
