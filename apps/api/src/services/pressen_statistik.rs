//! Pressen: Statistik über alle gewerteten Läufe eines Kontos.
//!
//! Die Läufe stehen in `pressen_laeufe` (Migration `0028`). Geschrieben werden
//! sie vom Server, wenn eine Runde abgeschlossen ist – im selben Schritt, der
//! den Spielstand speichert (`persist_session`), eine Zeile je gewerteter
//! Person. Gelesen werden sie nur von dem Konto, dem sie gehören.
//!
//! WARUM die Sichtbarkeitsregel hier von selbst gilt: Fremde Zeiten sind bis
//! zum Rundenende verborgen (`fuer_betrachter`). Eine Zeile entsteht erst, wenn
//! die Runde feststeht; bis dahin gibt es nichts, was eine Statistik verraten
//! könnte. Der Vergleich „du gegen Anna“ nutzt nur die eigenen Zeilen (mit den
//! Werten, die zum Rundenende offen wurden) – Anna sieht ihre eigenen.
//!
//! Die Rechnung (`berechne`) ist eine reine Funktion über die Zeilen und damit
//! ohne Datenbank prüfbar.

use std::collections::HashMap;

use chrono::{DateTime, Utc};
use serde::Serialize;
use uuid::Uuid;

use crate::games::pressen::{State, GLAS_DEZI};
use crate::games::{user_of_seat, GameSeat};

/* ---------- Schreiben ---------- */

/// Ein Lauf, der in `pressen_laeufe` einzutragen ist.
#[derive(Debug, Clone, PartialEq)]
pub struct NeuerLauf {
    pub user_id: Uuid,
    pub session_id: Uuid,
    pub runde: i32,
    pub sitz: i32,
    pub modus: String,
    pub start_art: &'static str,
    pub gegner_ids: Vec<Uuid>,
    pub team_ids: Vec<Uuid>,
    pub dauer_ms: i32,
    pub verschuettet_dezi: i32,
    pub wertung_ms: i32,
    pub reaktion_ms: Option<i32>,
    pub vorzeitig: bool,
    pub getruemmert: bool,
    pub malus_ms: i32,
    pub versatz_ms: i32,
    pub ausgang: &'static str,
    pub team_wertung_ms: Option<i64>,
    pub gegner_wertung_ms: Option<i64>,
}

/// Welche Läufe schließt dieser Zug ab? (Leer, wenn die Runde noch offen ist.)
///
/// Zwei Fälle schließen eine Runde: Das Spiel ist entschieden (die Ergebnisse
/// stehen in `ergebnisse`), oder es gab Atempo (die Ergebnisse wandern in die
/// `vorrunde`, die Rundenzahl steigt). Alles andere – ein einzelner Lauf, die
/// Wahl vor dem Start – ändert nichts an der Statistik.
pub fn laeufe_aus_zug(
    session_id: Uuid,
    spieler: &[GameSeat],
    vorher: &State,
    nachher: &State,
) -> Vec<NeuerLauf> {
    let (ergebnisse, runde, entschieden) = if nachher.fertig && !vorher.fertig {
        (&nachher.ergebnisse, nachher.runde, true)
    } else if nachher.runde > vorher.runde {
        match &nachher.vorrunde {
            Some(vorrunde) => (vorrunde, vorher.runde, false),
            None => return Vec::new(),
        }
    } else {
        return Vec::new();
    };

    let wertung = |sitz: i32| {
        ergebnisse
            .get(sitz as usize)
            .and_then(|e| e.as_ref())
            .map(|e| e.wertung_ms)
    };
    let team_summe = |team: &[i32]| -> i64 { team.iter().filter_map(|s| wertung(*s)).sum() };
    let nutzer = |sitz: i32| user_of_seat(spieler, Some(sitz));

    let mut zeilen = Vec::new();
    for (nr, eintrag) in ergebnisse.iter().enumerate() {
        let (Some(e), sitz) = (eintrag, nr as i32) else {
            continue;
        };
        let Some(user_id) = nutzer(sitz) else {
            continue;
        };
        let eigenes_team = nachher.teams.iter().position(|t| t.contains(&sitz));
        let gegner_sitze: Vec<i32> = match eigenes_team {
            Some(eigen) => nachher
                .teams
                .iter()
                .enumerate()
                .filter(|(i, _)| *i != eigen)
                .flat_map(|(_, t)| t.iter().copied())
                .collect(),
            None => Vec::new(),
        };
        let team_sitze: Vec<i32> = eigenes_team
            .map(|eigen| nachher.teams[eigen].clone())
            .unwrap_or_default();
        let ausgang = if nachher.ampel == Some(sitz) {
            "nicht_gewertet"
        } else if !entschieden {
            "atempo"
        } else if nachher.sieger.contains(&sitz) {
            "sieg"
        } else {
            "niederlage"
        };
        zeilen.push(NeuerLauf {
            user_id,
            session_id,
            runde: runde as i32,
            sitz,
            modus: nachher.modus.clone(),
            // Ein gemeinsamer Beginn schlägt sich als Versatz im Lauf nieder;
            // wer ab dem eigenen „Anstoßen“ zählt, hat keinen.
            start_art: if e.versatz_ms > 0 {
                "echtzeit"
            } else {
                "asynchron"
            },
            gegner_ids: gegner_sitze.iter().filter_map(|s| nutzer(*s)).collect(),
            team_ids: team_sitze
                .iter()
                .filter(|s| **s != sitz)
                .filter_map(|s| nutzer(*s))
                .collect(),
            dauer_ms: e.dauer_ms as i32,
            verschuettet_dezi: e.verschuettet_dezi as i32,
            wertung_ms: e.wertung_ms as i32,
            reaktion_ms: e.reaktion_ms.map(|r| r as i32),
            vorzeitig: e.vorzeitig,
            getruemmert: e.getruemmert,
            malus_ms: e.verzoegerung_ms as i32,
            versatz_ms: e.versatz_ms as i32,
            ausgang,
            team_wertung_ms: eigenes_team.map(|_| team_summe(&team_sitze)),
            gegner_wertung_ms: if gegner_sitze.is_empty() {
                None
            } else {
                Some(team_summe(&gegner_sitze))
            },
        });
    }
    zeilen
}

