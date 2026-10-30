//! Der Erneuerungs-Token im Keks statt im Speicher der Seite.
//!
//! # Warum
//!
//! Der Web-Client legte den Erneuerungs-Token in `localStorage` ab. Dort
//! kann ihn jedes Skript der Seite lesen – ein einziger eingeschleuster
//! Schnipsel nimmt ihn mit und hat sechzig Tage lang eine rotierende Sitzung,
//! auch nachdem der Mensch die Seite längst geschlossen hat. Das kurzlebige
//! Zugriffstoken (eine Viertelstunde) ist ein viel kleinerer Verlust.
//!
//! Ein `HttpOnly`-Keks ist für Skripte unsichtbar; der Browser schickt ihn
//! von selbst mit, und zwar wegen `Path` NUR an `/api/v1/auth/refresh` –
//! `POST` erneuert, `DELETE` meldet ab. Keine andere Anfrage trägt ihn.
//!
//! # SameSite, Secure und CSRF
//!
//! * **Dieselbe Stelle** (App und API unter demselben Namen, auch mit
//!   verschiedenen Häfen – der Vite-Proxy, Caddy vor beidem): `SameSite=Strict`.
//!   Eine fremde Seite kann den Keks dann gar nicht mitschicken lassen.
//! * **Fremde Stelle über https**: `SameSite=None; Secure` – anders kommt der
//!   Keks bei einer Anfrage der App an die API nicht an. Dafür muss
//!   `CORS_ORIGINS` die App ausdrücklich nennen (mit `*` gibt es keine
//!   `credentials`).
//! * **Fremde Stelle über http**: geht nicht (`SameSite=None` ohne `Secure`
//!   verwirft jeder Browser). Dann setzt der Server keinen Keks und gibt den
//!   Token wie bisher im Rumpf zurück; der Web-Client hält ihn nur im
//!   Speicher des Tabs.
//!
//! `Secure` steht, sobald die API über https erreichbar ist. Über blankes
//! http (Entwicklung auf `localhost` oder im Heimnetz) bleibt es weg: Chrome
//! und Firefox nähmen einen `Secure`-Keks auf `localhost` zwar an, Safari und
//! jede Adresse im Heimnetz nicht – und die Entwicklung soll in allen gehen.
//!
//! Gegen CSRF zusätzlich zu `SameSite`: Wer mit dem Keks erneuert oder sich
//! abmeldet, muss den Kopf [`KOPF`] mitschicken (ein Formular oder ein
//! einfacher Querverweis kann das nicht; ein fremdes Skript nur nach einem
//! CORS-Vorabcheck, den der Server nur bekannten Herkünften erlaubt), und
//! eine mitgeschickte `Origin` muss eine bekannte Herkunft sein
//! ([`herkunft_erlaubt`]).
//!
//! Kein `Domain`: Der Keks gilt nur für genau den Namen, der ihn gesetzt hat.

use axum::http::HeaderMap;

use super::medienkeks;
use crate::config::Config;

pub const NAME: &str = "initiative_erneuern";
pub const PFAD: &str = "/api/v1/auth/refresh";
/// Der Kopf, mit dem ein Client sagt: „Ich führe die Sitzung über den Keks.“
///
/// Bei Anmelden/Registrieren/Erneuern heisst das: den Token NICHT im Rumpf
/// zurückgeben, wenn der Keks gesetzt werden konnte. Beim Erneuern und
/// Abmelden über den Keks ist er Pflicht (CSRF, siehe oben).
pub const KOPF: &str = "x-initiative-sitzung";

/// Wie der Keks gesetzt wird – oder `None`, wenn es nicht geht.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Beiwerk {
    /// `SameSite=Strict` statt `None`.
    pub streng: bool,
    pub sicher: bool,
}

pub fn beiwerk(config: &Config) -> Option<Beiwerk> {
    let medien = medienkeks::beiwerk(&config.public_app_url, &config.public_api_url)?;
    Some(Beiwerk {
        streng: medien.gleiche_stelle,
        sicher: medien.sicher,
    })
}

/// Der `Set-Cookie`-Wert mit diesem Token – oder `None`, wenn es keinen Keks
/// geben kann (fremde Stelle über http).
pub fn setzen(config: &Config, token: &str) -> Option<String> {
    let beiwerk = beiwerk(config)?;
    Some(bauen(token, config.refresh_token_ttl.as_secs(), beiwerk))
}

/// Der `Set-Cookie`-Wert, der ihn wieder wegnimmt.
pub fn loeschen(config: &Config) -> Option<String> {
    let beiwerk = beiwerk(config)?;
    Some(bauen("", 0, beiwerk))
}

