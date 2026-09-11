//! Der Keks, mit dem `<img src>` sich ausweist.
//!
//! # Warum ein Keks und nicht der Token im Kopf
//!
//! Die Medienrouten waren ohne Anmeldung erreichbar, und das war kein
//! Versehen: `<img>`, `<video>`, `<audio>`, ein Herunterladen-Anker und der
//! Dienst-Arbeiter können **keinen** `Authorization`-Kopf setzen. Wer dort
//! einen Kopf verlangt, nimmt der App jedes Bild.
//!
//! Ein Keks ist der eine Ausweis, den der Browser bei genau diesen Anfragen
//! von selbst mitschickt – ohne Zutun der Seite, ohne Token in der Adresse
//! (der landete in Verlauf, Protokollen und im Schlüssel des Zwischenspeichers)
//! und ohne eine zweite Kopie des Anmeldegeheimnisses im Arbeiter.
//!
//! # Was darin steht
//!
//! Nicht der Zugangstoken. Ein eigener, mit `typ: "medien"` – `AuthUser`
//! nimmt nur `typ: "access"` an, und diese Routen nehmen nur `typ: "medien"`
//! aus dem Keks. Wer den Keks abgreift, bekommt damit also keinen Zugang zum
//! Rest der API, und wer den Zugangstoken hat, kommt nicht über den Keksweg.
//!
//! `Path` grenzt zusätzlich ein: Der Browser schickt ihn nur an die
//! Medienrouten, nicht an jede API-Anfrage.

use axum::http::HeaderMap;
use uuid::Uuid;

use super::jwt;
use crate::config::Config;

pub const NAME: &str = "initiative_medien";
pub const PFAD: &str = "/api/v1/media";
/// Die Kekse gelten so lange wie eine Sitzung – siehe `Config::refresh_token_ttl`.
pub const TYP: &str = "medien";

/// Wie der Keks gesetzt werden muss, damit der Browser ihn auch mitschickt.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Beiwerk {
    /// `SameSite=Lax`, wenn App und API dieselbe Stelle sind – sonst `None`.
    pub gleiche_stelle: bool,
    /// `Secure` – Pflicht bei `SameSite=None`, und überall richtig bei https.
    pub sicher: bool,
}

/**
 * Entscheidet über `SameSite` und `Secure` – oder sagt, dass es nicht geht.
 *
 * Drei Lagen:
 *
 * * **Dieselbe Stelle** (App und API unter demselben eingetragenen Namen, auch
 *   bei verschiedenen Häfen): `SameSite=Lax` genügt und ist die engste Wahl.
 *   Bei einer Anfrage von der App aus ist die Herkunft nicht fremd, der Keks
 *   geht also auch an ein `<img>`.
 * * **Fremde Stelle über https**: Es braucht `SameSite=None; Secure`, und
 *   die App muss mit `credentials` fragen. Das setzt voraus, dass
 *   `CORS_ORIGINS` ausdrücklich gesetzt ist – bei `*` schaltet der Server
 *   `allow_credentials` ab, und der Browser verwirft die Antwort.
 * * **Fremde Stelle über http**: Geht nicht. `SameSite=None` ohne `Secure`
 *   lehnt jeder heutige Browser ab. Hier gibt es `None` zurück, und der
 *   Aufrufer schaltet die Medienanmeldung aus, statt die Bilder zu verlieren.
 */
pub fn beiwerk(app_url: &str, api_url: &str) -> Option<Beiwerk> {
    let api_https = api_url.starts_with("https://");
    let gleiche_stelle = gleiche_stelle(app_url, api_url);
    if gleiche_stelle {
        return Some(Beiwerk {
            gleiche_stelle: true,
            sicher: api_https,
        });
    }
    if api_https {
        return Some(Beiwerk {
            gleiche_stelle: false,
            sicher: true,
        });
    }
    None
}

