//! Ratenbegrenzung – wie oft jemand dieselbe Sache hintereinander darf.
//!
//! Bisher gab es keine. Bei Fly.io lag ein Proxy des Anbieters davor, der das
//! Gröbste abfing; auf einem eigenen Server steht die API nackt hinter Caddy.
//! Ohne Bremse kann jeder, der die Adresse kennt, Passwörter im Sekundentakt
//! durchprobieren oder Einladungscodes raten – und das kostet ihn nichts.
//!
//! # Was hier bewusst NICHT passiert
//!
//! **Kein Bannen.** Wer zu schnell ist, bekommt eine Absage und darf es gleich
//! wieder versuchen. Ein Bann über Minuten klingt strenger, sperrt aber im
//! Zweifel den Falschen aus: Hinter einem Mobilfunk-Anschluss teilen sich
//! Hunderte dieselbe Adresse.
//!
//! **Kein gemeinsamer Zustand über mehrere Prozesse.** Es läuft genau eine
//! Instanz. Ein Zähler in Redis wäre ein zweiter Dienst, der ausfallen kann,
//! für einen Gewinn, den es hier nicht gibt.
//!
//! # Warum zwei Schlüssel je Anmeldung
//!
//! Nur nach Adresse zu zählen hilft nicht gegen jemanden, der ein Botnetz hat
//! und ein einziges Konto angreift. Nur nach Benutzername zu zählen erlaubt es,
//! von einer Adresse aus tausend Konten mit demselben Passwort durchzuprobieren
//! („password spraying"). Beides zusammen deckt beide Richtungen ab.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Ein Eimer, der sich über die Zeit von selbst wieder füllt.
///
/// Der Vorteil gegenüber einem festen Zeitfenster: Wer eine Stunde nichts tut,
/// hat wieder alle Versuche frei, und wer dauerhaft am Limit arbeitet, wird
/// gleichmässig ausgebremst statt am Fensterrand schlagartig freigegeben.
#[derive(Debug, Clone, Copy)]
struct Eimer {
    /// Wie viele Versuche gerade noch drin sind – als Kommazahl, weil er sich
    /// kontinuierlich füllt.
    rest: f64,
    zuletzt: Instant,
}

#[derive(Debug, Clone, Copy)]
pub struct Regel {
    /// Wie viele Versuche im Vorrat stecken, wenn man frisch anfängt.
    pub vorrat: u32,
    /// In welcher Zeit sich der Vorrat einmal vollständig auffüllt.
    pub auffuellen_in: Duration,
}

impl Regel {
    pub const fn neu(vorrat: u32, auffuellen_in: Duration) -> Self {
        Self {
            vorrat,
            auffuellen_in,
        }
    }

    fn pro_sekunde(&self) -> f64 {
        if self.auffuellen_in.is_zero() {
            return f64::INFINITY;
        }
        f64::from(self.vorrat) / self.auffuellen_in.as_secs_f64()
    }
}

pub struct Drossel {
    /// Ob überhaupt gebremst wird – siehe `Config::rate_limit`.
    an: bool,
    eimer: Mutex<HashMap<String, Eimer>>,
    /// Ab wie vielen Einträgen aufgeräumt wird.
    ///
    /// Ohne Aufräumen wächst die Karte mit jeder je gesehenen Adresse – ein
    /// Speicherleck, das genau derjenige auslöst, gegen den die Drossel
    /// gerichtet ist.
    aufraeumen_ab: usize,
}

impl Default for Drossel {
    fn default() -> Self {
        Self::neu(true)
    }
}

impl Drossel {
    pub fn neu(an: bool) -> Self {
        Self {
            an,
            eimer: Mutex::new(HashMap::new()),
            aufraeumen_ab: 10_000,
        }
    }

    /// Einen Versuch anmelden. `true` heisst: erlaubt.
    pub fn erlaubt(&self, schluessel: &str, regel: Regel) -> bool {
        self.erlaubt_um(schluessel, regel, Instant::now())
    }

