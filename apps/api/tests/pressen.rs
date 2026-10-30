//! Pressen: Wertung, Rollen, Malus, Atempo und Sieg gegen die gemeinsamen
//! Testfälle.
//!
//! Dieselbe Datei liest `packages/shared/src/games/pressen.test.ts`: Server und
//! Oberfläche müssen für jeden Fall dasselbe ergeben. Dazu ein Durchgang durch
//! die echte Spiel-Engine (Registry, `apply_move` mit JSON), damit auch die
//! Anbindung stimmt – Katalog, Beitritt gesperrt, Ausgang.

use initiative_api::games::pressen::{
    dran_sitze, neuer_zustand, plan_fuer, verzoegerung_bei, wertung_ms, zug_anwenden, Malus, State,
    Zug,
};
use initiative_api::games::{get_game, GameSeat, MoveContext};
use serde_json::Value;
use uuid::Uuid;

const FAELLE: &str = include_str!("../../../packages/shared/src/testdaten/pressen.json");

fn daten() -> Value {
    serde_json::from_str(FAELLE).expect("Testfälle lesbar")
}

fn liste(wert: &Value) -> Vec<i64> {
    let mut v: Vec<i64> = wert
        .as_array()
        .expect("Liste")
        .iter()
        .map(|x| x.as_i64().expect("Zahl"))
        .collect();
    v.sort();
    v
}

#[test]
fn wertung_wie_im_typescript_spiegel() {
    for fall in daten()["wertung"].as_array().unwrap() {
        let erwartet = fall["erwartet"].as_i64().unwrap();
        assert_eq!(
            wertung_ms(
                fall["dauerMs"].as_i64().unwrap(),
                fall["verschuettetDezi"].as_i64().unwrap()
            ),
            erwartet,
            "{fall}"
        );
    }
}

#[test]
fn malus_klingt_wie_im_typescript_spiegel_ab() {
    for fall in daten()["malus"].as_array().unwrap() {
        let malus = Malus {
            wert_ms: fall["wertMs"].as_i64().unwrap(),
            stand: fall["stand"].as_i64().unwrap(),
        };
        assert_eq!(
            verzoegerung_bei(&malus, fall["jetzt"].as_i64().unwrap()),
            fall["erwartet"].as_i64().unwrap(),
            "{fall}"
        );
    }
}

#[test]
fn rollen_wie_im_typescript_spiegel() {
    for fall in daten()["plan"].as_array().unwrap() {
        let plan = plan_fuer(fall["n"].as_u64().unwrap() as usize);
        assert_eq!(plan.modus, fall["modus"].as_str().unwrap(), "{fall}");
        assert_eq!(
            plan.ampel.map(i64::from),
            fall["ampel"].as_i64(),
            "Ampel {fall}"
        );
        let teams: Vec<Vec<i64>> = plan
            .teams
            .iter()
            .map(|t| t.iter().map(|s| i64::from(*s)).collect())
            .collect();
        let erwartet: Vec<Vec<i64>> = fall["teams"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| {
                t.as_array()
                    .unwrap()
                    .iter()
                    .map(|s| s.as_i64().unwrap())
                    .collect()
            })
            .collect();
        assert_eq!(teams, erwartet, "Teams {fall}");
    }
}

fn zug_aus(z: &Value) -> Zug {
    serde_json::from_value(serde_json::json!({
        "typ": "ergebnis",
        "runde": z["runde"],
        "dauerMs": z["dauerMs"],
        "verschuettetDezi": z["verschuettetDezi"],
        "reaktionMs": z["reaktionMs"],
        "vorzeitig": z["vorzeitig"],
        "verzoegerungMs": z["verzoegerungMs"],
    }))
    .expect("Zug lesbar")
}