fn bauen(wert: &str, sekunden: u64, beiwerk: Beiwerk) -> String {
    let mut teile = vec![
        format!("{NAME}={wert}"),
        format!("Path={PFAD}"),
        format!("Max-Age={sekunden}"),
        "HttpOnly".to_string(),
        if beiwerk.streng {
            "SameSite=Strict"
        } else {
            "SameSite=None"
        }
        .to_string(),
    ];
    if beiwerk.sicher {
        teile.push("Secure".to_string());
    }
    teile.join("; ")
}

/// Den Keks aus den Kopfzeilen fischen.
pub fn aus_kopfzeilen(headers: &HeaderMap) -> Option<String> {
    for roh in headers.get_all(axum::http::header::COOKIE) {
        let Ok(roh) = roh.to_str() else { continue };
        for stueck in roh.split(';') {
            if let Some(wert) = stueck.trim().strip_prefix(&format!("{NAME}=")) {
                if !wert.is_empty() {
                    return Some(wert.to_string());
                }
            }
        }
    }
    None
}

/// Will der Client die Sitzung über den Keks führen?
pub fn will_keks(headers: &HeaderMap) -> bool {
    headers.contains_key(KOPF)
}

/**
 * Ist diese Herkunft eine, der wir eine Sitzung zutrauen?
 *
 * Dieselbe Liste wie für CORS (`app::cors_layer`): `CORS_ORIGINS`, die App
 * selbst und in der Entwicklung die üblichen lokalen Adressen. Dazu die API
 * selbst (Anfrage von derselben Stelle). Ein `*` in `CORS_ORIGINS` zählt hier
 * NICHT – wer überall herkommen darf, darf noch lange keine Sitzung erneuern.
 */
pub fn herkunft_erlaubt(config: &Config, herkunft: &str) -> bool {
    let herkunft = herkunft.trim_end_matches('/');
    if herkunft == config.public_app_url || herkunft == config.public_api_url {
        return true;
    }
    if config
        .cors_origins
        .iter()
        .any(|erlaubt| erlaubt != "*" && erlaubt == herkunft)
    {
        return true;
    }
    !config.is_production() && lokale_entwicklung(herkunft)
}

/// Lokale Entwicklungsadressen (Vite, Telefon im selben Netz).
pub fn lokale_entwicklung(herkunft: &str) -> bool {
    herkunft.starts_with("http://localhost")
        || herkunft.starts_with("http://127.0.0.1")
        || herkunft.starts_with("http://[::1]")
        || herkunft.starts_with("http://192.168.")
        || herkunft.starts_with("http://10.")
}

/// CSRF-Prüfung für alles, was der Keks allein auslöst: Kopf da, Herkunft
/// (falls mitgeschickt) bekannt.
pub fn anfrage_vertrauenswuerdig(config: &Config, headers: &HeaderMap) -> bool {
    if !will_keks(headers) {
        return false;
    }
    match headers.get(axum::http::header::ORIGIN) {
        None => true,
        Some(herkunft) => herkunft
            .to_str()
            .is_ok_and(|herkunft| herkunft_erlaubt(config, herkunft)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn beiwerk_fuer(streng: bool, sicher: bool) -> Beiwerk {
        Beiwerk { streng, sicher }
    }

    #[test]
    fn derselbe_name_bekommt_strict_und_nur_den_erneuerungspfad() {
        let keks = bauen("abc", 60, beiwerk_fuer(true, true));
        assert_eq!(
            keks,
            "initiative_erneuern=abc; Path=/api/v1/auth/refresh; Max-Age=60; HttpOnly; SameSite=Strict; Secure"
        );
        assert!(!keks.contains("Domain"), "nur der Name, der ihn setzt");
    }

    #[test]
    fn ueber_http_ohne_secure_damit_die_entwicklung_geht() {
        let keks = bauen("abc", 60, beiwerk_fuer(true, false));
        assert!(keks.contains("SameSite=Strict"));
        assert!(!keks.contains("Secure"));
    }

    #[test]
    fn keks_wird_gefunden_auch_neben_anderen() {
        let mut kopf = HeaderMap::new();
        kopf.insert(
            axum::http::header::COOKIE,
            "a=1; initiative_erneuern=xyz; initiative_medien=m"
                .parse()
                .unwrap(),
        );
        assert_eq!(aus_kopfzeilen(&kopf).as_deref(), Some("xyz"));
        kopf.insert(
            axum::http::header::COOKIE,
            "initiative_erneuern=".parse().unwrap(),
        );
        assert_eq!(aus_kopfzeilen(&kopf), None);
    }

    #[test]
    fn lokale_adressen_sind_entwicklung() {
        assert!(lokale_entwicklung("http://localhost:5173"));
        assert!(lokale_entwicklung("http://127.0.0.1:5293"));
        assert!(!lokale_entwicklung("https://boese.example"));
    }
}