/// Trägt die Läufe ein. Ein Wiederholen doppelt nichts (`on conflict`).
pub async fn eintragen(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    laeufe: &[NeuerLauf],
) -> Result<(), sqlx::Error> {
    for l in laeufe {
        sqlx::query(
            "insert into pressen_laeufe
               (user_id, session_id, runde, sitz, modus, start_art, gegner_ids, team_ids,
                dauer_ms, verschuettet_dezi, wertung_ms, reaktion_ms, vorzeitig, getruemmert,
                malus_ms, versatz_ms, ausgang, team_wertung_ms, gegner_wertung_ms)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
                     $17, $18, $19)
             on conflict (session_id, runde, user_id) do nothing",
        )
        .bind(l.user_id)
        .bind(l.session_id)
        .bind(l.runde)
        .bind(l.sitz)
        .bind(&l.modus)
        .bind(l.start_art)
        .bind(&l.gegner_ids)
        .bind(&l.team_ids)
        .bind(l.dauer_ms)
        .bind(l.verschuettet_dezi)
        .bind(l.wertung_ms)
        .bind(l.reaktion_ms)
        .bind(l.vorzeitig)
        .bind(l.getruemmert)
        .bind(l.malus_ms)
        .bind(l.versatz_ms)
        .bind(l.ausgang)
        .bind(l.team_wertung_ms)
        .bind(l.gegner_wertung_ms)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

/* ---------- Lesen ---------- */

/// Eine Zeile aus `pressen_laeufe`.
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct LaufZeile {
    pub id: Uuid,
    pub user_id: Uuid,
    pub session_id: Option<Uuid>,
    pub runde: i32,
    pub sitz: i32,
    pub modus: String,
    pub start_art: String,
    pub gegner_ids: Vec<Uuid>,
    pub team_ids: Vec<Uuid>,
    pub dauer_ms: i32,
    pub verschuettet_dezi: i32,
    pub wertung_ms: i32,
    pub reaktion_ms: Option<i32>,
    pub vorzeitig: bool,
    pub getruemmert: bool,
    pub malus_ms: i32,
    pub versatz_ms: i32,
    pub ausgang: String,
    pub team_wertung_ms: Option<i64>,
    pub gegner_wertung_ms: Option<i64>,
    pub gespielt_am: DateTime<Utc>,
}

pub const MODI: [&str; 4] = ["spiegel", "duell", "ampel", "staffette"];
pub const ARTEN: [&str; 2] = ["echtzeit", "asynchron"];
pub const AUSGAENGE: [&str; 4] = ["sieg", "niederlage", "atempo", "nicht_gewertet"];

/// So viele Läufe gehen höchstens in eine Rechnung (das Konto eines
/// Dauerspielers soll den Server nicht in die Knie zwingen).
pub const MAX_LAEUFE: i64 = 20_000;
/// So viele Punkte bekommt der Verlauf höchstens mit (die jüngsten).
pub const MAX_VERLAUF: usize = 600;
/// Breite einer Malus-Stufe in ms.
pub const MALUS_STUFE_MS: i32 = 50;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rekord {
    pub wert: i64,
    pub lauf_id: Uuid,
    pub gespielt_am: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Kopf {
    pub laeufe: i64,
    pub siege: i64,
    pub niederlagen: i64,
    pub atempo: i64,
    pub nicht_gewertet: i64,
    /// Siege / (Siege + Niederlagen), 0 bis 1; leer, solange nichts entschieden ist.
    pub siegquote: Option<f64>,
    pub getruemmert: i64,
    pub vorzeitig: i64,
    pub durchschnitt_zeit_ms: Option<f64>,
    pub durchschnitt_wertung_ms: Option<f64>,
    pub durchschnitt_verschuettet_dezi: Option<f64>,
    pub gesamt_getrunken_dezi: i64,
    pub gesamt_verschuettet_dezi: i64,
    /// Getrunken / (getrunken + verschüttet) über alle Läufe, 0 bis 1.
    pub trefferquote: Option<f64>,
    pub gesamt_dauer_ms: i64,
    pub laengste_siegesserie: i64,
    pub aktuelle_siegesserie: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Rekorde {
    pub beste_zeit: Option<Rekord>,
    pub beste_wertung: Option<Rekord>,
    /// Am wenigsten verschüttet (bei Gleichstand der schnellere Lauf), Zehntelml.
    pub sauberster_lauf: Option<Rekord>,
    pub schnellste_reaktion: Option<Rekord>,
    /// Länge der längsten Siegesserie; Datum und Lauf sind der letzte Sieg darin.
    pub laengste_siegesserie: Option<Rekord>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModusZeile {
    pub modus: String,
    pub laeufe: i64,
    pub siege: i64,
    pub niederlagen: i64,
    pub atempo: i64,
    pub beste_wertung_ms: Option<i64>,
    pub durchschnitt_zeit_ms: Option<f64>,
    pub durchschnitt_verschuettet_dezi: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GegnerZeile {
    pub user_id: Uuid,
    /// Anzeigename; leer, wenn das Konto nicht mehr besteht.
    pub name: Option<String>,
    /// Gemeinsame, abgeschlossene Runden.
    pub runden: i64,
    pub siege: i64,
    pub niederlagen: i64,
    pub atempo: i64,
    /// Mittlerer Vorsprung (ms) des eigenen Teams; negativ = im Schnitt langsamer.
    pub durchschnitt_vorsprung_ms: Option<f64>,
    pub letzte_runde: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MalusZeile {
    pub von_ms: i32,
    pub bis_ms: i32,
    pub laeufe: i64,
    pub durchschnitt_wertung_ms: Option<f64>,
    pub durchschnitt_zeit_ms: Option<f64>,
    pub durchschnitt_verschuettet_dezi: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VerlaufPunkt {
    pub id: Uuid,
    pub gespielt_am: DateTime<Utc>,
    pub modus: String,
    pub ausgang: String,
    pub dauer_ms: i32,
    pub verschuettet_dezi: i32,
    pub wertung_ms: i32,
    pub vorzeitig: bool,
    pub malus_ms: i32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Statistik {
    pub kopf: Kopf,
    pub rekorde: Rekorde,
    pub nach_modus: Vec<ModusZeile>,
    pub nach_gegner: Vec<GegnerZeile>,
    pub nach_malus: Vec<MalusZeile>,
    pub verlauf: Vec<VerlaufPunkt>,
    /// Es gab mehr Läufe, als der Verlauf zeigt (nur die jüngsten sind dabei).
    pub verlauf_gekuerzt: bool,
}

fn mittel(werte: impl Iterator<Item = f64>) -> Option<f64> {
    let (summe, n) = werte.fold((0.0, 0u64), |(s, n), w| (s + w, n + 1));
    (n > 0).then(|| summe / n as f64)
}

fn rekord(l: &LaufZeile, wert: i64) -> Rekord {
    Rekord {
        wert,
        lauf_id: l.id,
        gespielt_am: l.gespielt_am,
    }
}

/// Der kleinste Wert unter den Läufen; bei Gleichstand der früheste.
fn kleinster<'a>(
    laeufe: impl Iterator<Item = &'a LaufZeile>,
    schluessel: impl Fn(&LaufZeile) -> Option<(i64, i64)>,
) -> Option<Rekord> {
    laeufe
        .filter_map(|l| schluessel(l).map(|k| (k, l)))
        .min_by_key(|(k, l)| (*k, l.gespielt_am))
        .map(|((wert, _), l)| rekord(l, wert))
}

/// Rechnet die Statistik aus Läufen, die nach Zeit (aufsteigend) geordnet sind.
///
/// Festlegungen, damit die Zahlen nachvollziehbar bleiben:
///  - Zeit- und Wertungsrekorde und Durchschnitte zählen nur Läufe, die ins Ziel
///    kamen (`vorzeitig` = abgebrochen zählt nicht), alle Läufe zählen aber bei
///    Menge, Verschüttetem und Trefferquote.
///  - Die Siegesserie zählt aufeinanderfolgende Siege; eine Niederlage beendet
///    sie, Atempo und nicht gewertete Läufe lassen sie unberührt.
///  - Die Malus-Tabelle lässt den Spiegel weg (dort wächst der Malus nicht, die
///    Stufe 0 wäre sonst mit Übungsläufen aufgefüllt).
pub fn berechne(laeufe: &[LaufZeile], gegner_namen: &HashMap<Uuid, String>) -> Statistik {
    let ins_ziel = || laeufe.iter().filter(|l| !l.vorzeitig);
    let zaehle = |ausgang: &str| laeufe.iter().filter(|l| l.ausgang == ausgang).count() as i64;
    let siege = zaehle("sieg");
    let niederlagen = zaehle("niederlage");
    let gesamt_verschuettet: i64 = laeufe.iter().map(|l| l.verschuettet_dezi as i64).sum();
    let gesamt_getrunken: i64 = laeufe
        .iter()
        .map(|l| (GLAS_DEZI - l.verschuettet_dezi as i64).max(0))
        .sum();

    // Siegesserie über die Zeit.
    let (mut serie, mut laengste, mut ende_der_laengsten): (i64, i64, Option<&LaufZeile>) =
        (0, 0, None);
    for l in laeufe {
        match l.ausgang.as_str() {
            "sieg" => {
                serie += 1;
                if serie > laengste {
                    laengste = serie;
                    ende_der_laengsten = Some(l);
                }
            }
            "niederlage" => serie = 0,
            _ => {}
        }
    }

    let kopf = Kopf {
        laeufe: laeufe.len() as i64,
        siege,
        niederlagen,
        atempo: zaehle("atempo"),
        nicht_gewertet: zaehle("nicht_gewertet"),
        siegquote: (siege + niederlagen > 0).then(|| siege as f64 / (siege + niederlagen) as f64),
        getruemmert: laeufe.iter().filter(|l| l.getruemmert).count() as i64,
        vorzeitig: laeufe.iter().filter(|l| l.vorzeitig).count() as i64,
        durchschnitt_zeit_ms: mittel(ins_ziel().map(|l| l.dauer_ms as f64)),
        durchschnitt_wertung_ms: mittel(ins_ziel().map(|l| l.wertung_ms as f64)),
        durchschnitt_verschuettet_dezi: mittel(laeufe.iter().map(|l| l.verschuettet_dezi as f64)),
        gesamt_getrunken_dezi: gesamt_getrunken,
        gesamt_verschuettet_dezi: gesamt_verschuettet,
        trefferquote: (gesamt_getrunken + gesamt_verschuettet > 0)
            .then(|| gesamt_getrunken as f64 / (gesamt_getrunken + gesamt_verschuettet) as f64),
        gesamt_dauer_ms: laeufe.iter().map(|l| l.dauer_ms as i64).sum(),
        laengste_siegesserie: laengste,
        aktuelle_siegesserie: serie,
    };

    let rekorde = Rekorde {
        beste_zeit: kleinster(ins_ziel(), |l| Some((l.dauer_ms as i64, 0))),
        beste_wertung: kleinster(ins_ziel(), |l| Some((l.wertung_ms as i64, 0))),
        sauberster_lauf: kleinster(ins_ziel(), |l| {
            Some((l.verschuettet_dezi as i64, l.dauer_ms as i64))
        }),
        schnellste_reaktion: kleinster(ins_ziel(), |l| l.reaktion_ms.map(|r| (r as i64, 0))),
        laengste_siegesserie: ende_der_laengsten.map(|l| rekord(l, laengste)),
    };

    let nach_modus = MODI
        .iter()
        .filter_map(|modus| {
            let dieser: Vec<&LaufZeile> = laeufe.iter().filter(|l| l.modus == *modus).collect();
            if dieser.is_empty() {
                return None;
            }
            let ausgang = |a: &str| dieser.iter().filter(|l| l.ausgang == a).count() as i64;
            let im_ziel = || dieser.iter().filter(|l| !l.vorzeitig);
            Some(ModusZeile {
                modus: (*modus).to_string(),
                laeufe: dieser.len() as i64,
                siege: ausgang("sieg"),
                niederlagen: ausgang("niederlage"),
                atempo: ausgang("atempo"),
                beste_wertung_ms: im_ziel().map(|l| l.wertung_ms as i64).min(),
                durchschnitt_zeit_ms: mittel(im_ziel().map(|l| l.dauer_ms as f64)),
                durchschnitt_verschuettet_dezi: mittel(
                    dieser.iter().map(|l| l.verschuettet_dezi as f64),
                ),
            })
        })
        .collect();

    // Bilanz je Gegner über die gemeinsamen, abgeschlossenen Runden.
    #[derive(Default)]
    struct Konto {
        runden: i64,
        siege: i64,
        niederlagen: i64,
        atempo: i64,
        vorsprung: f64,
        vorsprung_n: u64,
        letzte: Option<DateTime<Utc>>,
    }
    let mut je_gegner: HashMap<Uuid, Konto> = HashMap::new();
    for l in laeufe {
        for gegner in &l.gegner_ids {
            let k = je_gegner.entry(*gegner).or_default();
            k.runden += 1;
            match l.ausgang.as_str() {
                "sieg" => k.siege += 1,
                "niederlage" => k.niederlagen += 1,
                "atempo" => k.atempo += 1,
                _ => {}
            }
            if let (Some(team), Some(gegen)) = (l.team_wertung_ms, l.gegner_wertung_ms) {
                k.vorsprung += (gegen - team) as f64;
                k.vorsprung_n += 1;
            }
            k.letzte = Some(k.letzte.map_or(l.gespielt_am, |t| t.max(l.gespielt_am)));
        }
    }
    let mut nach_gegner: Vec<GegnerZeile> = je_gegner
        .into_iter()
        .map(|(user_id, k)| GegnerZeile {
            user_id,
            name: gegner_namen.get(&user_id).cloned(),
            runden: k.runden,
            siege: k.siege,
            niederlagen: k.niederlagen,
            atempo: k.atempo,
            durchschnitt_vorsprung_ms: (k.vorsprung_n > 0)
                .then(|| k.vorsprung / k.vorsprung_n as f64),
            letzte_runde: k.letzte.unwrap_or_default(),
        })
        .collect();
    nach_gegner.sort_by(|a, b| {
        b.runden
            .cmp(&a.runden)
            .then(b.letzte_runde.cmp(&a.letzte_runde))
            .then(a.user_id.cmp(&b.user_id))
    });

    // Wertung nach Malus-Stufe (0–49, 50–99, … 200–250 ms).
    let stufen = (crate::games::pressen::MALUS_MAX_MS as i32 / MALUS_STUFE_MS) + 1;
    let nach_malus = (0..stufen)
        .filter_map(|stufe| {
            let von = stufe * MALUS_STUFE_MS;
            let in_stufe: Vec<&LaufZeile> = laeufe
                .iter()
                .filter(|l| {
                    l.modus != "spiegel"
                        && !l.vorzeitig
                        && l.malus_ms.min(crate::games::pressen::MALUS_MAX_MS as i32)
                            / MALUS_STUFE_MS
                            == stufe
                })
                .collect();
            if in_stufe.is_empty() {
                return None;
            }
            Some(MalusZeile {
                von_ms: von,
                bis_ms: if stufe == stufen - 1 {
                    crate::games::pressen::MALUS_MAX_MS as i32
                } else {
                    von + MALUS_STUFE_MS - 1
                },
                laeufe: in_stufe.len() as i64,
                durchschnitt_wertung_ms: mittel(in_stufe.iter().map(|l| l.wertung_ms as f64)),
                durchschnitt_zeit_ms: mittel(in_stufe.iter().map(|l| l.dauer_ms as f64)),
                durchschnitt_verschuettet_dezi: mittel(
                    in_stufe.iter().map(|l| l.verschuettet_dezi as f64),
                ),
            })
        })
        .collect();

    let verlauf_gekuerzt = laeufe.len() > MAX_VERLAUF;
    let verlauf = laeufe[laeufe.len().saturating_sub(MAX_VERLAUF)..]
        .iter()
        .map(|l| VerlaufPunkt {
            id: l.id,
            gespielt_am: l.gespielt_am,
            modus: l.modus.clone(),
            ausgang: l.ausgang.clone(),
            dauer_ms: l.dauer_ms,
            verschuettet_dezi: l.verschuettet_dezi,
            wertung_ms: l.wertung_ms,
            vorzeitig: l.vorzeitig,
            malus_ms: l.malus_ms,
        })
        .collect();

    Statistik {
        kopf,
        rekorde,
        nach_modus,
        nach_gegner,
        nach_malus,
        verlauf,
        verlauf_gekuerzt,
    }
}

/* ---------- Abfragen ---------- */

#[derive(Debug, Clone, Default)]
pub struct Filter {
    pub von: Option<DateTime<Utc>>,
    pub bis: Option<DateTime<Utc>>,
    pub modus: Option<String>,
    pub art: Option<String>,
    pub ausgang: Option<String>,
}

impl Filter {
    /// Prüft die Auswahlwerte gegen die erlaubten (sonst 400, nie ein leeres Ergebnis).
    pub fn pruefen(&self) -> Result<(), &'static str> {
        let erlaubt = |wert: &Option<String>, liste: &[&str]| {
            wert.as_deref().is_none_or(|w| liste.contains(&w))
        };
        if !erlaubt(&self.modus, &MODI) {
            return Err("Unbekannter Modus");
        }
        if !erlaubt(&self.art, &ARTEN) {
            return Err("Unbekannte Startart");
        }
        if !erlaubt(&self.ausgang, &AUSGAENGE) {
            return Err("Unbekannter Ausgang");
        }
        if let (Some(von), Some(bis)) = (self.von, self.bis) {
            if von >= bis {
                return Err("Der Zeitraum ist leer");
            }
        }
        Ok(())
    }
}

/// Die Läufe eines Kontos im Filter, nach Zeit aufsteigend.
pub async fn laden(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    filter: &Filter,
) -> Result<Vec<LaufZeile>, sqlx::Error> {
    sqlx::query_as::<_, LaufZeile>(
        // Die jüngsten MAX_LAEUFE, in zeitlicher Reihenfolge zurückgegeben.
        "select * from (
           select * from pressen_laeufe
            where user_id = $1
              and ($2::timestamptz is null or gespielt_am >= $2)
              and ($3::timestamptz is null or gespielt_am < $3)
              and ($4::text is null or modus = $4)
              and ($5::text is null or start_art = $5)
              and ($6::text is null or ausgang = $6)
            order by gespielt_am desc, id desc
            limit $7
         ) jung
         order by gespielt_am asc, id asc",
    )
    .bind(user_id)
    .bind(filter.von)
    .bind(filter.bis)
    .bind(&filter.modus)
    .bind(&filter.art)
    .bind(&filter.ausgang)
    .bind(MAX_LAEUFE)
    .fetch_all(pool)
    .await
}

/// Anzeigenamen; fehlende Konten fehlen im Ergebnis.
pub async fn namen(
    pool: &sqlx::PgPool,
    ids: &[Uuid],
) -> Result<HashMap<Uuid, String>, sqlx::Error> {
    if ids.is_empty() {
        return Ok(HashMap::new());
    }
    let zeilen: Vec<(Uuid, String)> =
        sqlx::query_as("select id, display_name from users where id = any($1)")
            .bind(ids)
            .fetch_all(pool)
            .await?;
    Ok(zeilen.into_iter().collect())
}

/// Sortierungen der Laufliste und ihr Schlüssel (alles ganze Zahlen, damit der
/// Cursor exakt vergleichbar bleibt).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sortierung {
    Neu,
    Alt,
    Zeit,
    Wertung,
    Verschuettet,
}

impl Sortierung {
    pub fn lesen(wert: Option<&str>) -> Option<Self> {
        match wert {
            None | Some("neu") => Some(Self::Neu),
            Some("alt") => Some(Self::Alt),
            Some("zeit") => Some(Self::Zeit),
            Some("wertung") => Some(Self::Wertung),
            Some("verschuettet") => Some(Self::Verschuettet),
            Some(_) => None,
        }
    }

    fn schluessel(self) -> &'static str {
        match self {
            Self::Neu | Self::Alt => "(extract(epoch from gespielt_am) * 1000000)::bigint",
            Self::Zeit => "dauer_ms::bigint",
            Self::Wertung => "wertung_ms::bigint",
            Self::Verschuettet => "verschuettet_dezi::bigint",
        }
    }

    fn absteigend(self) -> bool {
        self == Self::Neu
    }
}

/// Wert des Sortierschlüssels einer Zeile – das, was im Cursor steht.
fn schluesselwert(s: Sortierung, l: &LaufZeile) -> i64 {
    match s {
        Sortierung::Neu | Sortierung::Alt => l.gespielt_am.timestamp_micros(),
        Sortierung::Zeit => l.dauer_ms as i64,
        Sortierung::Wertung => l.wertung_ms as i64,
        Sortierung::Verschuettet => l.verschuettet_dezi as i64,
    }
}

pub fn cursor_lesen(cursor: &str) -> Option<(i64, Uuid)> {
    let (wert, id) = cursor.split_once('_')?;
    Some((wert.parse().ok()?, id.parse().ok()?))
}

/// Eine Seite der Laufliste: bis zu `limit` Zeilen und der Cursor für die nächste.
pub async fn seite(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    filter: &Filter,
    sortierung: Sortierung,
    cursor: Option<(i64, Uuid)>,
    limit: i64,
) -> Result<(Vec<LaufZeile>, Option<String>), sqlx::Error> {
    let schluessel = sortierung.schluessel();
    let (richtung, vergleich) = if sortierung.absteigend() {
        ("desc", "<")
    } else {
        ("asc", ">")
    };
    // Schlüssel und Richtung stammen aus der Aufzählung oben, nie vom Aufrufer.
    let abfrage = format!(
        "select * from pressen_laeufe
          where user_id = $1
            and ($2::timestamptz is null or gespielt_am >= $2)
            and ($3::timestamptz is null or gespielt_am < $3)
            and ($4::text is null or modus = $4)
            and ($5::text is null or start_art = $5)
            and ($6::text is null or ausgang = $6)
            and ($7::bigint is null or ({schluessel}, id) {vergleich} ($7, $8))
          order by {schluessel} {richtung}, id {richtung}
          limit $9"
    );
    let mut zeilen = sqlx::query_as::<_, LaufZeile>(&abfrage)
        .bind(user_id)
        .bind(filter.von)
        .bind(filter.bis)
        .bind(&filter.modus)
        .bind(&filter.art)
        .bind(&filter.ausgang)
        .bind(cursor.map(|(wert, _)| wert))
        .bind(cursor.map(|(_, id)| id))
        .bind(limit + 1)
        .fetch_all(pool)
        .await?;
    let weiter = if zeilen.len() as i64 > limit {
        zeilen.truncate(limit as usize);
        zeilen
            .last()
            .map(|l| format!("{}_{}", schluesselwert(sortierung, l), l.id))
    } else {
        None
    };
    Ok((zeilen, weiter))
}

pub async fn einzeln(
    pool: &sqlx::PgPool,
    user_id: Uuid,
    id: Uuid,
) -> Result<Option<LaufZeile>, sqlx::Error> {
    sqlx::query_as::<_, LaufZeile>("select * from pressen_laeufe where id = $1 and user_id = $2")
        .bind(id)
        .bind(user_id)
        .fetch_optional(pool)
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::games::pressen::{neuer_zustand, zug_anwenden, Zug};
    use chrono::TimeZone;

    fn zeit(tag: u32, stunde: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 5, tag, stunde, 0, 0).unwrap()
    }

    #[allow(clippy::too_many_arguments)]
    fn lauf(
        nr: u128,
        modus: &str,
        ausgang: &str,
        dauer: i32,
        verschuettet: i32,
        malus: i32,
        gegner: &[Uuid],
        zeit: DateTime<Utc>,
    ) -> LaufZeile {
        LaufZeile {
            id: Uuid::from_u128(nr),
            user_id: Uuid::from_u128(1),
            session_id: None,
            runde: 1,
            sitz: 0,
            modus: modus.to_string(),
            start_art: "asynchron".to_string(),
            gegner_ids: gegner.to_vec(),
            team_ids: Vec::new(),
            dauer_ms: dauer,
            verschuettet_dezi: verschuettet,
            wertung_ms: dauer + verschuettet * 10,
            reaktion_ms: Some(300 + nr as i32),
            vorzeitig: false,
            getruemmert: false,
            malus_ms: malus,
            versatz_ms: 0,
            ausgang: ausgang.to_string(),
            team_wertung_ms: Some((dauer + verschuettet * 10) as i64),
            gegner_wertung_ms: if gegner.is_empty() {
                None
            } else {
                Some((dauer + verschuettet * 10) as i64 + 1000)
            },
            gespielt_am: zeit,
        }
    }

    #[test]
    fn aggregate_an_bekannten_laeufen() {
        let anna = Uuid::from_u128(2);
        let bodo = Uuid::from_u128(3);
        let mut abgebrochen = lauf(
            6,
            "duell",
            "niederlage",
            3000,
            2900,
            40,
            &[bodo],
            zeit(6, 9),
        );
        abgebrochen.vorzeitig = true;
        abgebrochen.reaktion_ms = None;
        let mut truemmer = lauf(2, "duell", "sieg", 14000, 0, 0, &[anna], zeit(2, 9));
        truemmer.getruemmert = true;
        let laeufe = vec![
            lauf(1, "spiegel", "atempo", 20000, 100, 0, &[], zeit(1, 9)),
            truemmer,
            lauf(3, "duell", "sieg", 12000, 50, 40, &[anna], zeit(3, 9)),
            lauf(
                4,
                "duell",
                "niederlage",
                16000,
                200,
                80,
                &[bodo],
                zeit(4, 9),
            ),
            lauf(5, "ampel", "nicht_gewertet", 15000, 0, 0, &[], zeit(5, 9)),
            abgebrochen,
            lauf(7, "duell", "sieg", 13000, 0, 120, &[anna], zeit(7, 9)),
            lauf(8, "duell", "sieg", 12500, 10, 160, &[anna], zeit(8, 9)),
        ];
        let namen = HashMap::from([(anna, "Anna".to_string())]);
        let s = berechne(&laeufe, &namen);

        assert_eq!(s.kopf.laeufe, 8);
        assert_eq!(s.kopf.siege, 4);
        assert_eq!(s.kopf.niederlagen, 2);
        assert_eq!(s.kopf.atempo, 1);
        assert_eq!(s.kopf.nicht_gewertet, 1);
        assert_eq!(s.kopf.vorzeitig, 1);
        assert_eq!(s.kopf.getruemmert, 1);
        assert_eq!(s.kopf.siegquote, Some(4.0 / 6.0));
        // Serie: zwei Siege (Lauf 2, 3), dann Niederlagen, wieder zwei Siege; die erste längste bleibt.
        assert_eq!(s.kopf.laengste_siegesserie, 2);
        assert_eq!(s.kopf.aktuelle_siegesserie, 2);
        // Ø Zeit ohne den abgebrochenen: (20000+14000+12000+16000+15000+13000+12500)/7.
        let erwartet = (20000 + 14000 + 12000 + 16000 + 15000 + 13000 + 12500) as f64 / 7.0;
        assert_eq!(s.kopf.durchschnitt_zeit_ms, Some(erwartet));
        // Verschüttet über alle: 100+0+50+200+0+2900+0+10 = 3260.
        assert_eq!(s.kopf.gesamt_verschuettet_dezi, 3260);
        assert_eq!(s.kopf.gesamt_getrunken_dezi, 8 * 3000 - 3260);
        assert_eq!(s.kopf.gesamt_dauer_ms, 105_500);

        // Rekorde: die abgebrochene 3000 ms zählt nicht.
        let beste = s.rekorde.beste_zeit.as_ref().unwrap();
        assert_eq!((beste.wert, beste.lauf_id), (12000, Uuid::from_u128(3)));
        assert_eq!(beste.gespielt_am, zeit(3, 9));
        // Sauberster Lauf: 0 dezi, bei Gleichstand der schnellere (13 s vor 14 s und 15 s).
        let sauber = s.rekorde.sauberster_lauf.as_ref().unwrap();
        assert_eq!((sauber.wert, sauber.lauf_id), (0, Uuid::from_u128(7)));
        let serie = s.rekorde.laengste_siegesserie.as_ref().unwrap();
        assert_eq!(serie.wert, 2);
        assert_eq!(serie.lauf_id, Uuid::from_u128(3));

        let modi: Vec<(&str, i64)> = s
            .nach_modus
            .iter()
            .map(|m| (m.modus.as_str(), m.laeufe))
            .collect();
        assert_eq!(modi, vec![("spiegel", 1), ("duell", 6), ("ampel", 1)]);
        let duell = &s.nach_modus[1];
        assert_eq!((duell.siege, duell.niederlagen), (4, 2));

        // Gegner: Anna in vier gemeinsamen Runden (alle gewonnen), Bodo in zweien.
        let gegen_anna = s.nach_gegner.iter().find(|g| g.user_id == anna).unwrap();
        assert_eq!(gegen_anna.name.as_deref(), Some("Anna"));
        assert_eq!((gegen_anna.runden, gegen_anna.siege), (4, 4));
        assert_eq!(gegen_anna.durchschnitt_vorsprung_ms, Some(1000.0));
        let gegen_bodo = s.nach_gegner.iter().find(|g| g.user_id == bodo).unwrap();
        assert_eq!(gegen_bodo.name, None);
        assert_eq!((gegen_bodo.runden, gegen_bodo.niederlagen), (2, 2));
        assert_eq!(s.nach_gegner[0].user_id, anna);

        // Malus: der Spiegel (0 ms) und der abgebrochene Lauf zählen nicht.
        let stufen: Vec<(i32, i64)> = s.nach_malus.iter().map(|m| (m.von_ms, m.laeufe)).collect();
        assert_eq!(stufen, vec![(0, 3), (50, 1), (100, 1), (150, 1)]);
        assert_eq!(s.nach_malus[0].bis_ms, 49);

        assert_eq!(s.verlauf.len(), 8);
        assert!(!s.verlauf_gekuerzt);
        assert_eq!(s.verlauf[0].id, Uuid::from_u128(1));
    }

    #[test]
    fn leere_statistik_hat_keine_quoten_und_keine_rekorde() {
        let s = berechne(&[], &HashMap::new());
        assert_eq!(s.kopf.laeufe, 0);
        assert_eq!(s.kopf.siegquote, None);
        assert_eq!(s.kopf.trefferquote, None);
        assert_eq!(s.kopf.durchschnitt_zeit_ms, None);
        assert!(s.rekorde.beste_zeit.is_none());
        assert!(s.nach_modus.is_empty() && s.nach_gegner.is_empty() && s.verlauf.is_empty());
    }

    #[test]
    fn der_verlauf_behaelt_nur_die_juengsten() {
        let laeufe: Vec<LaufZeile> = (0..MAX_VERLAUF as u128 + 5)
            .map(|n| lauf(n + 1, "spiegel", "atempo", 15000, 0, 0, &[], zeit(1, 9)))
            .collect();
        let s = berechne(&laeufe, &HashMap::new());
        assert_eq!(s.verlauf.len(), MAX_VERLAUF);
        assert!(s.verlauf_gekuerzt);
        assert_eq!(s.verlauf[0].id, Uuid::from_u128(6));
        // Die Kopfzahlen zählen trotzdem alle.
        assert_eq!(s.kopf.laeufe, MAX_VERLAUF as i64 + 5);
    }

    fn sitze(n: usize) -> Vec<GameSeat> {
        (0..n)
            .map(|i| GameSeat {
                seat: i as i32,
                user_id: Uuid::from_u128(100 + i as u128),
            })
            .collect()
    }

    fn zug(runde: i64, dauer: i64, verschuettet: i64) -> Zug {
        Zug {
            typ: "ergebnis".into(),
            runde,
            dauer_ms: dauer,
            verschuettet_dezi: verschuettet,
            reaktion_ms: Some(300),
            vorzeitig: false,
            verzoegerung_ms: 0,
            versatz_ms: None,
        }
    }

    #[test]
    fn ein_einzelner_lauf_in_einem_duell_schreibt_noch_nichts() {
        let s0 = neuer_zustand(2);
        let s1 = zug_anwenden(&s0, &zug(1, 12000, 0), 0, 1_000_000).unwrap();
        assert!(laeufe_aus_zug(Uuid::nil(), &sitze(2), &s0, &s1).is_empty());
    }

    #[test]
    fn eine_entschiedene_runde_schreibt_je_sitz_sieg_und_niederlage_mit_gegner() {
        let s0 = neuer_zustand(2);
        let s1 = zug_anwenden(&s0, &zug(1, 12000, 0), 0, 1_000_000).unwrap();
        let s2 = zug_anwenden(&s1, &zug(1, 20000, 50), 1, 1_001_000).unwrap();
        let sid = Uuid::from_u128(77);
        let zeilen = laeufe_aus_zug(sid, &sitze(2), &s1, &s2);
        assert_eq!(zeilen.len(), 2);
        let a = &zeilen[0];
        let b = &zeilen[1];
        assert_eq!((a.sitz, a.ausgang, a.runde), (0, "sieg", 1));
        assert_eq!((b.sitz, b.ausgang), (1, "niederlage"));
        assert_eq!(a.gegner_ids, vec![Uuid::from_u128(101)]);
        assert_eq!(b.gegner_ids, vec![Uuid::from_u128(100)]);
        assert_eq!(a.modus, "duell");
        assert_eq!(a.session_id, sid);
        assert_eq!(a.team_wertung_ms, Some(12000));
        // 5,0 ml verschüttet: 500 ms linear + 50 ms quadratisch.
        assert_eq!(a.gegner_wertung_ms, Some(20550));
        assert!(a.team_ids.is_empty());
    }

    #[test]
    fn atempo_schreibt_die_vorrunde_mit_der_alten_rundennummer() {
        let s0 = neuer_zustand(2);
        let s1 = zug_anwenden(&s0, &zug(1, 12000, 0), 0, 1_000_000).unwrap();
        let s2 = zug_anwenden(&s1, &zug(1, 12100, 0), 1, 1_001_000).unwrap();
        assert_eq!(s2.runde, 2);
        let zeilen = laeufe_aus_zug(Uuid::nil(), &sitze(2), &s1, &s2);
        assert_eq!(zeilen.len(), 2);
        assert!(zeilen.iter().all(|z| z.ausgang == "atempo" && z.runde == 1));
    }

    #[test]
    fn die_ampel_ist_nicht_gewertet_und_hat_keinen_gegner() {
        let s0 = neuer_zustand(3);
        let mut s = s0.clone();
        let mut verlauf = vec![s0];
        for (sitz, dauer) in [(2, 15000), (0, 12000), (1, 20000)] {
            let vorher = verlauf.last().unwrap().clone();
            s = zug_anwenden(&vorher, &zug(1, dauer, 0), sitz, 1_000_000).unwrap();
            verlauf.push(s.clone());
        }
        let zeilen = laeufe_aus_zug(Uuid::nil(), &sitze(3), &verlauf[2], &s);
        let ampel = zeilen.iter().find(|z| z.sitz == 2).unwrap();
        assert_eq!(ampel.ausgang, "nicht_gewertet");
        assert!(ampel.gegner_ids.is_empty());
        assert_eq!(ampel.team_wertung_ms, None);
        assert_eq!(zeilen.iter().find(|z| z.sitz == 0).unwrap().ausgang, "sieg");
    }

    #[test]
    fn cursor_und_filter_werden_streng_gelesen() {
        let id = Uuid::from_u128(9);
        assert_eq!(cursor_lesen(&format!("123_{id}")), Some((123, id)));
        assert_eq!(cursor_lesen("abc_x"), None);
        assert_eq!(cursor_lesen("123"), None);
        assert!(Filter::default().pruefen().is_ok());
        let unbekannt = Filter {
            modus: Some("irgendwas".into()),
            ..Filter::default()
        };
        assert!(unbekannt.pruefen().is_err());
        assert_eq!(Sortierung::lesen(Some("kaputt")), None);
        assert_eq!(Sortierung::lesen(None), Some(Sortierung::Neu));
    }
}