/// Der Name hinter dem Schema und vor Hafen und Pfad.
fn wirt(url: &str) -> &str {
    let ohne_schema = url
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(url);
    let ohne_pfad = ohne_schema.split('/').next().unwrap_or(ohne_schema);
    // Der Hafen gehört nicht zur „Stelle": `example.com:8080` und
    // `example.com` sind für einen Keks dasselbe.
    match ohne_pfad.rsplit_once(':') {
        // Vorsicht bei IPv6 in Klammern – dort ist der Doppelpunkt Teil der
        // Adresse.
        Some((vorne, hinten)) if !hinten.is_empty() && hinten.chars().all(|c| c.is_ascii_digit()) => {
            vorne
        }
        _ => ohne_pfad,
    }
}

/**
 * Gehören die beiden Namen zur selben Stelle?
 *
 * Ohne die Liste der öffentlichen Endungen lässt sich „eingetragener Name"
 * nicht sauber bestimmen. Hier wird deshalb streng gerechnet: gleich, oder
 * der eine ist ein Untername des anderen (`api.example.com` zu
 * `example.com`). Das verfehlt den Fall `app.example.com` gegen
 * `api.example.com` – dort greift dann der Zweig für fremde Stellen, der
 * lediglich strenger ist und nichts kaputtmacht.
 */
fn gleiche_stelle(a: &str, b: &str) -> bool {
    let (a, b) = (wirt(a), wirt(b));
    if a.eq_ignore_ascii_case(b) {
        return true;
    }
    let (kurz, lang) = if a.len() < b.len() { (a, b) } else { (b, a) };
    !kurz.is_empty() && lang.to_ascii_lowercase().ends_with(&format!(".{}", kurz.to_ascii_lowercase()))
}

/// Der `Set-Cookie`-Wert, der eine Sitzung eröffnet.
pub fn setzen(config: &Config, user_id: Uuid) -> Option<String> {
    let beiwerk = beiwerk(&config.public_app_url, &config.public_api_url)?;
    let sekunden = config.refresh_token_ttl.as_secs();
    let token = jwt::encode(
        &user_id.to_string(),
        TYP,
        &config.jwt_secret,
        sekunden as i64,
    );
    Some(bauen(&token, sekunden, beiwerk))
}

/// Der `Set-Cookie`-Wert, der ihn wieder wegnimmt.
pub fn loeschen(config: &Config) -> Option<String> {
    let beiwerk = beiwerk(&config.public_app_url, &config.public_api_url)?;
    Some(bauen("", 0, beiwerk))
}

fn bauen(wert: &str, sekunden: u64, beiwerk: Beiwerk) -> String {
    let mut teile = vec![
        format!("{NAME}={wert}"),
        format!("Path={PFAD}"),
        format!("Max-Age={sekunden}"),
        "HttpOnly".to_string(),
    ];
    teile.push(
        if beiwerk.gleiche_stelle {
            "SameSite=Lax"
        } else {
            "SameSite=None"
        }
        .to_string(),
    );
    if beiwerk.sicher {
        teile.push("Secure".to_string());
    }
    teile.join("; ")
}

/// Den Keks aus den Kopfzeilen fischen.
pub fn aus_kopfzeilen(headers: &HeaderMap) -> Option<String> {
    let roh = headers.get(axum::http::header::COOKIE)?.to_str().ok()?;
    for stueck in roh.split(';') {
        let stueck = stueck.trim();
        if let Some(wert) = stueck.strip_prefix(&format!("{NAME}=")) {
            if wert.is_empty() {
                return None;
            }
            return Some(wert.to_string());
        }
    }
    None
}