#[test]
fn ablaeufe_wie_im_typescript_spiegel() {
    for ablauf in daten()["ablaeufe"].as_array().unwrap() {
        let name = ablauf["name"].as_str().unwrap();
        let mut state: State = neuer_zustand(ablauf["spieler"].as_u64().unwrap() as usize);
        for (nr, z) in ablauf["zuege"].as_array().unwrap().iter().enumerate() {
            let wo = format!("{name}, Zug {}", nr + 1);
            let antwort = zug_anwenden(
                &state,
                &zug_aus(z),
                z["sitz"].as_i64().unwrap() as i32,
                z["jetzt"].as_i64().unwrap(),
            );
            let soll_fehler = z["fehler"].as_bool().unwrap_or(false);
            assert_eq!(antwort.is_err(), soll_fehler, "{wo}: {antwort:?}");
            let Ok(neu) = antwort else { continue };
            state = neu;
            let d = &z["danach"];
            if d.is_null() {
                continue;
            }
            if let Some(r) = d["runde"].as_i64() {
                assert_eq!(state.runde, r, "{wo} runde");
            }
            if let Some(a) = d["atempo"].as_i64() {
                assert_eq!(state.atempo, a, "{wo} atempo");
            }
            if let Some(f) = d["fertig"].as_bool() {
                assert_eq!(state.fertig, f, "{wo} fertig");
            }
            if d["dran"].is_array() {
                let mut dran: Vec<i64> = dran_sitze(&state).into_iter().map(i64::from).collect();
                dran.sort();
                assert_eq!(dran, liste(&d["dran"]), "{wo} dran");
            }
            if d["sieger"].is_array() {
                let mut sieger: Vec<i64> = state.sieger.iter().map(|s| i64::from(*s)).collect();
                sieger.sort();
                assert_eq!(sieger, liste(&d["sieger"]), "{wo} sieger");
            }
            if d["teamWertung"].is_array() {
                let mut erwartet: Vec<i64> = Vec::new();
                for x in d["teamWertung"].as_array().unwrap() {
                    erwartet.push(x.as_i64().unwrap());
                }
                assert_eq!(
                    state.team_wertung.clone().unwrap(),
                    erwartet,
                    "{wo} wertung"
                );
            }
            if d["malusWerte"].is_array() {
                let werte: Vec<i64> = state.malus.iter().map(|m| m.wert_ms).collect();
                let erwartet: Vec<i64> = d["malusWerte"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|x| x.as_i64().unwrap())
                    .collect();
                assert_eq!(werte, erwartet, "{wo} malus");
            }
            if let Some(abstand) = d["abstandMs"].as_i64() {
                assert_eq!(state.letzter_abstand_ms, Some(abstand), "{wo} abstand");
            }
            if d["verzoegerung"].is_object() {
                let sitz = d["verzoegerung"]["sitz"].as_u64().unwrap() as usize;
                let e = state.ergebnisse[sitz]
                    .as_ref()
                    .or_else(|| state.vorrunde.as_ref().and_then(|v| v[sitz].as_ref()))
                    .expect("Ergebnis");
                assert_eq!(
                    e.verzoegerung_ms,
                    d["verzoegerung"]["wert"].as_i64().unwrap(),
                    "{wo} verzoegerung"
                );
            }
        }
    }
}

#[test]
fn die_engine_kennt_das_spiel_und_sperrt_den_beitritt() {
    let spiel = get_game("pressen").expect("registriert");
    assert_eq!(spiel.min_players(), 1);
    assert_eq!(spiel.max_players(), 8);

    let sitze: Vec<GameSeat> = (0..2)
        .map(|seat| GameSeat {
            seat,
            user_id: Uuid::now_v7(),
        })
        .collect();
    let state = spiel.initial_state(&sitze);
    assert!(spiel.can_join(&state).is_err());
    assert_eq!(
        spiel.current_seat(&state),
        None,
        "beide laufen gleichzeitig"
    );
    assert!(!spiel.outcome(&state).finished);

    // Ein Zug über die JSON-Schnittstelle der Engine – mit echter Uhr.
    let zug = serde_json::json!({
        "typ": "ergebnis", "runde": 1, "dauerMs": 10000, "verschuettetDezi": 0,
        "reaktionMs": 300, "vorzeitig": false, "verzoegerungMs": 0
    });
    let ctx = MoveContext {
        seat: 0,
        user_id: sitze[0].user_id,
        players: &sitze,
    };
    let danach = spiel.apply_move(&state, &zug, &ctx).expect("gültig");
    assert_eq!(spiel.current_seat(&danach), Some(1));
    // Doppelt melden geht nicht, und Unsinn schon gar nicht.
    assert!(spiel.apply_move(&danach, &zug, &ctx).is_err());
    assert!(spiel
        .apply_move(&state, &serde_json::json!({ "typ": "x" }), &ctx)
        .is_err());
    assert_eq!(spiel.describe(&state), "Runde 1 läuft");
}
