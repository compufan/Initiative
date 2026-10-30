//! Pressen – Echtzeit-Trinkspiel.
//!
//! Die Physik eines Laufs rechnet nur der Client (`packages/shared/src/games/
//! pressen-sim.ts`); hier kommt das Ergebnis an. Der Server prüft, ob es
//! physikalisch möglich ist, wertet es selbst (Dauer + Strafzeit), entscheidet
//! über Atempo und Sieg, schaltet den nächsten Läufer frei und führt den Malus
//! auf der Serveruhr. Warum das Eingabeprotokoll nicht nachgerechnet wird, steht
//! in `docs/entwurf-pressen.md`.
//!
//! Alles hier ist das Spiegelbild von `packages/shared/src/games/pressen.ts`;
//! beide laufen gegen `packages/shared/src/testdaten/pressen.json`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{GameDefinition, GameSeat, MoveContext, Outcome};

/* ---------- Konstanten (wie im TypeScript-Spiegel) ---------- */

pub const STRAFE_LINEAR_MS_PRO_ML: i64 = 100;
pub const STRAFE_QUADRAT_MS_PRO_ML2: i64 = 2;
pub const ATEMPO_TOLERANZ_MS: i64 = 250;
pub const MALUS_PRO_RUNDE_MS: i64 = 40;
pub const MALUS_MAX_MS: i64 = 250;
pub const MALUS_HALBWERTSZEIT_MS: f64 = 120_000.0;
pub const GETRUEMMERT_MS: i64 = 450;
pub const MIN_REAKTION_MS: i64 = 120;
pub const MIN_DAUER_MS: i64 = 1500;
/// 30 000 Schritte à 20 ms.
pub const MAX_DAUER_MS: i64 = 600_000;
const START_SPIELRAUM_MS: i64 = 30_000;

const GLAS_ML: f64 = 300.0;
const MUND_KAPAZITAET_ML: f64 = 25.0;
const SCHLUCK_RATE_ML_S: f64 = 30.0;

const MIN_SPIELER: usize = 1;
const MAX_SPIELER: usize = 8;