/// Wer hinter dem Keks steckt – oder `None`, wenn er nicht taugt.
pub fn betrachter(headers: &HeaderMap, secret: &str) -> Option<Uuid> {
    let token = aus_kopfzeilen(headers)?;
    let claims = jwt::decode(&token, secret)?;
    if claims.typ != TYP {
        return None;
    }
    Uuid::parse_str(&claims.sub).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gleicher_name_ist_dieselbe_stelle() {
        assert!(gleiche_stelle("https://example.com", "https://example.com"));
    }

    #[test]
    fn der_hafen_zaehlt_nicht() {
        // Genau der Fall in der Entwicklung: App auf 5173, API auf 8080.
        assert!(gleiche_stelle("http://localhost:5173", "http://localhost:8080"));
    }

    #[test]
    fn ein_untername_gehoert_dazu() {
        assert!(gleiche_stelle("https://example.com", "https://api.example.com"));
        assert!(gleiche_stelle("https://api.example.com", "https://example.com"));
    }

    #[test]
    fn zwei_fremde_namen_sind_es_nicht() {
        assert!(!gleiche_stelle("https://app.example.com", "https://cdn.woanders.de"));
    }

    #[test]
    fn kein_halber_name_gilt_als_untername() {
        // „bad-example.com" endet auf „example.com", ist aber etwas anderes.
        assert!(!gleiche_stelle("https://example.com", "https://badexample.com"));
    }

    #[test]
    fn dieselbe_stelle_bekommt_lax() {
        let b = beiwerk("https://example.com", "https://example.com").expect("möglich");
        assert!(b.gleiche_stelle);
        assert!(b.sicher);
        assert!(bauen("t", 60, b).contains("SameSite=Lax"));
        assert!(bauen("t", 60, b).contains("Secure"));
    }

    #[test]
    fn entwicklung_ohne_tls_bekommt_lax_ohne_secure() {
        let b = beiwerk("http://localhost:5173", "http://localhost:8080").expect("möglich");
        let keks = bauen("t", 60, b);
        assert!(keks.contains("SameSite=Lax"));
        assert!(!keks.contains("Secure"), "auf http gibt es kein Secure: {keks}");
    }

    #[test]
    fn fremde_stelle_ueber_https_bekommt_none_und_secure() {
        let b = beiwerk("https://app.example.com", "https://medien.woanders.de").expect("möglich");
        let keks = bauen("t", 60, b);
        assert!(keks.contains("SameSite=None"));
        assert!(keks.contains("Secure"));
    }

    #[test]
    fn fremde_stelle_ohne_tls_ist_unmoeglich() {
        // `SameSite=None` ohne `Secure` lehnt jeder Browser ab – dann lieber
        // ehrlich gar keinen Keks als einen, der nie ankommt.
        assert_eq!(beiwerk("http://app.example.com", "http://api.woanders.de"), None);
    }

    #[test]
    fn der_keks_traegt_pfad_und_httponly() {
        let b = beiwerk("https://example.com", "https://example.com").expect("möglich");
        let keks = bauen("t", 3600, b);
        assert!(keks.contains("Path=/api/v1/media"));
        assert!(keks.contains("HttpOnly"));
        assert!(keks.contains("Max-Age=3600"));
    }

    #[test]
    fn aus_mehreren_keksen_den_richtigen() {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::COOKIE,
            "andere=1; initiative_medien=abc.def.ghi; noch_eine=2"
                .parse()
                .unwrap(),
        );
        assert_eq!(aus_kopfzeilen(&headers).as_deref(), Some("abc.def.ghi"));
    }

    #[test]
    fn ein_geleerter_keks_gilt_nicht() {
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::COOKIE,
            "initiative_medien=".parse().unwrap(),
        );
        assert_eq!(aus_kopfzeilen(&headers), None);
    }

    #[test]
    fn ein_zugangstoken_taugt_im_keks_nicht() {
        // Der Kern der Trennung: Wer den Keksweg mit einem Zugangstoken geht,
        // kommt nicht durch – und umgekehrt ebenso wenig.
        let geheim = "test-secret-value-at-least-16-characters";
        let id = Uuid::now_v7();
        let zugang = jwt::encode(&id.to_string(), "access", geheim, 60);
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::COOKIE,
            format!("{NAME}={zugang}").parse().unwrap(),
        );
        assert_eq!(betrachter(&headers, geheim), None);

        let medien = jwt::encode(&id.to_string(), TYP, geheim, 60);
        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::COOKIE,
            format!("{NAME}={medien}").parse().unwrap(),
        );
        assert_eq!(betrachter(&headers, geheim), Some(id));
    }
}
