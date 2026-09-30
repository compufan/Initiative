//! Die Zustellungs-Planung gegen die gemeinsamen Testfälle.
//!
//! Dieselbe Datei liest die TypeScript-Fassung (`zustellungPlanen` im
//! gemeinsamen Paket): Die Oberfläche zeigt vor dem Senden, wohin die
//! Einladung geht, und der Server entscheidet danach. Rechnen beide anders,
//! steht in der Vorschau etwas, das nicht geschieht. Darum gibt es nur EINE
//! Liste von Fällen, und beide Seiten müssen sie bestehen.

use std::collections::HashMap;

use serde::Deserialize;
use uuid::Uuid;

use initiative_api::services::einladen::{planen, Wunsch};

const FAELLE: &str = include_str!("../../../packages/shared/src/testdaten/zustellung.json");

#[derive(Deserialize)]
struct Datei {
    faelle: Vec<Fall>,
}

#[derive(Deserialize)]
struct Fall {
    name: String,
    ersteller: String,
    personen: Vec<String>,
    wunsch: WunschJson,
    mitglieder: HashMap<String, Vec<String>>,
    erwartet: Erwartet,
}

#[derive(Deserialize)]
struct WunschJson {
    senden: bool,
    einzelchats: bool,
    gruppen: Vec<String>,
}

#[derive(Deserialize, Debug, PartialEq)]
struct Erwartet {
    gruppen: Vec<String>,
    ausgelassen: Vec<Ausgelassen>,
    einzel: Vec<String>,
}

#[derive(Deserialize, Debug, PartialEq)]
struct Ausgelassen {
    chat: String,
    fehlend: Vec<String>,
}

/// Namen werden zu Kennungen – und wieder zurück, damit ein Fehler lesbar bleibt.
#[derive(Default)]
struct Namen {
    ids: HashMap<String, Uuid>,
    zurueck: HashMap<Uuid, String>,
}

impl Namen {
    fn id(&mut self, name: &str) -> Uuid {
        if let Some(id) = self.ids.get(name) {
            return *id;
        }
        let id = Uuid::from_u128(self.ids.len() as u128 + 1);
        self.ids.insert(name.to_string(), id);
        self.zurueck.insert(id, name.to_string());
        id
    }

    fn name(&self, id: &Uuid) -> String {
        self.zurueck[id].clone()
    }
}

#[test]
fn alle_gemeinsamen_faelle_stimmen() {
    let datei: Datei = serde_json::from_str(FAELLE).expect("zustellung.json lesbar");
    assert!(datei.faelle.len() >= 10, "die Datei ist nicht leer");

    for fall in datei.faelle {
        let mut namen = Namen::default();
        let ersteller = namen.id(&fall.ersteller);
        let personen: Vec<Uuid> = fall.personen.iter().map(|name| namen.id(name)).collect();
        let wunsch = Wunsch {
            senden: fall.wunsch.senden,
            einzelchats: fall.wunsch.einzelchats,
            gruppen: fall
                .wunsch
                .gruppen
                .iter()
                .map(|name| namen.id(name))
                .collect(),
        };
        let mitglieder: HashMap<Uuid, Vec<Uuid>> = fall
            .mitglieder
            .iter()
            .map(|(chat, leute)| {
                (
                    namen.id(chat),
                    leute.iter().map(|name| namen.id(name)).collect(),
                )
            })
            .collect();

        let plan = planen(ersteller, &personen, &wunsch, &mitglieder);
        let ergebnis = Erwartet {
            gruppen: plan.gruppen.iter().map(|id| namen.name(id)).collect(),
            ausgelassen: plan
                .ausgelassen
                .iter()
                .map(|(chat, fehlend)| Ausgelassen {
                    chat: namen.name(chat),
                    fehlend: fehlend.iter().map(|id| namen.name(id)).collect(),
                })
                .collect(),
            einzel: plan.einzel.iter().map(|id| namen.name(id)).collect(),
        };
        assert_eq!(ergebnis, fall.erwartet, "Fall: {}", fall.name);
    }
}