/* ---------- Zustand ---------- */

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Malus {
    pub wert_ms: i64,
    pub stand: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Ergebnis {
    pub dauer_ms: i64,
    pub verschuettet_dezi: i64,
    pub reaktion_ms: Option<i64>,
    pub vorzeitig: bool,
    pub verzoegerung_ms: i64,
    pub wertung_ms: i64,
    pub getruemmert: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub modus: String,
    pub ampel: Option<i32>,
    pub teams: Vec<Vec<i32>>,
    pub runde: i64,
    pub atempo: i64,
    pub ergebnisse: Vec<Option<Ergebnis>>,
    pub vorrunde: Option<Vec<Option<Ergebnis>>>,
    pub letzter_abstand_ms: Option<i64>,
    pub malus: Vec<Malus>,
    pub team_wertung: Option<Vec<i64>>,
    pub sieger: Vec<i32>,
    pub fertig: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Zug {
    pub typ: String,
    pub runde: i64,
    pub dauer_ms: i64,
    pub verschuettet_dezi: i64,
    pub reaktion_ms: Option<i64>,
    pub vorzeitig: bool,
    pub verzoegerung_ms: i64,
}

/* ---------- reine Funktionen ---------- */

pub fn wertung_ms(dauer_ms: i64, verschuettet_dezi: i64) -> i64 {
    let d = verschuettet_dezi;
    dauer_ms + (10 * STRAFE_LINEAR_MS_PRO_ML * d + STRAFE_QUADRAT_MS_PRO_ML2 * d * d + 50) / 100
}

pub struct Plan {
    pub modus: &'static str,
    pub ampel: Option<i32>,
    pub teams: Vec<Vec<i32>>,
}

pub fn plan_fuer(n: usize) -> Plan {
    if n <= 1 {
        return Plan {
            modus: "spiegel",
            ampel: None,
            teams: vec![vec![0]],
        };
    }
    let ampel = if n >= 3 && n % 2 == 1 {
        Some(n as i32 - 1)
    } else {
        None
    };
    let laeufer = if ampel.is_some() { n - 1 } else { n };
    let mut teams: Vec<Vec<i32>> = vec![Vec::new(), Vec::new()];
    for sitz in 0..laeufer {
        teams[sitz % 2].push(sitz as i32);
    }
    let modus = match n {
        2 => "duell",
        3 => "ampel",
        _ => "staffette",
    };
    Plan {
        modus,
        ampel,
        teams,
    }
}

fn malus_bei(malus: &Malus, jetzt_ms: i64) -> f64 {
    let alter = (jetzt_ms - malus.stand).max(0) as f64;
    malus.wert_ms as f64 * 0.5f64.powf(alter / MALUS_HALBWERTSZEIT_MS)
}

pub fn verzoegerung_bei(malus: &Malus, jetzt_ms: i64) -> i64 {
    malus_bei(malus, jetzt_ms).round() as i64
}

/// Sitze, die gerade laufen dürfen.
pub fn dran_sitze(state: &State) -> Vec<i32> {
    if state.fertig {
        return Vec::new();
    }
    let offen = |sitz: i32| state.ergebnisse[sitz as usize].is_none();
    if let Some(ampel) = state.ampel {
        if offen(ampel) {
            return vec![ampel];
        }
    }
    state
        .teams
        .iter()
        .filter_map(|team| team.iter().copied().find(|sitz| offen(*sitz)))
        .collect()
}

fn pruefe_lauf(zug: &Zug) -> Option<&'static str> {
    if zug.dauer_ms < MIN_DAUER_MS || zug.dauer_ms > MAX_DAUER_MS {
        return Some("Unplausible Dauer.");
    }
    if zug.verschuettet_dezi < 0 || zug.verschuettet_dezi > GLAS_ML as i64 * 10 {
        return Some("Unplausible Menge.");
    }
    let getrunken_ml = GLAS_ML - zug.verschuettet_dezi as f64 / 10.0;
    if getrunken_ml > SCHLUCK_RATE_ML_S * zug.dauer_ms as f64 / 1000.0 + MUND_KAPAZITAET_ML {
        return Some("Unplausibel schnell getrunken.");
    }
    if zug.vorzeitig {
        if zug.reaktion_ms.is_some() {
            return Some("Unplausible Reaktion.");
        }
    } else {
        match zug.reaktion_ms {
            Some(reaktion) if reaktion >= MIN_REAKTION_MS && reaktion <= zug.dauer_ms => {}
            _ => return Some("Unplausible Reaktion."),
        }
    }
    if zug.verzoegerung_ms < 0 || zug.verzoegerung_ms > MALUS_MAX_MS {
        return Some("Unplausible Verzögerung.");
    }
    None
}

pub fn neuer_zustand(spieler: usize) -> State {
    let n = spieler.max(1);
    let plan = plan_fuer(n);
    State {
        modus: plan.modus.to_string(),
        ampel: plan.ampel,
        teams: plan.teams,
        runde: 1,
        atempo: 0,
        ergebnisse: vec![None; n],
        vorrunde: None,
        letzter_abstand_ms: None,
        malus: vec![
            Malus {
                wert_ms: 0,
                stand: 0
            };
            n
        ],
        team_wertung: None,
        sieger: Vec::new(),
        fertig: false,
    }
}

/// Ein Ergebnis einbuchen; `jetzt_ms` ist die Serveruhr (ms seit 1970).
pub fn zug_anwenden(state: &State, zug: &Zug, sitz: i32, jetzt_ms: i64) -> Result<State, String> {
    if zug.typ != "ergebnis" {
        return Err("Ungültiger Zug".into());
    }
    if state.fertig {
        return Err("Das Spiel ist beendet.".into());
    }
    if zug.runde != state.runde {
        return Err("Diese Runde ist schon vorbei.".into());
    }
    if !dran_sitze(state).contains(&sitz) {
        return Err("Du bist gerade nicht dran.".into());
    }
    if let Some(fehler) = pruefe_lauf(zug) {
        return Err(fehler.into());
    }

    let spiegel = state.modus == "spiegel";
    let malus = &state.malus[sitz as usize];
    // Die Verzögerung kann nicht kleiner sein als der Malus jetzt und nicht
    // größer als der zu Beginn des Laufs – dazwischen wird begrenzt, nicht
    // abgelehnt: Eine verstellte Handyuhr soll keinen guten Lauf kosten.
    let untere = (verzoegerung_bei(malus, jetzt_ms) - 2).max(0);
    let obere = (verzoegerung_bei(malus, jetzt_ms - zug.dauer_ms - START_SPIELRAUM_MS) + 2)
        .min(MALUS_MAX_MS);
    let verzoegerung_ms = if spiegel {
        0
    } else {
        zug.verzoegerung_ms.min(obere).max(untere)
    };

    let ergebnis = Ergebnis {
        dauer_ms: zug.dauer_ms,
        verschuettet_dezi: zug.verschuettet_dezi,
        reaktion_ms: zug.reaktion_ms,
        vorzeitig: zug.vorzeitig,
        verzoegerung_ms,
        wertung_ms: wertung_ms(zug.dauer_ms, zug.verschuettet_dezi),
        getruemmert: !zug.vorzeitig && zug.reaktion_ms.is_some_and(|r| r <= GETRUEMMERT_MS),
    };

    let mut weiter = state.clone();
    weiter.ergebnisse[sitz as usize] = Some(ergebnis);
    if !spiegel {
        weiter.malus[sitz as usize] = Malus {
            wert_ms: (verzoegerung_bei(malus, jetzt_ms) + MALUS_PRO_RUNDE_MS).min(MALUS_MAX_MS),
            stand: jetzt_ms,
        };
    }

    let alle_da = state
        .teams
        .iter()
        .flatten()
        .chain(state.ampel.iter())
        .all(|s| weiter.ergebnisse[*s as usize].is_some());
    if !alle_da {
        return Ok(weiter);
    }

    let summen: Vec<i64> = state
        .teams
        .iter()
        .map(|team| {
            team.iter()
                .map(|s| {
                    weiter.ergebnisse[*s as usize]
                        .as_ref()
                        .map_or(0, |e| e.wertung_ms)
                })
                .sum()
        })
        .collect();
    let abstand = if spiegel {
        0
    } else {
        (summen[0] - summen[1]).abs()
    };
    let toleranz = ATEMPO_TOLERANZ_MS * state.teams[0].len() as i64;
    if spiegel || abstand < toleranz {
        let leer = vec![None; weiter.ergebnisse.len()];
        weiter.vorrunde = Some(std::mem::replace(&mut weiter.ergebnisse, leer));
        weiter.runde += 1;
        weiter.atempo += 1;
        weiter.letzter_abstand_ms = Some(abstand);
        return Ok(weiter);
    }
    let gewinner = if summen[0] < summen[1] { 0 } else { 1 };
    weiter.sieger = state.teams[gewinner].clone();
    weiter.team_wertung = Some(summen);
    weiter.fertig = true;
    Ok(weiter)
}

/* ---------- Anbindung an die Spiel-Engine ---------- */

pub struct Pressen;

impl GameDefinition for Pressen {
    fn key(&self) -> &'static str {
        "pressen"
    }
    fn name(&self) -> &'static str {
        "Pressen"
    }
    fn description(&self) -> &'static str {
        "Bier so schnell wie möglich trinken – und möglichst nichts verschütten. Allein gegen den Spiegel, zu zweit, mit Ampel oder als Staffette."
    }
    fn emoji(&self) -> &'static str {
        "🍺"
    }
    fn min_players(&self) -> usize {
        MIN_SPIELER
    }
    fn max_players(&self) -> usize {
        MAX_SPIELER
    }

    fn initial_state(&self, players: &[GameSeat]) -> Value {
        serde_json::to_value(neuer_zustand(players.len())).expect("state serialises")
    }

    fn can_join(&self, _state: &Value) -> Result<(), String> {
        // Die Rollen (Ampel, Teams) hängen an der Zahl der Spielenden und
        // stehen beim Anlegen fest – ein Beitritt mitten im Lauf risse sie um.
        Err("Bei Pressen steht die Aufstellung beim Anlegen fest.".into())
    }

    fn apply_move(
        &self,
        state: &Value,
        mv: &Value,
        ctx: &MoveContext<'_>,
    ) -> Result<Value, String> {
        let state: State = serde_json::from_value(state.clone())
            .map_err(|_| "Ungültiger Spielstand".to_string())?;
        let zug: Zug =
            serde_json::from_value(mv.clone()).map_err(|_| "Ungültiger Zug".to_string())?;
        let jetzt = chrono::Utc::now().timestamp_millis();
        let next = zug_anwenden(&state, &zug, ctx.seat, jetzt)?;
        serde_json::to_value(next).map_err(|_| "Spielstand konnte nicht gespeichert werden".into())
    }

    fn current_seat(&self, state: &Value) -> Option<i32> {
        let state: State = serde_json::from_value(state.clone()).ok()?;
        match dran_sitze(&state).as_slice() {
            [einer] => Some(*einer),
            _ => None,
        }
    }

    fn outcome(&self, state: &Value) -> Outcome {
        let Ok(state) = serde_json::from_value::<State>(state.clone()) else {
            return Outcome::default();
        };
        Outcome {
            finished: state.fertig,
            draw: false,
            winner_seats: state.sieger,
        }
    }

    fn describe(&self, state: &Value) -> String {
        let Ok(state) = serde_json::from_value::<State>(state.clone()) else {
            return "Spiel".to_string();
        };
        if state.fertig {
            let erster = state.sieger.first().copied().unwrap_or(0);
            return if state.modus == "duell" || state.modus == "ampel" {
                format!("Sieg für Spieler {}", erster + 1)
            } else {
                let team = state
                    .teams
                    .iter()
                    .position(|team| team.first() == Some(&erster))
                    .unwrap_or(0);
                format!("Sieg für Team {}", team + 1)
            };
        }
        if state.atempo > 0 {
            format!("Atempo – Runde {}", state.runde)
        } else {
            format!("Runde {} läuft", state.runde)
        }
    }
}