    /// Dasselbe mit vorgegebener Zeit – so lässt es sich prüfen, ohne zu warten.
    pub fn erlaubt_um(&self, schluessel: &str, regel: Regel, jetzt: Instant) -> bool {
        if !self.an {
            return true;
        }
        let mut karte = match self.eimer.lock() {
            Ok(karte) => karte,
            // Ein vergifteter Mutex darf nicht dazu führen, dass sich niemand
            // mehr anmelden kann. Im Zweifel durchlassen.
            Err(vergiftet) => vergiftet.into_inner(),
        };

        if karte.len() >= self.aufraeumen_ab {
            let grenze = regel.auffuellen_in.max(Duration::from_secs(60));
            karte.retain(|_, eimer| jetzt.duration_since(eimer.zuletzt) < grenze);
        }

        let eintrag = karte.entry(schluessel.to_string()).or_insert(Eimer {
            rest: f64::from(regel.vorrat),
            zuletzt: jetzt,
        });

        let vergangen = jetzt
            .saturating_duration_since(eintrag.zuletzt)
            .as_secs_f64();
        eintrag.rest =
            (eintrag.rest + vergangen * regel.pro_sekunde()).min(f64::from(regel.vorrat));
        eintrag.zuletzt = jetzt;

        if eintrag.rest < 1.0 {
            return false;
        }
        eintrag.rest -= 1.0;
        true
    }

    /// Einen Schlüssel wieder freigeben – nach einer geglückten Anmeldung.
    ///
    /// Sonst zählt die Bremse auch die mit, die sich nur zweimal vertippt haben
    /// und dann richtig lagen.
    pub fn zuruecksetzen(&self, schluessel: &str) {
        if let Ok(mut karte) = self.eimer.lock() {
            karte.remove(schluessel);
        }
    }

    #[cfg(test)]
    fn groesse(&self) -> usize {
        self.eimer.lock().map(|karte| karte.len()).unwrap_or(0)
    }
}

/**
 * Wer die Anfrage geschickt hat – so gut, wie es sich feststellen lässt.
 *
 * Hinter einem Reverse Proxy ist die Gegenstelle immer der Proxy; die echte
 * Adresse steht in `X-Forwarded-For`. Geglaubt wird die Kopfzeile nur, wenn
 * `TRUST_PROXY` gesetzt ist – ohne Proxy davor könnte sie jeder selbst
 * schreiben und damit nicht nur an der Bremse vorbeilaufen, sondern auch
 * jemand anderen aussperren.
 *
 * Genommen wird der **letzte** Eintrag: Den hat der eigene Proxy angehängt,
 * alles davor stammt vom Absender.
 */
pub fn absender(
    headers: &axum::http::HeaderMap,
    peer: Option<std::net::IpAddr>,
    vertrauen: bool,
) -> String {
    if vertrauen {
        if let Some(kette) = headers
            .get("x-forwarded-for")
            .and_then(|wert| wert.to_str().ok())
        {
            if let Some(letzte) = kette
                .rsplit(',')
                .map(str::trim)
                .find(|teil| !teil.is_empty())
            {
                return letzte.to_string();
            }
        }
    }
    peer.map(|adresse| adresse.to_string())
        .unwrap_or_else(|| "unbekannt".to_string())
}

/**
 * Der Absender als Extraktor – damit die Handler nur `absender: Absender`
 * schreiben müssen.
 *
 * Er schlägt nie fehl. Weder eine fehlende Gegenstelle (in den Tests wird der
 * Router ohne Verbindungsinformationen gebaut) noch eine kaputte Kopfzeile darf
 * dazu führen, dass sich niemand mehr anmelden kann.
 */
pub struct Absender(pub String);

impl std::fmt::Display for Absender {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl axum::extract::FromRequestParts<crate::state::AppState> for Absender {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &crate::state::AppState,
    ) -> Result<Self, Self::Rejection> {
        let peer = parts
            .extensions
            .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
            .map(|axum::extract::ConnectInfo(adresse)| adresse.ip());
        Ok(Absender(absender(
            &parts.headers,
            peer,
            state.config.trust_proxy,
        )))
    }
}

/// Die Regeln, sortiert nach dem, was sie kosten, wenn jemand sie missbraucht.
pub mod regeln {
    use super::Regel;
    use std::time::Duration;

    /// Anmelden, gezählt **je Konto**: fünf Fehlversuche, dann etwa einer pro
    /// Minute.
    ///
    /// Grosszügig genug, dass ein vertipptes Passwort niemanden aufhält, und
    /// eng genug, dass Durchprobieren aussichtslos wird: Für zehntausend
    /// Versuche bräuchte man knapp eine Woche.
    pub const ANMELDEN: Regel = Regel::neu(5, Duration::from_secs(300));

