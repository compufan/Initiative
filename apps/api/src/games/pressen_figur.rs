//! Pressen: das Strichmännchen eines Kontos.
//!
//! Gespeichert in `users.settings.modules.pressenFigur` (siehe `modules/users.rs`),
//! also je Konto, über Geräte und Spiele hinweg. Die Zeichnung selbst kennt nur
//! der Client; hier stehen die Grenzen. Jede Angabe ist eine kleine Zahl, die
//! dort eine Auswahl bedeutet (Frisur Nr. 3, Hautfarbe Nr. 2 …) – kein
//! Freitext, keine Farbcodes, nichts, was beim Zeichnen etwas einschleusen
//! könnte. Die Obergrenzen spiegeln `PRESSEN_FIGUR_GRENZEN` in
//! `packages/shared/src/games/pressen-figur.ts`.

use serde_json::{Map, Value};

/// Name und größte erlaubte Nummer (einschließlich) je Merkmal.
pub const GRENZEN: [(&str, i64); 7] = [
    ("frisur", 11),
    ("haarfarbe", 9),
    ("haut", 6),
    ("shirt", 11),
    ("bart", 4),
    ("brille", 3),
    ("hut", 4),
];

/// Prüft eine Figur streng: alle Merkmale, nur ganze Zahlen in den Grenzen, keine
/// fremden Schlüssel. `Err` trägt eine Meldung für die Person.
pub fn pruefen(roh: &Value) -> Result<Value, String> {
    let Some(objekt) = roh.as_object() else {
        return Err("Die Figur muss ein Objekt sein.".into());
    };
    if let Some(fremd) = objekt
        .keys()
        .find(|schluessel| !GRENZEN.iter().any(|(name, _)| name == schluessel))
    {
        return Err(format!("Unbekanntes Merkmal „{fremd}“."));
    }
    let mut sauber = Map::new();
    for (name, max) in GRENZEN {
        let Some(wert) = objekt.get(name).and_then(Value::as_i64) else {
            return Err(format!("Merkmal „{name}“ fehlt oder ist keine ganze Zahl."));
        };
        if !(0..=max).contains(&wert) {
            return Err(format!("Merkmal „{name}“ liegt außerhalb von 0 bis {max}."));
        }
        sauber.insert(name.to_string(), Value::from(wert));
    }
    Ok(Value::Object(sauber))
}

/// Liest eine gespeicherte Figur tolerant: Ist etwas ungültig, gibt es keine –
/// der Client nimmt dann seine Standardfigur.
pub fn lesen(roh: &Value) -> Option<Value> {
    pruefen(roh).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn gut() -> Value {
        json!({ "frisur": 3, "haarfarbe": 9, "haut": 0, "shirt": 11, "bart": 4, "brille": 3, "hut": 0 })
    }

    #[test]
    fn eine_gueltige_figur_geht_durch() {
        assert_eq!(pruefen(&gut()).unwrap(), gut());
    }

    #[test]
    fn grenzen_fehlendes_und_fremdes_werden_abgelehnt() {
        let mut zu_gross = gut();
        zu_gross["frisur"] = json!(12);
        assert!(pruefen(&zu_gross).is_err());
        let mut negativ = gut();
        negativ["hut"] = json!(-1);
        assert!(pruefen(&negativ).is_err());
        let mut kommazahl = gut();
        kommazahl["bart"] = json!(1.5);
        assert!(pruefen(&kommazahl).is_err());
        let mut text = gut();
        text["haut"] = json!("rot");
        assert!(pruefen(&text).is_err());
        let mut fremd = gut();
        fremd["skript"] = json!(1);
        assert!(pruefen(&fremd).is_err());
        let mut fehlt = gut();
        fehlt.as_object_mut().unwrap().remove("shirt");
        assert!(pruefen(&fehlt).is_err());
        assert!(pruefen(&json!([1, 2])).is_err());
        assert!(lesen(&json!("x")).is_none());
    }
}
