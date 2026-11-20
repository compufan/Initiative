//! Formatierungsmarken aus einem Text entfernen – für Push-Vorschauen.
//!
//! Dieselben Regeln wie `packages/shared/src/util/formatierung.ts` (beide
//! Tests lesen `packages/shared/src/testdaten/formatierung.json`). Der Server
//! braucht nur die Klartextfassung: Eine Mitteilung zeigt „Treffen um 8“,
//! nicht „*Treffen* um _8_“, und ein ||Spoiler|| bleibt dort verborgen.
//!
//! Laufzeit linear wie im Client: je Markierung einmal von rechts nach links
//! der nächste gültige Schluss, keine Suche je Öffnung, keine regulären
//! Ausdrücke.

const SPOILER_ERSATZ: &str = "▒▒▒";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Art {
    Spoiler,
    Fett,
    Kursiv,
    Durch,
    Mono,
}

const MARKIERUNGEN: [(Art, &str); 5] = [
    (Art::Spoiler, "||"),
    (Art::Fett, "*"),
    (Art::Kursiv, "_"),
    (Art::Durch, "~"),
    (Art::Mono, "`"),
];

fn ist_markierung(c: char) -> bool {
    matches!(c, '*' | '_' | '~' | '`' | '|')
}

fn vor_oeffnen(c: char) -> bool {
    matches!(
        c,
        '(' | '[' | '{' | '"' | '\'' | '«' | '„' | '‚' | '»' | '“' | '‘' | '-' | '/'
    )
}

fn nach_schluss(c: char) -> bool {
    matches!(
        c,
        '.' | ','
            | ';'
            | ':'
            | '!'
            | '?'
            | ')'
            | ']'
            | '}'
            | '"'
            | '\''
            | '»'
            | '“'
            | '”'
            | '’'
            | '«'
            | '-'
            | '/'
    )
}

struct Text {
    z: Vec<char>,
    schluss: [Vec<isize>; 5],
    zeile: Vec<usize>,
}

impl Text {
    fn beginnt_mit(&self, i: usize, zeichen: &str) -> bool {
        zeichen
            .chars()
            .enumerate()
            .all(|(k, c)| self.z.get(i + k) == Some(&c))
    }

    fn kann_oeffnen(&self, i: usize, laenge: usize) -> bool {
        match self.z.get(i + laenge) {
            None => return false,
            Some(c) if c.is_whitespace() => return false,
            _ => {}
        }
        if i == 0 {
            return true;
        }
        let davor = self.z[i - 1];
        davor.is_whitespace() || vor_oeffnen(davor) || ist_markierung(davor)
    }

    fn kann_schliessen(&self, j: usize, laenge: usize) -> bool {
        if j == 0 || self.z[j - 1].is_whitespace() {
            return false;
        }
        match self.z.get(j + laenge) {
            None => true,
            Some(&c) => c.is_whitespace() || nach_schluss(c) || ist_markierung(c),
        }
    }
}

fn vorrechnen(text: &str) -> Text {
    let z: Vec<char> = text.chars().collect();
    let n = z.len();
    let mut t = Text {
        z,
        schluss: Default::default(),
        zeile: vec![n; n + 2],
    };
    for (index, (_, zeichen)) in MARKIERUNGEN.iter().enumerate() {
        let laenge = zeichen.chars().count();
        let mut naechste = vec![-1isize; n + 2];
        for k in (0..n).rev() {
            let passt = t.beginnt_mit(k, zeichen) && t.kann_schliessen(k, laenge);
            naechste[k] = if passt { k as isize } else { naechste[k + 1] };
        }
        t.schluss[index] = naechste;
    }
    for k in (0..n).rev() {
        t.zeile[k] = if t.z[k] == '\n' { k } else { t.zeile[k + 1] };
    }
    t
}

fn inline(t: &Text, anfang: usize, ende: usize, erlaubt: &[Art], aus: &mut String) {
    let mut i = anfang;
    while i < ende {
        let mut getroffen = false;
        if ist_markierung(t.z[i]) {
            for (index, (art, zeichen)) in MARKIERUNGEN.iter().enumerate() {
                if !erlaubt.contains(art) {
                    continue;
                }
                let laenge = zeichen.chars().count();
                if !t.beginnt_mit(i, zeichen) || !t.kann_oeffnen(i, laenge) {
                    continue;
                }
                let ab = i + laenge + 1;
                let j = if ab <= ende { t.schluss[index][ab] } else { -1 };
                if j < 0 {
                    continue;
                }
                let j = j as usize;
                if j + laenge > ende || t.zeile[i] < j {
                    continue;
                }
                match art {
                    Art::Mono => aus.extend(&t.z[i + laenge..j]),
                    Art::Spoiler => aus.push_str(SPOILER_ERSATZ),
                    _ => {
                        let ohne: Vec<Art> = erlaubt.iter().copied().filter(|a| a != art).collect();
                        inline(t, i + laenge, j, &ohne, aus);
                    }
                }
                i = j + laenge;
                getroffen = true;
                break;
            }
        }
        if !getroffen {
            aus.push(t.z[i]);
            i += 1;
        }
    }
}

/// Der Text ohne Formatierungsmarken; Spoiler werden zu „▒▒▒“.
pub fn ohne_formatierung(text: &str) -> String {
    if !text.contains(['*', '_', '~', '`', '|']) {
        return text.to_string();
    }
    let t = vorrechnen(text);
    let alle: Vec<Art> = MARKIERUNGEN.iter().map(|(art, _)| *art).collect();
    let mut aus = String::with_capacity(text.len());
    let n = t.z.len();
    let mut i = 0;
    // Erst die Blöcke ```…```, auch über Zeilen.
    while let Some(auf) = finde(&t.z, i, "```") {
        let Some(zu) = finde(&t.z, auf + 3, "```") else {
            break;
        };
        if zu == auf + 3 {
            break;
        }
        inline(&t, i, auf, &alle, &mut aus);
        let mut inhalt: String = t.z[auf + 3..zu].iter().collect();
        if inhalt.starts_with('\n') {
            inhalt.remove(0);
        }
        if inhalt.ends_with('\n') {
            inhalt.pop();
        }
        aus.push_str(&inhalt);
        i = zu + 3;
    }
    inline(&t, i, n, &alle, &mut aus);
    aus
}

fn finde(z: &[char], ab: usize, nadel: &str) -> Option<usize> {
    let nadel: Vec<char> = nadel.chars().collect();
    if z.len() < nadel.len() {
        return None;
    }
    (ab..=z.len() - nadel.len()).find(|&k| z[k..k + nadel.len()] == nadel[..])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Dieselben Fälle wie der Client (`formatierung.test.ts`).
    #[test]
    fn gemeinsame_testdaten() {
        let roh = include_str!("../../../../../packages/shared/src/testdaten/formatierung.json");
        let faelle: Vec<serde_json::Value> = serde_json::from_str(roh).expect("JSON");
        assert!(faelle.len() > 10);
        for fall in faelle {
            let text = fall["text"].as_str().unwrap();
            let erwartet = fall["ohne"].as_str().unwrap();
            assert_eq!(ohne_formatierung(text), erwartet, "Fall: {text:?}");
        }
    }

    #[test]
    fn viele_offene_marken_sind_schnell() {
        let boese = "*_~`|".repeat(20_000);
        let anfang = std::time::Instant::now();
        let _ = ohne_formatierung(&boese);
        let _ = ohne_formatierung(&"*a ".repeat(30_000));
        assert!(anfang.elapsed() < std::time::Duration::from_secs(2));
    }
}