    /// Anmelden, gezählt **je Adresse** – deutlich lockerer, und das mit Absicht.
    ///
    /// Der erste Entwurf hatte hier dieselben fünf Versuche wie beim Konto.
    /// Ein Test hat gezeigt, was das bedeutet: Hinter einem Router teilen sich
    /// alle im Haushalt eine Adresse, hinter einem Mobilfunkanschluss Hunderte
    /// Fremde. Fünf Vertipper im Wohnzimmer, und die ganze Familie kommt nicht
    /// mehr hinein – für eine App, die genau für solche Runden gedacht ist,
    /// wäre das die schlechtere Fehlerart.
    ///
    /// Dreissig reichen weiterhin gegen das, wogegen dieser Zähler wirklich
    /// da ist: von einer Adresse aus viele verschiedene Konten mit demselben
    /// Passwort durchzuprobieren. Der enge Zähler steht am Konto.
    pub const ANMELDEN_ADRESSE: Regel = Regel::neu(30, Duration::from_secs(300));

    /// Registrieren: zwanzig je Stunde und Adresse.
    ///
    /// Die Zahl ist bewusst nicht klein. Wogegen dieser Zähler wirklich
    /// hilft, ist massenhaftes Anlegen von Konten bei offener Registrierung –
    /// und dafür ist der Unterschied zwischen zwanzig und Tausenden pro Stunde
    /// der entscheidende. Gegen das Erraten eines Einladungscodes braucht es
    /// ihn ohnehin nicht: Ein Code hat 32 Zeichen aus einem Alphabet ohne
    /// Verwechslungsgefahr.
    ///
    /// Der erste Entwurf stand auf fünf. Ein Test hat gezeigt, was daran
    /// falsch ist: Wer bei einem Treffen acht Freunden ein Konto anlegt,
    /// sitzt mit allen im selben WLAN – und beim sechsten wäre Schluss
    /// gewesen. Genau der Fall, für den diese App gedacht ist.
    pub const REGISTRIEREN: Regel = Regel::neu(20, Duration::from_secs(3600));

    /// Erneuern des Zugangs: Das macht die App selbst, etwa alle 15 Minuten.
    /// Wer deutlich häufiger kommt, hat entweder einen Fehler oder etwas vor.
    pub const ERNEUERN: Regel = Regel::neu(30, Duration::from_secs(600));

    /// Personensuche: Sie liest über den ganzen Bestand. Eine Bremse hält
    /// jemanden davon ab, sich das Verzeichnis Buchstabe für Buchstabe
    /// abzuholen.
    pub const SUCHEN: Regel = Regel::neu(60, Duration::from_secs(60));

    /// Admin-Passwort: fünf Versuche je Stunde und Konto.
    ///
    /// Der engste Zähler von allen, und das aus gutem Grund: Jedes angemeldete
    /// Konto darf hier probieren, das Passwort muss nur acht Zeichen lang
    /// sein, und ein Treffer bedeutet Vollzugriff – Konten löschen,
    /// Einladungscodes anlegen. Wer es wirklich weiss, tippt es einmal.
    pub const ADMIN: Regel = Regel::neu(5, Duration::from_secs(3600));

    /// Passkey-Anmeldung beginnen: Jeder Aufruf schreibt – ohne Anmeldung –
    /// eine Zeile in die Datenbank. Zehn je fünf Minuten reichen für jeden
    /// ehrlichen Versuch und machen das Fluten der Tabelle unattraktiv.
    pub const PASSKEY: Regel = Regel::neu(10, Duration::from_secs(300));

    /// Passwort ändern – angemeldet, aber ein beliebter Weg, das alte Passwort
    /// zu erraten.
    pub const PASSWORT: Regel = Regel::neu(10, Duration::from_secs(600));
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST: Regel = Regel::neu(3, Duration::from_secs(30));

    fn kopfzeilen(wert: &str) -> axum::http::HeaderMap {
        let mut map = axum::http::HeaderMap::new();
        map.insert("x-forwarded-for", wert.parse().unwrap());
        map
    }

    #[test]
    fn abgeschaltet_laesst_sie_alles_durch() {
        // Fuer die Browser-Tests: Sie legen zwei Dutzend Konten in zwei
        // Minuten an, alle von derselben Adresse.
        let drossel = Drossel::neu(false);
        let jetzt = Instant::now();
        for _ in 0..100 {
            assert!(drossel.erlaubt_um("a", TEST, jetzt));
        }
    }

    #[test]
    fn nimmt_ohne_vertrauen_immer_die_gegenstelle() {
        let peer: std::net::IpAddr = "203.0.113.9".parse().unwrap();
        // Der Absender behauptet, jemand anderes zu sein – ohne Proxy davor
        // wird das ignoriert, sonst könnte er einen Fremden aussperren.
        let wer = absender(&kopfzeilen("198.51.100.1"), Some(peer), false);
        assert_eq!(wer, "203.0.113.9");
    }

    #[test]
    fn nimmt_mit_vertrauen_den_letzten_eintrag_der_kette() {
        let peer: std::net::IpAddr = "127.0.0.1".parse().unwrap();
        // Vorne steht, was der Absender selbst geschrieben hat; hinten das,
        // was der eigene Proxy gesehen hat. Nur Letzteres zählt.
        let wer = absender(&kopfzeilen("1.1.1.1, 203.0.113.9"), Some(peer), true);
        assert_eq!(wer, "203.0.113.9");
    }

    #[test]
    fn faellt_ohne_kopfzeile_auf_die_gegenstelle_zurueck() {
        let peer: std::net::IpAddr = "203.0.113.9".parse().unwrap();
        let wer = absender(&axum::http::HeaderMap::new(), Some(peer), true);
        assert_eq!(wer, "203.0.113.9");
    }

    #[test]
    fn laesst_den_vorrat_durch_und_bremst_danach() {
        let drossel = Drossel::neu(true);
        let jetzt = Instant::now();
        assert!(drossel.erlaubt_um("a", TEST, jetzt));
        assert!(drossel.erlaubt_um("a", TEST, jetzt));
        assert!(drossel.erlaubt_um("a", TEST, jetzt));
        assert!(!drossel.erlaubt_um("a", TEST, jetzt), "vierter Versuch");
    }

    #[test]
    fn fuellt_sich_mit_der_zeit_wieder_auf() {
        let drossel = Drossel::neu(true);
        let jetzt = Instant::now();
        for _ in 0..3 {
            assert!(drossel.erlaubt_um("a", TEST, jetzt));
        }
        assert!(!drossel.erlaubt_um("a", TEST, jetzt));

        // Ein Drittel der Auffüllzeit bringt genau einen Versuch zurück.
        let spaeter = jetzt + Duration::from_secs(10);
        assert!(drossel.erlaubt_um("a", TEST, spaeter));
        assert!(!drossel.erlaubt_um("a", TEST, spaeter));
    }

    #[test]
    fn laeuft_nicht_ueber_den_vorrat_hinaus_voll() {
        // Wer eine Woche nichts tut, hat drei Versuche – nicht dreitausend.
        let drossel = Drossel::neu(true);
        let jetzt = Instant::now();
        assert!(drossel.erlaubt_um("a", TEST, jetzt));
        let viel_spaeter = jetzt + Duration::from_secs(7 * 24 * 3600);
        for _ in 0..3 {
            assert!(drossel.erlaubt_um("a", TEST, viel_spaeter));
        }
        assert!(!drossel.erlaubt_um("a", TEST, viel_spaeter));
    }

    #[test]
    fn zaehlt_jeden_schluessel_fuer_sich() {
        let drossel = Drossel::neu(true);
        let jetzt = Instant::now();
        for _ in 0..3 {
            assert!(drossel.erlaubt_um("a", TEST, jetzt));
        }
        assert!(!drossel.erlaubt_um("a", TEST, jetzt));
        // Der Nachbar hinter derselben Bremse darf weiterhin.
        assert!(drossel.erlaubt_um("b", TEST, jetzt));
    }

    #[test]
    fn eine_geglueckte_anmeldung_loescht_die_fehlversuche() {
        let drossel = Drossel::neu(true);
        let jetzt = Instant::now();
        assert!(drossel.erlaubt_um("a", TEST, jetzt));
        assert!(drossel.erlaubt_um("a", TEST, jetzt));
        drossel.zuruecksetzen("a");
        // Wer sich zweimal vertippt und dann richtig liegt, faengt bei null an.
        for _ in 0..3 {
            assert!(drossel.erlaubt_um("a", TEST, jetzt));
        }
    }

    #[test]
    fn raeumt_alte_eintraege_weg_statt_zu_wachsen() {
        // Genau der Fall, den ein Angreifer auslöst: viele verschiedene
        // Adressen. Ohne Aufräumen wäre die Bremse selbst das Leck.
        let mut drossel = Drossel::neu(true);
        drossel.aufraeumen_ab = 50;
        let jetzt = Instant::now();
        for i in 0..60 {
            drossel.erlaubt_um(&format!("alt-{i}"), TEST, jetzt);
        }
        assert!(drossel.groesse() >= 50);

        let spaeter = jetzt + Duration::from_secs(600);
        drossel.erlaubt_um("neu", TEST, spaeter);
        assert_eq!(
            drossel.groesse(),
            1,
            "nach dem Aufräumen bleibt nur der frische Eintrag"
        );
    }
}
